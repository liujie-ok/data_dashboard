import os
from flask import Flask, jsonify, send_from_directory
from telemetry_buffer import TelemetryBuffer
from csv_logger import CSVLogger
from serial_reader import SerialReader
from telemetry_processor import TelemetryProcessor
import logging

log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR)


# ------------------------------
# Configuration from environment
# ------------------------------
USE_DUMMY = os.getenv("USE_DUMMY", "false").lower() == "true"
import sys
_default_port = "COM5" if sys.platform == "win32" else "/dev/ttyUSB0"
SERIAL_PORT = os.getenv("SERIAL_PORT", _default_port)
BAUD_RATE = int(os.getenv("BAUD_RATE", 19200))
CSV_PATH = os.getenv("CSV_PATH", "logs/telemetry.csv")
BUFFER_SIZE = int(os.getenv("BUFFER_SIZE", 200))

WEB_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../web")

# ------------------------------
# Initialize modules
# ------------------------------
buffer = TelemetryBuffer(maxlen=BUFFER_SIZE)
csv_logger = CSVLogger(directory="/app/logs")
processor = TelemetryProcessor()  # NEW: Real-time telemetry processor

if USE_DUMMY:
    from dummy_reader import DummyReader
    reader = DummyReader(buffer, csv_logger, processor)
else:
    from serial_reader import SerialReader
    reader = SerialReader(SERIAL_PORT, BAUD_RATE, buffer, csv_logger, processor)

# ------------------------------
# Flask app
# ------------------------------
app = Flask(__name__, static_folder=WEB_FOLDER, template_folder=WEB_FOLDER)

@app.route('/')
def index():
    return send_from_directory(WEB_FOLDER, 'index.html')

@app.route('/data')
def get_data():
    """
    Return current telemetry buffer as JSON for live plotting.
    """
    return jsonify(buffer.get_all())

# ------------------------------
# NEW: Derived Telemetry Endpoints
# ------------------------------

@app.route('/api/stats')
def get_stats():
    """
    Get derived telemetry statistics (max g-forces, velocity, events, etc.)
    """
    return jsonify(processor.get_stats())

@app.route('/api/position_history')
def get_position_history():
    """
    Get recent GPS position history (list of {lat, lon}) for track visualization.
    """
    return jsonify(processor.get_position_history())

@app.route('/api/current')
def get_current():
    """
    Get current GPS snapshot: lat, lon, speed_mph, heading, accel_g.
    """
    return jsonify(processor.get_current())

@app.route('/api/reset_stats', methods=['POST'])
def reset_stats():
    """
    Reset all derived statistics (for starting a new run)
    """
    processor.reset()
    return {"status": "reset"}

# ------------------------------
# Existing Endpoints
# ------------------------------

@app.route("/api/start", methods=["POST"])
def start_reader():
    print("API: start_reader called")
    reader.start()
    return {"status": "started"}

@app.route("/api/stop", methods=["POST"])
def stop_reader():
    reader.stop()
    return {"status": "stopped"}

@app.route("/api/status")
def reader_status():
    return {
        "running": reader.running,
        "has_fix": processor.get_stats().get("has_fix", False),
    }

@app.route("/api/flush", methods=["POST"])
def flush_csv():
    if csv_logger:
        csv_logger.flush()
        return {"status": "flushed"}
    else:
        return {"status": "no_logger"}, 400
    
@app.route("/api/flush_restart", methods=["POST"])
def flush_restart():
    """
    Stop the reader, flush the CSV log, then restart the reader.
    Returns the new CSV filename and status.
    """
    if not reader:
        return {"status": "no_reader"}, 400

    reader.stop(wait=True)

    if csv_logger:
        csv_logger.flush()
        new_file = csv_logger.filepath
    else:
        new_file = None

    reader.start()

    return {"status": "restarted", "file": new_file}

import glob

@app.route("/api/delete_logs", methods=["POST"])
def delete_logs():
    """
    Delete all CSV files in the logger's directory.
    Stops the reader before deletion to prevent writing to removed files.
    """
    if reader:
        reader.stop(wait=True)

    deleted_files = []
    if csv_logger:
        log_dir = csv_logger.directory
        for filepath in glob.glob(f"{log_dir}/*.csv"):
            try:
                os.remove(filepath)
                deleted_files.append(filepath)
            except Exception as e:
                print(f"Error deleting {filepath}: {e}")

    return {"status": "deleted", "files": deleted_files}

@app.route("/api/start_log", methods=["POST"])
def start_log():
    if csv_logger:
        csv_logger.start_log()
        # Reset stats when starting a new log
        processor.reset()
        return {"status": "ok", "file": csv_logger.filename}
    return {"status": "error", "file": None}

@app.route("/api/stop_log", methods=["POST"])
def stop_log():
    if csv_logger:
        csv_logger.stop_log()
        return {"status": "ok"}
    return {"status": "error"}

@app.route("/latest")
def latest():
    data = buffer.get_all()
    return data[-1:] if data else []

# ------------------------------
# App start / shutdown hooks
# ------------------------------
if __name__ == '__main__':
    try:
        print("Starting telemetry source...")
        reader.start()
        app.run(
            host="0.0.0.0",
            port=5000,
            debug=False,
            use_reloader=False
        )
    finally:
        reader.stop()
        csv_logger.close()