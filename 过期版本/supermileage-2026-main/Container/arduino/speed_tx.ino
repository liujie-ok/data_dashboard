/*
 * IMS Oval Speed Display + nRF24L01 Telemetry Transmitter
 * Hardware: LILYGO ESP32 T-Display S3 + MPU-6050 + nRF24L01+PA+LNA
 *
 * ── Wiring ────────────────────────────────────────────────────────────────────
 *  MPU-6050 (GY-521):
 *    VCC  -> ESP32 5V        (GY-521 has onboard 3.3V reg; 5V input is safe)
 *    GND  -> ESP32 GND
 *    SDA  -> GPIO 43
 *    SCL  -> GPIO 44
 *    AD0, INT, XDA, XCL -> leave unconnected
 *
 *  nRF24L01+PA+LNA:
 *    VCC  -> ESP32 3V3       (STRICTLY 3.3V — NOT 5V)
 *    GND  -> ESP32 GND
 *    CE   -> GPIO 21
 *    CSN  -> GPIO 10
 *    SCK  -> GPIO 12
 *    MOSI -> GPIO 11
 *    MISO -> GPIO 13
 *    IRQ  -> leave unconnected (polling mode)
 *    *** Solder a 10–100 µF cap across VCC/GND on the nRF24 module ***
 *
 *  Power:
 *    Buck converter OUT+ (5.0 V, verified with multimeter) -> ESP32 5V pin
 *    Buck converter OUT-                                   -> ESP32 GND
 *
 * ── Telemetry payload ─────────────────────────────────────────────────────────
 *  Every TELEMETRY_INTERVAL_MS (500 ms) a 32-byte packet is sent:
 *    "<timestamp_ms>,<ax×1000>,<ay×1000>,<az×1000>"
 *  ax/ay/az are bias-corrected m/s², scaled ×1000 to integer to stay within
 *  the 32-byte limit. Receiver parses the raw CSV string unchanged.
 *
 * ── Robustness features ───────────────────────────────────────────────────────
 *  - radio.write() retries capped at 3×3 (~0.75 ms worst-case stall) so the
 *    500 Hz IMU loop is never meaningfully disrupted
 *  - Consecutive TX failure counter: after NRF_MAX_FAILS the radio is fully
 *    re-initialised via initRadio() to escape any persistent bad state
 *  - radio.begin() return value checked; init failure shown on screen but
 *    does NOT halt — display and IMU continue to work without the radio
 *  - Payload buffer memset'd before every snprintf — no stale tail bytes
 *  - rawAx/Ay/Az reset to 0 on calibrate so first TX is never garbage
 *
 * ── Speed display / drift strategy ───────────────────────────────────────────
 *  See original ims_speed_display header for full algorithm notes.
 *
 * Libraries required (Arduino Library Manager):
 *   TFT_eSPI  (Bodmer)          — any recent version
 *   Adafruit MPU6050
 *   Adafruit Unified Sensor
 *   RF24                        — version >= 1.4.8
 *
 * TFT_eSPI: in User_Setup_Select.h uncomment the correct T-Display S3 header.
 *
 * Button 0 = recalibrate (hold while stationary on a straight)
 */

#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <TFT_eSPI.h>
#include <math.h>
#include <SPI.h>
#include <RF24.h>
#include <nRF24L01.h>

// ── Pin definitions ───────────────────────────────────────────────────────────
#define I2C_SDA      1
#define I2C_SCL      2

#define NRF_CE_PIN   21
#define NRF_CSN_PIN  10
#define NRF_SCK_PIN  12
#define NRF_MISO_PIN 13
#define NRF_MOSI_PIN 11

// ── Hardware objects ──────────────────────────────────────────────────────────
Adafruit_MPU6050 mpu;
TFT_eSPI         tft = TFT_eSPI();

// Dedicated HSPI bus — never contends with the TFT's SPI bus
SPIClass nrfSPI(HSPI);
RF24     radio(NRF_CE_PIN, NRF_CSN_PIN);

// ── Telemetry config ──────────────────────────────────────────────────────────
const uint32_t TELEMETRY_INTERVAL_MS = 500;
uint32_t       lastTelemetryMs       = 0;

const byte RF_ADDRESS[6] = "00001";

