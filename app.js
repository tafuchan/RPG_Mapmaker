"use strict";
/* RPG Map Maker — スマホ向けタイルマップドラフトツール */

const TILE = 48;              // ワールド座標での1セルのpx
const KEY_INDEX = "rpgmm_index_v2";
const KEY_MAP = (id) => "rpgmm_map_" + id;
const OLD_KEY = "rpgmapmaker_v1";
const BG_LAYERS = ["bg1", "bg2", "bg3"];
const TAP_MOVE_PX = 6;        // これ以上動いたらドラッグ扱い
const PINCH_REVERT_MS = 300;  // 描画開始からこの時間内にピンチになったら描画を取り消す
const LONGPRESS_MS = 500;

let meta = null;              // tiles.json
let sheetMap = {};            // sheetIndex -> {key,label,file,cols,count,tiles}
let sheetOrder = [];          // 表示順のsheetIndex列(内蔵0..9 → 追加100..)
let customSheets = [];        // IndexedDB上の追加シートレコード
let atlases = {};             // sheetIndex -> HTMLImageElement
let index = null;             // {maps:[{id,name,w,h,updated,thumb}], last}
let mapId = null;
let map = null;               // {w,h,layers:{bg1:[],...},objects:[]}
let view = { x: 0, y: 0, scale: 1 };
let mode = "bg1";
let tool = "pen";             // pen|rect|fill|eraser|picker
let sel = { sheet: 0, tile: 0 };
let selObj = -1;
let recent = [];              // [{s,t}]
let brush = 1;                // ペン/消しゴムのブラシサイズ(1/2/3)
let showGrid = true;
let dimOthers = false;
let undoStack = [], redoStack = [];
const UNDO_MAX = 100;

const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");
const $ = (id) => document.getElementById(id);

/* ---------------- map data / storage ---------------- */
function newMapData(w, h) {
  return {
    w, h,
    layers: { bg1: new Array(w * h).fill(-1), bg2: new Array(w * h).fill(-1), bg3: new Array(w * h).fill(-1) },
    objects: []               // {s,t,x,y,scale,flip}
  };
}
function tileId(s, t) { return s * 1000 + t; }
function idSheet(id) { return Math.floor(id / 1000); }
function idTile(id) { return id % 1000; }
function getSheet(s) { return sheetMap[s]; }
function loadImage(src) {
  return new Promise((ok, ng) => {
    const im = new Image();
    im.onload = () => ok(im);
    im.onerror = () => ng(new Error("画像を読み込めません"));
    im.src = src;
  });
}
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function loadIndex() {
  try {
    const s = localStorage.getItem(KEY_INDEX);
    if (s) return JSON.parse(s);
  } catch (e) { console.warn(e); }
  const idx = { maps: [], last: null, recent: [] };
  // 旧形式からの移行
  try {
    const old = localStorage.getItem(OLD_KEY);
    if (old) {
      const m = JSON.parse(old);
      if (m && m.w && m.layers) {
        const id = genId();
        idx.maps.push({ id, name: "マップ1", w: m.w, h: m.h, updated: Date.now(), thumb: null });
        localStorage.setItem(KEY_MAP(id), old);
        localStorage.removeItem(OLD_KEY);
      }
    }
  } catch (e) { console.warn(e); }
  return idx;
}
function saveIndex() {
  index.recent = recent;
  try { localStorage.setItem(KEY_INDEX, JSON.stringify(index)); } catch (e) { console.warn(e); }
}
function indexEntry() { return index.maps.find(m => m.id === mapId); }

function saveLocal() {
  clearTimeout(saveLocal._t);
  saveLocal._t = setTimeout(() => {
    if (!map || !mapId) return;
    try {
      localStorage.setItem(KEY_MAP(mapId), JSON.stringify(map));
      const e = indexEntry();
      if (e) {
        e.w = map.w; e.h = map.h; e.updated = Date.now();
        e.thumb = makeThumb();
      }
      saveIndex();
    } catch (e) { console.warn(e); }
  }, 600);
}

function makeThumb() {
  try {
    const P = 4;
    const c = document.createElement("canvas");
    c.width = map.w * P; c.height = map.h * P;
    const g = c.getContext("2d");
    g.fillStyle = "#101120"; g.fillRect(0, 0, c.width, c.height);
    for (const lname of BG_LAYERS) {
      const layer = map.layers[lname];
      for (let y = 0; y < map.h; y++)
        for (let x = 0; x < map.w; x++) {
          const id = layer[y * map.w + x];
          if (id >= 0) drawTile(id, x * P, y * P, P, P, g);
        }
    }
    const k = P / TILE;
    for (const o of map.objects) {
      const d = objDrawRect(o);
      drawTile(tileId(o.s, o.t), d.x * k, d.y * k, d.w * k, d.h * k, g);
    }
    return c.toDataURL("image/jpeg", 0.5);
  } catch (e) { return null; }
}

/* ---------------- undo ---------------- */
function pushUndo(entry) {
  undoStack.push(entry);
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}
function applyEntry(e, dir) {
  if (e.type === "cells") {
    for (const [i, before, after] of e.changes)
      map.layers[e.layer][i] = dir === "undo" ? before : after;
  } else if (e.type === "objects") {
    map.objects = JSON.parse(JSON.stringify(dir === "undo" ? e.before : e.after));
    selObj = -1; hideObjToolbar();
  } else if (e.type === "full") {
    const s = dir === "undo" ? e.before : e.after;
    map.layers = JSON.parse(JSON.stringify(s.layers));
    map.objects = JSON.parse(JSON.stringify(s.objects));
    selObj = -1; hideObjToolbar();
  } else if (e.type === "resize") {
    const s = dir === "undo" ? e.before : e.after;
    map.w = s.w; map.h = s.h;
    map.layers = JSON.parse(JSON.stringify(s.layers));
    map.objects = JSON.parse(JSON.stringify(s.objects));
    selObj = -1; hideObjToolbar();
  }
}
function doUndo() {
  const e = undoStack.pop();
  if (!e) return;
  applyEntry(e, "undo"); redoStack.push(e);
  updateUndoButtons(); saveLocal(); render();
}
function doRedo() {
  const e = redoStack.pop();
  if (!e) return;
  applyEntry(e, "redo"); undoStack.push(e);
  updateUndoButtons(); saveLocal(); render();
}
function updateUndoButtons() {
  $("undoBtn").disabled = undoStack.length === 0;
  $("redoBtn").disabled = redoStack.length === 0;
}
function objSnapshot() { return JSON.parse(JSON.stringify(map.objects)); }
function fullSnapshot() {
  return { layers: JSON.parse(JSON.stringify(map.layers)), objects: JSON.parse(JSON.stringify(map.objects)) };
}

/* ---------------- rendering ---------------- */
function resizeCanvas() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

function drawTile(id, dx, dy, dw, dh, g) {
  const s = idSheet(id), t = idTile(id);
  const sh = getSheet(s);
  if (!sh || !sh.tiles[t] || !atlases[s]) return;
  const ti = sh.tiles[t];
  const ratio = ti.w / ti.h;
  if (ratio < 0.85 || ratio > 1.18) {
    // 非正方形タイル(橋・崖パーツ等)はセル内でアスペクト維持、下端揃え
    const k = Math.min(dw / ti.w, dh / ti.h);
    const w = ti.w * k, h = ti.h * k;
    (g || ctx).drawImage(atlases[s], ti.x, ti.y, ti.w, ti.h, dx + (dw - w) / 2, dy + (dh - h), w, h);
  } else {
    (g || ctx).drawImage(atlases[s], ti.x, ti.y, ti.w, ti.h, dx, dy, dw, dh);
  }
}

