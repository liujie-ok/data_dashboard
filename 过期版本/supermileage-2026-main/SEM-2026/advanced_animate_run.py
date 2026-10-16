"""
advanced_animate_run_log.py
---------------------------
Advanced Blender Python script that reads a CSV run log and animates:
  - Car object moving along the GPS path
  - Car color shifting blue (slow) -> red (fast) based on speed_mph
  - 3 animated force-arrow objects showing accel_x / accel_y / accel_z
    parented to the car, scaling each frame with the live G-force values

CSV FORMAT (header row required):
  millis, lat, lon, speed_mph, heading_deg, accel_x_g, accel_y_g, accel_z_g
"""

import bpy
import csv
import math
import os
from datetime import datetime

# ─────────────────────────────────────────────────────────────────────────────
#  CONFIG
# ─────────────────────────────────────────────────────────────────────────────

CSV_PATH        = r"C:\Users\gavin\OneDrive\Desktop\suptest\logs\test-me.csv"
OBJECT_NAME     = "Car"
FPS             = 24
PLAYBACK_SPEED  = 1.0              # 1.0 = real-time, 2.0 = 2x faster
SCALE_FACTOR    = 1000.0           # metres per Blender unit (1 unit = 1 km)
CREATE_PATH     = True             # draw full-resolution path curve?
CREATE_CAMERA   = False            # chase camera parented to car?

LINE_START      = None             # first data row (1-based). None = beginning
LINE_STOP       = None             # last  data row (1-based). None = end

# Keyframe density. CSV is 1 row per 500 ms.
#   1  = every row (very dense)
#   10 = every 5 s  (good default)
#   20 = every 10 s (sparse)
KEYFRAME_EVERY_N_ROWS = 10

# ── Speed → color ────────────────────────────────────────────────────────────
# Car material interpolates: SLOW_COLOR (blue) → FAST_COLOR (red)
# SPEED_MAX_MPH sets what counts as "full red". Values above it clamp to red.
SPEED_MAX_MPH   = 60.0
SLOW_COLOR      = (0.0,  0.1,  1.0, 1.0)   # RGBA blue
FAST_COLOR      = (1.0,  0.05, 0.0, 1.0)   # RGBA red

# ── Force arrows ─────────────────────────────────────────────────────────────
# Each G-force axis gets its own arrow object parented to the car.
# Arrow length = ARROW_SCALE * abs(accel_g).  Negative values flip the arrow.
# ARROW_BASE_SIZE controls the shaft thickness (Blender units).
ARROW_SCALE     = 0.4              # Blender units per 1 G
ARROW_BASE_SIZE = 0.02             # shaft half-width

# Column name mapping
COL_MILLIS      = "millis"
COL_LAT         = "lat"
COL_LON         = "lon"
COL_SPEED       = "speed_mph"
COL_HEADING     = "heading_deg"
COL_ACCEL_X     = "accel_x_g"
COL_ACCEL_Y     = "accel_y_g"
COL_ACCEL_Z     = "accel_z_g"

# ─────────────────────────────────────────────────────────────────────────────


# ── helpers ───────────────────────────────────────────────────────────────────

def latlon_to_xy(lat, lon, origin_lat, origin_lon):
    R = 6_371_000.0
    dlat = math.radians(lat - origin_lat)
    dlon = math.radians(lon - origin_lon)
    avg_lat = math.radians((lat + origin_lat) / 2.0)
    return R * dlon * math.cos(avg_lat), R * dlat


def heading_to_z_rotation(h):
    return math.radians(-(h - 90.0))


def lerp_color(c0, c1, t):
    """Linear interpolate between two RGBA tuples by factor t in [0, 1]."""
    t = max(0.0, min(1.0, t))
    return tuple(c0[i] + (c1[i] - c0[i]) * t for i in range(4))


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
    print("Warning: unknown Action layout — could not set LINEAR interpolation.")


