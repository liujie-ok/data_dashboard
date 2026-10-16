# Directories:

- ## /Container
    Docker container implementation of telemetry system that used solely accelerometer data; chose to go a different route for competition and stopped iterating on this design.

- ## /SEM-2026
    CSV logging code written during competition. Includes logs from a few runs, the ESP32 code, a python script to extract logs from the ESP32, python scripts to create visuals of the CSV logs, and the blender files with the scripts opened

    see /SEM-2026/logs/ for CSV logs

- ## /ViteApp
    Live rendered telemetry display web app via Vite. Uses the nrf24 transmitters in telemetry tx/rx code and includes an in-browser telemetry dashboard. Functional, but limited due to transmitter range issues. Decided to focus on logging data and speed display for competition. 