function render() {
  if (!map) return;
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  const sc = view.scale, ts = TILE * sc;
  const ox = -view.x * sc, oy = -view.y * sc;

  ctx.fillStyle = "#23253c";
  ctx.fillRect(ox, oy, map.w * ts, map.h * ts);
  ctx.fillStyle = "#282a44";
  for (let y = 0; y < map.h; y++)
    for (let x = (y % 2); x < map.w; x += 2)
      ctx.fillRect(ox + x * ts, oy + y * ts, ts, ts);

  const x0 = Math.max(0, Math.floor((0 - ox) / ts)), x1 = Math.min(map.w - 1, Math.ceil((r.width - ox) / ts));
  const y0 = Math.max(0, Math.floor((0 - oy) / ts)), y1 = Math.min(map.h - 1, Math.ceil((r.height - oy) / ts));

  ctx.imageSmoothingEnabled = true;
  for (const lname of BG_LAYERS) {
    const dim = dimOthers && mode !== "obj" && mode !== lname;
    ctx.globalAlpha = dim ? 0.3 : 1;
    const layer = map.layers[lname];
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const id = layer[y * map.w + x];
        if (id >= 0) drawTile(id, ox + x * ts, oy + y * ts, ts + 0.6, ts + 0.6);
      }
  }
  ctx.globalAlpha = dimOthers && mode !== "obj" ? 0.5 : 1;

  for (let i = 0; i < map.objects.length; i++) {
    const o = map.objects[i];
    const d = objDrawRect(o);
    ctx.save();
    if (o.flip) {
      ctx.translate(ox + (d.x + d.w / 2) * sc, 0);
      ctx.scale(-1, 1);
      ctx.translate(-(ox + (d.x + d.w / 2) * sc), 0);
    }
    drawTile(tileId(o.s, o.t), ox + d.x * sc, oy + d.y * sc, d.w * sc, d.h * sc);
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  if (mode === "obj" && selObj >= 0 && map.objects[selObj]) {
    const d = objDrawRect(map.objects[selObj]);
    ctx.strokeStyle = "#ffb648"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.strokeRect(ox + d.x * sc - 3, oy + d.y * sc - 3, d.w * sc + 6, d.h * sc + 6);
    ctx.setLineDash([]);
    // 縦横リサイズハンドル(右・下・右下角)
    for (const hnd of objHandlePositions()) {
      ctx.fillStyle = "#ffb648";
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
      ctx.fillRect(hnd.x - HANDLE_PX / 2, hnd.y - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
      ctx.strokeRect(hnd.x - HANDLE_PX / 2, hnd.y - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
    }
  }

  // 四角塗りのプレビュー
  if (rectSel) {
    const ax = Math.min(rectSel.a.x, rectSel.b.x), ay = Math.min(rectSel.a.y, rectSel.b.y);
    const bx = Math.max(rectSel.a.x, rectSel.b.x), by = Math.max(rectSel.a.y, rectSel.b.y);
    ctx.fillStyle = tool === "eraser" ? "rgba(255,80,80,0.25)" : "rgba(91,140,255,0.30)";
    ctx.fillRect(ox + ax * ts, oy + ay * ts, (bx - ax + 1) * ts, (by - ay + 1) * ts);
    ctx.strokeStyle = "#ffb648"; ctx.lineWidth = 2;
    ctx.strokeRect(ox + ax * ts, oy + ay * ts, (bx - ax + 1) * ts, (by - ay + 1) * ts);
  }

  if (showGrid && ts >= 8) {
    ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0; x <= x1 + 1; x++) { ctx.moveTo(ox + x * ts, oy + y0 * ts); ctx.lineTo(ox + x * ts, oy + (y1 + 1) * ts); }
    for (let y = y0; y <= y1 + 1; y++) { ctx.moveTo(ox + x0 * ts, oy + y * ts); ctx.lineTo(ox + (x1 + 1) * ts, oy + y * ts); }
    ctx.stroke();
  }

  ctx.strokeStyle = "#5b8cff88"; ctx.lineWidth = 2;
  ctx.strokeRect(ox, oy, map.w * ts, map.h * ts);

  // リサイズ中は新しい境界を点線でプレビュー
  if (resize) {
    ctx.strokeStyle = "#ffb648"; ctx.lineWidth = 2; ctx.setLineDash([8, 5]);
    ctx.strokeRect(ox - resize.addLeft * ts, oy - resize.addTop * ts,
      resize.newW * ts, resize.newH * ts);
    ctx.setLineDash([]);
  }

  // マップ端のリサイズハンドル(ペイント風)
  for (const hnd of handlePositions()) {
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#5b8cff"; ctx.lineWidth = 2;
    ctx.fillRect(hnd.x - HANDLE_PX / 2, hnd.y - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
    ctx.strokeRect(hnd.x - HANDLE_PX / 2, hnd.y - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
  }
}

const HANDLE_PX = 12;
const HANDLE_HIT = 24;
function handlePositions() {
  const sc = view.scale, ts = TILE * sc;
  const ox = -view.x * sc, oy = -view.y * sc;
  const w = map.w * ts, h = map.h * ts;
  return [
    { k: "r", x: ox + w, y: oy + h / 2 },
    { k: "b", x: ox + w / 2, y: oy + h },
    { k: "br", x: ox + w, y: oy + h },
    { k: "l", x: ox, y: oy + h / 2 },
    { k: "t", x: ox + w / 2, y: oy },
  ];
}
function hitHandle(p) {
  for (const hnd of handlePositions())
    if (Math.abs(p.x - hnd.x) <= HANDLE_HIT && Math.abs(p.y - hnd.y) <= HANDLE_HIT) return hnd;
  return null;
}

function objHandlePositions() {
  if (selObj < 0 || !map.objects[selObj]) return [];
  const d = objDrawRect(map.objects[selObj]);
  const sc = view.scale;
  const x0 = (d.x - view.x) * sc, y0 = (d.y - view.y) * sc;
  const w = d.w * sc, h = d.h * sc;
  return [
    { k: "r", x: x0 + w + 8, y: y0 + h / 2 },
    { k: "b", x: x0 + w / 2, y: y0 + h + 8 },
    { k: "br", x: x0 + w + 8, y: y0 + h + 8 },
  ];
}
function hitObjHandle(p) {
  for (const hnd of objHandlePositions())
    if (Math.abs(p.x - hnd.x) <= HANDLE_HIT && Math.abs(p.y - hnd.y) <= HANDLE_HIT) return hnd;
  return null;
}

/* マップサイズ変更: offX/offY = 左/上に追加する列・行数(負なら削除) */
function resizeMapTo(newW, newH, offX, offY) {
  const before = { w: map.w, h: map.h, layers: JSON.parse(JSON.stringify(map.layers)), objects: objSnapshot() };
  const nm = newMapData(newW, newH);
  for (const l of BG_LAYERS)
    for (let y = 0; y < map.h; y++) {
      const ny = y + offY;
      if (ny < 0 || ny >= newH) continue;
      for (let x = 0; x < map.w; x++) {
        const nx = x + offX;
        if (nx < 0 || nx >= newW) continue;
        nm.layers[l][ny * newW + nx] = map.layers[l][y * map.w + x];
      }
    }
  nm.objects = map.objects.map(o => ({ ...o, x: o.x + offX * TILE, y: o.y + offY * TILE }));
  map = nm;
  selObj = -1; hideObjToolbar();
  pushUndo({ type: "resize", before, after: { w: map.w, h: map.h, layers: JSON.parse(JSON.stringify(map.layers)), objects: objSnapshot() } });
  saveLocal();
}

function objScales(o) {
  // 旧形式(scale単一)との互換
  const sx = o.sx !== undefined ? o.sx : (o.scale !== undefined ? o.scale : 1);
  const sy = o.sy !== undefined ? o.sy : (o.scale !== undefined ? o.scale : 1);
  return { sx, sy };
}
function objDrawRect(o) {
  const sh = getSheet(o.s), ti = sh && sh.tiles[o.t];
  if (!ti) return { x: o.x - 1, y: o.y - 1, w: 2, h: 2 };
  const { sx, sy } = objScales(o);
  const w = ti.w * TILE * sx / meta.tilePx, h = ti.h * TILE * sy / meta.tilePx;
  return { x: o.x - w / 2, y: o.y - h / 2, w, h };
}
function normObjects(list) {
  for (const o of list || []) {
    if (o.sx === undefined) { const s = objScales(o); o.sx = s.sx; o.sy = s.sy; }
  }
}

/* ---------------- coords ---------------- */
function screenToWorld(px, py) {
  return { x: px / view.scale + view.x, y: py / view.scale + view.y };
}
function worldToCell(w) { return { x: Math.floor(w.x / TILE), y: Math.floor(w.y / TILE) }; }
function inMap(c) { return c.x >= 0 && c.y >= 0 && c.x < map.w && c.y < map.h; }
function clampCell(c) {
  return { x: Math.max(0, Math.min(map.w - 1, c.x)), y: Math.max(0, Math.min(map.h - 1, c.y)) };
}

/* ---------------- painting ---------------- */
let stroke = null;   // {layer, changes:Map(idx->[before,after]), lastCell}
let rectSel = null;  // {a:cell, b:cell} 四角塗りプレビュー

function beginStroke(c) {
  stroke = { layer: mode, changes: new Map(), lastCell: c };
  paintBlock(c);
}
function paintBlock(c) {
  const off = brush === 3 ? -1 : 0;   // 3×3は中心塗り、2×2は右下方向
  for (let dy = 0; dy < brush; dy++)
    for (let dx = 0; dx < brush; dx++)
      paintCell({ x: c.x + dx + off, y: c.y + dy + off });
}
function paintCell(c) {
  if (!inMap(c)) return;
  const layer = map.layers[mode];
  const i = c.y * map.w + c.x;
  const val = tool === "eraser" ? -1 : tileId(sel.sheet, sel.tile);
  if (layer[i] === val) return;
  if (!stroke.changes.has(i)) stroke.changes.set(i, [layer[i], val]);
  else stroke.changes.get(i)[1] = val;
  layer[i] = val;
}
function paintLine(c0, c1) {
  const n = Math.max(Math.abs(c1.x - c0.x), Math.abs(c1.y - c0.y));
  for (let i = 0; i <= n; i++)
    paintBlock({ x: Math.round(c0.x + (c1.x - c0.x) * i / (n || 1)), y: Math.round(c0.y + (c1.y - c0.y) * i / (n || 1)) });
}
function endStroke() {
  if (stroke && stroke.changes.size) {
    pushUndo({ type: "cells", layer: stroke.layer, changes: [...stroke.changes.entries()].map(([i, [b, a]]) => [i, b, a]) });
    saveLocal();
  }
  stroke = null;
}
function revertStroke() {
  if (stroke) {
    for (const [i, [before]] of stroke.changes.entries())
      map.layers[stroke.layer][i] = before;
  }
  stroke = null;
}

function commitRect(a, b) {
  const ax = Math.max(0, Math.min(a.x, b.x)), ay = Math.max(0, Math.min(a.y, b.y));
  const bx = Math.min(map.w - 1, Math.max(a.x, b.x)), by = Math.min(map.h - 1, Math.max(a.y, b.y));
  const layer = map.layers[mode];
  const val = tileId(sel.sheet, sel.tile);
  const changes = [];
  for (let y = ay; y <= by; y++)
    for (let x = ax; x <= bx; x++) {
      const i = y * map.w + x;
      if (layer[i] !== val) { changes.push([i, layer[i], val]); layer[i] = val; }
    }
  if (changes.length) {
    pushUndo({ type: "cells", layer: mode, changes });
    saveLocal();
  }
}

function floodFill(c) {
  if (!inMap(c)) return;
  const layer = map.layers[mode];
  const target = layer[c.y * map.w + c.x];
  const val = tileId(sel.sheet, sel.tile);
  if (target === val) return;
  const changes = [];
  const q = [c.y * map.w + c.x];
  const seen = new Set(q);
  while (q.length) {
    const i = q.pop();
    if (layer[i] !== target) continue;
    changes.push([i, target, val]);
    layer[i] = val;
    const x = i % map.w, y = Math.floor(i / map.w);
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
      const ni = ny * map.w + nx;
      if (!seen.has(ni)) { seen.add(ni); q.push(ni); }
    }
  }
  if (changes.length) {
    pushUndo({ type: "cells", layer: mode, changes });
    saveLocal(); render();
  }
}

function pickTile(c) {
  if (!inMap(c)) return false;
  const i = c.y * map.w + c.x;
  const order = [mode, "bg3", "bg2", "bg1"].filter((v, k, a) => v !== "obj" && a.indexOf(v) === k);
  for (const l of order) {
    const id = map.layers[l][i];
    if (id >= 0) {
      selectTile(idSheet(id), idTile(id));
      buildPaletteTabs(); buildPaletteGrid();
      if (tool === "picker") setTool("pen");
      return true;
    }
  }
  return false;
}

/* ---------------- tile selection / recent ---------------- */
function selectTile(s, t) {
  sel.sheet = s; sel.tile = t;
  recent = [{ s, t }, ...recent.filter(r => !(r.s === s && r.t === t))].slice(0, 16);
  updateSelChip(); buildRecentRow(); saveIndex();
}
function tileBgStyle(el, s, t, cssPx) {
  const sh = getSheet(s);
  if (!sh || t >= sh.count) { el.style.backgroundImage = "none"; return; }
  const col = t % sh.cols, row = Math.floor(t / sh.cols);
  const rows = Math.ceil(sh.count / sh.cols);
  el.style.backgroundImage = `url(${sh.file})`;
  el.style.backgroundSize = `${sh.cols * 100}% ${rows * 100}%`;
  el.style.backgroundPosition =
    `${sh.cols > 1 ? (col * 100 / (sh.cols - 1)) : 0}% ${rows > 1 ? (row * 100 / (rows - 1)) : 0}%`;
}
function updateSelChip() { tileBgStyle($("selChip"), sel.sheet, sel.tile); }

/* ---------------- objects ---------------- */
function hitObject(w) {
  for (let i = map.objects.length - 1; i >= 0; i--) {
    const d = objDrawRect(map.objects[i]);
    if (w.x >= d.x && w.x <= d.x + d.w && w.y >= d.y && w.y <= d.y + d.h) return i;
  }
  return -1;
}

function addObjectAtCenter() {
  const r = canvas.getBoundingClientRect();
  const w = screenToWorld(r.width / 2, r.height / 2);
  const before = objSnapshot();
  map.objects.push({
    s: sel.sheet, t: sel.tile,
    x: Math.max(0, Math.min(map.w * TILE, w.x)),
    y: Math.max(0, Math.min(map.h * TILE, w.y)),
    sx: 3, sy: 3, flip: false   // 初期サイズは3×3マス相当
  });
  selObj = map.objects.length - 1;
  pushUndo({ type: "objects", before, after: objSnapshot() });
  saveLocal(); render(); showObjToolbar();
}

const objToolbar = $("objToolbar");
function showObjToolbar() {
  if (selObj < 0 || !map.objects[selObj]) { hideObjToolbar(); return; }
  const d = objDrawRect(map.objects[selObj]);
  const sc = view.scale;
  const sx = (d.x + d.w / 2 - view.x) * sc, sy = (d.y - view.y) * sc;
  objToolbar.classList.remove("hidden");
  const r = canvas.getBoundingClientRect();
  const tw = objToolbar.offsetWidth || 230;
  let left = sx - tw / 2, top = sy - 56;
  left = Math.max(4, Math.min(r.width - tw - 4, left));
  if (top < 4) top = Math.min(r.height - 52, (d.y + d.h - view.y) * sc + 12);
  objToolbar.style.left = left + "px";
  objToolbar.style.top = top + "px";
}
function hideObjToolbar() { objToolbar.classList.add("hidden"); }

function objAction(fn) {
  if (selObj < 0 || !map.objects[selObj]) return;
  const before = objSnapshot();
  fn();
  pushUndo({ type: "objects", before, after: objSnapshot() });
  saveLocal(); render();
  if (selObj >= 0) showObjToolbar(); else hideObjToolbar();
}
function objScaleBy(k) {
  objAction(() => {
    const o = map.objects[selObj];
    const s = objScales(o);
    o.sx = Math.max(0.2, Math.min(20, s.sx * k));
    o.sy = Math.max(0.2, Math.min(20, s.sy * k));
    showZoomHint(o.sx.toFixed(2) === o.sy.toFixed(2)
      ? "×" + o.sx.toFixed(2) : `${o.sx.toFixed(2)} × ${o.sy.toFixed(2)}`);
  });
}
$("objSmaller").addEventListener("click", () => objScaleBy(1 / 1.2));
$("objBigger").addEventListener("click", () => objScaleBy(1.2));
$("objDel").addEventListener("click", () => objAction(() => {
  map.objects.splice(selObj, 1); selObj = -1;
}));
$("objDup").addEventListener("click", () => objAction(() => {
  const o = JSON.parse(JSON.stringify(map.objects[selObj]));
  o.x += TILE; o.y += TILE;
  map.objects.push(o); selObj = map.objects.length - 1;
}));
$("objFlip").addEventListener("click", () => objAction(() => {
  map.objects[selObj].flip = !map.objects[selObj].flip;
}));
$("objFront").addEventListener("click", () => objAction(() => {
  const [o] = map.objects.splice(selObj, 1);
  map.objects.push(o); selObj = map.objects.length - 1;
}));
$("objBack").addEventListener("click", () => objAction(() => {
  const [o] = map.objects.splice(selObj, 1);
  map.objects.unshift(o); selObj = 0;
}));

/* ---------------- pointer input ----------------
   タップ即描画はしない: 動き始めたら描画、タップは指を離した時に1マス。
   ピンチ開始時は描画中でも取り消してズームに移行する。 */
const pointers = new Map();
let gesture = null;   // pending|paint|rect|pan|pinch|objdrag|objpinch|longpicked|resize
let down = null;      // {p, t, cell, world}
let resize = null;    // {edge, w0, h0, world, newW, newH, addLeft, addTop}
let objResize = null; // {edge, sx0, sy0, world, baseW, baseH}
let pinch0 = null;
let objDrag0 = null;
let objBefore = null;
let longPressT = null;

function pdist() {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y) || 1;
}
function pmid() {
  const [a, b] = [...pointers.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function cancelLongPress() { clearTimeout(longPressT); longPressT = null; }

canvas.addEventListener("pointerdown", (ev) => {
  try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic pointer等 */ }
  const rect = canvas.getBoundingClientRect();
  const p = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  pointers.set(ev.pointerId, p);

  if (pointers.size === 1) {
    const w = screenToWorld(p.x, p.y);
    const c = worldToCell(w);
    down = { p, t: performance.now(), cell: c, world: w };
    const objHnd = mode === "obj" ? hitObjHandle(p) : null;
    const hnd = objHnd ? null : hitHandle(p);
    if (objHnd) {
      const o = map.objects[selObj];
      const { sx, sy } = objScales(o);
      const sh = getSheet(o.s), ti = sh.tiles[o.t];
      gesture = "objresize";
      objBefore = objSnapshot();
      objResize = {
        edge: objHnd.k, sx0: sx, sy0: sy, world: w,
        baseW: ti.w * TILE / meta.tilePx, baseH: ti.h * TILE / meta.tilePx
      };
      hideObjToolbar();
    } else if (hnd) {
      gesture = "resize";
      resize = { edge: hnd.k, w0: map.w, h0: map.h, world: w, newW: map.w, newH: map.h, addLeft: 0, addTop: 0 };
      render();
    } else if (mode === "obj") {
      const hit = hitObject(w);
      if (hit >= 0) {
        selObj = hit;
        objBefore = objSnapshot();
        objDrag0 = { ox: map.objects[hit].x - w.x, oy: map.objects[hit].y - w.y };
        gesture = "objdrag";
        hideObjToolbar();
      } else {
        // 選択は維持したままパン(選択解除は「動かさずタップ」した時だけ)
        hideObjToolbar();
        gesture = "pan";
      }
      render();
    } else {
      gesture = "pending";
      // 長押しスポイト
      cancelLongPress();
      longPressT = setTimeout(() => {
        if (gesture === "pending" && pointers.size === 1) {
          if (pickTile(down.cell)) {
            gesture = "longpicked";
            if (navigator.vibrate) navigator.vibrate(15);
            showZoomHint("💧 タイルを取得");
          }
        }
      }, LONGPRESS_MS);
    }
  } else if (pointers.size === 2) {
    cancelLongPress();
    if (gesture === "paint") {
      // 描画直後のピンチは誤操作: 取り消す。時間が経っていれば確定
      if (performance.now() - down.t < PINCH_REVERT_MS) revertStroke();
      else endStroke();
    }
    if (gesture === "rect") rectSel = null;
    if (gesture === "resize") resize = null;
    if (gesture === "objresize") objResize = null;
    if (mode === "obj" && selObj >= 0 && map.objects[selObj]) {
      // 選択中なら画面のどこをピンチしてもオブジェクトを拡縮
      gesture = "objpinch";
      if (!objBefore) objBefore = objSnapshot();
      const s = objScales(map.objects[selObj]);
      pinch0 = { dist: pdist(), sx0: s.sx, sy0: s.sy };
    } else {
      gesture = "pinch";
      const m = pmid();
      pinch0 = { dist: pdist(), scale: view.scale, world: screenToWorld(m.x, m.y) };
    }
    render();
  }
});

canvas.addEventListener("pointermove", (ev) => {
  if (!pointers.has(ev.pointerId)) return;
  const rect = canvas.getBoundingClientRect();
  const p = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  const prev = pointers.get(ev.pointerId);
  pointers.set(ev.pointerId, p);

  if (down && Math.hypot(p.x - down.p.x, p.y - down.p.y) > TAP_MOVE_PX) down.moved = true;

  if (pointers.size === 1) {
    const c = worldToCell(screenToWorld(p.x, p.y));
    if (gesture === "objresize" && selObj >= 0) {
      const wNow = screenToWorld(p.x, p.y);
      const o = map.objects[selObj];
      const clampS = (v) => Math.max(0.2, Math.min(20, v));
      if (objResize.edge === "r" || objResize.edge === "br")
        o.sx = clampS(objResize.sx0 + (wNow.x - objResize.world.x) / objResize.baseW);
      if (objResize.edge === "b" || objResize.edge === "br")
        o.sy = clampS(objResize.sy0 + (wNow.y - objResize.world.y) / objResize.baseH);
      showZoomHint(`${o.sx.toFixed(2)} × ${o.sy.toFixed(2)}`);
      render();
      return;
    }
    if (gesture === "resize") {
      const wNow = screenToWorld(p.x, p.y);
      const dx = Math.round((wNow.x - resize.world.x) / TILE);
      const dy = Math.round((wNow.y - resize.world.y) / TILE);
      const clamp = (v) => Math.max(8, Math.min(100, v));
      let newW = resize.w0, newH = resize.h0, addLeft = 0, addTop = 0;
      if (resize.edge === "r" || resize.edge === "br") newW = clamp(resize.w0 + dx);
      if (resize.edge === "b" || resize.edge === "br") newH = clamp(resize.h0 + dy);
      if (resize.edge === "l") { newW = clamp(resize.w0 - dx); addLeft = newW - resize.w0; }
      if (resize.edge === "t") { newH = clamp(resize.h0 - dy); addTop = newH - resize.h0; }
      Object.assign(resize, { newW, newH, addLeft, addTop });
      showZoomHint(`${newW} × ${newH}`);
      render();
      return;
    }
    if (gesture === "pending") {
      if (Math.hypot(p.x - down.p.x, p.y - down.p.y) > TAP_MOVE_PX) {
        cancelLongPress();
        if (tool === "pen" || tool === "eraser") {
          gesture = "paint";
          beginStroke(down.cell);
          paintLine(down.cell, c);
          stroke.lastCell = c;
          render();
        } else if (tool === "rect") {
          gesture = "rect";
          rectSel = { a: clampCell(down.cell), b: clampCell(c) };
          render();
        } else {
          gesture = "pan";  // fill/pickerはドラッグでパン
        }
      }
    } else if (gesture === "paint") {
      if (c.x !== stroke.lastCell.x || c.y !== stroke.lastCell.y) {
        paintLine(stroke.lastCell, c);
        stroke.lastCell = c;
        render();
      }
    } else if (gesture === "rect") {
      rectSel.b = clampCell(c);
      render();
    } else if (gesture === "pan") {
      view.x -= (p.x - prev.x) / view.scale;
      view.y -= (p.y - prev.y) / view.scale;
      render();
    } else if (gesture === "objdrag" && selObj >= 0) {
      const w = screenToWorld(p.x, p.y);
      map.objects[selObj].x = w.x + objDrag0.ox;
      map.objects[selObj].y = w.y + objDrag0.oy;
      render();
    }
  } else if (pointers.size === 2) {
    if (gesture === "objpinch" && selObj >= 0) {
      const k = pdist() / pinch0.dist;
      const o = map.objects[selObj];
      o.sx = Math.max(0.2, Math.min(20, pinch0.sx0 * k));
      o.sy = Math.max(0.2, Math.min(20, pinch0.sy0 * k));
      showZoomHint(o.sx.toFixed(2) === o.sy.toFixed(2)
        ? "×" + o.sx.toFixed(2) : `${o.sx.toFixed(2)} × ${o.sy.toFixed(2)}`);
      render();
    } else if (gesture === "pinch") {
      const m = pmid();
      const sc = Math.max(0.15, Math.min(5, pinch0.scale * pdist() / pinch0.dist));
      view.scale = sc;
      view.x = pinch0.world.x - m.x / sc;
      view.y = pinch0.world.y - m.y / sc;
      showZoomHint(Math.round(sc * 100) + "%");
      render();
    }
  }
});

function pointerEnd(ev) {
  if (!pointers.has(ev.pointerId)) return;
  pointers.delete(ev.pointerId);
  cancelLongPress();
  if (pointers.size === 0) {
    if (gesture === "pending") {
      // タップ確定
      const c = down.cell;
      if (tool === "pen" || tool === "eraser") {
        beginStroke(c); endStroke(); render();
      } else if (tool === "rect") {
        commitRect(c, c); render();
      } else if (tool === "fill") {
        floodFill(c);
      } else if (tool === "picker") {
        pickTile(c);
      }
    } else if (gesture === "paint") {
      endStroke();
    } else if (gesture === "rect") {
      const r = rectSel; rectSel = null;
      if (r) commitRect(r.a, r.b);
      render();
    } else if (gesture === "resize") {
      const rs = resize; resize = null;
      if (rs && (rs.newW !== rs.w0 || rs.newH !== rs.h0))
        resizeMapTo(rs.newW, rs.newH, rs.addLeft, rs.addTop);
      render();
    } else if (gesture === "pan" && mode === "obj" && down && !down.moved && selObj >= 0) {
      // 空きを動かさずタップ → 選択解除
      selObj = -1; hideObjToolbar(); render();
    } else if ((gesture === "objdrag" || gesture === "objpinch" || gesture === "objresize") && objBefore) {
      const after = objSnapshot();
      if (JSON.stringify(after) !== JSON.stringify(objBefore))
        pushUndo({ type: "objects", before: objBefore, after });
      objBefore = null;
      saveLocal();
    }
    if (mode === "obj" && selObj >= 0) showObjToolbar();
    gesture = null; pinch0 = null; down = null; objResize = null;
  } else if (pointers.size === 1) {
    // ピンチから1本残り → パンへ(オブジェクト選択は維持)
    gesture = "pan";
  }
}
canvas.addEventListener("pointerup", pointerEnd);
canvas.addEventListener("pointercancel", pointerEnd);
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

/* desktop: ホイールズーム */
canvas.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
  const w = screenToWorld(px, py);
  const sc = Math.max(0.15, Math.min(5, view.scale * (ev.deltaY < 0 ? 1.1 : 0.9)));
  view.scale = sc;
  view.x = w.x - px / sc;
  view.y = w.y - py / sc;
  showZoomHint(Math.round(sc * 100) + "%");
  render();
}, { passive: false });

