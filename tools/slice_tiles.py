# -*- coding: utf-8 -*-
"""タイルシート(マゼンタ背景)からタイルを切り出し、アトラスWebP + tiles.json を生成する。

- グリッドではなく連結成分ベース: マゼンタで区切られた「ひとかたまり」を1タイルとして検出
  (タイル内部の細かいマゼンタ隙間は膨張処理でブリッジするので、草の房などは分割されない)
- マゼンタ除去は2段階: 純マゼンタのハード判定 + 境界リングでのブレンド(フリンジ)除去
- tilesets/*.png を自動検出。SHEETS に無い新規ファイルも自動でシート登録される
- 各タイルは最大 TILE_PX px に縮小し、シートごとに8列グリッドのアトラスへ詰める
"""
import glob
import json
import math
import os
import re

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(__file__)
SRC_DIR = os.path.join(HERE, "..", "tilesets")
OUT_DIR = os.path.join(HERE, "..", "assets")
TILE_PX = 64            # アトラス内の1タイル最大辺
MAGENTA_DIST = 105      # 純マゼンタ判定のユークリッド距離しきい値
FRINGE_MAGENTA = 45     # リング内のフリンジ判定: min(R,B)-G がこれ以上なら除去
FRINGE_RING = 4         # 透明部から何pxをフリンジ検査対象にするか
BRIDGE_PX = 3           # タイル内の隙間をブリッジする膨張半径(px)
MERGE_GAP = 16          # この距離未満で隣接する断片は統合候補
MAX_TILE = 180          # 統合後にこのサイズを超えるなら別タイルとみなす(隣接タイルの誤結合防止)
MIN_AREA = 400          # タイルとみなす最小面積(px^2、ノイズ除去)
COLS = 8                # アトラスの列数

# 既知シートの表示順・キー・タブ名。ここに無いPNGはファイル名から自動登録される
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

STRIP_WORDS = ["のピクセルタイルシート", "ピクセルタイルシート", "のタイルシート",
               "タイルシート", "のタイルセット", "タイルセット", "のピクセルタイル",
               "ピクセルタイル", "ドット絵", "ファンタジー"]


def discover_sheets():
    """SHEETS + tilesets/ 内の未登録PNGを (ファイル名, key, label) で返す"""
    known = {f for f, _, _ in SHEETS}
    result = [s for s in SHEETS if os.path.exists(os.path.join(SRC_DIR, s[0]))]
    extras = sorted(os.path.basename(p) for p in glob.glob(os.path.join(SRC_DIR, "*.png"))
                    if os.path.basename(p) not in known)
    for i, fname in enumerate(extras):
        label = os.path.splitext(fname)[0]
        for w in STRIP_WORDS:
            label = label.replace(w, "")
        label = re.sub(r"[ _\-]+", "", label) or f"追加{i + 1}"
        result.append((fname, f"extra{i:02d}", label[:8]))
    return result


def magenta_masks(arr):
    """arr: HxWx3 uint8 -> (hard, fringe_ok) のbool配列2つ

    hard: 純マゼンタ(完全に透過)
    fringe: hard周辺リング内でマゼンタ被りが強いピクセル(こちらも透過)
    """
    a = arr.astype(np.int32)
    diff = a - np.array([255, 0, 255])
    hard = np.sqrt((diff ** 2).sum(axis=2)) < MAGENTA_DIST
    ring = ndimage.binary_dilation(hard, iterations=FRINGE_RING) & ~hard
    magentaness = np.minimum(a[:, :, 0], a[:, :, 2]) - a[:, :, 1]
    fringe = ring & (magentaness > FRINGE_MAGENTA)
    return hard, fringe