def make_arrow_mesh(name, axis, base_size):
    """
    Build a simple arrow mesh pointing along `axis` ('X', 'Y', or 'Z').
    The arrow is 1 Blender unit long; scale it to change length.
    Shaft runs from 0 → 0.75; arrowhead from 0.75 → 1.0.
    """
    b = base_size
    h = base_size * 2.5   # arrowhead half-width

    # Shaft: a flat quad (visible from above in top-down view)
    # Arrowhead: a triangle
    if axis == 'X':
        shaft_verts = [( 0,  b, 0), ( 0, -b, 0), (0.75, -b, 0), (0.75,  b, 0)]
        head_verts  = [(0.75,  h, 0), (0.75, -h, 0), (1.0, 0, 0)]
    elif axis == 'Y':
        shaft_verts = [( b,  0, 0), (-b,  0, 0), (-b, 0.75, 0), ( b, 0.75, 0)]
        head_verts  = [( h, 0.75, 0), (-h, 0.75, 0), (0, 1.0, 0)]
    else:  # Z
        shaft_verts = [( b, 0,  0), (-b, 0,  0), (-b, 0, 0.75), ( b, 0, 0.75)]
        head_verts  = [( h, 0, 0.75), (-h, 0, 0.75), (0, 0, 1.0)]

    verts = shaft_verts + head_verts
    faces = [(0, 1, 2, 3), (4, 5, 6)]

    mesh = bpy.data.meshes.new(name + "Mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    return mesh


def get_or_clear_object(name, scene):
    """Remove existing object of that name so we start fresh each run."""
    if name in bpy.data.objects:
        obj = bpy.data.objects[name]
        bpy.data.objects.remove(obj, do_unlink=True)


# ── load CSV ──────────────────────────────────────────────────────────────────

if not os.path.isfile(CSV_PATH):
    raise FileNotFoundError(f"CSV not found: {CSV_PATH}")

all_rows = []
last_lat = None
last_lon = None
no_fix_count = 0

with open(CSV_PATH, newline="", encoding="utf-8-sig") as f:
    reader = csv.DictReader(f)
    # print("CSV HEADERS:", reader.fieldnames)   # uncomment to debug
    for row in reader:
        raw_lat = row[COL_LAT].strip()
        raw_lon = row[COL_LON].strip()

        # Use last known position if this row has no GPS fix
        if raw_lat.upper() in ("NO FIX", "NO_FIX") or raw_lon.upper() in ("NO FIX", "NO_FIX"):
            if last_lat is None:
                # No fix yet at all — skip this row entirely
                no_fix_count += 1
                continue
            lat = last_lat
            lon = last_lon
            no_fix_count += 1
        else:
            lat = float(raw_lat)
            lon = float(raw_lon)
            last_lat = lat
            last_lon = lon

        all_rows.append({
            "t":       float(row[COL_MILLIS]) / 1000.0,   # ms → seconds
            "lat":     lat,
            "lon":     lon,
            "speed":   float(row[COL_SPEED]),
            "heading": float(row[COL_HEADING]),
            "ax":      float(row[COL_ACCEL_X]),
            "ay":      float(row[COL_ACCEL_Y]),
            "az":      float(row[COL_ACCEL_Z]),
        })

# Slice
start_idx = (LINE_START - 1) if LINE_START is not None else 0
stop_idx  = LINE_STOP         if LINE_STOP  is not None else len(all_rows)
rows = all_rows[start_idx:stop_idx]
rows.sort(key=lambda r: r["t"])

if len(rows) < 2:
    raise ValueError("Slice contains fewer than 2 rows.")

# Downsample for keyframes
n = max(1, KEYFRAME_EVERY_N_ROWS)
kf_rows = rows[::n]
if kf_rows[-1] is not rows[-1]:
    kf_rows.append(rows[-1])

print(f"Total rows in CSV  : {len(all_rows) + no_fix_count}")
print(f"  NO FIX rows      : {no_fix_count}  (used last known position)")
print(f"Rows after slice   : {len(rows)}  (lines {start_idx+1}–{start_idx+len(rows)})")
print(f"Keyframe rows      : {len(kf_rows)}  (every {n} rows = every {n*0.5:.1f} s)")

# ── coordinate conversion ─────────────────────────────────────────────────────

origin_lat = rows[0]["lat"]
origin_lon = rows[0]["lon"]
t0         = rows[0]["t"]
max_speed  = max(r["speed"] for r in rows) or 1.0

for r in rows:
    x, y = latlon_to_xy(r["lat"], r["lon"], origin_lat, origin_lon)
    r["x"]  = x / SCALE_FACTOR
    r["y"]  = y / SCALE_FACTOR
    r["z"]  = 0.0
    r["dt"] = r["t"] - t0

print(f"Spanning {rows[-1]['dt']:.1f} s / {rows[-1]['dt']/60:.1f} min")
print(f"Speed range: 0 – {max_speed:.1f} mph  (color max: {SPEED_MAX_MPH} mph)")

# ── scene setup ───────────────────────────────────────────────────────────────

scene = bpy.context.scene
scene.render.fps = FPS

total_frames = max(2, int(rows[-1]["dt"] / PLAYBACK_SPEED * FPS) + 1)
scene.frame_start = 1
scene.frame_end   = total_frames

def time_to_frame(dt):
    return max(1, round(dt / PLAYBACK_SPEED * FPS) + 1)

# ── car object ────────────────────────────────────────────────────────────────

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
    print(f"Created arrow object '{OBJECT_NAME}'")

car.animation_data_clear()
car.rotation_mode = "XYZ"

# ── car material (speed → color) ──────────────────────────────────────────────

mat_name = "CarSpeedMat"
if mat_name in bpy.data.materials:
    bpy.data.materials.remove(bpy.data.materials[mat_name])

mat = bpy.data.materials.new(mat_name)
mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]