let zoomHintT = null;
function showZoomHint(text) {
  const el = $("zoomHint");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(zoomHintT);
  zoomHintT = setTimeout(() => el.classList.add("hidden"), 900);
}

/* ---------------- UI: modes / tools ---------------- */
document.querySelectorAll(".mode-tab").forEach(b => {
  b.addEventListener("click", () => {
    mode = b.dataset.mode;
    document.querySelectorAll(".mode-tab").forEach(x => x.classList.toggle("active", x === b));
    selObj = -1; hideObjToolbar();
    document.querySelectorAll("#toolbar .tool").forEach(t => {
      t.style.display = mode === "obj" ? "none" : "";
    });
    render();
  });
});

function setTool(t) {
  tool = t;
  document.querySelectorAll(".tool").forEach(b => b.classList.toggle("active", b.dataset.tool === t));
}
document.querySelectorAll(".tool").forEach(b => b.addEventListener("click", () => setTool(b.dataset.tool)));
$("brushBtn").addEventListener("click", () => {
  brush = brush % 3 + 1;
  $("brushBtn").textContent = brush + "×";
  $("brushBtn").classList.toggle("active", brush > 1);
  showZoomHint(`ブラシ ${brush}×${brush}`);
});
$("undoBtn").addEventListener("click", doUndo);
$("redoBtn").addEventListener("click", doRedo);
$("fitBtn").addEventListener("click", () => { fitView(); render(); });
$("selChip").addEventListener("click", () => {
  const p = $("palette");
  if (p.classList.contains("collapsed")) togglePalette();
});
$("paletteToggle").addEventListener("click", togglePalette);
function togglePalette() {
  const p = $("palette");
  p.classList.toggle("collapsed");
  $("paletteToggle").textContent = p.classList.contains("collapsed") ? "▲" : "▼";
  setTimeout(resizeCanvas, 220);
}

