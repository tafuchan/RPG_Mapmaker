# -*- coding: utf-8 -*-
"""タイルシート(マゼンタ区切り)からタイルを切り出し、アトラスPNG + tiles.json を生成する。

- マゼンタ(#FF00FF付近)を透過として扱う
- 行→列の投影プロファイルでセルを検出(オブジェクトシートの可変サイズにも対応)
- 各タイルは最大 TILE_PX px に縮小し、シートごとに8列グリッドのアトラスへ詰める
"""
import glob
import json
import math
import os

import numpy as np
from PIL import Image

SRC_DIR = os.path.join(os.path.dirname(__file__), "..", "tilesets")
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "assets")
TILE_PX = 64          # アトラス内の1タイル最大辺
MAGENTA_DIST = 90     # マゼンタ判定のユークリッド距離しきい値
MIN_CONTENT = 8       # 帯とみなす最小の非マゼンタピクセル数
MIN_CELL = 20         # セルの最小辺(ノイズ除去)

SHEETS = [
    ("ファンタジー地面タイルシート.png", "ground", "地面"),
    ("背の高い草のピクセルタイルシート.png", "grass", "草"),
    ("水と岸辺のピクセルタイルシート.png", "water", "水辺"),
    ("ファンタジー崖と断崖のタイルセット.png", "cliff", "崖"),
    ("峡谷と火山の地形タイルシート.png", "canyon", "峡谷・火山"),
    ("ファンタジーフォレストと洞窟の地面.png", "forest", "森・洞窟"),
    ("湖畔と市場の地面タイルシート.png", "lake", "湖畔・市場"),
    ("ドリームタワーの床タイルシート.png", "tower", "タワー床"),
    ("ファンタジー背景用ドット絵タイルシート.png", "bg", "背景"),
    ("魔法の階段と橋のピクセルタイル.png", "bridge", "階段・橋"),
]


def magenta_mask(arr):
    """arr: HxWx3 uint8 -> HxW bool (True = マゼンタ=透過)"""
    diff = arr.astype(np.int32) - np.array([255, 0, 255])
    dist = np.sqrt((diff ** 2).sum(axis=2))
    return dist < MAGENTA_DIST


def find_bands(content_counts, min_content, min_size):
    """1次元の非マゼンタ数から連続帯 [(start, end)] を返す"""
    bands = []
    start = None
    for i, c in enumerate(content_counts):
        if c > min_content:
            if start is None:
                start = i
        else:
            if start is not None:
                if i - start >= min_size:
                    bands.append((start, i))
                start = None
    if start is not None and len(content_counts) - start >= min_size:
        bands.append((start, len(content_counts)))
    return bands


def slice_sheet(path):
    im = Image.open(path).convert("RGB")
    arr = np.array(im)
    mag = magenta_mask(arr)
    content = ~mag

    tiles = []
    row_bands = find_bands(content.sum(axis=1), MIN_CONTENT, MIN_CELL)
    for (y0, y1) in row_bands:
        strip = content[y0:y1]
        col_bands = find_bands(strip.sum(axis=0), MIN_CONTENT, MIN_CELL)
        for (x0, x1) in col_bands:
            cell = content[y0:y1, x0:x1]
            ys, xs = np.nonzero(cell)
            if len(ys) == 0:
                continue
            by0, by1 = y0 + ys.min(), y0 + ys.max() + 1
            bx0, bx1 = x0 + xs.min(), x0 + xs.max() + 1
            rgba = np.dstack([arr[by0:by1, bx0:bx1],
                              np.where(mag[by0:by1, bx0:bx1], 0, 255).astype(np.uint8)])
            tiles.append(Image.fromarray(rgba, "RGBA"))
    return tiles


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    meta = {"tilePx": TILE_PX, "sheets": []}
    for fname, key, label in SHEETS:
        path = os.path.join(SRC_DIR, fname)
        tiles = slice_sheet(path)
        cols = 8
        rows = math.ceil(len(tiles) / cols)
        atlas = Image.new("RGBA", (cols * TILE_PX, rows * TILE_PX), (0, 0, 0, 0))
        entries = []
        for i, t in enumerate(tiles):
            scale = min(TILE_PX / t.width, TILE_PX / t.height, 1.0)
            w, h = max(1, round(t.width * scale)), max(1, round(t.height * scale))
            t2 = t.resize((w, h), Image.LANCZOS)
            cx = (i % cols) * TILE_PX + (TILE_PX - w) // 2
            cy = (i // cols) * TILE_PX + (TILE_PX - h) // 2
            atlas.paste(t2, (cx, cy))
            entries.append({"x": cx, "y": cy, "w": w, "h": h})
        out = os.path.join(OUT_DIR, f"atlas_{key}.webp")
        atlas.save(out, lossless=True, quality=100, method=6)
        meta["sheets"].append({"key": key, "label": label, "file": f"assets/atlas_{key}.webp",
                               "cols": cols, "count": len(tiles), "tiles": entries})
        print(f"{label}: {len(tiles)} tiles -> {out} ({os.path.getsize(out)//1024} KB)")
    with open(os.path.join(OUT_DIR, "tiles.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False)
    print("done")


if __name__ == "__main__":
    main()
