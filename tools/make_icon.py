# -*- coding: utf-8 -*-
"""橋タイルからPWAアイコンを生成"""
import os
import numpy as np
from PIL import Image

HERE = os.path.dirname(__file__)
src = Image.open(os.path.join(HERE, "..", "tilesets", "魔法の階段と橋のピクセルタイル.png")).convert("RGB")
# 1段目左端の石階段タイルを切り出す(だいたいの位置から探索)
arr = np.array(src)
diff = arr.astype(np.int32) - np.array([255, 0, 255])
mag = np.sqrt((diff ** 2).sum(axis=2)) < 90
content = ~mag
ys = np.nonzero(content.sum(axis=1) > 8)[0]
xs = np.nonzero(content[ys[0]:ys[0] + 150].sum(axis=0) > 8)[0]
tile = src.crop((xs[0], ys[0], xs[0] + 150, ys[0] + 150))
tile_arr = np.array(tile.convert("RGBA"))
d2 = tile_arr[:, :, :3].astype(np.int32) - np.array([255, 0, 255])
m2 = np.sqrt((d2 ** 2).sum(axis=2)) < 90
tile_arr[:, :, 3] = np.where(m2, 0, 255)
tile = Image.fromarray(tile_arr)

for size in (192, 512):
    icon = Image.new("RGBA", (size, size), (26, 28, 44, 255))
    t = tile.resize((int(size * 0.82), int(size * 0.82)), Image.LANCZOS)
    icon.paste(t, ((size - t.width) // 2, (size - t.height) // 2), t)
    icon.convert("RGB").save(os.path.join(HERE, "..", "assets", f"icon_{size}.png"), optimize=True)
    print("icon", size)