/* ---------------- palette ---------------- */
function buildPaletteTabs() {
  const tabs = $("paletteTabs");
  tabs.innerHTML = "";
  for (const i of sheetOrder) {
    const sh = sheetMap[i];
    const b = document.createElement("button");
    b.textContent = sh.label;
    b.classList.toggle("active", i === sel.sheet);
    b.addEventListener("click", () => { sel.sheet = i; sel.tile = 0; updateSelChip(); buildPaletteTabs(); buildPaletteGrid(); });
    tabs.appendChild(b);
  }
  const add = document.createElement("button");
  add.textContent = "＋";
  add.title = "タイルシートを追加";
  add.addEventListener("click", () => $("sheetFile").click());
  tabs.appendChild(add);
}

function buildPaletteGrid() {
  const grid = $("paletteGrid");
  grid.innerHTML = "";
  const sh = getSheet(sel.sheet);
  if (!sh) return;
  for (let t = 0; t < sh.count; t++) {
    const b = document.createElement("button");
    b.className = "tile-btn" + (t === sel.tile ? " selected" : "");
    tileBgStyle(b, sel.sheet, t);
    b.addEventListener("click", () => {
      selectTile(sel.sheet, t);
      grid.querySelectorAll(".tile-btn").forEach((x, k) => x.classList.toggle("selected", k === t));
      if (mode === "obj") addObjectAtCenter();
      else if (tool === "eraser" || tool === "picker") setTool("pen");
    });
    grid.appendChild(b);
  }
}

