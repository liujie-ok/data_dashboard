"""
Download GPS log files from the ESP32 LittleFS over USB serial.

Usage:
  python download_log.py COM5           # download most recent run
  python download_log.py COM5 --list    # list all files on device
  python download_log.py COM5 --all     # download every file
  python download_log.py COM5 run_0002.csv   # download a specific file
  python download_log.py COM5 --delete  # delete all logs on device
"""

import serial
import sys
import os
import time

PORT    = sys.argv[1] if len(sys.argv) > 1 else "COM5"
BAUD    = 115200
TIMEOUT = 5   # seconds to wait for response

def open_port():
    return serial.Serial(PORT, BAUD, timeout=TIMEOUT)

def send_cmd(ser, cmd):
    ser.reset_input_buffer()
    ser.write((cmd + "\n").encode())
    time.sleep(0.1)

def read_until_end(ser):
    """Read lines until we see END or timeout."""
    lines = []
    while True:
        line = ser.readline().decode("utf-8", errors="ignore").strip()
        if not line:
            break
        if line == "END":
            break
        lines.append(line)
    return lines

def list_files(ser):
    send_cmd(ser, "LIST")
    lines = []
    for _ in range(50):
        line = ser.readline().decode("utf-8", errors="ignore").strip()
        if not line:
            break
        lines.append(line)
    if lines:
        print("\nFiles on device:")
        for l in lines:
            print(" ", l)
    else:
        print("No files found (or device not ready)")
    return lines

def dump_file(ser, filename=None):
    cmd = "DUMP" if filename is None else f"DUMP {filename}"
    send_cmd(ser, cmd)

    # First line should be "BEGIN /run_XXXX.csv"
    header = ser.readline().decode("utf-8", errors="ignore").strip()
    if not header.startswith("BEGIN"):
        print(f"Unexpected response: {header}")
        return None

    remote_path = header.split(" ", 1)[1] if " " in header else "run.csv"
    local_name  = os.path.basename(remote_path)

    lines = read_until_end(ser)
    if not lines:
        print("No data received")
        return None

    with open(local_name, "w", newline="\n") as f:
        f.write("\n".join(lines) + "\n")

    print(f"Saved {len(lines)} lines -> {local_name}")
    return local_name

def main():
    args = sys.argv[2:]

    print(f"Connecting to {PORT} at {BAUD} baud...")
    with open_port() as ser:
        time.sleep(1.5)  # wait for ESP32 to stop boot messages
        ser.reset_input_buffer()

        if "--list" in args:
            list_files(ser)

        elif "--delete" in args:
            confirm = input("Delete ALL logs on device? (yes/no): ")
            if confirm.strip().lower() == "yes":
                send_cmd(ser, "DELETE")
                time.sleep(0.5)
                line = ser.readline().decode("utf-8", errors="ignore").strip()
                print(line)
            else:
                print("Cancelled.")

        elif "--all" in args:
            file_lines = list_files(ser)
            for entry in file_lines:
                fname = entry.split()[0].lstrip("/")
                if fname.endswith(".csv"):
                    print(f"\nDownloading {fname}...")
                    dump_file(ser, fname)

        elif args and not args[0].startswith("--"):
            # Specific filename
            print(f"Downloading {args[0]}...")
            dump_file(ser, args[0])

        else:
            # Default: download most recent
            print("Downloading most recent log...")
            dump_file(ser)

if __name__ == "__main__":
    main()
