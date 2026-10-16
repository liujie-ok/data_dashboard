/*
 * speed_accel_log.ino
 * GPS + Accelerometer Data Logger — FFat storage, serial extraction
 * Hardware: LILYGO ESP32 T-Display S3 + NEO-6M GPS + MPU6050
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *  Normal boot:  logs GPS + accel data to /gps_log.csv on FFat
 *  Extraction:   plug into laptop, open serial at 115200,
 *                send 'D' to dump CSV, send 'X' to delete log
 *
 * ── CSV columns ──────────────────────────────────────────────────────────────
 *  millis, lat, lon, speed_mph, heading_deg, accel_x_g, accel_y_g, accel_z_g
 *  accel values are in g (1.0 = 1 standard gravity)
 *
 * ── MPU6050 wiring ───────────────────────────────────────────────────────────
 *  MPU6050 SDA → ESP32 pin defined by I2C_SDA
 *  MPU6050 SCL → ESP32 pin defined by I2C_SCL
 *  MPU6050 VCC → 3.3V
 *  MPU6050 GND → GND
 *  MPU6050 AD0 → GND  (sets I2C address to 0x68)
 *
 * ── Libraries required ───────────────────────────────────────────────────────
 *  TinyGPS++, FFat, Adafruit MPU6050, Adafruit Unified Sensor
 */

#include <TinyGPSPlus.h>
#include <FFat.h>
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>

#define GPS_RX_PIN  44
#define GPS_TX_PIN  43
#define GPS_BAUD    9600

#define I2C_SDA     17
#define I2C_SCL     18

#define PIN_BL   15
#define PIN_PWR  38

#define LOG_FILE        "/gps_log.csv"
#define LOG_INTERVAL_MS  500

HardwareSerial   gpsSerial(1);
TinyGPSPlus      gps;
Adafruit_MPU6050 mpu;

uint32_t lastLogMs = 0;
bool     fsReady   = false;
bool     mpuReady  = false;

// ─────────────────────────────────────────────────────────────────────────────
void dumpLog() {
  if (!FFat.exists(LOG_FILE)) { Serial.println("NO_FILE"); return; }
  File f = FFat.open(LOG_FILE, "r");
  if (!f) { Serial.println("OPEN_ERR"); return; }
  Serial.println("BEGIN_DUMP");
  while (f.available()) Serial.write(f.read());
  f.close();
  Serial.println("END_DUMP");
}

void deleteLog() {
  if (FFat.exists(LOG_FILE)) {
    FFat.remove(LOG_FILE);
    Serial.println("LOG_DELETED");
  } else {
    Serial.println("NO_FILE");
  }
}

void logData() {
  if (!fsReady) return;

  float ax = 0.0f, ay = 0.0f, az = 0.0f;
  if (mpuReady) {
    sensors_event_t accel, gyro, temp;
    mpu.getEvent(&accel, &gyro, &temp);
    ax = accel.acceleration.x / 9.81f;
    ay = accel.acceleration.y / 9.81f;
    az = accel.acceleration.z / 9.81f;
  }

  File f = FFat.open(LOG_FILE, "a");
  if (!f) { Serial.println("LOG_WRITE_ERR"); return; }

  if (gps.location.isValid()) {
    f.printf("%lu,%.6f,%.6f,%.2f,%.1f,%.4f,%.4f,%.4f\n",
             (unsigned long)millis(),
             gps.location.lat(),
             gps.location.lng(),
             gps.speed.mph(),
             gps.course.deg(),
             ax, ay, az);
  } else {
    f.printf("%lu,NO_FIX,NO_FIX,0.00,0.0,%.4f,%.4f,%.4f\n",
             (unsigned long)millis(),
             ax, ay, az);
  }
  f.close();

  Serial.printf("LOGGED: %lu | gps:%s | accel:%.3f,%.3f,%.3f\n",
                (unsigned long)millis(),
                gps.location.isValid() ? "FIX" : "NO_FIX",
                ax, ay, az);
}

// ─────────────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);

  pinMode(PIN_PWR, OUTPUT);
  pinMode(PIN_BL,  OUTPUT);
  digitalWrite(PIN_PWR, LOW);
  digitalWrite(PIN_BL,  LOW);

  Wire.begin(I2C_SDA, I2C_SCL);

  if (!mpu.begin()) {
    Serial.println("MPU6050_FAIL — check wiring");
    mpuReady = false;
  } else {
    Serial.println("MPU6050_OK");
    mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    mpuReady = true;
  }

  if (!FFat.begin(true)) {
    Serial.println("FFAT_FAIL");
    fsReady = false;
  } else {
    Serial.println("FFAT_OK");
    fsReady = true;
  }

  if (fsReady && !FFat.exists(LOG_FILE)) {
    File f = FFat.open(LOG_FILE, "w");
    if (f) {
      f.println("millis,lat,lon,speed_mph,heading_deg,accel_x_g,accel_y_g,accel_z_g");
      f.close();
    }
  }

  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Serial.println("GPS_READY");
  Serial.println("Commands: D = dump log, X = delete log");
}

// ─────────────────────────────────────────────────────────────────────────────
void loop() {
  while (gpsSerial.available()) gps.encode(gpsSerial.read());

  if (Serial.available()) {
    char cmd = Serial.read();
    if      (cmd == 'D' || cmd == 'd') dumpLog();
    else if (cmd == 'X' || cmd == 'x') deleteLog();
  }

  uint32_t nowMs = millis();
  if ((nowMs - lastLogMs) >= LOG_INTERVAL_MS) {
    lastLogMs = nowMs;
    logData();
  }
}