function buildRecentRow() {
  const row = $("recentRow"), box = $("recentTiles");
  if (!recent.length) { row.classList.add("hidden"); return; }
  row.classList.remove("hidden");
  box.innerHTML = "";
  for (const rt of recent) {
    if (!getSheet(rt.s) || rt.t >= getSheet(rt.s).count) continue;
    const b = document.createElement("button");
    b.className = "tile-btn" + (rt.s === sel.sheet && rt.t === sel.tile ? " selected" : "");
    tileBgStyle(b, rt.s, rt.t);
    b.addEventListener("click", () => {
      sel.sheet = rt.s;
      selectTile(rt.s, rt.t);
      buildPaletteTabs(); buildPaletteGrid();
      if (mode === "obj") addObjectAtCenter();
      else if (tool === "eraser" || tool === "picker") setTool("pen");
    });
    box.appendChild(b);
  }
}

/* ---------------- custom tilesheets (upload) ----------------
   PC側 tools/slice_tiles.py と同じロジックのJS移植:
   マゼンタ/透過を背景として連結成分でタイルを検出し、アトラスに詰めてIndexedDBへ保存 */
const STRIP_WORDS = ["のピクセルタイルシート", "ピクセルタイルシート", "のタイルシート",
  "タイルシート", "のタイルセット", "タイルセット", "のピクセルタイル",
  "ピクセルタイル", "ドット絵", "ファンタジー"];

function idbOpen() {
  return new Promise((ok, ng) => {
    const rq = indexedDB.open("rpgmm", 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore("sheets", { keyPath: "id" });
    rq.onsuccess = () => ok(rq.result);
    rq.onerror = () => ng(rq.error);
  });
}
async function idbAll() {
  const db = await idbOpen();
  return new Promise((ok, ng) => {
    const rq = db.transaction("sheets").objectStore("sheets").getAll();
    rq.onsuccess = () => ok(rq.result || []);
    rq.onerror = () => ng(rq.error);
  });
}
async function idbPut(rec) {
  const db = await idbOpen();
  return new Promise((ok, ng) => {
    const tx = db.transaction("sheets", "readwrite");
    tx.objectStore("sheets").put(rec);
    tx.oncomplete = ok; tx.onerror = () => ng(tx.error);
  });
}
async function idbDel(id) {
  const db = await idbOpen();
  return new Promise((ok, ng) => {
    const tx = db.transaction("sheets", "readwrite");
    tx.objectStore("sheets").delete(id);
    tx.oncomplete = ok; tx.onerror = () => ng(tx.error);
  });
}

function dilate(src, k, W, H) {
  let a = new Uint8Array(src);
  let b = new Uint8Array(a.length);
  for (let it = 0; it < k; it++) {
    for (let i = 0; i < a.length; i++) {
      if (a[i]) { b[i] = 1; continue; }
      const x = i % W, y = (i / W) | 0;
      b[i] = ((x > 0 && a[i - 1]) || (x < W - 1 && a[i + 1]) ||
              (y > 0 && a[i - W]) || (y < H - 1 && a[i + W])) ? 1 : 0;
    }
    const t = a; a = b; b = t;
  }
  return a;
}

function processSheetImage(img) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, W, H);
  const px = data.data;
  const n = W * H;
  // しきい値は基準解像度1254pxに対する比率でスケール
  const S = Math.max(0.4, Math.max(W, H) / 1254);
  const RING = Math.max(2, Math.round(4 * S));
  const BRIDGE = Math.max(2, Math.round(3 * S));
  const MERGE_GAP = 16 * S, MAX_TILE = 180 * S, MIN_AREA = 400 * S * S;

  // 背景判定: 既存の透過 or 純マゼンタ
  const hard = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = px[i * 4], gg = px[i * 4 + 1], b = px[i * 4 + 2], a = px[i * 4 + 3];
    if (a < 30) { hard[i] = 1; continue; }
    const dr = r - 255, db = b - 255;
    if (dr * dr + gg * gg + db * db < 105 * 105) hard[i] = 1;
  }
  // 境界リングのマゼンタフリンジ除去
  const ring = dilate(hard, RING, W, H);
  const transparent = new Uint8Array(n);
  const content = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (hard[i]) transparent[i] = 1;
    else if (ring[i] && Math.min(px[i * 4], px[i * 4 + 2]) - px[i * 4 + 1] > 45) transparent[i] = 1;
    content[i] = transparent[i] ? 0 : 1;
  }
  // 連結成分(タイル内の細かい隙間はブリッジ)
  const bridged = dilate(content, BRIDGE, W, H);
  const label = new Int32Array(n);
  let boxes = [];
  const stack = [];
  let cur = 0;
  for (let seed = 0; seed < n; seed++) {
    if (!bridged[seed] || label[seed]) continue;
    cur++;
    let minx = W, miny = H, maxx = -1, maxy = -1, area = 0;
    label[seed] = cur; stack.push(seed);
    while (stack.length) {
      const j = stack.pop();
      const x = j % W, y = (j / W) | 0;
      if (content[j]) {
        area++;
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
      if (x > 0 && bridged[j - 1] && !label[j - 1]) { label[j - 1] = cur; stack.push(j - 1); }
      if (x < W - 1 && bridged[j + 1] && !label[j + 1]) { label[j + 1] = cur; stack.push(j + 1); }
      if (y > 0 && bridged[j - W] && !label[j - W]) { label[j - W] = cur; stack.push(j - W); }
      if (y < H - 1 && bridged[j + W] && !label[j + W]) { label[j + W] = cur; stack.push(j + W); }
    }
    if (area > 0) boxes.push([minx, miny, maxx + 1, maxy + 1, area]);
  }
  // 断片統合: 近接かつ統合後もタイルサイズ以内なら結合
  let mergedFlag = true;
  while (mergedFlag) {
    mergedFlag = false;
    outer:
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const gx = Math.max(a[0], b[0]) - Math.min(a[2], b[2]);
        const gy = Math.max(a[1], b[1]) - Math.min(a[3], b[3]);
        const nx0 = Math.min(a[0], b[0]), ny0 = Math.min(a[1], b[1]);
        const nx1 = Math.max(a[2], b[2]), ny1 = Math.max(a[3], b[3]);
        if (Math.max(gx, gy) < MERGE_GAP && nx1 - nx0 <= MAX_TILE && ny1 - ny0 <= MAX_TILE) {
          boxes[i] = [nx0, ny0, nx1, ny1, a[4] + b[4]];
          boxes.splice(j, 1);
          mergedFlag = true;
          break outer;
        }
      }
  }
  boxes = boxes.filter(b => b[4] >= MIN_AREA);
  // 行ごとに左→右、上→下へ並べる
  boxes.sort((p, q) => (p[1] + p[3]) / 2 - (q[1] + q[3]) / 2);
  const rows = [];
  for (const b of boxes) {
    const cy = (b[1] + b[3]) / 2;
    if (rows.length && cy < rows[rows.length - 1].until) {
      const r = rows[rows.length - 1];
      r.items.push(b);
      r.until = Math.max(r.until, b[3] - (b[3] - b[1]) * 0.3);
    } else rows.push({ items: [b], until: b[3] - (b[3] - b[1]) * 0.3 });
  }
  const ordered = rows.flatMap(r => r.items.sort((p, q) => p[0] - q[0]));
  // 透過を適用してアトラスへ詰める
  for (let i = 0; i < n; i++) if (transparent[i]) px[i * 4 + 3] = 0;
  g.putImageData(data, 0, 0);
  const CELL = meta.tilePx, COLS = 8;
  const at = document.createElement("canvas");
  at.width = COLS * CELL;
  at.height = Math.max(1, Math.ceil(ordered.length / COLS)) * CELL;
  const ag = at.getContext("2d");
  const entries = [];
  ordered.forEach((b, i) => {
    const bw = b[2] - b[0], bh = b[3] - b[1];
    const k = Math.min(CELL / bw, CELL / bh, 1);
    const w = Math.max(1, Math.round(bw * k)), h = Math.max(1, Math.round(bh * k));
    const cx = (i % COLS) * CELL + ((CELL - w) >> 1);
    const cy = ((i / COLS) | 0) * CELL + ((CELL - h) >> 1);
    ag.drawImage(c, b[0], b[1], bw, bh, cx, cy, w, h);
    entries.push({ x: cx, y: cy, w, h });
  });
  return { atlas: at.toDataURL("image/png"), cols: COLS, count: entries.length, tiles: entries };
}

