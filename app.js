"use strict";
/* RPG Map Maker — スマホ向けタイルマップドラフトツール */

const TILE = 48;              // ワールド座標での1セルのpx
const STORAGE_KEY = "rpgmapmaker_v1";
const BG_LAYERS = ["bg1", "bg2", "bg3"];

let meta = null;              // tiles.json
let atlases = [];             // HTMLImageElement per sheet
let map = null;               // {w,h,layers:{bg1:[],bg2:[],bg3:[]},objects:[]}
let view = { x: 0, y: 0, scale: 1 };
let mode = "bg1";             // bg1|bg2|bg3|obj
let tool = "pen";             // pen|fill|eraser|picker
let sel = { sheet: 0, tile: 0 };   // パレット選択
let selObj = -1;              // 選択中オブジェクトindex
let showGrid = true;
let dimOthers = false;
let undoStack = [], redoStack = [];
const UNDO_MAX = 100;

const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");

/* ---------------- map data ---------------- */
function newMap(w, h) {
  return {
    w, h,
    layers: { bg1: new Array(w * h).fill(-1), bg2: new Array(w * h).fill(-1), bg3: new Array(w * h).fill(-1) },
    objects: []               // {s,t,x,y,scale,flip}
  };
}
function tileId(s, t) { return s * 1000 + t; }
function idSheet(id) { return Math.floor(id / 1000); }
function idTile(id) { return id % 1000; }

function saveLocal() {
  clearTimeout(saveLocal._t);
  saveLocal._t = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch (e) { console.warn(e); }
  }, 600);
}
function loadLocal() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (!s) return null;
    const m = JSON.parse(s);
    if (m && m.w && m.layers && m.layers.bg1) return m;
  } catch (e) { console.warn(e); }
  return null;
}

/* ---------------- undo ---------------- */
function pushUndo(entry) {
  undoStack.push(entry);
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}
function applyEntry(e, dir) {   // dir: "undo"|"redo"
  if (e.type === "cells") {
    for (const [i, before, after] of e.changes)
      map.layers[e.layer][i] = dir === "undo" ? before : after;
  } else if (e.type === "objects") {
    map.objects = JSON.parse(JSON.stringify(dir === "undo" ? e.before : e.after));
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
  document.getElementById("undoBtn").disabled = undoStack.length === 0;
  document.getElementById("redoBtn").disabled = redoStack.length === 0;
}
function objSnapshot() { return JSON.parse(JSON.stringify(map.objects)); }

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

  // map background (checker)
  ctx.fillStyle = "#23253c";
  ctx.fillRect(ox, oy, map.w * ts, map.h * ts);
  ctx.fillStyle = "#282a44";
  const step = ts;
  for (let y = 0; y < map.h; y++)
    for (let x = (y % 2); x < map.w; x += 2)
      ctx.fillRect(ox + x * step, oy + y * step, step, step);

  // visible cell range
  const x0 = Math.max(0, Math.floor((0 - ox) / ts)), x1 = Math.min(map.w - 1, Math.ceil((r.width - ox) / ts));
  const y0 = Math.max(0, Math.floor((0 - oy) / ts)), y1 = Math.min(map.h - 1, Math.ceil((r.height - oy) / ts));

  ctx.imageSmoothingEnabled = true;
  for (const lname of BG_LAYERS) {
    const dim = dimOthers && mode !== "obj" && mode !== lname;
    ctx.globalAlpha = dim ? 0.3 : 1;
    const layer = map.layers[lname];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const id = layer[y * map.w + x];
        if (id >= 0) drawTile(id, ox + x * ts, oy + y * ts, ts + 0.6, ts + 0.6);
      }
    }
  }
  ctx.globalAlpha = dimOthers && mode !== "obj" ? 0.5 : 1;

  // objects
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

  // selection outline
  if (mode === "obj" && selObj >= 0 && map.objects[selObj]) {
    const d = objDrawRect(map.objects[selObj]);
    ctx.strokeStyle = "#ffb648"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.strokeRect(ox + d.x * sc - 3, oy + d.y * sc - 3, d.w * sc + 6, d.h * sc + 6);
    ctx.setLineDash([]);
  }

  // grid
  if (showGrid && ts >= 8) {
    ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0; x <= x1 + 1; x++) { ctx.moveTo(ox + x * ts, oy + y0 * ts); ctx.lineTo(ox + x * ts, oy + (y1 + 1) * ts); }
    for (let y = y0; y <= y1 + 1; y++) { ctx.moveTo(ox + x0 * ts, oy + y * ts); ctx.lineTo(ox + (x1 + 1) * ts, oy + y * ts); }
    ctx.stroke();
  }

  // map border
  ctx.strokeStyle = "#5b8cff88"; ctx.lineWidth = 2;
  ctx.strokeRect(ox, oy, map.w * ts, map.h * ts);
}

