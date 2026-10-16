"""
GPS Live Telemetry — Blender Visualizer
========================================
Polls the Flask telemetry backend and visualizes the car's GPS track in
real-time inside Blender's 3D viewport.

Objects created / managed:
  GPS_Car      — arrow mesh that moves and rotates with the car
  GPS_Trail    — curve that traces the full position history
  GPS_Stats    — 3-D text overlay showing live stats

Usage:
  1. Start the telemetry backend  (USE_DUMMY=true python app.py)
  2. Open this script in Blender's Text Editor and press Run Script.
  3. Switch to a 3D Viewport — the car and trail will appear and update live.
  Press Button 0 on the board (or call reset_scene() from the console) to
  clear the trail and recentre the origin.

Coordinate system:
  First GPS fix becomes the raw origin.  All positions are then scaled and
  centred so the full recorded track always fits inside a SCENE_SIZE × SCENE_SIZE
  unit bounding box (default 10 × 10).  Scale updates automatically each frame
  as the car covers more ground.
"""

import bpy
import urllib.request
import json
import math

# ── CONFIG ────────────────────────────────────────────────────────────────────
BASE_URL   = "http://localhost:5000"
POLL_HZ    = 10          # fetches per second
SCENE_SIZE = 10.0        # target bounding box (units) — track always fits here

# ── Object names (change these if they collide with existing scene objects) ───
CAR_OBJ_NAME   = "GPS_Car"
TRAIL_OBJ_NAME = "GPS_Trail"
TEXT_OBJ_NAME  = "GPS_Stats"

POLL_INTERVAL = 1.0 / POLL_HZ

# ── Runtime state ─────────────────────────────────────────────────────────────
_origin_lat    = None
_origin_lon    = None
_scene_scale   = 1.0    # metres → Blender units (recomputed every frame)
_scene_cx      = 0.0    # raw-metre centre of bounding box (X)
_scene_cy      = 0.0    # raw-metre centre of bounding box (Y)


# ══════════════════════════════════════════════════════════════════════════════
# Coordinate helpers
# ══════════════════════════════════════════════════════════════════════════════

def latlon_to_local(lat, lon):
    """
    Convert GPS decimal-degree coordinates to local X/Y metres
    relative to the first-fix origin.
    """
    global _origin_lat, _origin_lon
    if _origin_lat is None:
        _origin_lat, _origin_lon = lat, lon

    R        = 6_371_000.0                          # Earth radius (m)
    cos_lat0 = math.cos(math.radians(_origin_lat))
    x        = math.radians(lon - _origin_lon) * cos_lat0 * R   # East
    y        = math.radians(lat - _origin_lat) * R              # North
    return x, y


def reset_origin():
    """Clear the origin so the next GPS fix becomes (0, 0)."""
    global _origin_lat, _origin_lon, _scene_scale, _scene_cx, _scene_cy
    _origin_lat = _origin_lon = None
    _scene_scale = 1.0
    _scene_cx = _scene_cy = 0.0


def _update_scene_scale(raw_coords):
    """
    Recompute scale + centre so that all raw_coords fit inside
    a SCENE_SIZE × SCENE_SIZE bounding box with 10 % padding.
    """
    global _scene_scale, _scene_cx, _scene_cy
    if len(raw_coords) < 2:
        return
    xs   = [c[0] for c in raw_coords]
    ys   = [c[1] for c in raw_coords]
    span = max(max(xs) - min(xs), max(ys) - min(ys))
    if span < 0.1:          # avoid div-by-zero when barely moving
        return
    _scene_scale = (SCENE_SIZE * 0.9) / span
    _scene_cx    = (min(xs) + max(xs)) / 2.0
    _scene_cy    = (min(ys) + max(ys)) / 2.0


def _to_scene(raw_x, raw_y):
    """Apply scale + centre offset to convert raw metres → scene units."""
    return (raw_x - _scene_cx) * _scene_scale, \
           (raw_y - _scene_cy) * _scene_scale