function registerCustomSheet(rec) {
  sheetMap[rec.sIndex] = {
    key: "c" + rec.sIndex, label: rec.label, file: rec.atlas,
    cols: rec.cols, count: rec.count, tiles: rec.tiles
  };
  if (!sheetOrder.includes(rec.sIndex)) sheetOrder.push(rec.sIndex);
  return loadImage(rec.atlas).then(im => { atlases[rec.sIndex] = im; });
}

$("sheetFile").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  for (const f of files) {
    showZoomHint("タイルを処理中…");
    try {
      const url = URL.createObjectURL(f);
      const img = await loadImage(url);
      const res = processSheetImage(img);
      URL.revokeObjectURL(url);
      if (!res.count) { alert(`タイルを検出できませんでした: ${f.name}`); continue; }
      let label = f.name.replace(/\.[^.]+$/, "");
      for (const w of STRIP_WORDS) label = label.split(w).join("");
      label = label.replace(/[ _\-]+/g, "").slice(0, 8) || `追加${customSheets.length + 1}`;
      const sIndex = 100 + (customSheets.length ? Math.max(...customSheets.map(r => r.sIndex)) - 99 : 0);
      const rec = {
        id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        sIndex, label, created: Date.now(), ...res
      };
      await idbPut(rec);
      customSheets.push(rec);
      await registerCustomSheet(rec);
      sel.sheet = sIndex; sel.tile = 0;
      updateSelChip(); buildPaletteTabs(); buildPaletteGrid();
      $("palette").classList.remove("collapsed");
      showZoomHint(`「${rec.label}」${res.count}タイルを追加`);
    } catch (err) {
      alert("取り込みに失敗しました: " + err.message);
    }
  }
  if (!$("sheetPanel").classList.contains("hidden")) buildSheetList();
});

/* --- 追加シート管理パネル --- */
function buildSheetList() {
  const list = $("sheetList");
  list.innerHTML = "";
  if (!customSheets.length) {
    const p = document.createElement("p");
    p.textContent = "追加したタイルシートはまだありません。";
    list.appendChild(p);
    return;
  }
  for (const rec of customSheets) {
    const row = document.createElement("div");
    row.className = "sheet-row";
    const name = document.createElement("span");
    name.className = "sheet-name";
    name.textContent = `${rec.label}(${rec.count}タイル)`;
    const ren = document.createElement("button");
    ren.textContent = "✎";
    ren.addEventListener("click", () => openDialog({
      title: "タブ名を変更", name: rec.label, showSize: false,
      cb: async ({ name: nn }) => {
        rec.label = (nn || rec.label).slice(0, 8);
        sheetMap[rec.sIndex].label = rec.label;
        await idbPut(rec);
        buildSheetList(); buildPaletteTabs();
      }
    }));
    const del = document.createElement("button");
    del.textContent = "🗑";
    del.addEventListener("click", async () => {
      if (!confirm(`「${rec.label}」を削除します。このシートのタイルを使っている場所は表示されなくなります。よろしいですか?`)) return;
      await idbDel(rec.id);
      customSheets = customSheets.filter(r => r.id !== rec.id);
      delete sheetMap[rec.sIndex];
      delete atlases[rec.sIndex];
      sheetOrder = sheetOrder.filter(i => i !== rec.sIndex);
      recent = recent.filter(r => r.s !== rec.sIndex);
      if (sel.sheet === rec.sIndex) { sel.sheet = 0; sel.tile = 0; }
      saveIndex();
      updateSelChip(); buildPaletteTabs(); buildPaletteGrid(); buildRecentRow();
      buildSheetList(); render();
    });
    row.appendChild(name); row.appendChild(ren); row.appendChild(del);
    list.appendChild(row);
  }
}
$("mSheets").addEventListener("click", () => {
  menuPanel.classList.add("hidden");
  buildSheetList();
  $("sheetPanel").classList.remove("hidden");
});
$("sAdd").addEventListener("click", () => $("sheetFile").click());
$("sClose").addEventListener("click", () => $("sheetPanel").classList.add("hidden"));

/* ---------------- templates ----------------
   定番RPGマップの「型」を下地として自動生成する。
   タイル参照は内蔵シート固定: 0=地面, 2=水辺, tileId(s,t)
   地面シート: 0-7草 / 8-15濃緑 / 16-23花草 / 24-31土砂 / 32-39濃土 / 40-47石 / 48-55石畳 */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function tplBase(m, rnd, baseTile, variants, varRate) {
  const l = m.layers.bg1;
  for (let i = 0; i < m.w * m.h; i++)
    l[i] = (rnd() < varRate) ? variants[(rnd() * variants.length) | 0] : baseTile;
}
function tplRectFill(m, layer, x0, y0, x1, y1, tile) {
  for (let y = Math.max(0, y0); y <= Math.min(m.h - 1, y1); y++)
    for (let x = Math.max(0, x0); x <= Math.min(m.w - 1, x1); x++)
      m.layers[layer][y * m.w + x] = tile;
}
function tplBlob(m, layer, cx, cy, rx, ry, tile, rnd) {
  for (let y = 0; y < m.h; y++)
    for (let x = 0; x < m.w; x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1 + (rnd() - 0.5) * 0.35)
        m.layers[layer][y * m.w + x] = tile;
    }
}
function tplPathH(m, layer, tile, rnd, width) {
  let y = (m.h / 2 + (rnd() - 0.5) * m.h * 0.3) | 0;
  for (let x = 0; x < m.w; x++) {
    for (let k = 0; k < width; k++) {
      const yy = y + k;
      if (yy >= 0 && yy < m.h) m.layers[layer][yy * m.w + x] = tile;
    }
    if (rnd() < 0.35) y += rnd() < 0.5 ? -1 : 1;
    y = Math.max(1, Math.min(m.h - width - 1, y));
  }
  return y;
}
function tplPathV(m, layer, tile, rnd, width, x0) {
  let x = x0 !== undefined ? x0 : (m.w / 2 + (rnd() - 0.5) * m.w * 0.3) | 0;
  for (let y = 0; y < m.h; y++) {
    for (let k = 0; k < width; k++) {
      const xx = x + k;
      if (xx >= 0 && xx < m.w) m.layers[layer][y * m.w + xx] = tile;
    }
    if (rnd() < 0.35) x += rnd() < 0.5 ? -1 : 1;
    x = Math.max(1, Math.min(m.w - width - 1, x));
  }
}
const G = (t) => tileId(0, t);   // 地面シート
const W2 = (t) => tileId(2, t);  // 水辺シート
const TW = (t) => tileId(7, t);  // タワー床シート

