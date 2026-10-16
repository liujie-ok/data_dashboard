/*
 * GPS Telemetry Transmitter + Speed Display + LittleFS Logger
 * Hardware: LILYGO ESP32 T-Display S3 + NEO-6M GPS + nRF24L01+PA+LNA
 *
 * ── Wiring ────────────────────────────────────────────────────────────────────
 *  NEO-6M GPS:
 *    VCC  -> ESP32 3V3
 *    GND  -> ESP32 GND
 *    TX   -> GPIO 44   (ESP32 UART1 RX)
 *    RX   -> GPIO 43   (ESP32 UART1 TX — optional)
 *
 *  nRF24L01+PA+LNA (HSPI bus):
 *    VCC  -> ESP32 3V3       (STRICTLY 3.3V — NOT 5V)
 *    GND  -> ESP32 GND
 *    CE   -> GPIO 21
 *    CSN  -> GPIO 10
 *    SCK  -> GPIO 12
 *    MOSI -> GPIO 11
 *    MISO -> GPIO 13
 *    *** Solder a 10–100 µF cap across VCC/GND ***
 *
 *  Power:
 *    Buck converter OUT+ (5.0 V) -> ESP32 5V pin
 *    Buck converter OUT-         -> ESP32 GND
 *
 * ── LittleFS log files ────────────────────────────────────────────────────────
 *  Files: /run_0001.csv, /run_0002.csv, ... (new file each power-cycle)
 *  Header: millis,lat,lon,speed_mph,heading
 *
 * ── Downloading logs to laptop ───────────────────────────────────────────────
 *  Plug ESP32 into laptop via USB (115200 baud), then type:
 *    LIST                — list all log filenames and sizes
 *    DUMP                — stream the current run as CSV, ends with END
 *    DUMP run_0002.csv   — stream a specific file
 *    DELETE              — wipe all log files
 *  Use download_log.py in this folder to do it automatically.
 *
 * ── Button 0 ──────────────────────────────────────────────────────────────────
 *  Short press (<2 s) — reset peak speed and elapsed timer
 *  Long press  (>2 s) — flush log and start a new file
 *
 * ── Arduino IDE partition scheme ─────────────────────────────────────────────
 *  Tools -> Partition Scheme -> "No OTA (2MB APP / 2MB SPIFFS)"
 *  Gives ~1.5 MB for LittleFS. Default partition only allocates 64 KB.
 *
 * ── Libraries (Arduino Library Manager) ──────────────────────────────────────
 *  TFT_eSPI  (Bodmer)    — set User_Setup_Select.h for T-Display S3
 *  TinyGPS++ (Mikal Hart)
 *  RF24      (TMRh20)    — v1.4.8+
 *  LittleFS  — built into ESP32 Arduino core, no install needed
 */

#include <TFT_eSPI.h>
#include <TinyGPSPlus.h>
#include <SPI.h>
#include <RF24.h>
#include <nRF24L01.h>
#include <LittleFS.h>

// ── Pin definitions ───────────────────────────────────────────────────────────
#define GPS_RX_PIN   44
#define GPS_TX_PIN   43
#define GPS_BAUD     9600

#define NRF_CE_PIN   21
#define NRF_CSN_PIN  10
#define NRF_SCK_PIN  12
#define NRF_MISO_PIN 13
#define NRF_MOSI_PIN 11

#define PIN_BL       15
#define PIN_PWR      38

// ── Timing ────────────────────────────────────────────────────────────────────
const uint32_t TX_INTERVAL_MS    = 500;    // RF24 transmit rate
const uint32_t LOG_INTERVAL_MS   = 500;    // how often to write a GPS row
const uint32_t DISPLAY_MS        = 100;    // display refresh rate
const uint32_t FLUSH_INTERVAL_MS = 10000; // flush LittleFS every 10 s

// ── Hardware ──────────────────────────────────────────────────────────────────
HardwareSerial gpsSerial(1);
TinyGPSPlus    gps;
TFT_eSPI       tft = TFT_eSPI();
SPIClass       nrfSPI(HSPI);
RF24           radio(NRF_CE_PIN, NRF_CSN_PIN);

// ── RF24 ──────────────────────────────────────────────────────────────────────
const byte    RF_ADDRESS[6] = "00001";
const uint8_t NRF_MAX_FAILS = 5;
uint8_t       nrfFailCount  = 0;
struct Payload { char data[64]; };
Payload txPacket;

// ── LittleFS ──────────────────────────────────────────────────────────────────
bool  fsReady      = false;
File  logFile;
char  logFilename[24];

// Serial command buffer
char    cmdBuf[32];
uint8_t cmdIdx = 0;

