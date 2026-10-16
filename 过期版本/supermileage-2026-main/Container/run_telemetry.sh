#!/bin/bash
# Run from project root: ./run_telemetry.sh

# --- Step 1: Compile & upload Arduino firmware ---
# echo "Uploading Arduino firmware..."
# arduino-cli compile --fqbn arduino:avr:nano arduino/telemetry_sender.ino
# arduino-cli upload -p /dev/ttyUSB0 --fqbn arduino:avr:nano arduino/telemetry_sender.ino

# --- Step 2: Start Docker telemetry container ---
echo "Starting telemetry server..."
docker-compose up --build