const TEMPLATES = [
  { key: "blank", label: "まっさら", gen: null },
  {
    key: "plain", label: "草原と道",
    gen: (m, rnd) => {
      tplBase(m, rnd, G(1), [G(0), G(2), G(3), G(5)], 0.14);
      tplPathH(m, "bg2", G(24), rnd, 2);
      // 花のパッチ
      for (let i = 0; i < (m.w * m.h) / 180; i++)
        tplBlob(m, "bg1", rnd() * m.w, rnd() * m.h, 1.6 + rnd() * 2, 1.2 + rnd() * 1.6, G(rnd() < 0.5 ? 2 : 5), rnd);
    }
  },
  {
    key: "lake", label: "湖畔",
    gen: (m, rnd) => {
      tplBase(m, rnd, G(1), [G(0), G(2), G(3)], 0.15);
      const cx = m.w * (0.3 + rnd() * 0.4), cy = m.h * (0.3 + rnd() * 0.4);
      const rx = m.w * 0.22, ry = m.h * 0.2;
      // 砂浜 → 水
      tplBlob(m, "bg1", cx, cy, rx * 1.35, ry * 1.35, G(24), rnd);
      tplBlob(m, "bg1", cx, cy, rx, ry, W2(0), rnd);
      // 湖から端へ川
      const vx = (cx + (rnd() < 0.5 ? -1 : 1) * rx * 0.4) | 0;
      for (let y = cy | 0; y < m.h; y++)
        for (let k = 0; k < 2; k++)
          if (vx + k < m.w) m.layers.bg1[y * m.w + vx + k] = W2(0);
      tplPathH(m, "bg2", G(25), rnd, 2);
    }
  },
  {
    key: "village", label: "村",
    gen: (m, rnd) => {
      tplBase(m, rnd, G(1), [G(0), G(2), G(4)], 0.12);
      // 中央広場(石畳)+ 十字路(土)
      const cw = Math.max(6, m.w * 0.28 | 0), ch = Math.max(6, m.h * 0.28 | 0);
      const cx = m.w / 2 | 0, cy = m.h / 2 | 0;
      tplPathH(m, "bg2", G(24), rnd, 2);
      tplPathV(m, "bg2", G(24), rnd, 2);
      tplRectFill(m, "bg2", cx - cw / 2 | 0, cy - ch / 2 | 0, cx + cw / 2 | 0, cy + ch / 2 | 0, G(48));
      // 隅に池
      tplBlob(m, "bg1", m.w * 0.82, m.h * 0.8, m.w * 0.1, m.h * 0.09, W2(0), rnd);
      // 花壇
      for (let i = 0; i < 4; i++)
        tplBlob(m, "bg1", rnd() * m.w, rnd() * m.h, 1.5, 1.2, G(6), rnd);
    }
  },
  {
    key: "cave", label: "洞窟",
    gen: (m, rnd) => {
      tplBase(m, rnd, G(34), [G(32), G(33), G(35)], 0.22);
      // 石の通路
      tplPathH(m, "bg2", G(41), rnd, 2);
      // 地底湖
      if (rnd() < 0.8)
        tplBlob(m, "bg1", m.w * (0.2 + rnd() * 0.6), m.h * (0.2 + rnd() * 0.6), m.w * 0.13, m.h * 0.11, W2(6), rnd);
    }
  },
  {
    key: "tower", label: "魔法の塔",
    gen: (m, rnd) => {
      tplBase(m, rnd, TW(1), [TW(0), TW(2), TW(3)], 0.2);
      // 中央に紫の絨毯 + 最奥の魔法の間
      const x = (m.w / 2 - 1) | 0;
      tplPathV(m, "bg2", TW(9), rnd, 2, x);
      const hallB = Math.max(4, m.h * 0.24 | 0);
      tplRectFill(m, "bg2", x - 3, 1, x + 4, hallB, TW(8));
      // 魔法陣を1枚だけ中央に
      m.layers.bg2[(((1 + hallB) / 2) | 0) * m.w + x] = TW(57);
    }
  },
];

/* ---------------- map list ---------------- */
function fmtDate(t) {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function showMapList() {
  saveIndex();
  buildMapList();
  $("mapListPanel").classList.remove("hidden");
}

function buildMapList() {
  const list = $("mapList");
  list.innerHTML = "";
  if (!index.maps.length) {
    const p = document.createElement("p");
    p.className = "empty-note";
    p.textContent = "マップがありません。「＋ マップを追加」から作成してください。";
    list.appendChild(p);
    return;
  }
  const sorted = [...index.maps].sort((a, b) => b.updated - a.updated);
  for (const m of sorted) {
    const item = document.createElement("div");
    item.className = "map-item";
    const img = document.createElement("img");
    img.className = "thumb";
    if (m.thumb) img.src = m.thumb;
    img.alt = "";
    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML = `<div class="name"></div><div class="sub">${m.w}×${m.h} ・ ${fmtDate(m.updated)}</div>`;
    info.querySelector(".name").textContent = m.name;
    const acts = document.createElement("div");
    acts.className = "acts";
    const mk = (label, title, fn) => {
      const b = document.createElement("button");
      b.textContent = label; b.title = title;
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
      acts.appendChild(b);
    };
    mk("✎", "名前変更", () => openDialog({
      title: "名前を変更", name: m.name, showSize: false,
      cb: ({ name }) => { m.name = name || m.name; saveIndex(); buildMapList(); }
    }));
    mk("⧉", "複製", () => {
      const id = genId();
      const data = localStorage.getItem(KEY_MAP(m.id));
      if (data) localStorage.setItem(KEY_MAP(id), data);
      index.maps.push({ ...m, id, name: m.name + " コピー", updated: Date.now() });
      saveIndex(); buildMapList();
    });
    mk("🗑", "削除", () => {
      if (!confirm(`「${m.name}」を削除します。よろしいですか?`)) return;
      index.maps = index.maps.filter(x => x.id !== m.id);
      localStorage.removeItem(KEY_MAP(m.id));
      if (index.last === m.id) index.last = null;
      saveIndex(); buildMapList();
    });
    item.appendChild(img); item.appendChild(info); item.appendChild(acts);
    item.addEventListener("click", () => openMap(m.id));
    list.appendChild(item);
  }
}

function openMap(id) {
  const e = index.maps.find(m => m.id === id);
  if (!e) return;
  let data = null;
  try { data = JSON.parse(localStorage.getItem(KEY_MAP(id))); } catch (err) { /* noop */ }
  map = (data && data.w && data.layers) ? data : newMapData(e.w, e.h);
  if (!map.objects) map.objects = [];
  normObjects(map.objects);
  mapId = id;
  index.last = id;
  saveIndex();
  undoStack.length = 0; redoStack.length = 0; updateUndoButtons();
  selObj = -1; hideObjToolbar();
  $("mapListPanel").classList.add("hidden");
  resizeCanvas(); fitView(); render();
}

function createMap(name, w, h, tpl) {
  const id = genId();
  const data = newMapData(w, h);
  const t = TEMPLATES.find(x => x.key === tpl);
  if (t && t.gen) t.gen(data, makeRng(Date.now()));
  index.maps.push({ id, name: name || `マップ${index.maps.length + 1}`, w, h, updated: Date.now(), thumb: null });
  localStorage.setItem(KEY_MAP(id), JSON.stringify(data));
  saveIndex();
  openMap(id);
  saveLocal(); // サムネイル生成
}

$("listBtn").addEventListener("click", showMapList);
$("addMapBtn").addEventListener("click", () => openDialog({
  title: "新しいマップ", name: `マップ${index.maps.length + 1}`, showSize: true, showTpl: true,
  cb: ({ name, w, h, tpl }) => createMap(name, w, h, tpl)
}));
$("listTips").addEventListener("click", () => $("tipsPanel").classList.remove("hidden"));
$("mTips").addEventListener("click", () => {
  menuPanel.classList.add("hidden");
  $("tipsPanel").classList.remove("hidden");
});
$("tClose").addEventListener("click", () => $("tipsPanel").classList.add("hidden"));

/* ---------------- dialog ---------------- */
let dlgCb = null;
let dlgTpl = "blank";
function openDialog({ title, name = "", w = 32, h = 32, showName = true, showSize = true, showTpl = false, cb }) {
  $("dlgTitle").textContent = title;
  $("dlgName").value = name;
  $("dlgW").value = w; $("dlgH").value = h;
  $("dlgNameRow").classList.toggle("hidden", !showName);
  $("dlgSizeRow").classList.toggle("hidden", !showSize);
  $("dlgTplRow").classList.toggle("hidden", !showTpl);
  if (showTpl) {
    dlgTpl = "blank";
    const box = $("dlgTpls");
    box.innerHTML = "";
    for (const t of TEMPLATES) {
      const b = document.createElement("button");
      b.textContent = t.label;
      b.classList.toggle("active", t.key === dlgTpl);
      b.addEventListener("click", () => {
        dlgTpl = t.key;
        box.querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b));
      });
      box.appendChild(b);
    }
  }
  dlgCb = cb;
  $("mapDialog").classList.remove("hidden");
}
$("dlgOk").addEventListener("click", () => {
  const clamp = (v, d) => { const n = parseInt(v, 10); return isNaN(n) ? d : Math.max(8, Math.min(100, n)); };
  const res = { name: $("dlgName").value.trim(), w: clamp($("dlgW").value, 32), h: clamp($("dlgH").value, 32), tpl: dlgTpl };
  $("mapDialog").classList.add("hidden");
  if (dlgCb) dlgCb(res);
  dlgCb = null;
});
$("dlgCancel").addEventListener("click", () => { $("mapDialog").classList.add("hidden"); dlgCb = null; });