// ── State ─────────────────────────────────────────────────────────────────────
float    peakMph       = 0.0f;
uint32_t lastTxMs      = 0;
uint32_t lastLogMs     = 0;
uint32_t lastDisplayMs = 0;
uint32_t lastFlushMs   = 0;
uint32_t runStartMs    = 0;
uint32_t btn0PressMs   = 0;
bool     btn0Held      = false;

// ── Colours ───────────────────────────────────────────────────────────────────
#define COL_BG      TFT_BLACK
#define COL_LABEL   0x7BEF
#define COL_VALUE   TFT_WHITE
#define COL_UNIT    0x07FF
#define COL_WARN    TFT_YELLOW
#define COL_ERR     TFT_RED
#define COL_GREEN   0x07E0
#define COL_PEAK    0xF81F
#define COL_BAR_BG  0x1082
#define COL_BAR_LO  0x07E0
#define COL_BAR_MID 0xFD20
#define COL_BAR_HI  TFT_RED
const float BAR_MAX_MPH = 60.0f;

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════
const char* cardinal(float deg) {
  const char* dirs[] = {"N","NE","E","SE","S","SW","W","NW"};
  return dirs[((int)((deg + 22.5f) / 45.0f)) % 8];
}

void fmtTime(uint32_t ms, char* buf) {
  uint32_t s = ms / 1000, m = s / 60; s %= 60;
  sprintf(buf, "%02lu:%02lu", (unsigned long)m, (unsigned long)s);
}

// ═════════════════════════════════════════════════════════════════════════════
// LittleFS
// ═════════════════════════════════════════════════════════════════════════════
void openNextLogFile() {
  for (int i = 1; i <= 9999; i++) {
    snprintf(logFilename, sizeof(logFilename), "/run_%04d.csv", i);
    if (!LittleFS.exists(logFilename)) break;
  }
  logFile = LittleFS.open(logFilename, "w");
  if (logFile) {
    logFile.println("millis,lat,lon,speed_mph,heading");
    logFile.flush();
    fsReady = true;
    Serial.printf("Logging: %s\n", logFilename);
  } else {
    fsReady = false;
    Serial.println("FS: could not open log file");
  }
}

void initFS() {
  if (!LittleFS.begin(true)) { Serial.println("FS: mount failed"); return; }
  openNextLogFile();
}

void logRow(uint32_t ms, float lat, float lon, float spd, float hdg) {
  if (!fsReady || !logFile) return;
  logFile.printf("%lu,%.6f,%.6f,%.2f,%.1f\n",
                 (unsigned long)ms, lat, lon, spd, hdg);
}

// ── Serial download commands ──────────────────────────────────────────────────
void dumpFile(const char* path) {
  File f = LittleFS.open(path, "r");
  if (!f) { Serial.printf("ERROR: %s not found\n", path); return; }
  Serial.printf("BEGIN %s\n", path);
  while (f.available()) Serial.write(f.read());
  f.close();
  Serial.println("\nEND");
}

void handleCmd(const char* cmd) {
  if (strcmp(cmd, "LIST") == 0) {
    File root = LittleFS.open("/");
    File f = root.openNextFile();
    int n = 0;
    while (f) { Serial.printf("%s  %d bytes\n", f.name(), (int)f.size()); f = root.openNextFile(); n++; }
    if (!n) Serial.println("(no files)");

  } else if (strcmp(cmd, "DUMP") == 0) {
    if (logFile) logFile.flush();
    dumpFile(logFilename);

  } else if (strncmp(cmd, "DUMP ", 5) == 0) {
    if (logFile) logFile.flush();
    char path[28]; snprintf(path, sizeof(path), "/%s", cmd + 5);
    dumpFile(path);

  } else if (strcmp(cmd, "DELETE") == 0) {
    if (logFile) { logFile.flush(); logFile.close(); }
    File root = LittleFS.open("/");
    File f = root.openNextFile();
    int n = 0;
    while (f) {
      char path[28]; snprintf(path, sizeof(path), "/%s", f.name());
      f = root.openNextFile(); LittleFS.remove(path); n++;
    }
    Serial.printf("Deleted %d files\n", n);
    fsReady = false;
    openNextLogFile();

  } else {
    Serial.println("Commands: LIST  DUMP  DUMP <file>  DELETE");
  }
}

void pollSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (cmdIdx > 0) { cmdBuf[cmdIdx] = '\0'; handleCmd(cmdBuf); cmdIdx = 0; }
    } else if (cmdIdx < (int)sizeof(cmdBuf) - 1) {
      cmdBuf[cmdIdx++] = c;
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// RF24
// ═════════════════════════════════════════════════════════════════════════════
bool initRadio() {
  nrfSPI.end();
  nrfSPI.begin(NRF_SCK_PIN, NRF_MISO_PIN, NRF_MOSI_PIN, NRF_CSN_PIN);
  if (!radio.begin(&nrfSPI)) return false;
  radio.setRetries(3, 3);
  radio.setPALevel(RF24_PA_LOW);
  radio.setDataRate(RF24_250KBPS);
  radio.setChannel(100);
  radio.setPayloadSize(sizeof(Payload));
  radio.setAutoAck(true);
  radio.openWritingPipe(RF_ADDRESS);
  radio.stopListening();
  nrfFailCount = 0;
  return true;
}

void transmit(float lat, float lon, float spd, float hdg) {
  char la[12], lo[13], sp[8], hd[8];
  dtostrf(lat, 9, 6, la); dtostrf(lon, 10, 6, lo);
  dtostrf(spd, 5, 2, sp); dtostrf(hdg,  5, 1, hd);
  memset(txPacket.data, 0, sizeof(txPacket.data));
  snprintf(txPacket.data, sizeof(txPacket.data),
           "%lu,%s,%s,%s,%s", (unsigned long)millis(), la, lo, sp, hd);
  if (!radio.write(&txPacket, sizeof(txPacket))) {
    if (++nrfFailCount >= NRF_MAX_FAILS) {
      nrfFailCount = initRadio() ? 0 : NRF_MAX_FAILS;
    }
  } else { nrfFailCount = 0; }
}

// ═════════════════════════════════════════════════════════════════════════════
// Display
// ═════════════════════════════════════════════════════════════════════════════
void drawChrome() {
  tft.fillScreen(COL_BG);
  tft.fillRect(0, 0, 320, 20, 0x000E);
  tft.setTextColor(COL_UNIT, 0x000E); tft.setTextSize(2);
  tft.setCursor(4, 2); tft.print("GPS Speed");
  tft.setTextColor(COL_LABEL, 0x000E); tft.setTextSize(1);
  tft.setCursor(200, 5); tft.print("FIX");
  tft.setCursor(238, 5); tft.print("LOG");
  tft.setCursor(268, 5); tft.print("ELAPSED");

  tft.drawRect(4, 96, 312, 10, COL_LABEL);
  tft.setTextColor(COL_LABEL, COL_BG); tft.setTextSize(1);
  tft.setCursor(4,   108); tft.print("0");
  tft.setCursor(148, 108); tft.print("30");
  tft.setCursor(300, 108); tft.print("60mph");
  tft.setCursor(4,   124); tft.print("PEAK");
  tft.setCursor(164, 124); tft.print("HEADING");
  tft.setCursor(4,   148); tft.print("POSITION");
}

void updateDisplay() {
  bool  fix  = gps.location.isValid();
  float spd  = fix ? gps.speed.mph()  : 0.0f;
  float hdg  = (fix && gps.course.isValid()) ? gps.course.deg() : 0.0f;
  if (spd > peakMph) peakMph = spd;

  tft.setTextSize(1);

  // FIX badge
  tft.fillRect(196, 3, 38, 8, 0x000E);
  tft.setTextColor(fix ? COL_GREEN : COL_ERR, 0x000E);
  tft.setCursor(196, 6); tft.print(fix ? "GPS OK" : "NO FIX");

  // LOG badge
  tft.fillRect(234, 3, 30, 8, 0x000E);
  tft.setTextColor(fsReady ? COL_GREEN : COL_WARN, 0x000E);
  tft.setCursor(234, 6); tft.print(fsReady ? "LOG ON" : "NO LOG");

  // Elapsed
  char tbuf[8]; fmtTime(millis() - runStartMs, tbuf);
  tft.fillRect(276, 3, 44, 8, 0x000E);
  tft.setTextColor(COL_VALUE, 0x000E);
  tft.setCursor(276, 6); tft.print(tbuf);

  // Big speed
  tft.fillRect(4, 22, 210, 60, COL_BG);
  tft.setTextColor(fix ? COL_VALUE : COL_LABEL, COL_BG);
  tft.setTextSize(7); tft.setCursor(6, 24); tft.printf("%.1f", spd);
  tft.fillRect(216, 22, 60, 30, COL_BG);
  tft.setTextColor(COL_UNIT, COL_BG);
  tft.setTextSize(3); tft.setCursor(218, 32); tft.print("mph");

  // Sats
  tft.setTextSize(1); tft.setTextColor(COL_LABEL, COL_BG);
  tft.fillRect(218, 64, 60, 8, COL_BG);
  tft.setCursor(218, 64); tft.printf("%d sats", (int)gps.satellites.value());

  // Bar
  int bw = constrain((int)((spd / BAR_MAX_MPH) * 310.0f), 0, 310);
  uint16_t bc = spd > BAR_MAX_MPH*0.75f ? COL_BAR_HI :
                spd > BAR_MAX_MPH*0.50f ? COL_BAR_MID : COL_BAR_LO;
  tft.fillRect(5, 97, bw, 8, bc);
  tft.fillRect(5+bw, 97, 310-bw, 8, COL_BAR_BG);

  // Peak
  tft.setTextSize(2); tft.setTextColor(COL_PEAK, COL_BG);
  tft.fillRect(40, 120, 114, 16, COL_BG);
  tft.setCursor(40, 120); tft.printf("%.1fmph", peakMph);

  // Heading
  tft.setTextColor(COL_VALUE, COL_BG);
  tft.fillRect(230, 120, 86, 16, COL_BG);
  tft.setCursor(230, 120);
  if (fix && gps.course.isValid()) tft.printf("%.0f %s", hdg, cardinal(hdg));
  else tft.print("---");

  // Position
  tft.setTextSize(1); tft.setTextColor(COL_LABEL, COL_BG);
  tft.fillRect(52, 148, 264, 8, COL_BG);
  tft.setCursor(52, 148);
  if (fix) tft.printf("%.6f,  %.6f", gps.location.lat(), gps.location.lng());
  else     tft.print("Waiting for GPS fix...");
}

// ═════════════════════════════════════════════════════════════════════════════
// Setup
// ═════════════════════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);

  pinMode(PIN_PWR, OUTPUT); digitalWrite(PIN_PWR, HIGH);
  pinMode(PIN_BL,  OUTPUT); digitalWrite(PIN_BL,  HIGH);
  delay(100);

  tft.init(); tft.setRotation(3); tft.fillScreen(COL_BG);
  tft.setTextSize(2); tft.setTextColor(COL_LABEL, COL_BG);
  tft.setCursor(8, 30); tft.print("Initialising...");

  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  tft.setTextColor(COL_GREEN, COL_BG);
  tft.setCursor(8, 54); tft.print("GPS ready");

  if (!initRadio()) {
    tft.setTextColor(COL_WARN, COL_BG);
    tft.setCursor(8, 78); tft.print("Radio init failed!");
    Serial.println("WARNING: nRF24 init failed");
    delay(1500);
  } else {
    tft.setTextColor(COL_GREEN, COL_BG);
    tft.setCursor(8, 78); tft.print("Radio ready");
  }

  initFS();
  tft.setTextSize(1);
  if (fsReady) {
    tft.setTextColor(COL_GREEN, COL_BG);
    tft.setCursor(8, 102); tft.printf("Log: %s", logFilename);
  } else {
    tft.setTextColor(COL_WARN, COL_BG);
    tft.setCursor(8, 102); tft.print("Flash log failed");
  }
  delay(1500);

  pinMode(0, INPUT_PULLUP);
  runStartMs = millis();
  drawChrome();

  Serial.println("Ready. Commands: LIST  DUMP  DUMP <file>  DELETE");
}