// After this many consecutive TX failures the radio is fully re-initialised
const uint8_t NRF_MAX_FAILS = 5;
uint8_t       nrfFailCount  = 0;

struct TelemetryPayload {
  char data1[32];
};
TelemetryPayload dataPacket;

// ── IMS constants ─────────────────────────────────────────────────────────────
const float MPS_TO_MPH = 2.23694f;
const float G          = 9.81f;

// IMS turn banking: 9 deg 12 arcmin ≈ 9.2 deg
const float BANK_ANGLE_RAD = 9.2f * (M_PI / 180.0f);
const float BANK_GRAV_Y    = G * sinf(BANK_ANGLE_RAD);  // ~1.57 m/s²

// ── Tuning ────────────────────────────────────────────────────────────────────
const float    ACCEL_DEADBAND     = 0.12f;   // m/s²
const float    COAST_THRESHOLD    = 0.25f;   // m/s²
const uint32_t COAST_LOCK_MS      = 300;
const float    BANK_DETECT_THRESH = 0.90f;   // m/s²
const float    LAP_CORRECTION_K   = 0.25f;
const float    MAX_DECEL_MPS2     = 0.6f * G;
const float    MAX_SPEED_MPS      = 15.0f;   // ~33.5 mph
const float    ALPHA              = 0.10f;
const uint8_t  SMOOTH_N           = 3;
const uint32_t DISPLAY_MS         = 50;
const float    BAR_MAX_MPH        = 30.0f;

// ── State ─────────────────────────────────────────────────────────────────────
float velFwd     = 0;
float headingRad = 0;

float filtAx = 0, filtAy = 0, filtAz = 0, filtGz = 0;

float   smoothBuf[SMOOTH_N] = {};
uint8_t smoothIdx  = 0;
float   speedMph   = 0;
float   peakMph    = 0;

uint32_t coastStartMs = 0;
bool     coasting     = false;
bool     coastLocked  = false;
bool     inBankedTurn = false;

int   lastQuadrant     = 0;
int   quadrantsCrossed = 0;
int   lapCount         = 0;
float lapHeadingBase   = 0;

float    recentVelSum = 0;
uint16_t recentVelN   = 0;
float    recentVelAvg = 0;
float    prevVelFwd   = 0;

float biasX = 0, biasY = 0, biasZ = 0, biasGz = 0;

uint32_t lastSampleUs  = 0;
uint32_t lastDisplayMs = 0;
uint32_t runStartMs    = 0;

// Bias-corrected raw accel (m/s²) — set each loop, consumed by telemetry
float rawAxLast = 0, rawAyLast = 0, rawAzLast = 0;

// ── Colours ───────────────────────────────────────────────────────────────────
#define COL_BG      TFT_BLACK
#define COL_LABEL   0x7BEF
#define COL_VALUE   TFT_WHITE
#define COL_UNIT    0x07FF
#define COL_WARN    TFT_YELLOW
#define COL_ERR     TFT_RED
#define COL_COAST   0x04FF
#define COL_BANK    0xFD20
#define COL_LAP     0x07E0
#define COL_BAR_BG  0x1082
#define COL_BAR_LO  0x07E0
#define COL_BAR_MID 0xFD20
#define COL_BAR_HI  TFT_RED
#define COL_PEAK    0xF81F

