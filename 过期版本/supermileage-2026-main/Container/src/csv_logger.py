from datetime import datetime
import os
import time

class CSVLogger:
    """
    CSV Logger for GPS telemetry data.

    Each row contains:
        timestamp (float): Unix epoch seconds
        human_ts  (str):   Human-readable timestamp (YYYY-MM-DD HH:MM:SS.mmm)
        lat       (float): Latitude  (decimal degrees)
        lon       (float): Longitude (decimal degrees)
        speed_mph (float): GPS speed (mph)
        heading   (float): Course heading (degrees, 0-360)

    Files are named: telemetry-YYYYMMDD-HHMMSS.csv
    """

    def __init__(self, directory=None):
        self.directory = directory
        self.file      = None
        self.filepath  = None
        self.filename  = None

    def start_log(self):
        """Start logging to a new timestamped CSV file."""
        if self.directory is None:
            raise RuntimeError("No logging directory specified.")

        t        = time.localtime()
        human_ts = time.strftime("%Y%m%d-%H%M%S", t)
        self.filename = f"telemetry-{human_ts}.csv"

        os.makedirs(self.directory, exist_ok=True)
        self.filepath = os.path.join(self.directory, self.filename)
        self.file = open(self.filepath, "w")
        self.file.write("timestamp,human_ts,lat,lon,speed_mph,heading\n")

        print(f"CSVLogger: started new log {self.filename}")

    def write(self, timestamp, human_ts, lat, lon, speed_mph, heading):
        """Write a single row to the CSV file if logging is active."""
        if self.file:
            self.file.write(f"{timestamp},{human_ts},{lat},{lon},{speed_mph},{heading}\n")
            self.file.flush()

    def stop_log(self):
        """Stop logging and close the current CSV file."""
        if self.file:
            self.file.close()
            print(f"CSVLogger: stopped log {self.filename}")
            self.file = None

    def flush(self):
        if self.file:
            self.file.flush()

    def close(self):
        self.stop_log()