# ══════════════════════════════════════════════════════════════════════════════
# Scene-object setup  (idempotent — safe to call multiple times)
# ══════════════════════════════════════════════════════════════════════════════

def _make_material(name, base_color=(0.0, 0.8, 1.0, 1.0), emission_strength=2.0):
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value    = base_color
        bsdf.inputs["Emission Color"].default_value = base_color
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def get_or_create_car():
    if CAR_OBJ_NAME in bpy.data.objects:
        return bpy.data.objects[CAR_OBJ_NAME]

    # Normalised arrow pointing in the +Y (North) direction — 1 unit tall.
    # Actual size is set via obj.scale each frame so it stays proportional
    # to SCENE_SIZE regardless of GPS zoom level.
    verts = [
        ( 0.0,  1.0,  0.0),   # 0 nose
        (-0.5, -0.4,  0.0),   # 1 left rear
        ( 0.5, -0.4,  0.0),   # 2 right rear
        ( 0.0,  0.1,  0.4),   # 3 top-centre
    ]
    faces = [(0, 1, 3), (0, 3, 2), (1, 2, 3), (0, 2, 1)]

    mesh = bpy.data.meshes.new("GPS_CarMesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()

    obj = bpy.data.objects.new(CAR_OBJ_NAME, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(_make_material("GPS_CarMat",
                                              base_color=(0.0, 0.8, 1.0, 1.0),
                                              emission_strength=3.0))
    return obj


def get_or_create_trail():
    if TRAIL_OBJ_NAME in bpy.data.objects:
        return bpy.data.objects[TRAIL_OBJ_NAME]

    curve             = bpy.data.curves.new("GPS_TrailCurve", type='CURVE')
    curve.dimensions  = '3D'
    curve.bevel_depth = SCENE_SIZE * 0.012   # ~1.2 % of scene — scales with zoom
    curve.bevel_resolution = 2

    obj = bpy.data.objects.new(TRAIL_OBJ_NAME, curve)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(_make_material("GPS_TrailMat",
                                              base_color=(0.0, 0.4, 1.0, 1.0),
                                              emission_strength=1.0))
    return obj


def get_or_create_text():
    if TEXT_OBJ_NAME in bpy.data.objects:
        return bpy.data.objects[TEXT_OBJ_NAME]

    font_data          = bpy.data.curves.new(TEXT_OBJ_NAME, type='FONT')
    font_data.body     = "GPS TELEMETRY"
    font_data.size     = SCENE_SIZE * 0.08
    font_data.align_x  = 'LEFT'

    obj = bpy.data.objects.new(TEXT_OBJ_NAME, font_data)
    bpy.context.collection.objects.link(obj)
    obj.location = (0, 0, SCENE_SIZE * 0.6)
    obj.data.materials.append(_make_material("GPS_TextMat",
                                              base_color=(1.0, 1.0, 1.0, 1.0),
                                              emission_strength=1.0))
    return obj


# ══════════════════════════════════════════════════════════════════════════════
# Trail curve update
# ══════════════════════════════════════════════════════════════════════════════

def update_trail(trail_obj, local_coords):
    """Replace the trail curve spline with the latest position history."""
    curve = trail_obj.data
    curve.splines.clear()

    if len(local_coords) < 2:
        return

    spline = curve.splines.new('POLY')
    spline.points.add(len(local_coords) - 1)   # starts with 1 point already
    for i, (x, y) in enumerate(local_coords):
        spline.points[i].co = (x, y, 0.0, 1.0)   # (X, Y, Z, W)


# ══════════════════════════════════════════════════════════════════════════════
# HTTP helpers
# ══════════════════════════════════════════════════════════════════════════════

def fetch_json(path):
    try:
        with urllib.request.urlopen(BASE_URL + path, timeout=1) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        print(f"[GPS live_stream] fetch error {path}: {e}")
        return None


# ══════════════════════════════════════════════════════════════════════════════
# Main update callback  (registered as a Blender timer)
# ══════════════════════════════════════════════════════════════════════════════

car_obj   = get_or_create_car()
trail_obj = get_or_create_trail()
text_obj  = get_or_create_text()

_last_timestamp = None


def update():
    global _last_timestamp

    # ── 1. Live position ──────────────────────────────────────────────────────
    current = fetch_json("/api/current")
    if not current or current.get("lat") is None:
        return POLL_INTERVAL                        # no fix yet — try again

    lat     = current["lat"]
    lon     = current["lon"]
    speed   = current["speed_mph"]
    heading = current["heading"]
    accel_g = current["accel_g"]

    raw_x, raw_y = latlon_to_local(lat, lon)

    # ── 2. Fetch history + recompute scale every frame ────────────────────────
    history = fetch_json("/api/position_history")
    raw_coords = []
    if history:
        raw_coords = [latlon_to_local(p["lat"], p["lon"]) for p in history]
        _update_scene_scale(raw_coords)   # keeps track inside 10×10 box

    sx, sy = _to_scene(raw_x, raw_y)

    # ── 3. Move + rotate car ──────────────────────────────────────────────────
    car_obj.location = (sx, sy, 0.0)
    # GPS heading: 0 = North (+Y), 90 = East (+X)
    car_obj.rotation_euler = (0.0, 0.0, math.radians(-heading))
    # Keep car arrow proportional to scene size regardless of GPS zoom
    car_size = SCENE_SIZE * 0.06
    car_obj.scale = (car_size, car_size, car_size)

    # Speed-based colour: cyan → green → yellow → red
    t = min(1.0, speed / 60.0)
    r = min(1.0, t * 2.0)
    g = max(0.0, min(1.0, 1.0 - (t - 0.5) * 2.0))
    b = max(0.0, 1.0 - t * 3.0)
    mat  = car_obj.data.materials[0]
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value     = (r, g, b, 1.0)
        bsdf.inputs["Emission Color"].default_value = (r, g, b, 1.0)

    # ── 4. Update trail with scaled coordinates ───────────────────────────────
    if raw_coords:
        scene_coords = [_to_scene(rx, ry) for rx, ry in raw_coords]
        update_trail(trail_obj, scene_coords)

    # ── 5. Stats text ─────────────────────────────────────────────────────────
    stats = fetch_json("/api/stats")
    if stats:
        cardinal = _heading_cardinal(heading)
        text_obj.data.body = (
            f"SPD   {speed:>5.1f} mph\n"
            f"ACCEL {accel_g:>+6.3f} g\n"
            f"HDG   {heading:>5.1f}° {cardinal}\n"
            f"DIST  {stats['distance_miles']:>5.2f} mi\n"
            f"MAX   {stats['max_speed_mph']:>5.1f} mph"
        )
        # Float the text above the car, scaled with the scene
        text_obj.data.size = SCENE_SIZE * 0.08
        text_obj.location  = (sx, sy, SCENE_SIZE * 0.6)

    return POLL_INTERVAL


def _heading_cardinal(deg):
    dirs = ["N","NE","E","SE","S","SW","W","NW"]
    return dirs[round(deg / 45) % 8]


# ══════════════════════════════════════════════════════════════════════════════
# Public helpers (call from Blender Python console if needed)
# ══════════════════════════════════════════════════════════════════════════════

def reset_scene():
    """Clear the trail and recentre origin on the next GPS sample."""
    reset_origin()
    trail_obj.data.splines.clear()
    print("[GPS live_stream] Origin reset — trail cleared.")


def stop_stream():
    if bpy.app.timers.is_registered(update):
        bpy.app.timers.unregister(update)
        print("[GPS live_stream] Stopped.")


# ══════════════════════════════════════════════════════════════════════════════
# Register timer
# ══════════════════════════════════════════════════════════════════════════════
if bpy.app.timers.is_registered(update):
    bpy.app.timers.unregister(update)

bpy.app.timers.register(update, first_interval=0.5)
print(f"[GPS live_stream] Started — polling {BASE_URL} at {POLL_HZ} Hz.")
print("  reset_scene() — clear trail and recentre origin")
print("  stop_stream()  — stop the timer")