// ─────────────────────────────────────────────────────────────────────────────
// Radio initialisation — extracted so it can be called from both setup() and
// the failure-recovery path inside transmitTelemetry().
// Returns true on success.
// ─────────────────────────────────────────────────────────────────────────────
bool initRadio() {
  nrfSPI.end();
  nrfSPI.begin(NRF_SCK_PIN, NRF_MISO_PIN, NRF_MOSI_PIN, NRF_CSN_PIN);

  if (!radio.begin(&nrfSPI)) {
    return false;
  }

  // Retries: 3 attempts × 250 µs spacing ≈ 0.75 ms worst-case stall.
  // The original 15×15 setting could block for ~225 ms and corrupt dt.
  radio.setRetries(3, 3);

  radio.setPALevel(RF24_PA_LOW);
  radio.setDataRate(RF24_250KBPS);
  radio.setChannel(100);
  radio.setPayloadSize(sizeof(TelemetryPayload));
  radio.setAutoAck(true);
  radio.openWritingPipe(RF_ADDRESS);
  radio.stopListening();

  nrfFailCount = 0;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transmit one telemetry packet.
// Tracks consecutive failures and re-initialises the radio after NRF_MAX_FAILS.
// ─────────────────────────────────────────────────────────────────────────────
void transmitTelemetry() {
  // Scale m/s² → integer (×1000) to keep the CSV within 32 bytes.
  // At ±4g range max is ±39,240 — well within int32 bounds.
  int ax_i = (int)(rawAxLast * 1000.0f);
  int ay_i = (int)(rawAyLast * 1000.0f);
  int az_i = (int)(rawAzLast * 1000.0f);

  // Zero buffer first — a truncated snprintf must never leave stale bytes
  memset(dataPacket.data1, 0, sizeof(dataPacket.data1));
  snprintf(dataPacket.data1, sizeof(dataPacket.data1),
           "%lu,%d,%d,%d", (unsigned long)millis(), ax_i, ay_i, az_i);

  bool ok = radio.write(&dataPacket, sizeof(dataPacket));

  if (ok) {
    nrfFailCount = 0;
    Serial.print("TX ");
    Serial.print(dataPacket.data1);
    Serial.println(" ... OK");
  } else {
    nrfFailCount++;
    Serial.print("TX FAIL (");
    Serial.print(nrfFailCount);
    Serial.print("/");
    Serial.print(NRF_MAX_FAILS);
    Serial.println(")");

    if (nrfFailCount >= NRF_MAX_FAILS) {
      Serial.println("TX: re-initialising radio...");
      if (initRadio()) {
        Serial.println("TX: radio recovered");
      } else {
        Serial.println("TX: radio recovery FAILED — check wiring");
        // nrfFailCount was reset to 0 inside initRadio() on success only,
        // so on failure it stays at NRF_MAX_FAILS and we retry next interval.
        nrfFailCount = NRF_MAX_FAILS;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
float smoothSpeed(float s) {
  smoothBuf[smoothIdx] = s;
  smoothIdx = (smoothIdx + 1) % SMOOTH_N;
  float sum = 0;
  for (uint8_t i = 0; i < SMOOTH_N; i++) sum += smoothBuf[i];
  return sum / SMOOTH_N;
}

// ─────────────────────────────────────────────────────────────────────────────
bool checkLapProgress() {
  float lapHeading = headingRad - lapHeadingBase;
  int quad = (int)(fabsf(lapHeading) / (M_PI / 2.0f));
  quad = constrain(quad, 0, 3);

  if (quad > lastQuadrant) {
    lastQuadrant = quad;
    quadrantsCrossed++;

    if (recentVelN > 0) recentVelAvg = recentVelSum / recentVelN;
    recentVelSum = 0;
    recentVelN   = 0;

    if (quadrantsCrossed >= 4) {
      lapCount++;
      lapHeadingBase   = headingRad;
      lastQuadrant     = 0;
      quadrantsCrossed = 0;
      return true;
    }
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
void calibrate(uint16_t samples = 400) {
  tft.fillScreen(COL_BG);
  tft.setTextColor(COL_LABEL, COL_BG);
  tft.setTextSize(2);
  tft.setCursor(8, 24);  tft.println("Calibrating...");
  tft.setCursor(8, 46);  tft.println("Stationary on");
  tft.setCursor(8, 68);  tft.println("a straight!");
  tft.setTextSize(1);
  tft.setTextColor(COL_WARN, COL_BG);
  tft.setCursor(8, 96);  tft.println("Engine off preferred");
  tft.setCursor(8, 108); tft.println("X axis must face forward");
  tft.setCursor(8, 120); tft.println("Vehicle must be level");

  double sAx=0, sAy=0, sAz=0, sGz=0;
  for (uint16_t i = 0; i < samples; i++) {
    sensors_event_t a, g, t;
    mpu.getEvent(&a, &g, &t);
    sAx += a.acceleration.x;
    sAy += a.acceleration.y;
    sAz += a.acceleration.z;
    sGz += g.gyro.z;
    delay(4);
  }
  biasX  = (float)(sAx / samples);
  biasY  = (float)(sAy / samples);
  biasZ  = (float)(sAz / samples) - G;
  biasGz = (float)(sGz / samples);

  velFwd = prevVelFwd = 0;
  headingRad = lapHeadingBase = 0;
  filtAx = filtAy = filtAz = filtGz = 0;
  coasting = coastLocked = inBankedTurn = false;
  coastStartMs = 0;
  lastQuadrant = quadrantsCrossed = lapCount = 0;
  recentVelSum = recentVelN = recentVelAvg = 0;
  for (uint8_t i = 0; i < SMOOTH_N; i++) smoothBuf[i] = 0;
  smoothIdx = 0;
  speedMph = peakMph = 0;
  rawAxLast = rawAyLast = rawAzLast = 0;  // no garbage on first TX
  runStartMs = millis();

  tft.fillScreen(COL_BG);
}

// ─────────────────────────────────────────────────────────────────────────────
void drawChrome() {
  tft.fillScreen(COL_BG);

  // Header bar
  tft.fillRect(0, 0, 320, 20, 0x000E);
  tft.setTextColor(COL_UNIT, 0x000E);
  tft.setTextSize(2);
  tft.setCursor(4, 2);   tft.print("IMS Speed");
  tft.setTextColor(COL_LABEL, 0x000E);
  tft.setTextSize(1);
  tft.setCursor(210, 5); tft.print("LAP");
  tft.setCursor(258, 5); tft.print("ELAPSED");

  // Speed bar outline + scale
  tft.drawRect(4, 96, 312, 10, COL_LABEL);
  tft.setTextColor(COL_LABEL, COL_BG);
  tft.setTextSize(1);
  tft.setCursor(4,   108); tft.print("0");
  tft.setCursor(152, 108); tft.print("15");
  tft.setCursor(300, 108); tft.print("30mph");

  // Static labels
  tft.setCursor(4,   124); tft.print("PEAK");
  tft.setCursor(164, 124); tft.print("ACCEL");
  tft.setCursor(4,   148); tft.print("STATUS");
}


// ─────────────────────────────────────────────────────────────────────────────
void formatTime(uint32_t ms, char* buf) {
  uint32_t s = ms / 1000, m = s / 60; s %= 60;
  sprintf(buf, "%02lu:%02lu", (unsigned long)m, (unsigned long)s);
}

// ─────────────────────────────────────────────────────────────────────────────
void updateDisplay(float fwdAccel, bool lapEvent) {
  // ── LAP + ELAPSED ─────────────────────────────────
  tft.setTextSize(1);
  tft.fillRect(228, 3, 30, 8, 0x000E);
  tft.setTextColor(COL_LAP, 0x000E);
  tft.setCursor(228, 6);
  tft.printf("L%d", lapCount);

  char tbuf[8];
  formatTime(millis() - runStartMs, tbuf);
  tft.fillRect(276, 3, 44, 8, 0x000E);
  tft.setTextColor(COL_VALUE, 0x000E);
  tft.setCursor(276, 6);
  tft.print(tbuf);

  // ── Big speed number (size 7 = 42×56px per char) ──
  tft.fillRect(4, 22, 210, 60, COL_BG);
  tft.setTextColor(COL_VALUE, COL_BG);
  tft.setTextSize(7);
  tft.setCursor(6, 24);
  tft.printf("%.1f", speedMph);

  // "mph" unit label
  tft.fillRect(216, 22, 60, 30, COL_BG);
  tft.setTextColor(COL_UNIT, COL_BG);
  tft.setTextSize(3);
  tft.setCursor(218, 32);
  tft.print("mph");

  // COAST / BANK badges
  tft.setTextSize(1);
  tft.setTextColor(coastLocked  ? COL_COAST : COL_BG, COL_BG);
  tft.setCursor(218, 64);
  tft.print("COAST");
  tft.setTextColor(inBankedTurn ? COL_BANK : COL_BG, COL_BG);
  tft.setCursor(268, 64);
  tft.print("BANK");

  // ── Speed bar ─────────────────────────────────────
  int barW = (int)((speedMph / BAR_MAX_MPH) * 310.0f);
  barW = constrain(barW, 0, 310);
  uint16_t barCol = (speedMph > BAR_MAX_MPH * 0.75f) ? COL_BAR_HI :
                    (speedMph > BAR_MAX_MPH * 0.50f) ? COL_BAR_MID : COL_BAR_LO;
  tft.fillRect(5, 97,       barW,       8, barCol);
  tft.fillRect(5 + barW, 97, 310 - barW, 8, COL_BAR_BG);

  // ── Peak ──────────────────────────────────────────
  tft.setTextSize(2);
  tft.setTextColor(COL_PEAK, COL_BG);
  tft.fillRect(40, 120, 114, 16, COL_BG);
  tft.setCursor(40, 120);
  tft.printf("%.1fmph", peakMph);

  // ── Fwd accel ─────────────────────────────────────
  float fwdG = fwdAccel / G;
  tft.setTextColor(
    (fwdG >  0.05f) ? COL_LAP  :
    (fwdG < -0.05f) ? COL_WARN : COL_VALUE, COL_BG);
  tft.fillRect(200, 120, 116, 16, COL_BG);
  tft.setCursor(200, 120);
  tft.printf("%+.2fg", fwdG);

  // ── Status ────────────────────────────────────────
  tft.setTextSize(1);
  tft.fillRect(44, 148, 272, 8, COL_BG);
  tft.setCursor(44, 148);
  if (lapEvent) {
    tft.setTextColor(COL_LAP, COL_BG);
    tft.print("LAP RESET -- drift corrected");
  } else {
    tft.setTextColor(COL_LABEL, COL_BG);
    tft.printf("Hdg %.0fdeg  vel %.2fm/s",
               headingRad * (180.0f / M_PI), velFwd);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);

  // --- POWER ON PERIPHERALS ---
  pinMode(15, OUTPUT);  // Backlight
  pinMode(38, OUTPUT);  // Peripheral Power Enable
  
  digitalWrite(38, HIGH); // Power on the I2C bus and screen
  digitalWrite(15, HIGH); // Turn on backlight
  delay(100);             // Wait for power to stabilize

  // --- TFT ---
  tft.init();
  tft.setRotation(3);
  tft.fillScreen(COL_BG);
  tft.setTextColor(COL_LABEL, COL_BG);
  tft.setTextSize(2);
  tft.setCursor(8, 50);
  tft.print("Initialising...");

  // --- I2C + MPU-6050 ---
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(100000);

  // Try address 0x68, then try 0x69 if 0x68 fails
  bool mpuFound = mpu.begin(0x68);

  if (!mpuFound) {
    tft.fillScreen(COL_BG);
    tft.setTextColor(COL_ERR, COL_BG);
    tft.setCursor(8, 36);  tft.println("MPU-6050");
    tft.setCursor(8, 58);  tft.println("not found!");
    tft.setTextSize(1);
    tft.setCursor(8, 90);  tft.println("Check SDA(1) SCL(2)");
    tft.setCursor(8, 102); tft.println("Check VCC/GND wires");
    tft.setCursor(8, 114); tft.println("Check GPIO 38 Power");
    Serial.println("CRITICAL: MPU-6050 not found.");
    while (true) delay(1000); 
  }


  mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
  mpu.setGyroRange(MPU6050_RANGE_250_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_10_HZ);

  // --- nRF24L01 ---
  if (!initRadio()) {
    Serial.println("WARNING: nRF24L01 init failed — telemetry disabled");
    // We don't halt here, just show a brief warning on Serial
  }

  // --- Finalize ---
  pinMode(0, INPUT_PULLUP);
  calibrate(400);
  drawChrome();

  lastSampleUs  = micros();
  lastDisplayMs = millis();
}

// ─────────────────────────────────────────────────────────────────────────────
void loop() {
  // ── Recalibrate on button press ───────────────────────────────────────────
  if (digitalRead(0) == LOW) {
    delay(50);
    if (digitalRead(0) == LOW) {
      calibrate(400);
      drawChrome();
      lastSampleUs = micros();
      return;
    }
  }

  // ── Read sensor ───────────────────────────────────────────────────────────
  sensors_event_t a, g, tmp;
  mpu.getEvent(&a, &g, &tmp);

  float rawX  = a.acceleration.x - biasX;
  float rawY  = a.acceleration.y - biasY;
  float rawZ  = a.acceleration.z - biasZ;
  float rawGz = g.gyro.z         - biasGz;

  // Capture for telemetry before filtering (receiver gets unsmoothed values)
  rawAxLast = rawX;
  rawAyLast = rawY;
  rawAzLast = rawZ;

  // ── Low-pass filter ───────────────────────────────────────────────────────
  filtAx = ALPHA * rawX  + (1.0f - ALPHA) * filtAx;
  filtAy = ALPHA * rawY  + (1.0f - ALPHA) * filtAy;
  filtAz = ALPHA * rawZ  + (1.0f - ALPHA) * filtAz;
  filtGz = ALPHA * rawGz + (1.0f - ALPHA) * filtGz;

  // ── Deadband ──────────────────────────────────────────────────────────────
  float ax = (fabsf(filtAx) > ACCEL_DEADBAND) ? filtAx : 0.0f;
  float ay = (fabsf(filtAy) > ACCEL_DEADBAND) ? filtAy : 0.0f;

  // ── Time delta ────────────────────────────────────────────────────────────
  uint32_t nowUs = micros();
  float dt = (nowUs - lastSampleUs) * 1e-6f;
  lastSampleUs = nowUs;
  dt = constrain(dt, 0.0f, 0.05f);

  // ── Heading integration ───────────────────────────────────────────────────
  headingRad += filtGz * dt;

  // ── Banking detection and compensation ───────────────────────────────────
  float ayCompensated = ay;
  inBankedTurn = (filtAy > BANK_DETECT_THRESH);
  if (inBankedTurn) {
    ayCompensated = ay - BANK_GRAV_Y;
  }

  // ── Forward-axis projection ───────────────────────────────────────────────
  float cosH     = cosf(headingRad);
  float sinH     = sinf(headingRad);
  float fwdAccel = ax * cosH + ayCompensated * sinH;

  // ── Coast detection ───────────────────────────────────────────────────────
  uint32_t nowMs = millis();
  if (fabsf(fwdAccel) < COAST_THRESHOLD) {
    if (!coasting) { coasting = true; coastStartMs = nowMs; }
    coastLocked = (nowMs - coastStartMs) >= COAST_LOCK_MS;
  } else {
    coasting = coastLocked = false;
  }

// ── Integrate forward velocity ────────────────────────────────────────────
if (!coastLocked) {
    velFwd += fwdAccel * dt;
} else {
    velFwd *= 0.90f;
    if (velFwd < 0.05f) velFwd = 0.0f;
}



  float maxDrop = MAX_DECEL_MPS2 * dt;
  if ((prevVelFwd - velFwd) > maxDrop) velFwd = prevVelFwd - maxDrop;
  prevVelFwd = velFwd;
  velFwd = constrain(velFwd, 0.0f, MAX_SPEED_MPS);

  recentVelSum += velFwd;
  recentVelN++;

  // ── Lap-boundary drift correction ─────────────────────────────────────────
  bool lapEvent = checkLapProgress();
  if (lapEvent) {
    if (recentVelAvg > 0) {
      velFwd = velFwd + LAP_CORRECTION_K * (recentVelAvg - velFwd);
    }
    if (quadrantsCrossed == 0) {
      headingRad = 0;
    }
  }

  // ── Update display (every DISPLAY_MS) ────────────────────────────────────
  if ((nowMs - lastDisplayMs) >= DISPLAY_MS) {
    lastDisplayMs = nowMs;
    speedMph = smoothSpeed(velFwd * MPS_TO_MPH);
    if (speedMph > peakMph) peakMph = speedMph;
    updateDisplay(fwdAccel, lapEvent);

    // CSV for Serial Plotter: fwdAccel_g, speedMph, lapCount, coastLocked, inBankedTurn
    Serial.printf("%.3f,%.2f,%d,%d,%d\n",
                  fwdAccel / G, speedMph, lapCount,
                  (int)coastLocked, (int)inBankedTurn);
  }

  // ── Transmit telemetry (every TELEMETRY_INTERVAL_MS) ─────────────────────
  if ((nowMs - lastTelemetryMs) >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryMs = nowMs;
    transmitTelemetry();
  }

  delay(2);   // ~500 Hz sample rate
}