/* ---------------- menu ---------------- */
const menuPanel = $("menuPanel");
$("menuBtn").addEventListener("click", () => {
  const e = indexEntry();
  $("mapInfo").textContent =
    `${e ? e.name : ""}: ${map.w}×${map.h} / オブジェクト ${map.objects.length}個`;
  menuPanel.classList.remove("hidden");
});
$("mClose").addEventListener("click", () => menuPanel.classList.add("hidden"));
menuPanel.addEventListener("click", (e) => { if (e.target === menuPanel) menuPanel.classList.add("hidden"); });
// ヘルプ・コツ・シート管理パネルも背景タップで閉じられるように
for (const pid of ["helpPanel", "tipsPanel", "sheetPanel"]) {
  const el = $(pid);
  el.addEventListener("click", (e) => { if (e.target === el) el.classList.add("hidden"); });
}

$("mHelp").addEventListener("click", () => {
  menuPanel.classList.add("hidden");
  $("helpPanel").classList.remove("hidden");
});
$("hClose").addEventListener("click", () => $("helpPanel").classList.add("hidden"));

$("mGrid").addEventListener("click", () => {
  showGrid = !showGrid;
  $("mGridState").textContent = showGrid ? "ON" : "OFF";
  render();
});
$("mDim").addEventListener("click", () => {
  dimOthers = !dimOthers;
  $("mDimState").textContent = dimOthers ? "ON" : "OFF";
  render();
});

$("mClearLayer").addEventListener("click", () => {
  const label = mode === "obj" ? "オブジェクトレイヤー" : { bg1: "背景1", bg2: "背景2", bg3: "背景3" }[mode];
  if (!confirm(`${label}を一括クリアします。よろしいですか?`)) return;
  if (mode === "obj") {
    const before = objSnapshot();
    map.objects = [];
    selObj = -1; hideObjToolbar();
    pushUndo({ type: "objects", before, after: [] });
  } else {
    const layer = map.layers[mode];
    const changes = [];
    for (let i = 0; i < layer.length; i++)
      if (layer[i] >= 0) { changes.push([i, layer[i], -1]); layer[i] = -1; }
    if (changes.length) pushUndo({ type: "cells", layer: mode, changes });
  }
  saveLocal(); render();
  menuPanel.classList.add("hidden");
});

$("mClearAll").addEventListener("click", () => {
  if (!confirm("背景1〜3とオブジェクトを全て消去します。よろしいですか?")) return;
  const before = fullSnapshot();
  for (const l of BG_LAYERS) map.layers[l].fill(-1);
  map.objects = [];
  selObj = -1; hideObjToolbar();
  pushUndo({ type: "full", before, after: fullSnapshot() });
  saveLocal(); render();
  menuPanel.classList.add("hidden");
});

$("mResize").addEventListener("click", () => {
  menuPanel.classList.add("hidden");
  openDialog({
    title: "マップサイズ変更", showName: false, w: map.w, h: map.h,
    cb: ({ w, h }) => {
      const nm = newMapData(w, h);
      for (const l of BG_LAYERS)
        for (let y = 0; y < Math.min(map.h, h); y++)
          for (let x = 0; x < Math.min(map.w, w); x++)
            nm.layers[l][y * w + x] = map.layers[l][y * map.w + x];
      nm.objects = map.objects;
      map = nm;
      undoStack.length = 0; redoStack.length = 0; updateUndoButtons();
      saveLocal(); render();
    }
  });
});

$("mExportJson").addEventListener("click", () => {
  const e = indexEntry();
  const blob = new Blob([JSON.stringify({ name: e ? e.name : "map", ...map })], { type: "application/json" });
  downloadBlob(blob, (e && e.name ? e.name : "rpgmap") + ".json");
  menuPanel.classList.add("hidden");
});

$("mImportJson").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const m = JSON.parse(rd.result);
      if (!m.w || !m.layers) throw new Error("形式が違います");
      const id = genId();
      const name = m.name || f.name.replace(/\.json$/i, "") || "インポート";
      delete m.name;
      if (!m.objects) m.objects = [];
      normObjects(m.objects);
      localStorage.setItem(KEY_MAP(id), JSON.stringify(m));
      index.maps.push({ id, name, w: m.w, h: m.h, updated: Date.now(), thumb: null });
      saveIndex();
      openMap(id);
      menuPanel.classList.add("hidden");
    } catch (err) { alert("読み込みに失敗しました: " + err.message); }
  };
  rd.readAsText(f);
  e.target.value = "";
});

$("mExportPng").addEventListener("click", () => {
  const P = meta.tilePx;
  const c = document.createElement("canvas");
  c.width = map.w * P; c.height = map.h * P;
  const g = c.getContext("2d");
  for (const lname of BG_LAYERS) {
    const layer = map.layers[lname];
    for (let y = 0; y < map.h; y++)
      for (let x = 0; x < map.w; x++) {
        const id = layer[y * map.w + x];
        if (id >= 0) drawTile(id, x * P, y * P, P, P, g);
      }
  }
  const k = P / TILE;
  for (const o of map.objects) {
    const sh = getSheet(o.s), ti = sh && sh.tiles[o.t];
    if (!ti || !atlases[o.s]) continue;
    const d = objDrawRect(o);
    g.save();
    if (o.flip) {
      g.translate((d.x + d.w / 2) * k, 0); g.scale(-1, 1); g.translate(-(d.x + d.w / 2) * k, 0);
    }
    g.drawImage(atlases[o.s], ti.x, ti.y, ti.w, ti.h, d.x * k, d.y * k, d.w * k, d.h * k);
    g.restore();
  }
  const e = indexEntry();
  c.toBlob((blob) => downloadBlob(blob, (e && e.name ? e.name : "rpgmap") + ".png"), "image/png");
  menuPanel.classList.add("hidden");
});

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ---------------- init ---------------- */
function fitView() {
  const r = canvas.getBoundingClientRect();
  if (!map || !r.width) return;
  const sc = Math.min(r.width / (map.w * TILE), r.height / (map.h * TILE)) * 0.95;
  view.scale = Math.max(0.15, Math.min(2, sc));
  view.x = (map.w * TILE - r.width / view.scale) / 2;
  view.y = (map.h * TILE - r.height / view.scale) / 2;
}

async function init() {
  const res = await fetch("assets/tiles.json");
  meta = await res.json();
  meta.sheets.forEach((sh, i) => { sheetMap[i] = sh; sheetOrder.push(i); });
  await Promise.all(sheetOrder.map(i => loadImage(sheetMap[i].file).then(im => { atlases[i] = im; })));
  try {
    customSheets = (await idbAll()).sort((a, b) => a.sIndex - b.sIndex);
    await Promise.all(customSheets.map(registerCustomSheet));
  } catch (e) { console.warn("custom sheets", e); }
  index = loadIndex();
  recent = (index.recent || []).filter(r => getSheet(r.s) && r.t < getSheet(r.s).count);
  buildPaletteTabs();
  buildPaletteGrid();
  buildRecentRow();
  updateSelChip();
  updateUndoButtons();
  $("loading").remove();
  showMapList();   // 起動時はマップ一覧から
}

new ResizeObserver(() => resizeCanvas()).observe($("canvasWrap"));
window.addEventListener("orientationchange", () => setTimeout(resizeCanvas, 300));
init().catch(e => {
  $("loading").textContent = "読み込みエラー: " + e.message;
});
