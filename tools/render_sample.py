# -*- coding: utf-8 -*-
"""新アセットを使ったサンプル村マップを生成してPNG出力する。
   エディタと同じデータモデル(bg1/bg2/bg3の-1埋め配列 + big + objects)を作り、
   最終的に PNG に描き出す。アプリのapp.jsのdrawTileと同じ描画規則を再現する。"""
import json
import math
import os
import random
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), "..")
meta = json.load(open(os.path.join(ROOT, "assets", "tiles.json"), encoding="utf-8"))

# sheet key -> sheet index
KEY_IDX = {sh["key"]: i for i, sh in enumerate(meta["sheets"])}
SHEETS = meta["sheets"]
TILE_PX = meta["tilePx"]  # アトラス側の1マスpx
CELL = 32                 # 出力側の1マス表示px(大きすぎるとファイルサイズ増)
W, H = 28, 20             # マップサイズ

atlases = [Image.open(os.path.join(ROOT, sh["file"])).convert("RGBA")
           for sh in SHEETS]


def tid(key, t):
    return KEY_IDX[key] * 1000 + t


def id_sheet(x): return x // 1000
def id_tile(x): return x % 1000


def crop_tile(id_):
    s, t = id_sheet(id_), id_tile(id_)
    ti = SHEETS[s]["tiles"][t]
    return atlases[s].crop((ti["x"], ti["y"], ti["x"] + ti["w"], ti["y"] + ti["h"])), ti


def paste_tile(img, id_, dx, dy, dw, dh):
    """app.jsのdrawTileと同じ規則: 非正方形は下端揃えでアスペクト維持"""
    tile, ti = crop_tile(id_)
    ratio = ti["w"] / ti["h"]
    if ratio < 0.85 or ratio > 1.18:
        k = min(dw / ti["w"], dh / ti["h"])
        w = max(1, round(ti["w"] * k))
        h = max(1, round(ti["h"] * k))
        t2 = tile.resize((w, h), Image.LANCZOS)
        img.alpha_composite(t2, (int(dx + (dw - w) / 2), int(dy + (dh - h))))
    else:
        t2 = tile.resize((int(dw), int(dh)), Image.LANCZOS)
        img.alpha_composite(t2, (int(dx), int(dy)))


def new_map():
    return {
        "w": W, "h": H,
        "bg1": [-1] * (W * H), "bg2": [-1] * (W * H), "bg3": [-1] * (W * H),
        "big": {"bg1": [], "bg2": [], "bg3": []},
        "objects": [],
    }


def base(m, base_tile, variants, rate, rnd):
    for i in range(W * H):
        m["bg1"][i] = variants[int(rnd.random() * len(variants))] if rnd.random() < rate else base_tile


def rectf(m, layer, x0, y0, x1, y1, tile):
    for y in range(max(0, y0), min(H, y1 + 1)):
        for x in range(max(0, x0), min(W, x1 + 1)):
            m[layer][y * W + x] = tile


def path_h(m, layer, tile, y0, width, rnd):
    y = y0
    for x in range(W):
        for k in range(width):
            if 0 <= y + k < H:
                m[layer][(y + k) * W + x] = tile
        if rnd.random() < 0.3:
            y += -1 if rnd.random() < 0.5 else 1
        y = max(1, min(H - width - 1, y))


def path_v(m, layer, tile, x0, width, rnd):
    x = x0
    for y in range(H):
        for k in range(width):
            if 0 <= x + k < W:
                m[layer][y * W + x + k] = tile
        if rnd.random() < 0.25:
            x += -1 if rnd.random() < 0.5 else 1
        x = max(1, min(W - width - 1, x))


def blob(m, layer, cx, cy, rx, ry, tile, rnd):
    for y in range(H):
        for x in range(W):
            dx, dy = (x - cx) / rx, (y - cy) / ry
            if dx * dx + dy * dy <= 1 + (rnd.random() - 0.5) * 0.35:
                m[layer][y * W + x] = tile


def add_obj(m, key, t, cx, cy, sx=3, sy=3, flip=False):
    m["objects"].append({
        "s": KEY_IDX[key], "t": t,
        "x": cx * 48, "y": cy * 48,   # TILE=48はエディタと同じ座標系(内部ユニット)
        "sx": sx, "sy": sy, "flip": flip,
    })


def obj_rect(o):
    sh = SHEETS[o["s"]]; ti = sh["tiles"][o["t"]]
    w = ti["w"] * 48 * o["sx"] / TILE_PX
    h = ti["h"] * 48 * o["sy"] / TILE_PX
    return o["x"] - w / 2, o["y"] - h / 2, w, h


