from collections import deque
import threading

class TelemetryBuffer:
    def __init__(self, maxlen=200):
        """
        In-memory circular buffer for GPS telemetry samples.
        :param maxlen: Maximum number of recent samples to keep
        """
        self.buffer = deque(maxlen=maxlen)
        self.lock = threading.Lock()

    def add(self, timestamp, human_ts, lat, lon, speed_mph, heading):
        """Add a new GPS telemetry sample."""
        with self.lock:
            self.buffer.append({
                "timestamp": timestamp,
                "human_ts":  human_ts,
                "lat":       lat,
                "lon":       lon,
                "speed_mph": speed_mph,
                "heading":   heading,
            })

    def get_all(self):
        """Return a copy of all samples in the buffer."""
        with self.lock:
            return list(self.buffer)

    def clear(self):
        with self.lock:
            self.buffer.clear()