/* オブジェクトのワールド座標での描画矩形 */
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
function worldToCell(w) {
  return { x: Math.floor(w.x / TILE), y: Math.floor(w.y / TILE) };
}
function inMap(c) { return c.x >= 0 && c.y >= 0 && c.x < map.w && c.y < map.h; }

/* ---------------- painting ---------------- */
let stroke = null;   // {layer, changes:Map(idx->[before,after]), lastCell}

function paintCell(c) {
  if (!inMap(c)) return;
  const layer = map.layers[mode];
  const i = c.y * map.w + c.x;
  let val;
  if (tool === "pen") val = tileId(sel.sheet, sel.tile);
  else if (tool === "eraser") val = -1;
  else return;
  if (layer[i] === val) return;
  if (!stroke.changes.has(i)) stroke.changes.set(i, [layer[i], val]);
  else stroke.changes.get(i)[1] = val;
  layer[i] = val;
}

function paintLine(c0, c1) {
  const dx = Math.abs(c1.x - c0.x), dy = Math.abs(c1.y - c0.y);
  const n = Math.max(dx, dy);
  for (let i = 0; i <= n; i++) {
    paintCell({ x: Math.round(c0.x + (c1.x - c0.x) * i / (n || 1)), y: Math.round(c0.y + (c1.y - c0.y) * i / (n || 1)) });
  }
}

function floodFill(c) {
  if (!inMap(c)) return;
  const layer = map.layers[mode];
  const target = layer[c.y * map.w + c.x];
  const val = tool === "eraser" ? -1 : tileId(sel.sheet, sel.tile);
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
  if (!inMap(c)) return;
  const i = c.y * map.w + c.x;
  // 現在レイヤー優先、なければ上のレイヤーから順に
  const order = [mode, "bg3", "bg2", "bg1"].filter((v, k, a) => v !== "obj" && a.indexOf(v) === k);
  for (const l of order) {
    const id = map.layers[l][i];
    if (id >= 0) {
      sel.sheet = idSheet(id); sel.tile = idTile(id);
      buildPaletteTabs(); buildPaletteGrid();
      setTool("pen");
      return;
    }
  }
}

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

const objToolbar = document.getElementById("objToolbar");
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
document.getElementById("objDel").addEventListener("click", () => objAction(() => {
  map.objects.splice(selObj, 1); selObj = -1;
}));
document.getElementById("objDup").addEventListener("click", () => objAction(() => {
  const o = JSON.parse(JSON.stringify(map.objects[selObj]));
  o.x += TILE; o.y += TILE;
  map.objects.push(o); selObj = map.objects.length - 1;
}));
document.getElementById("objFlip").addEventListener("click", () => objAction(() => {
  map.objects[selObj].flip = !map.objects[selObj].flip;
}));
document.getElementById("objFront").addEventListener("click", () => objAction(() => {
  const [o] = map.objects.splice(selObj, 1);
  map.objects.push(o); selObj = map.objects.length - 1;
}));
document.getElementById("objBack").addEventListener("click", () => objAction(() => {
  const [o] = map.objects.splice(selObj, 1);
  map.objects.unshift(o); selObj = 0;
}));