# Assign material to car (replace slot 0 or add new)
if car.data.materials:
    car.data.materials[0] = mat
else:
    car.data.materials.append(mat)

# ── force arrow objects ───────────────────────────────────────────────────────

arrow_cfg = {
    "ArrowX": ("X", (1.0, 0.15, 0.15, 1.0)),   # red-ish   — lateral
    "ArrowY": ("Y", (0.15, 1.0, 0.15, 1.0)),   # green     — longitudinal
    "ArrowZ": ("Z", (0.5,  0.5, 1.0,  1.0)),   # blue-ish  — vertical
}

arrows = {}
for aname, (axis, color) in arrow_cfg.items():
    get_or_clear_object(aname, scene)
    amesh = make_arrow_mesh(aname, axis, ARROW_BASE_SIZE)
    aobj  = bpy.data.objects.new(aname, amesh)
    scene.collection.objects.link(aobj)

    # Parent to car so arrows move with it
    aobj.parent = car
    aobj.location = (0, 0, 0.05)   # slightly above the car plane

    # Material
    amat = bpy.data.materials.new(aname + "Mat")
    amat.use_nodes = True
    amat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = color
    amat.node_tree.nodes["Principled BSDF"].inputs["Emission Color"].default_value = color
    amat.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 1.5
    aobj.data.materials.append(amat)

    aobj.animation_data_clear()
    arrows[aname] = aobj

print("Created force arrow objects: ArrowX (lateral), ArrowY (longitudinal), ArrowZ (vertical)")

# ── insert keyframes ──────────────────────────────────────────────────────────

for r in kf_rows:
    frame = time_to_frame(r["dt"])

    # --- car location & heading ---
    car.location          = (r["x"], r["y"], r["z"])
    car.rotation_euler[2] = heading_to_z_rotation(r["heading"])
    car.keyframe_insert(data_path="location",       frame=frame)
    car.keyframe_insert(data_path="rotation_euler", frame=frame)

    # --- speed → color ---
    t_color = r["speed"] / SPEED_MAX_MPH
    color   = lerp_color(SLOW_COLOR, FAST_COLOR, t_color)
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Base Color"].keyframe_insert("default_value", frame=frame)

    # --- custom properties ---
    car["speed"]   = r["speed"]
    car["heading"] = r["heading"]
    car["accel_x"] = r["ax"]
    car["accel_y"] = r["ay"]
    car["accel_z"] = r["az"]
    car.keyframe_insert(data_path='["speed"]',   frame=frame)
    car.keyframe_insert(data_path='["heading"]', frame=frame)
    car.keyframe_insert(data_path='["accel_x"]', frame=frame)
    car.keyframe_insert(data_path='["accel_y"]', frame=frame)
    car.keyframe_insert(data_path='["accel_z"]', frame=frame)

    # --- force arrows: scale each arrow by its G value ---
    # Positive G  → arrow points in positive axis direction (scale > 0)
    # Negative G  → flip arrow by using negative scale on the arrow axis
    accel_map = {
        "ArrowX": r["ax"],
        "ArrowY": r["ay"],
        "ArrowZ": r["az"],
    }
    for aname, g_val in accel_map.items():
        aobj = arrows[aname]
        length = abs(g_val) * ARROW_SCALE
        sign   = 1.0 if g_val >= 0 else -1.0

        axis = arrow_cfg[aname][0]
        if axis == 'X':
            aobj.scale = (sign * length, 1.0, 1.0)
        elif axis == 'Y':
            aobj.scale = (1.0, sign * length, 1.0)
        else:
            aobj.scale = (1.0, 1.0, sign * length)

        # Hide arrow if G is essentially zero
        aobj.hide_viewport = (length < 0.001)
        aobj.hide_render   = (length < 0.001)
        aobj.keyframe_insert(data_path="scale",          frame=frame)
        aobj.keyframe_insert(data_path="hide_viewport",  frame=frame)
        aobj.keyframe_insert(data_path="hide_render",    frame=frame)

