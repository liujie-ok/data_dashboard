import threading
import math
from collections import deque


def _haversine_miles(lat1, lon1, lat2, lon2):
    """Return distance in miles between two GPS coordinates."""
    R = 3958.8  # Earth radius in miles
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


class TelemetryProcessor:
    """
    Real-time processor for GPS telemetry data.

    Receives lat/lon/speed/heading from a NEO-6M GPS module and computes:
    - Smoothed speed
    - Derived acceleration (Δv/Δt, in g)
    - Session max speed, max accel, max decel
    - Cumulative distance (haversine)
    - Braking event detection
    - Position history for track visualization
    """

    def __init__(self):
        self.lock = threading.Lock()

        # Current smoothed values
        self.current_speed_mph = 0.0
        self.current_accel_g   = 0.0
        self.current_heading   = 0.0
        self.current_lat       = None
        self.current_lon       = None
        self.has_fix           = False

        # Session statistics
        self.max_speed_mph = 0.0
        self.max_accel_g   = 0.0   # max forward acceleration (g)
        self.max_decel_g   = 0.0   # max braking deceleration (positive g)
        self.distance_miles = 0.0

        # State for derivatives
        self.last_timestamp    = None
        self.last_speed_smooth = 0.0
        self.last_lat          = None
        self.last_lon          = None

        # Speed smoothing (5-sample moving average reduces GPS noise)
        self.recent_speeds = deque(maxlen=5)

        # Position history for track map (last 500 points)
        self.position_history = deque(maxlen=500)

        # Braking event detection
        self.in_braking             = False
        self.braking_peak_g         = 0.0
        self.total_braking_events   = 0
        self.braking_threshold_g    = -0.15   # decel g to enter braking state
        self.braking_exit_threshold = -0.05   # decel g to exit braking state

    # ------------------------------------------------------------------
    def reset(self):
        """Reset all session statistics (e.g. for a new run)."""
        with self.lock:
            self.current_speed_mph  = 0.0
            self.current_accel_g    = 0.0
            self.current_heading    = 0.0
            self.current_lat        = None
            self.current_lon        = None
            self.has_fix            = False

            self.max_speed_mph      = 0.0
            self.max_accel_g        = 0.0
            self.max_decel_g        = 0.0
            self.distance_miles     = 0.0

            self.last_timestamp     = None
            self.last_speed_smooth  = 0.0
            self.last_lat           = None
            self.last_lon           = None

            self.recent_speeds.clear()
            self.position_history.clear()

            self.in_braking           = False
            self.braking_peak_g       = 0.0
            self.total_braking_events = 0

    # ------------------------------------------------------------------
    def process(self, timestamp, lat, lon, speed_mph, heading):
        """
        Process a new GPS sample.

        :param timestamp:  Unix timestamp (seconds, from system clock)
        :param lat:        Latitude  (decimal degrees)
        :param lon:        Longitude (decimal degrees)
        :param speed_mph:  Speed from GPS (mph)
        :param heading:    Course/heading (degrees, 0-360)
        """
        with self.lock:
            # --- Smooth speed ---
            self.recent_speeds.append(speed_mph)
            speed_smooth = sum(self.recent_speeds) / len(self.recent_speeds)

            # --- Derive acceleration (g) from Δv/Δt ---
            accel_g = 0.0
            if self.last_timestamp is not None:
                dt = timestamp - self.last_timestamp
                if 0 < dt < 2.0:
                    # Convert mph → m/s (×0.44704), then normalise by g (9.81 m/s²)
                    delta_v_ms = (speed_smooth - self.last_speed_smooth) * 0.44704
                    accel_g = (delta_v_ms / dt) / 9.81

            # --- Update current values ---
            self.current_speed_mph  = speed_smooth
            self.current_accel_g    = accel_g
            self.current_heading    = heading
            self.current_lat        = lat
            self.current_lon        = lon
            self.has_fix            = True

            # --- Session maxima ---
            if speed_smooth > self.max_speed_mph:
                self.max_speed_mph = speed_smooth
            if accel_g > self.max_accel_g:
                self.max_accel_g = accel_g
            if accel_g < -self.max_decel_g:
                self.max_decel_g = -accel_g

            # --- Cumulative distance (haversine) ---
            if self.last_lat is not None and self.last_lon is not None:
                d = _haversine_miles(self.last_lat, self.last_lon, lat, lon)
                if d < 0.1:   # sanity-check: ignore jumps > 0.1 mi between samples
                    self.distance_miles += d

            # --- Position history ---
            self.position_history.append({"lat": lat, "lon": lon})

            # --- Braking event detection ---
            if not self.in_braking and accel_g < self.braking_threshold_g:
                self.in_braking     = True
                self.braking_peak_g = accel_g
            if self.in_braking:
                if accel_g < self.braking_peak_g:
                    self.braking_peak_g = accel_g
                if accel_g > self.braking_exit_threshold:
                    self.in_braking = False
                    self.total_braking_events += 1

            # --- Advance state ---
            self.last_timestamp    = timestamp
            self.last_speed_smooth = speed_smooth
            self.last_lat          = lat
            self.last_lon          = lon

    # ------------------------------------------------------------------
    def get_stats(self):
        """Return all derived session statistics as a dict."""
        with self.lock:
            return {
                # Live values
                "speed_mph":           round(self.current_speed_mph, 1),
                "speed_kph":           round(self.current_speed_mph * 1.60934, 1),
                "accel_g":             round(self.current_accel_g, 3),
                "heading":             round(self.current_heading, 1),
                "has_fix":             self.has_fix,

                # Session bests
                "max_speed_mph":       round(self.max_speed_mph, 1),
                "max_speed_kph":       round(self.max_speed_mph * 1.60934, 1),
                "max_accel_g":         round(self.max_accel_g, 3),
                "max_decel_g":         round(self.max_decel_g, 3),

                # Distance
                "distance_miles":      round(self.distance_miles, 3),
                "distance_km":         round(self.distance_miles * 1.60934, 3),

                # Braking events
                "in_braking":          self.in_braking,
                "braking_peak_g":      round(abs(self.braking_peak_g), 3) if self.in_braking else None,
                "total_braking_events": self.total_braking_events,
            }

    def get_current(self):
        """Return current smoothed GPS snapshot."""
        with self.lock:
            return {
                "lat":       self.current_lat,
                "lon":       self.current_lon,
                "speed_mph": round(self.current_speed_mph, 1),
                "heading":   round(self.current_heading, 1),
                "accel_g":   round(self.current_accel_g, 3),
            }

    def get_position_history(self):
        """Return list of recent {lat, lon} points for track visualization."""
        with self.lock:
            return list(self.position_history)