/* ---------------- pointer input ---------------- */
const pointers = new Map();   // id -> {x,y}
let gesture = null;           // "paint" | "pan" | "pinch" | "objdrag" | "objpinch"
let pinch0 = null;
let objDrag0 = null;
let objBefore = null;         // オブジェクト操作のundo用スナップショット

function pdist() {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y) || 1;
}
function pmid() {
  const [a, b] = [...pointers.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

canvas.addEventListener("pointerdown", (ev) => {
  try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic pointer等 */ }
  const rect = canvas.getBoundingClientRect();
  const p = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  pointers.set(ev.pointerId, p);

  if (pointers.size === 1) {
    const w = screenToWorld(p.x, p.y);
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
      const c = worldToCell(w);
      if (tool === "fill") { floodFill(c); gesture = null; }
      else if (tool === "picker") { pickTile(c); gesture = null; }
      else {
        gesture = "paint";
        stroke = { layer: mode, changes: new Map(), lastCell: c };
        paintCell(c); render();
      }
    }
  } else if (pointers.size === 2) {
    // 2本目: ピンチ開始。描画中ストロークは確定
    if (gesture === "paint") endStroke();
    if (mode === "obj" && gesture === "objdrag" && selObj >= 0) {
      gesture = "objpinch";
      pinch0 = { dist: pdist(), scale: map.objects[selObj].scale };
    } else {
      gesture = "pinch";
      const m = pmid();
      pinch0 = { dist: pdist(), scale: view.scale, mid: m, world: screenToWorld(m.x, m.y) };
    }
  }
});

canvas.addEventListener("pointermove", (ev) => {
  if (!pointers.has(ev.pointerId)) return;
  const rect = canvas.getBoundingClientRect();
  const p = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  const prev = pointers.get(ev.pointerId);
  pointers.set(ev.pointerId, p);

  if (gesture === "paint" && pointers.size === 1) {
    const c = worldToCell(screenToWorld(p.x, p.y));
    if (c.x !== stroke.lastCell.x || c.y !== stroke.lastCell.y) {
      paintLine(stroke.lastCell, c);
      stroke.lastCell = c;
      render();
    }
  } else if (gesture === "pan" && pointers.size === 1) {
    view.x -= (p.x - prev.x) / view.scale;
    view.y -= (p.y - prev.y) / view.scale;
    render();
  } else if (gesture === "objdrag" && pointers.size === 1 && selObj >= 0) {
    const w = screenToWorld(p.x, p.y);
    map.objects[selObj].x = w.x + objDrag0.ox;
    map.objects[selObj].y = w.y + objDrag0.oy;
    render();
  } else if (gesture === "objpinch" && pointers.size === 2 && selObj >= 0) {
    const s = Math.max(0.2, Math.min(10, pinch0.scale * pdist() / pinch0.dist));
    map.objects[selObj].scale = s;
    showZoomHint("×" + s.toFixed(2));
    render();
  } else if (gesture === "pinch" && pointers.size === 2) {
    const m = pmid();
    const sc = Math.max(0.15, Math.min(5, pinch0.scale * pdist() / pinch0.dist));
    view.scale = sc;
    view.x = pinch0.world.x - m.x / sc;
    view.y = pinch0.world.y - m.y / sc;
    showZoomHint(Math.round(sc * 100) + "%");
    render();
  }
});

function endStroke() {
  if (stroke && stroke.changes.size) {
    pushUndo({ type: "cells", layer: stroke.layer, changes: [...stroke.changes.entries()].map(([i, [b, a]]) => [i, b, a]) });
    saveLocal();
  }
  stroke = null;
}

