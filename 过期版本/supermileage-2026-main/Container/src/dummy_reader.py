import threading
import time
import math
from datetime import datetime


class DummyReader:
    """
    Simulated GPS reader for testing without hardware.

    Simulates a car doing laps around a small oval track near Denver, CO.
    Speed varies realistically with acceleration and braking phases.
    Position is derived from the simulated heading and speed.
    """

    # Track center (Denver area)
    CENTER_LAT = 39.7500
    CENTER_LON = -105.0000

    # Track semi-axes in degrees (~150m × ~200m oval)
    RADIUS_LAT = 0.00135   # ~150 m
    RADIUS_LON = 0.00180   # ~200 m (lon degrees are shorter at this latitude)

    LAP_SECONDS = 30       # One full lap in seconds

    def __init__(self, buffer, csv_logger=None, processor=None, sample_rate_hz=10):
        self.buffer      = buffer
        self.csv_logger  = csv_logger
        self.processor   = processor
        self.sample_period = 1.0 / sample_rate_hz
        self.running     = False
        self.thread      = None
        self.t0          = time.time()

    def start(self):
        if self.running:
            print("DummyReader already running")
            return
        print("DummyReader starting thread")
        self.running = True
        self.thread  = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def stop(self, wait=True):
        self.running = False
        if self.thread and wait:
            self.thread.join(timeout=2)
            self.thread = None

    def _run(self):
        print("DummyReader thread entered _run()")
        counter = 0

        while self.running:
            t         = time.time() - self.t0
            timestamp = time.time()
            human_ts  = datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]

            # --- Position: parametric oval ---
            angle = 2 * math.pi * t / self.LAP_SECONDS
            lat   = self.CENTER_LAT + self.RADIUS_LAT * math.sin(angle)
            lon   = self.CENTER_LON + self.RADIUS_LON * math.cos(angle)

            # Heading: tangent direction (derivative of position vector, normalised)
            dlat = self.RADIUS_LAT * math.cos(angle)
            dlon = -self.RADIUS_LON * math.sin(angle)
            heading = (math.degrees(math.atan2(dlon, dlat))) % 360

            # --- Speed: sinusoidal base with hard-braking phases ---
            # Base: 20–55 mph, one cycle per lap
            speed_mph = 37.5 + 17.5 * math.sin(2 * angle)

            # Hard braking for 3 s every 30 s (at the "bottom" of the oval)
            phase_in_lap = t % self.LAP_SECONDS
            if phase_in_lap < 3.0:
                speed_mph = max(5.0, speed_mph - 30.0)

            speed_mph = max(0.0, speed_mph)

            # --- Feed pipeline ---
            self.buffer.add(timestamp, human_ts, lat, lon, speed_mph, heading)

            if self.csv_logger:
                self.csv_logger.write(timestamp, human_ts, lat, lon, speed_mph, heading)

            if self.processor:
                self.processor.process(timestamp, lat, lon, speed_mph, heading)

            counter += 1
            if counter % 100 == 0:
                print(f"DummyReader: generated {counter} samples")

            time.sleep(self.sample_period)
