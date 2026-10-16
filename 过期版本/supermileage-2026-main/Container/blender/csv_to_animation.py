import bpy
import pandas as pd

CSV_PATH = "/absolute/path/to/telemetry.csv"
FPS = 50
SCALE = 0.1

df = pd.read_csv(CSV_PATH)

obj_name = "TelemetryPlayback"

if obj_name not in bpy.data.objects:
    mesh = bpy.data.meshes.new("PlaybackMesh")
    obj = bpy.data.objects.new(obj_name, mesh)
    bpy.context.collection.objects.link(obj)
else:
    obj = bpy.data.objects[obj_name]

bpy.context.scene.render.fps = FPS

frame = 1
for _, row in df.iterrows():
    obj.location = (
        row["x"] * SCALE,
        row["y"] * SCALE,
        row["z"] * SCALE
    )
    obj.keyframe_insert(data_path="location", frame=frame)
    frame += 1

print("CSV animation imported.")