function pointerEnd(ev) {
  if (!pointers.has(ev.pointerId)) return;
  pointers.delete(ev.pointerId);
  if (pointers.size === 0) {
    if (gesture === "paint") endStroke();
    if ((gesture === "objdrag" || gesture === "objpinch") && objBefore) {
      const after = objSnapshot();
      if (JSON.stringify(after) !== JSON.stringify(objBefore))
        pushUndo({ type: "objects", before: objBefore, after });
      objBefore = null;
      saveLocal();
    }
    if (mode === "obj" && selObj >= 0) showObjToolbar();
    gesture = null; pinch0 = null;
  } else if (pointers.size === 1) {
    // ピンチ後に1本残った → パンに移行
    gesture = (mode === "obj" && gesture === "objpinch") ? "pan" : "pan";
    if (gesture === "pan" && mode === "obj") { /* keep selection */ }
  }
}
canvas.addEventListener("pointerup", pointerEnd);
canvas.addEventListener("pointercancel", pointerEnd);

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
  const el = document.getElementById("zoomHint");
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
    document.getElementById("toolbar").querySelectorAll(".tool").forEach(t => {
      t.style.display = (mode === "obj" && t.dataset.tool !== "pen") ? "none" : "";
    });
    if (mode === "obj") setTool("pen");
    render();
  });
});

function setTool(t) {
  tool = t;
  document.querySelectorAll(".tool").forEach(b => b.classList.toggle("active", b.dataset.tool === t));
}
document.querySelectorAll(".tool").forEach(b => b.addEventListener("click", () => setTool(b.dataset.tool)));
document.getElementById("undoBtn").addEventListener("click", doUndo);
document.getElementById("redoBtn").addEventListener("click", doRedo);
document.getElementById("gridBtn").addEventListener("click", (e) => {
  showGrid = !showGrid; e.currentTarget.classList.toggle("active", showGrid); render();
});
document.getElementById("dimBtn").addEventListener("click", (e) => {
  dimOthers = !dimOthers; e.currentTarget.classList.toggle("active", dimOthers); render();
});
document.getElementById("paletteToggle").addEventListener("click", (e) => {
  const p = document.getElementById("palette");
  p.classList.toggle("collapsed");
  e.currentTarget.textContent = p.classList.contains("collapsed") ? "▲" : "▼";
  setTimeout(resizeCanvas, 220);
});

/* ---------------- palette ---------------- */
function buildPaletteTabs() {
  const tabs = document.getElementById("paletteTabs");
  tabs.innerHTML = "";
  meta.sheets.forEach((sh, i) => {
    const b = document.createElement("button");
    b.textContent = sh.label;
    b.classList.toggle("active", i === sel.sheet);
    b.addEventListener("click", () => { sel.sheet = i; sel.tile = 0; buildPaletteTabs(); buildPaletteGrid(); });
    tabs.appendChild(b);
  });
}

function buildPaletteGrid() {
  const grid = document.getElementById("paletteGrid");
  grid.innerHTML = "";
  const sh = meta.sheets[sel.sheet];
  const P = meta.tilePx;
  for (let t = 0; t < sh.count; t++) {
    const b = document.createElement("button");
    b.className = "tile-btn" + (t === sel.tile ? " selected" : "");
    const ti = sh.tiles[t];
    const col = t % sh.cols, row = Math.floor(t / sh.cols);
    b.style.backgroundImage = `url(${sh.file})`;
    const cell = 46; // css px基準(background-sizeを%で指定して自動スケール)
    const rows = Math.ceil(sh.count / sh.cols);
    b.style.backgroundSize = `${sh.cols * 100}% ${rows * 100}%`;
    b.style.backgroundPosition = `${sh.cols > 1 ? (col * 100 / (sh.cols - 1)) : 0}% ${rows > 1 ? (row * 100 / (rows - 1)) : 0}%`;
    b.addEventListener("click", () => {
      const prev = sel.tile;
      sel.tile = t;
      grid.querySelectorAll(".tile-btn").forEach((x, k) => x.classList.toggle("selected", k === t));
      if (mode === "obj") addObjectAtCenter();
      else if (tool === "eraser" || tool === "picker") setTool("pen");
    });
    grid.appendChild(b);
  }
}

