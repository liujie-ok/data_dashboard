import serial
import threading
import time
from datetime import datetime
from telemetry_buffer import TelemetryBuffer
from csv_logger import CSVLogger
from telemetry_processor import TelemetryProcessor


class SerialReader:
    def __init__(self, port, baud_rate, buffer: TelemetryBuffer, csv_logger: CSVLogger, processor: TelemetryProcessor = None):
        """
        Read GPS telemetry from a NEO-6M via Arduino serial.

        Expected CSV line format (from telemetry_tx.ino):
            millis,lat,lon,speed_mph,heading
        Lines containing "NO_FIX" or starting with "---" are skipped.
        """
        self.port       = port
        self.baud_rate  = baud_rate
        self.buffer     = buffer
        self.csv_logger = csv_logger
        self.processor  = processor
        self.thread     = None
        self.running    = False

    def start(self):
        if self.thread is None:
            self.running = True
            self.thread  = threading.Thread(target=self._read_loop, daemon=True)
            self.thread.start()

    def stop(self, wait=True):
        self.running = False
        if self.thread is not None and wait:
            self.thread.join(timeout=2)
            self.thread = None

    def _read_loop(self):
        try:
            with serial.Serial(self.port, self.baud_rate, timeout=1) as ser:
                print(f"SerialReader: port {self.port} opened at {self.baud_rate} baud")
                while self.running:
                    line = ser.readline().decode('utf-8', errors='ignore').strip()
                    if not line:
                        continue

                    print(f"[RAW] {repr(line)}")  # DEBUG — shows every line received

                    # Skip status/header lines
                    if line.startswith('NO_FIX') or line.startswith('---') or 'lat' in line.lower():
                        print(f"[SKIP] filtered: {repr(line)}")
                        continue

                    parts = line.split(",")
                    if len(parts) not in (4, 5):
                        print(f"[SKIP] expected 4-5 parts, got {len(parts)}: {parts}")
                        continue  # malformed line

                    try:
                        # parts[0] is Arduino millis — we use system time for epoch
                        lat       = float(parts[1])
                        lon       = float(parts[2])
                        speed_mph = float(parts[3])
                        heading   = float(parts[4]) if len(parts) == 5 else 0.0

                        timestamp = time.time()
                        human_ts  = datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
                    except ValueError as e:
                        print(f"[SKIP] parse error {e}: {parts}")
                        continue

                    self.buffer.add(timestamp, human_ts, lat, lon, speed_mph, heading)
                    self.csv_logger.write(timestamp, human_ts, lat, lon, speed_mph, heading)

                    if self.processor:
                        self.processor.process(timestamp, lat, lon, speed_mph, heading)

        except serial.SerialException as e:
            print(f"Serial error on {self.port}: {e}")
