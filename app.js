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
let atlases = [];             // HTMLImageElement per sheet
let index = null;             // {maps:[{id,name,w,h,updated,thumb}], last}
let mapId = null;
let map = null;               // {w,h,layers:{bg1:[],...},objects:[]}
let view = { x: 0, y: 0, scale: 1 };
let mode = "bg1";
let tool = "pen";             // pen|rect|fill|eraser|picker
let sel = { sheet: 0, tile: 0 };
let selObj = -1;
let recent = [];              // [{s,t}]
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
  const sh = meta.sheets[s];
  if (!sh || !sh.tiles[t]) return;
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
}

function objDrawRect(o) {
  const sh = meta.sheets[o.s], ti = sh.tiles[o.t];
  const base = TILE * o.scale / meta.tilePx;
  const w = ti.w * base, h = ti.h * base;
  return { x: o.x - w / 2, y: o.y - h / 2, w, h };
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
  paintCell(c);
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
    paintCell({ x: Math.round(c0.x + (c1.x - c0.x) * i / (n || 1)), y: Math.round(c0.y + (c1.y - c0.y) * i / (n || 1)) });
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
  const sh = meta.sheets[s];
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
    scale: 1, flip: false
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
let gesture = null;   // pending|paint|rect|pan|pinch|objdrag|objpinch|longpicked
let down = null;      // {p, t, cell, world}
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
    if (mode === "obj") {
      const hit = hitObject(w);
      if (hit >= 0) {
        selObj = hit;
        objBefore = objSnapshot();
        objDrag0 = { ox: map.objects[hit].x - w.x, oy: map.objects[hit].y - w.y };
        gesture = "objdrag";
        hideObjToolbar();
      } else {
        selObj = -1; hideObjToolbar();
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
    if (mode === "obj" && gesture === "objdrag" && selObj >= 0) {
      gesture = "objpinch";
      pinch0 = { dist: pdist(), scale: map.objects[selObj].scale };
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

  if (pointers.size === 1) {
    const c = worldToCell(screenToWorld(p.x, p.y));
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
      const s = Math.max(0.2, Math.min(10, pinch0.scale * pdist() / pinch0.dist));
      map.objects[selObj].scale = s;
      showZoomHint("×" + s.toFixed(2));
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
    } else if ((gesture === "objdrag" || gesture === "objpinch") && objBefore) {
      const after = objSnapshot();
      if (JSON.stringify(after) !== JSON.stringify(objBefore))
        pushUndo({ type: "objects", before: objBefore, after });
      objBefore = null;
      saveLocal();
    }
    if (mode === "obj" && selObj >= 0) showObjToolbar();
    gesture = null; pinch0 = null; down = null;
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
  meta.sheets.forEach((sh, i) => {
    const b = document.createElement("button");
    b.textContent = sh.label;
    b.classList.toggle("active", i === sel.sheet);
    b.addEventListener("click", () => { sel.sheet = i; sel.tile = 0; updateSelChip(); buildPaletteTabs(); buildPaletteGrid(); });
    tabs.appendChild(b);
  });
}

function buildPaletteGrid() {
  const grid = $("paletteGrid");
  grid.innerHTML = "";
  const sh = meta.sheets[sel.sheet];
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
    if (!meta.sheets[rt.s] || rt.t >= meta.sheets[rt.s].count) continue;
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
  mapId = id;
  index.last = id;
  saveIndex();
  undoStack.length = 0; redoStack.length = 0; updateUndoButtons();
  selObj = -1; hideObjToolbar();
  $("mapListPanel").classList.add("hidden");
  resizeCanvas(); fitView(); render();
}

function createMap(name, w, h) {
  const id = genId();
  index.maps.push({ id, name: name || `マップ${index.maps.length + 1}`, w, h, updated: Date.now(), thumb: null });
  localStorage.setItem(KEY_MAP(id), JSON.stringify(newMapData(w, h)));
  saveIndex();
  openMap(id);
}

$("listBtn").addEventListener("click", showMapList);
$("addMapBtn").addEventListener("click", () => openDialog({
  title: "新しいマップ", name: `マップ${index.maps.length + 1}`, showSize: true,
  cb: ({ name, w, h }) => createMap(name, w, h)
}));

/* ---------------- dialog ---------------- */
let dlgCb = null;
function openDialog({ title, name = "", w = 32, h = 32, showName = true, showSize = true, cb }) {
  $("dlgTitle").textContent = title;
  $("dlgName").value = name;
  $("dlgW").value = w; $("dlgH").value = h;
  $("dlgNameRow").classList.toggle("hidden", !showName);
  $("dlgSizeRow").classList.toggle("hidden", !showSize);
  dlgCb = cb;
  $("mapDialog").classList.remove("hidden");
}
$("dlgOk").addEventListener("click", () => {
  const clamp = (v, d) => { const n = parseInt(v, 10); return isNaN(n) ? d : Math.max(8, Math.min(100, n)); };
  const res = { name: $("dlgName").value.trim(), w: clamp($("dlgW").value, 32), h: clamp($("dlgH").value, 32) };
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
    const d = objDrawRect(o);
    const ti = meta.sheets[o.s].tiles[o.t];
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
  atlases = await Promise.all(meta.sheets.map(sh => new Promise((ok, ng) => {
    const im = new Image();
    im.onload = () => ok(im);
    im.onerror = ng;
    im.src = sh.file;
  })));
  index = loadIndex();
  recent = (index.recent || []).filter(r => meta.sheets[r.s] && r.t < meta.sheets[r.s].count);
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
