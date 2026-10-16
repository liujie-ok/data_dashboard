"""
animate_run_log.py
------------------
Blender Python script that reads a CSV run log (timestamp, latitude, longitude,
speed, heading) and animates a car object following the path.

HOW TO USE:
  1. Open Blender and switch to the Scripting workspace.
  2. Open this file (or paste it into a new text block).
  3. Edit the CONFIG section below to point at your CSV file.
  4. Press "Run Script".

CSV FORMAT EXPECTED (header row required):
  timestamp, latitude, longitude, speed, heading
  - timestamp : any format parseable by Python (epoch float, or ISO string)
  - latitude  : decimal degrees
  - longitude : decimal degrees
  - speed     : km/h or mph (used for custom property only)
  - heading   : degrees clockwise from North (0 = North, 90 = East, ...)
"""

import bpy
import csv
import math
import os
from datetime import datetime

# ─────────────────────────────────────────────────────────────────────────────
#  CONFIG  –  edit these values before running
# ─────────────────────────────────────────────────────────────────────────────

CSV_PATH        = r"C:\Users\gavin\OneDrive\Desktop\suptest\logs\2137mpg-1546-5766.csv"
OBJECT_NAME     = "Car"            # name of the object to animate (created if missing)
FPS             = 24               # frames per second for the animation
PLAYBACK_SPEED  = 1.0              # 1.0 = real-time, 2.0 = 2x faster, 0.5 = slow-mo
SCALE_FACTOR    = 1000.0           # metres per Blender unit  (1 unit = 1 km by default)
CREATE_PATH     = True             # draw a curve showing the driven path?
CREATE_CAMERA   = False            # create a chase camera that follows the car?

# Row slice (1-based, inclusive). Use None to mean "start" or "end" of file.
# e.g. LINE_START = 100, LINE_STOP = 500  ->  animates data rows 100 through 500
#      LINE_START = None, LINE_STOP = None ->  animates the entire CSV
LINE_START      = 1546
LINE_STOP       = 5766

# Keyframe density.
# Your CSV is 1 row per 500 ms. KEYFRAME_EVERY_N_ROWS = 1 keeps every row.
# Examples (at 500 ms / row):
#   1  -> keyframe every 0.5 s  (every row,   very dense)
#   4  -> keyframe every 2 s
#   10 -> keyframe every 5 s    (good default)
#   20 -> keyframe every 10 s   (very sparse)
# The first and last rows of the slice are always included regardless.
KEYFRAME_EVERY_N_ROWS = 10

# Column name mapping - change if your CSV uses different header names
COL_TIME        = "timestamp"
COL_LAT         = "latitude"
COL_LON         = "longitude"
COL_SPEED       = "speed"
COL_HEADING     = "heading"

# ─────────────────────────────────────────────────────────────────────────────


# ── helpers ──────────────────────────────────────────────────────────────────

def parse_timestamp(raw: str) -> float:
    raw = raw.strip()
    try:
        return float(raw)
    except ValueError:
        pass
    for fmt in (
        "%Y-%m-%dT%H:%M:%S.%f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S.%f",
        "%Y-%m-%d %H:%M:%S",
        "%m/%d/%Y %H:%M:%S",
    ):
        try:
            return datetime.strptime(raw, fmt).timestamp()
        except ValueError:
            continue
    raise ValueError(f"Unrecognised timestamp format: {raw!r}")


def latlon_to_xy(lat, lon, origin_lat, origin_lon):
    R = 6_371_000.0
    dlat = math.radians(lat - origin_lat)
    dlon = math.radians(lon - origin_lon)
    avg_lat = math.radians((lat + origin_lat) / 2.0)
    return R * dlon * math.cos(avg_lat), R * dlat


def heading_to_z_rotation(heading_deg):
    return math.radians(-(heading_deg))


def set_fcurves_linear(action):
    """Set all keyframe interpolation to LINEAR. Handles Blender 3 / 4 / 5."""
    if hasattr(action, "fcurves"):
        for fc in action.fcurves:
            for kp in fc.keyframe_points:
                kp.interpolation = "LINEAR"
        return
    if hasattr(action, "layers"):
        for layer in action.layers:
            for strip in layer.strips:
                if hasattr(strip, "channelbags"):
                    for bag in strip.channelbags:
                        for fc in bag.fcurves:
                            for kp in fc.keyframe_points:
                                kp.interpolation = "LINEAR"
        return
    print("Warning: unknown Action layout - could not set LINEAR interpolation.")


# ── load CSV ─────────────────────────────────────────────────────────────────

if not os.path.isfile(CSV_PATH):
    raise FileNotFoundError(f"CSV not found: {CSV_PATH}")

all_rows = []
with open(CSV_PATH, newline="", encoding="utf-8-sig") as f:
    reader = csv.DictReader(f)
    # print("CSV HEADERS:", reader.fieldnames)   # uncomment to debug column names
    for row in reader:
        all_rows.append({
            "t":       parse_timestamp(row[COL_TIME]),
            "lat":     float(row[COL_LAT]),
            "lon":     float(row[COL_LON]),
            "speed":   float(row[COL_SPEED]),
            "heading": float(row[COL_HEADING]),
        })

# Apply LINE_START / LINE_STOP slice
start_idx = (LINE_START - 1) if LINE_START is not None else 0
stop_idx  = LINE_STOP         if LINE_STOP  is not None else len(all_rows)
rows = all_rows[start_idx:stop_idx]
rows.sort(key=lambda r: r["t"])