// ═════════════════════════════════════════════════════════════════════════════
// Loop
// ═════════════════════════════════════════════════════════════════════════════
void loop() {
  // Feed GPS parser
  while (gpsSerial.available()) gps.encode(gpsSerial.read());

  // Serial download commands
  pollSerial();

  // ── Button 0 ──────────────────────────────────────────────────────────────
  if (digitalRead(0) == LOW) {
    if (!btn0Held) { btn0Held = true; btn0PressMs = millis(); }
    else if ((millis() - btn0PressMs) > 2000) {
      // Long press — new log file
      if (logFile) { logFile.flush(); logFile.close(); }
      openNextLogFile();
      peakMph    = 0.0f;
      runStartMs = millis();
      btn0Held   = false;
      drawChrome();
    }
  } else if (btn0Held) {
    if ((millis() - btn0PressMs) < 2000) {
      // Short press — reset peak + timer only
      peakMph    = 0.0f;
      runStartMs = millis();
    }
    btn0Held = false;
  }

  uint32_t now = millis();

  // ── Display refresh ───────────────────────────────────────────────────────
  if (now - lastDisplayMs >= DISPLAY_MS) {
    lastDisplayMs = now;
    updateDisplay();
  }

  // ── Log + transmit on GPS update ──────────────────────────────────────────
  if (gps.location.isValid() && now - lastLogMs >= LOG_INTERVAL_MS) {
    lastLogMs = now;
    float lat = gps.location.lat();
    float lon = gps.location.lng();
    float spd = gps.speed.mph();
    float hdg = gps.course.isValid() ? gps.course.deg() : 0.0f;
    logRow(now, lat, lon, spd, hdg);
    if (now - lastTxMs >= TX_INTERVAL_MS) {
      lastTxMs = now;
      transmit(lat, lon, spd, hdg);
    }
  }

  // ── Periodic flush ────────────────────────────────────────────────────────
  if (fsReady && now - lastFlushMs >= FLUSH_INTERVAL_MS) {
    lastFlushMs = now;
    logFile.flush();
  }
}