/* ---------------- menu ---------------- */
const menuPanel = document.getElementById("menuPanel");
document.getElementById("menuBtn").addEventListener("click", () => {
  document.getElementById("mapInfo").textContent =
    `マップ: ${map.w}×${map.h} / オブジェクト: ${map.objects.length}個`;
  menuPanel.classList.remove("hidden");
});
document.getElementById("mClose").addEventListener("click", () => menuPanel.classList.add("hidden"));
menuPanel.addEventListener("click", (e) => { if (e.target === menuPanel) menuPanel.classList.add("hidden"); });

document.getElementById("mHelp").addEventListener("click", () => {
  menuPanel.classList.add("hidden");
  document.getElementById("helpPanel").classList.remove("hidden");
});
document.getElementById("hClose").addEventListener("click", () => document.getElementById("helpPanel").classList.add("hidden"));

document.getElementById("mNew").addEventListener("click", () => {
  if (!confirm("マップを全て消去して新規作成します。よろしいですか?")) return;
  const w = parseInt(prompt("マップの幅(セル数, 8〜100)", map.w), 10) || map.w;
  const h = parseInt(prompt("マップの高さ(セル数, 8〜100)", map.h), 10) || map.h;
  map = newMap(clampSize(w), clampSize(h));
  undoStack.length = 0; redoStack.length = 0; updateUndoButtons();
  fitView(); saveLocal(); render();
  menuPanel.classList.add("hidden");
});

document.getElementById("mResize").addEventListener("click", () => {
  const w = parseInt(prompt("新しい幅(セル数, 8〜100)", map.w), 10);
  const h = parseInt(prompt("新しい高さ(セル数, 8〜100)", map.h), 10);
  if (!w || !h) return;
  const nw = clampSize(w), nh = clampSize(h);
  const nm = newMap(nw, nh);
  for (const l of BG_LAYERS)
    for (let y = 0; y < Math.min(map.h, nh); y++)
      for (let x = 0; x < Math.min(map.w, nw); x++)
        nm.layers[l][y * nw + x] = map.layers[l][y * map.w + x];
  nm.objects = map.objects;
  map = nm;
  undoStack.length = 0; redoStack.length = 0; updateUndoButtons();
  saveLocal(); render();
  menuPanel.classList.add("hidden");
});
function clampSize(v) { return Math.max(8, Math.min(100, v)); }

document.getElementById("mExportJson").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(map)], { type: "application/json" });
  downloadBlob(blob, "rpgmap.json");
  menuPanel.classList.add("hidden");
});

document.getElementById("mImportJson").addEventListener("click", () => {
  document.getElementById("fileInput").click();
});
document.getElementById("fileInput").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const m = JSON.parse(rd.result);
      if (!m.w || !m.layers) throw new Error("bad format");
      map = m;
      if (!map.objects) map.objects = [];
      undoStack.length = 0; redoStack.length = 0; updateUndoButtons();
      fitView(); saveLocal(); render();
      menuPanel.classList.add("hidden");
    } catch (err) { alert("読み込みに失敗しました: " + err.message); }
  };
  rd.readAsText(f);
  e.target.value = "";
});

document.getElementById("mExportPng").addEventListener("click", () => {
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
    const s = o.s, ti = meta.sheets[s].tiles[o.t];
    g.save();
    if (o.flip) {
      g.translate((d.x + d.w / 2) * k, 0); g.scale(-1, 1); g.translate(-(d.x + d.w / 2) * k, 0);
    }
    g.drawImage(atlases[s], ti.x, ti.y, ti.w, ti.h, d.x * k, d.y * k, d.w * k, d.h * k);
    g.restore();
  }
  c.toBlob((blob) => downloadBlob(blob, "rpgmap.png"), "image/png");
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
  map = loadLocal() || newMap(32, 32);
  if (!map.objects) map.objects = [];
  buildPaletteTabs();
  buildPaletteGrid();
  updateUndoButtons();
  document.getElementById("loading").remove();
  resizeCanvas();
  fitView();
  render();
}

new ResizeObserver(() => resizeCanvas()).observe(document.getElementById("canvasWrap"));
window.addEventListener("orientationchange", () => setTimeout(resizeCanvas, 300));
init().catch(e => {
  document.getElementById("loading").textContent = "読み込みエラー: " + e.message;
});