# ---- マップ生成 ----
def build():
    m = new_map()
    rnd = random.Random(20260720)
    G = lambda t: tid("ground", t)
    W2 = lambda t: tid("water", t)

    # 1) 下敷き: 草原ベース
    base(m, G(1), [G(0), G(2), G(3), G(5)], 0.15, rnd)

    # 2) 湖(左下)+ 砂浜
    blob(m, "bg1", 5, 15, 4.2, 2.8, G(24), rnd)      # 砂
    blob(m, "bg1", 5, 15, 3.2, 2.0, W2(0), rnd)      # 水

    # 3) 森ゾーンの下地(右上)
    for y in range(0, 6):
        for x in range(20, 28):
            if rnd.random() < 0.6:
                m["bg1"][y * W + x] = G(rnd.choice([0, 2, 3]))

    # 4) 十字の道(bg2、土)
    path_h(m, "bg2", G(24), 11, 2, rnd)
    path_v(m, "bg2", G(24), 13, 2, rnd)

    # 5) 中央広場(bg2、石畳)
    cx, cy = 13, 11
    rectf(m, "bg2", cx - 3, cy - 2, cx + 4, cy + 3, G(48))

    # ---- オブジェクト配置 ----
    # 中央広場に噴水(街小物シートの噴水=index 10前後)
    add_obj(m, "decor", 10, 13, 11.2, sx=2.5, sy=2.5)

    # 家(村の家シート)を広場の周りに配置
    houses = [
        (7, 6, 0),   # 左上の家
        (16, 6, 3),  # 右上の家
        (20, 12, 6),
        (7, 17, 9),
        (17, 17, 12),
    ]
    for hx, hy, ti in houses:
        add_obj(m, "houseC", ti, hx, hy, sx=3.2, sy=3.2)

    # 大型施設: 右下に城、左端に大教会
    add_obj(m, "houseB", 3, 24, 17, sx=4.5, sy=4.5)   # 城
    add_obj(m, "houseB", 0, 2, 5, sx=3.8, sy=3.8)     # ドーム教会

    # 森ゾーンに大樹
    add_obj(m, "trees", 0, 22, 3, sx=4, sy=4)         # バニヤン
    add_obj(m, "trees", 5, 25, 2, sx=3, sy=3)         # 栗
    add_obj(m, "trees", 15, 2, 25, sx=3.5, sy=3.5)    # ライラック
    add_obj(m, "wilds", 6, 24, 5, sx=2.5, sy=2.5)     # 竹

    # 湖畔に自然物(桟橋・水蓮)
    add_obj(m, "facility", 11, 4, 15, sx=2.2, sy=2.2)  # 蓮
    add_obj(m, "facility", 3, 7, 13, sx=2.5, sy=2.5)   # ヤシ

    # 生活物(井戸・柵など)を村に散らす
    add_obj(m, "plants", 0, 10, 10, sx=1.8, sy=1.8)    # 井戸
    add_obj(m, "plants", 14, 16, 13, sx=1.5, sy=1.5)   # 天秤
    add_obj(m, "decor", 12, 15, 10, sx=1.5, sy=1.5)    # 宝箱

    # 街小物: 看板を交差点に
    add_obj(m, "decor", 0, 13, 8, sx=1.4, sy=1.4)      # 看板

    # 小植物を隙間に散らす
    small_seeds = [(9, 8, 21), (12, 15, 22), (18, 8, 20), (11, 12, 3), (20, 10, 25)]
    for x, y, t in small_seeds:
        add_obj(m, "small", t, x, y, sx=1.2, sy=1.2)

    # 森木を森ゾーンに追加
    add_obj(m, "wilds", 0, 21, 4, sx=2.2, sy=2.2)
    add_obj(m, "wilds", 2, 27, 5, sx=2.5, sy=2.5)

    return m


def render(m, out_path):
    img = Image.new("RGBA", (W * CELL, H * CELL), (30, 33, 60, 255))
    # チェッカー背景
    dark = Image.new("RGBA", (CELL, CELL), (40, 42, 68, 255))
    for y in range(H):
        for x in range((y % 2), W, 2):
            img.alpha_composite(dark, (x * CELL, y * CELL))
    # BG1〜3
    for layer in ("bg1", "bg2", "bg3"):
        arr = m[layer]
        for y in range(H):
            for x in range(W):
                v = arr[y * W + x]
                if v >= 0:
                    paste_tile(img, v, x * CELL, y * CELL, CELL, CELL)
        for b in m["big"][layer]:
            paste_tile(img, b["id"], b["x"] * CELL, b["y"] * CELL, b["n"] * CELL, b["n"] * CELL)
    # objects
    k = CELL / 48  # 48はエディタの内部TILE
    for o in m["objects"]:
        x, y, w, h = obj_rect(o)
        if o.get("flip"):
            sh = SHEETS[o["s"]]; ti = sh["tiles"][o["t"]]
            tile = atlases[o["s"]].crop((ti["x"], ti["y"], ti["x"] + ti["w"], ti["y"] + ti["h"]))
            ratio = ti["w"] / ti["h"]
            if ratio < 0.85 or ratio > 1.18:
                kk = min(w * k / ti["w"], h * k / ti["h"])
                pw, ph = max(1, round(ti["w"] * kk)), max(1, round(ti["h"] * kk))
                t2 = tile.resize((pw, ph), Image.LANCZOS)
                px = int(x * k + (w * k - pw) / 2); py = int(y * k + (h * k - ph))
            else:
                t2 = tile.resize((int(w * k), int(h * k)), Image.LANCZOS)
                px, py = int(x * k), int(y * k)
            t2 = t2.transpose(Image.FLIP_LEFT_RIGHT)
            img.alpha_composite(t2, (px, py))
        else:
            paste_tile(img, o["s"] * 1000 + o["t"], x * k, y * k, w * k, h * k)

    img.convert("RGB").save(out_path)
    print("saved:", out_path, img.size)


if __name__ == "__main__":
    m = build()
    out = os.path.join(ROOT, "sample_map.png")
    render(m, out)