def slice_sheet(path):
    im = Image.open(path).convert("RGB")
    arr = np.array(im)
    hard, fringe = magenta_masks(arr)
    transparent = hard | fringe
    content = ~transparent

    # タイル内の細かい隙間(草の間のマゼンタ等)をブリッジしてから連結成分を取る
    bridged = ndimage.binary_dilation(content, iterations=BRIDGE_PX)
    labels, n = ndimage.label(bridged)
    boxes = []
    for sl in ndimage.find_objects(labels):
        sub = content[sl]
        area = sub.sum()
        if area == 0:
            continue
        ys, xs = np.nonzero(sub)
        y0 = sl[0].start + ys.min()
        y1 = sl[0].start + ys.max() + 1
        x0 = sl[1].start + xs.min()
        x1 = sl[1].start + xs.max() + 1
        boxes.append([x0, y0, x1, y1, area])

    # 断片の統合: 近接していて、統合後もタイルサイズに収まるものだけ結合する
    # (葉のはみ出しで隣接タイル同士が近くても、結合後が大きすぎれば別タイルのまま)
    merged = True
    while merged:
        merged = False
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                a, b = boxes[i], boxes[j]
                gx = max(a[0], b[0]) - min(a[2], b[2])   # 負ならX軸で重なり
                gy = max(a[1], b[1]) - min(a[3], b[3])
                nx0, ny0 = min(a[0], b[0]), min(a[1], b[1])
                nx1, ny1 = max(a[2], b[2]), max(a[3], b[3])
                if (max(gx, gy) < MERGE_GAP
                        and nx1 - nx0 <= MAX_TILE and ny1 - ny0 <= MAX_TILE):
                    boxes[i] = [nx0, ny0, nx1, ny1, a[4] + b[4]]
                    boxes.pop(j)
                    merged = True
                    break
            if merged:
                break

    boxes = [(x0, y0, x1, y1) for x0, y0, x1, y1, area in boxes if area >= MIN_AREA]

    # 行ごとにまとめて左→右、上→下の順に並べる
    boxes.sort(key=lambda b: (b[1] + b[3]) / 2)
    rows = []
    for b in boxes:
        cy = (b[1] + b[3]) / 2
        if rows and cy < rows[-1]["until"]:
            rows[-1]["items"].append(b)
            rows[-1]["until"] = max(rows[-1]["until"], b[3] - (b[3] - b[1]) * 0.3)
        else:
            rows.append({"items": [b], "until": b[3] - (b[3] - b[1]) * 0.3})
    ordered = [b for r in rows for b in sorted(r["items"], key=lambda b: b[0])]

    tiles = []
    for (x0, y0, x1, y1) in ordered:
        alpha = np.where(transparent[y0:y1, x0:x1], 0, 255).astype(np.uint8)
        rgba = np.dstack([arr[y0:y1, x0:x1], alpha])
        tiles.append(Image.fromarray(rgba, "RGBA"))
    return tiles


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    meta = {"tilePx": TILE_PX, "sheets": []}
    for fname, key, label in discover_sheets():
        tiles = slice_sheet(os.path.join(SRC_DIR, fname))
        rows = math.ceil(len(tiles) / COLS)
        atlas = Image.new("RGBA", (COLS * TILE_PX, max(1, rows) * TILE_PX), (0, 0, 0, 0))
        entries = []
        for i, t in enumerate(tiles):
            scale = min(TILE_PX / t.width, TILE_PX / t.height, 1.0)
            w, h = max(1, round(t.width * scale)), max(1, round(t.height * scale))
            t2 = t.resize((w, h), Image.LANCZOS)
            cx = (i % COLS) * TILE_PX + (TILE_PX - w) // 2
            cy = (i // COLS) * TILE_PX + (TILE_PX - h) // 2
            atlas.paste(t2, (cx, cy))
            entries.append({"x": cx, "y": cy, "w": w, "h": h})
        out = os.path.join(OUT_DIR, f"atlas_{key}.webp")
        atlas.save(out, lossless=True, quality=100, method=4)
        meta["sheets"].append({"key": key, "label": label, "file": f"assets/atlas_{key}.webp",
                               "cols": COLS, "count": len(tiles), "tiles": entries})
        print(f"{label}: {len(tiles)} tiles -> {out} ({os.path.getsize(out)//1024} KB)")
    with open(os.path.join(OUT_DIR, "tiles.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False)
    print("done")


if __name__ == "__main__":
    main()