if len(rows) < 2:
    raise ValueError("Slice contains fewer than 2 rows - widen LINE_START/LINE_STOP.")

# Downsample for keyframes: keep every Nth row, always include first and last
n = max(1, KEYFRAME_EVERY_N_ROWS)
kf_rows = rows[::n]
if kf_rows[-1] is not rows[-1]:
    kf_rows.append(rows[-1])

print(f"Total rows in CSV  : {len(all_rows)}")
print(f"Rows after slice   : {len(rows)}  (lines {start_idx + 1} - {start_idx + len(rows)})")
print(f"Keyframe rows      : {len(kf_rows)}  (every {n} rows = every {n * 0.5:.1f} s)")

# ── coordinate conversion ────────────────────────────────────────────────────

origin_lat = rows[0]["lat"]
origin_lon = rows[0]["lon"]
t0         = rows[0]["t"]

# Convert ALL rows (needed for the path curve)
for r in rows:
    x, y = latlon_to_xy(r["lat"], r["lon"], origin_lat, origin_lon)
    r["x"]  = x / SCALE_FACTOR
    r["y"]  = y / SCALE_FACTOR
    r["z"]  = 0.0
    r["dt"] = r["t"] - t0

print(f"Spanning {rows[-1]['dt']:.1f} s / {rows[-1]['dt'] / 60:.1f} min")

# ── scene setup ──────────────────────────────────────────────────────────────

scene = bpy.context.scene
scene.render.fps = FPS

total_frames = max(2, (len(kf_rows) - 1) * 30 + 1)
scene.frame_start = 1
scene.frame_end   = total_frames

print(f"Animation: {total_frames} frames at {FPS} fps ({total_frames / FPS:.1f} s playback)")

# ── get or create the car object ─────────────────────────────────────────────

if OBJECT_NAME in bpy.data.objects:
    car = bpy.data.objects[OBJECT_NAME]
    print(f"Using existing object '{OBJECT_NAME}'")
else:
    verts = [
        ( 0.0,  0.5, 0.0),
        (-0.3, -0.4, 0.0),
        ( 0.0, -0.2, 0.0),
        ( 0.3, -0.4, 0.0),
    ]
    faces = [(0, 1, 2), (0, 2, 3)]
    mesh = bpy.data.meshes.new("CarMesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    car = bpy.data.objects.new(OBJECT_NAME, mesh)
    scene.collection.objects.link(car)
    print(f"Created new arrow object '{OBJECT_NAME}'")

car["speed"]   = 0.0
car["heading"] = 0.0
car.animation_data_clear()

# ── insert keyframes (downsampled rows only) ──────────────────────────────────

car.rotation_mode = "XYZ"

for i, r in enumerate(kf_rows):
    frame = i * 30 + 1   # 30 frames per row = 0.5 s at 60 fps

    car.location          = (r["x"], r["y"], r["z"])
    car.rotation_euler[2] = heading_to_z_rotation(r["heading"])

    car.keyframe_insert(data_path="location",       frame=frame)
    car.keyframe_insert(data_path="rotation_euler", frame=frame)

    car["speed"]   = r["speed"]
    car["heading"] = r["heading"]
    car.keyframe_insert(data_path='["speed"]',   frame=frame)
    car.keyframe_insert(data_path='["heading"]', frame=frame)

print(f"Inserted {len(kf_rows)} keyframes.")

if car.animation_data and car.animation_data.action:
    set_fcurves_linear(car.animation_data.action)

# ── optional: path curve (uses ALL rows for full-resolution trace) ────────────

if CREATE_PATH:
    curve_data = bpy.data.curves.new("RunPath", type="CURVE")
    curve_data.dimensions   = "3D"
    curve_data.resolution_u = 2

    spline = curve_data.splines.new("POLY")
    spline.points.add(len(rows) - 1)
    for i, r in enumerate(rows):
        spline.points[i].co = (r["x"], r["y"], r["z"], 1.0)

    path_obj = bpy.data.objects.new("RunPath", curve_data)
    scene.collection.objects.link(path_obj)

    mat = bpy.data.materials.new("PathMat")
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (
        0.0, 0.8, 1.0, 1.0)
    path_obj.data.materials.append(mat)
    curve_data.bevel_depth = 0.005

    print("Created path curve 'RunPath' (full resolution).")

# ── optional: chase camera ────────────────────────────────────────────────────

if CREATE_CAMERA:
    cam_data = bpy.data.cameras.new("ChaseCamera")
    cam_obj  = bpy.data.objects.new("ChaseCamera", cam_data)
    scene.collection.objects.link(cam_obj)

    cam_obj.parent         = car
    cam_obj.location       = (0.0, -3.0, 1.5)
    cam_obj.rotation_euler = (math.radians(70), 0.0, 0.0)

    scene.camera = cam_obj
    print("Created chase camera parented to car.")

# ── done ──────────────────────────────────────────────────────────────────────

scene.frame_set(1)

print("\n── Animation complete ──────────────────────────────────────────")
print(f"  Object     : {car.name}")
print(f"  Keyframes  : {len(kf_rows)}  (every {n} rows = every {n * 0.5:.1f} s)")
print(f"  CSV lines  : {start_idx + 1} - {start_idx + len(rows)}")
print(f"  Frames     : {scene.frame_start} -> {scene.frame_end}  ({total_frames / FPS:.1f} s)")
print(f"  Path curve : {'yes (full resolution)' if CREATE_PATH else 'no'}")
print(f"  Chase cam  : {'yes' if CREATE_CAMERA else 'no'}")
print("  Press SPACE in the viewport to play.")