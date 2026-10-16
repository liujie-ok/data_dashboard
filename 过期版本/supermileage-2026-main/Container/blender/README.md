# Blender Telemetry Integration

This directory contains Blender Python scripts for:
- Live streaming telemetry data from the telemetry server
- Offline CSV-based animation reconstruction

## Requirements
- Blender 3.x+
- Python packages available inside Blender:
  - pandas (optional, only for CSV playback)

## Live Streaming
- Run `live_stream.py` inside Blender
- Ensure telemetry server is running
- Object motion updates in real time

## CSV Playback
- Use `csv_to_animation.py`
- Converts logged CSV telemetry into keyframed animation
