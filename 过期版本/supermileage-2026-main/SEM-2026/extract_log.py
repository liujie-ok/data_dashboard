# extract_log.py
# Usage: python extract_log.py --port COM3 (or /dev/ttyUSB0 on Linux/Mac)

import serial
import argparse
import time
import os

def extract(port, baud=115200, output="gps_log.csv"):
    print(f"Connecting to {port}...")
    with serial.Serial(port, baud, timeout=5) as ser:
        time.sleep(2)  # wait for ESP32 to settle

        print("Requesting dump...")
        ser.write(b'D')

        lines = []
        capturing = False

        while True:
            line = ser.readline().decode("utf-8", errors="replace").strip()
            if not line:
                continue
            if line == "NO_FILE":
                print("No log file found on device.")
                return
            if line == "BEGIN_DUMP":
                capturing = True
                print("Receiving data...")
                continue
            if line == "END_DUMP":
                break
            if capturing:
                lines.append(line)

    if not lines:
        print("No data received.")
        return

    with open(output, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print(f"Saved {len(lines) - 1} records to {output}")  # -1 for header

def delete(port, baud=115200):
    with serial.Serial(port, baud, timeout=5) as ser:
        time.sleep(2)
        ser.write(b'X')
        time.sleep(1)
        response = ser.readline().decode("utf-8", errors="replace").strip()
        print(response)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract GPS log from ESP32 LittleFS")
    parser.add_argument("--port",   required=True, help="Serial port (e.g. COM3 or /dev/ttyUSB0)")
    parser.add_argument("--baud",   default=115200, type=int)
    parser.add_argument("--output", default="gps_log.csv", help="Output CSV filename")
    parser.add_argument("--delete", action="store_true", help="Delete log from device after extracting")
    args = parser.parse_args()

    extract(args.port, args.baud, args.output)

    if args.delete:
        print("Deleting log from device...")
        delete(args.port, args.baud)