print(f"Inserted {len(kf_rows)} keyframes.")

# Set LINEAR interpolation on all animated objects
for obj in [car] + list(arrows.values()):
    if obj.animation_data and obj.animation_data.action:
        set_fcurves_linear(obj.animation_data.action)

# Also set LINEAR on the material node animation
if mat.node_tree.animation_data and mat.node_tree.animation_data.action:
    set_fcurves_linear(mat.node_tree.animation_data.action)

# ── path curve (full resolution) ──────────────────────────────────────────────

if CREATE_PATH:
    # Remove old path if re-running
    if "RunPath" in bpy.data.objects:
        bpy.data.objects.remove(bpy.data.objects["RunPath"], do_unlink=True)

    curve_data = bpy.data.curves.new("RunPath", type="CURVE")
    curve_data.dimensions   = "3D"
    curve_data.resolution_u = 2

    spline = curve_data.splines.new("POLY")
    spline.points.add(len(rows) - 1)
    for i, r in enumerate(rows):
        spline.points[i].co = (r["x"], r["y"], r["z"], 1.0)

    path_obj = bpy.data.objects.new("RunPath", curve_data)
    scene.collection.objects.link(path_obj)

    path_mat = bpy.data.materials.new("PathMat")
    path_mat.use_nodes = True
    path_mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (
        0.0, 0.8, 1.0, 1.0)
    path_obj.data.materials.append(path_mat)
    curve_data.bevel_depth = 0.005

    print("Created path curve 'RunPath' (full resolution).")

# ── optional chase camera ─────────────────────────────────────────────────────

if CREATE_CAMERA:
    if "ChaseCamera" in bpy.data.objects:
        bpy.data.objects.remove(bpy.data.objects["ChaseCamera"], do_unlink=True)

    cam_data = bpy.data.cameras.new("ChaseCamera")
    cam_obj  = bpy.data.objects.new("ChaseCamera", cam_data)
    scene.collection.objects.link(cam_obj)
    cam_obj.parent         = car
    cam_obj.location       = (0.0, -3.0, 1.5)
    cam_obj.rotation_euler = (math.radians(70), 0.0, 0.0)
    scene.camera = cam_obj
    print("Created chase camera.")

# ── done ──────────────────────────────────────────────────────────────────────

scene.frame_set(1)

print("\n── Animation complete ───────────────────────────────────────────")
print(f"  Object     : {car.name}")
print(f"  Keyframes  : {len(kf_rows)}  (every {n} rows = every {n*0.5:.1f} s)")
print(f"  CSV lines  : {start_idx+1} – {start_idx+len(rows)}")
print(f"  Frames     : {scene.frame_start} → {scene.frame_end}  ({total_frames/FPS:.1f} s)")
print(f"  Color range: blue ({SLOW_COLOR[:3]}) → red ({FAST_COLOR[:3]})  max={SPEED_MAX_MPH} mph")
print(f"  Arrows     : ArrowX (lateral/red)  ArrowY (longitudinal/green)  ArrowZ (vertical/blue)")
print(f"  Path curve : {'yes' if CREATE_PATH else 'no'}")
print(f"  Chase cam  : {'yes' if CREATE_CAMERA else 'no'}")
print("  Press SPACE in the viewport to play.")