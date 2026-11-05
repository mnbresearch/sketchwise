/* global rough */
// Sketchwise — hand-drawn whiteboard. Vanilla JS + rough.js, everything client-side.
import { uid, bounds, center, hit, intersects, edgePoint, recognize, simplify, compress, decompress } from './lib/geometry.mjs';
import { TEMPLATES, diagramElements } from './lib/templates.mjs';

const $ = (s) => document.querySelector(s);
const canvas = $('#board');
const ctx = canvas.getContext('2d');
const rc = rough.canvas(canvas);
const gen = rc.generator;
const FONT = 'Kalam, "Comic Sans MS", cursive';
const STROKES = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00', '#9c36b5', '#0c8599', '#868e96'];
const FILLS = ['transparent', '#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99', '#d0bfff', '#99e9f2', '#e9ecef'];
const STORE = 'sketchwise:board';

// ------------------------------------------------------------------ state
let els = [];
let sel = new Set();
let view = { x: 0, y: 0, z: 1 };
let tool = 'select';
let lockTool = false;
let ink = true;
let grid = false;
let style = { stroke: '#1e1e1e', fill: 'transparent', fillStyle: 'hachure', strokeWidth: 2, roughness: 1, opacity: 1, fontSize: 20 };
let undo = [];
let redo = [];
let drag = null;
let laser = [];
let clipboard = [];
const cache = new Map();
const images = new Map();
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('sketchwise') : null;

try {
  const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
  if (saved) ({ els = [], view = view, style = style, grid = false } = saved);
} catch {
  /* fresh board */
}

const toScene = (sx, sy) => [sx / view.z + view.x, sy / view.z + view.y];
const toScreen = (x, y) => [(x - view.x) * view.z, (y - view.y) * view.z];
const byId = (id) => els.find((e) => e.id === id);
const snapshot = () => JSON.stringify(els);

function commit() {
  undo.push(lastSnap);
  if (undo.length > 150) undo.shift();
  redo = [];
  lastSnap = snapshot();
  save();
}
let lastSnap = snapshot();
let saveT;
function flush() {
  clearTimeout(saveT);
  try {
    localStorage.setItem(STORE, JSON.stringify({ els, view, style, grid }));
  } catch {
    toast('Board too large for local storage — use Save as .sketchwise');
  }
  bc?.postMessage({ els });
}
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(flush, 250);
}
addEventListener('pagehide', flush);
bc && (bc.onmessage = (e) => {
  if (drag) return;
  els = e.data.els;
  lastSnap = snapshot();
  sel = new Set([...sel].filter(byId));
  render();
});

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.hidden = true), 2600);
}

function newEl(type, o = {}) {
  return { id: uid(), type, x: 0, y: 0, w: 0, h: 0, seed: Math.floor(Math.random() * 2 ** 31), v: 1, ...style, ...o };
}
const touch = (e) => (e.v = (e.v || 0) + 1);

// ------------------------------------------------------------------ arrows bound to shapes
function routeArrow(a) {
  const s = a.start && byId(a.start.id);
  const t = a.end && byId(a.end.id);
  if (!s && !t) return;
  const p0 = [a.x + a.points[0][0], a.y + a.points[0][1]];
  const p1 = [a.x + a.points.at(-1)[0], a.y + a.points.at(-1)[1]];
  if (a.route === 'below' && s && t) {
    // Loop-back edge: drop below both shapes instead of cutting through the diagram.
    const bs = bounds(s);
    const bt = bounds(t);
    const from = [bs.x + bs.w / 2, bs.y + bs.h + 6];
    const to = [bt.x + bt.w / 2, bt.y + bt.h + 6];
    const y = Math.max(bs.y + bs.h, bt.y + bt.h) + 60;
    a.x = from[0];
    a.y = from[1];
    a.points = [[0, 0], [0, y - from[1]], [to[0] - from[0], y - from[1]], [to[0] - from[0], to[1] - from[1]]];
    return touch(a);
  }
  const from = s ? edgePoint(s, t ? center(t) : p1) : p0;
  const to = t ? edgePoint(t, s ? center(s) : p0) : p1;
  a.x = from[0];
  a.y = from[1];
  a.points = [[0, 0], [to[0] - from[0], to[1] - from[1]]];
  touch(a);
}
function rerouteFor(ids) {
  for (const a of els) if (a.type === 'arrow' && (ids.has(a.start?.id) || ids.has(a.end?.id))) routeArrow(a);
}

// ------------------------------------------------------------------ rendering
function drawableFor(e) {
  const key = e.id + ':' + e.v + ':' + e.w + ':' + e.h;
  if (cache.has(key)) return cache.get(key);
  const o = { seed: e.seed, stroke: e.stroke, strokeWidth: e.strokeWidth, roughness: e.roughness, fill: e.fill === 'transparent' ? undefined : e.fill, fillStyle: e.fillStyle, fillWeight: e.strokeWidth / 2, hachureGap: 4 + e.strokeWidth * 2, bowing: e.roughness };
  const b = { x: 0, y: 0, w: Math.abs(e.w), h: Math.abs(e.h) };
  let d = [];
  if (e.type === 'rectangle') d = [gen.rectangle(0, 0, b.w, b.h, o)];
  if (e.type === 'ellipse') d = [gen.ellipse(b.w / 2, b.h / 2, b.w, b.h, o)];
  if (e.type === 'diamond') d = [gen.polygon([[b.w / 2, 0], [b.w, b.h / 2], [b.w / 2, b.h], [0, b.h / 2]], o)];
  if (e.type === 'line' || e.type === 'arrow') {
    d = [gen.linearPath(e.points, { ...o, fill: undefined })];
    if (e.type === 'arrow' && e.points.length > 1) {
      const [x1, y1] = e.points.at(-2);
      const [x2, y2] = e.points.at(-1);
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const L = Math.min(22, Math.hypot(x2 - x1, y2 - y1) * 0.4) + e.strokeWidth * 2;
      for (const s of [-1, 1]) d.push(gen.line(x2, y2, x2 - L * Math.cos(ang + s * 0.45), y2 - L * Math.sin(ang + s * 0.45), { ...o, fill: undefined }));
    }
  }
  if (cache.size > 4000) cache.clear();
  cache.set(key, d);
  return d;
}

function textLines(e, t = e.text) {
  return String(t || '').split('\n');
}
function measureText(e, t = e.text) {
  ctx.save();
  ctx.font = `${e.fontSize}px ${FONT}`;
  const lines = textLines(e, t);
  const w = Math.max(10, ...lines.map((l) => ctx.measureText(l).width));
  ctx.restore();
  return { w, h: lines.length * e.fontSize * 1.25 };
}

function drawFree(c, e) {
  const p = e.points;
  c.save();
  c.strokeStyle = e.stroke;
  c.lineWidth = e.strokeWidth * 1.4;
  c.lineCap = c.lineJoin = 'round';
  c.beginPath();
  c.moveTo(p[0][0], p[0][1]);
  for (let i = 1; i < p.length - 1; i++) c.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
  c.lineTo(p.at(-1)[0], p.at(-1)[1]);
  c.stroke();
  c.restore();
}

function drawText(c, e, x, y, t = e.text, align = 'left') {
  c.save();
  c.font = `${e.fontSize}px ${FONT}`;
  c.fillStyle = e.stroke;
  c.textBaseline = 'top';
  c.textAlign = align;
  textLines(e, t).forEach((l, i) => c.fillText(l, x, y + i * e.fontSize * 1.25));
  c.restore();
}

function drawElement(c, r, e) {
  c.save();
  c.globalAlpha = e.opacity ?? 1;
  const b = bounds(e);
  if (e.type === 'freedraw') {
    c.translate(e.x, e.y);
    drawFree(c, e);
  } else if (e.type === 'text') {
    drawText(c, e, e.x, e.y);
  } else if (e.type === 'image') {
    let img = images.get(e.src);
    if (!img) {
      img = new Image();
      img.onload = () => render();
      img.src = e.src;
      images.set(e.src, img);
    }
    if (img.complete) c.drawImage(img, b.x, b.y, b.w, b.h);
  } else {
    c.translate(e.type === 'line' || e.type === 'arrow' ? e.x : b.x, e.type === 'line' || e.type === 'arrow' ? e.y : b.y);
    for (const d of drawableFor(e)) r.draw(d);
  }
  c.restore();
  if (e.label && editing?.id !== e.id) {
    const m = measureText(e, e.label);
    const [cx, cy] = center(e);
    if (e.type === 'arrow' || e.type === 'line') {
      c.save();
      c.fillStyle = '#ffffff';
      c.fillRect(cx - m.w / 2 - 4, cy - m.h / 2 - 2, m.w + 8, m.h + 4);
      c.restore();
    }
    drawText(c, e, cx, cy - m.h / 2, e.label, 'center');
  }
}

function render() {
  const dpr = window.devicePixelRatio || 1;
  const W = innerWidth;
  const H = innerHeight;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
    canvas.width = W * dpr;
    canvas.height = H * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  if (grid) {
    const step = 20 * view.z;
    if (step > 6) {
      ctx.strokeStyle = '#eef0f4';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = (-view.x * view.z) % step; x < W; x += step) ctx.moveTo(x, 0), ctx.lineTo(x, H);
      for (let y = (-view.y * view.z) % step; y < H; y += step) ctx.moveTo(0, y), ctx.lineTo(W, y);
      ctx.stroke();
    }
  }
  ctx.setTransform(dpr * view.z, 0, 0, dpr * view.z, -view.x * view.z * dpr, -view.y * view.z * dpr);
  const [vx0, vy0] = toScene(0, 0);
  const [vx1, vy1] = toScene(W, H);
  for (const e of els) {
    const b = bounds(e);
    if (b.x > vx1 || b.y > vy1 || b.x + b.w < vx0 || b.y + b.h < vy0) continue; // cull off-screen
    drawElement(ctx, rc, e);
  }
  // selection
  ctx.lineWidth = 1 / view.z;
  for (const id of sel) {
    const e = byId(id);
    if (!e) continue;
    const b = bounds(e);
    const pad = 6 / view.z;
    ctx.strokeStyle = '#6965db';
    ctx.setLineDash([4 / view.z, 3 / view.z]);
    ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
    ctx.setLineDash([]);
    if (sel.size === 1 && e.type !== 'text') {
      const hs = 8 / view.z;
      ctx.fillStyle = '#fff';
      for (const [hx, hy] of handles(e)) {
        ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
        ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
      }
    }
  }
  if (drag?.mode === 'marquee') {
    const r = drag.rect;
    ctx.fillStyle = 'rgba(105,101,219,.08)';
    ctx.strokeStyle = '#6965db';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }
  // laser trail
  const now = performance.now();
  laser = laser.filter((p) => now - p[2] < 900);
  if (laser.length > 1) {
    ctx.lineCap = ctx.lineJoin = 'round';
    for (let i = 1; i < laser.length; i++) {
      const a = 1 - (now - laser[i][2]) / 900;
      ctx.strokeStyle = `rgba(255,40,60,${a})`;
      ctx.lineWidth = (2 + 4 * a) / view.z;
      ctx.beginPath();
      ctx.moveTo(laser[i - 1][0], laser[i - 1][1]);
      ctx.lineTo(laser[i][0], laser[i][1]);
      ctx.stroke();
    }
    requestAnimationFrame(render);
  }
  $('#zoomReset').textContent = Math.round(view.z * 100) + '%';
  $('#hint').hidden = els.length > 0;
  syncPanel();
}

function handles(e) {
  if (e.type === 'line' || e.type === 'arrow' || e.type === 'freedraw') {
    if (e.type === 'freedraw') {
      const b = bounds(e);
      return [[b.x + b.w, b.y + b.h]];
    }
    return [[e.x + e.points[0][0], e.y + e.points[0][1]], [e.x + e.points.at(-1)[0], e.y + e.points.at(-1)[1]]];
  }
  const b = bounds(e);
  return [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]];
}

// ------------------------------------------------------------------ pointer input
const pointers = new Map();
let spaceDown = false;

function topHit(p) {
  const tol = 6 / view.z;
  for (let i = els.length - 1; i >= 0; i--) if (hit(els[i], p, tol)) return els[i];
  return null;
}
function shapeAt(p, exclude) {
  for (let i = els.length - 1; i >= 0; i--) {
    const e = els[i];
    if (e.id !== exclude && ['rectangle', 'ellipse', 'diamond', 'text', 'image'].includes(e.type) && hit(e, p, 4 / view.z)) return e;
  }
  return null;
}

canvas.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep focus in the text editor
canvas.addEventListener('pointerdown', (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, [ev.clientX, ev.clientY]);
  if (editing) finishEdit();
  if (pointers.size === 2) {
    // two-finger pinch/pan on touch screens
    const [a, b] = [...pointers.values()];
    drag = { mode: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]), z0: view.z, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], v0: { ...view } };
    return;
  }
  const p = toScene(ev.clientX, ev.clientY);
  if (tool === 'hand' || spaceDown || ev.button === 1) {
    drag = { mode: 'pan', s: [ev.clientX, ev.clientY], v0: { ...view } };
    return;
  }
  if (tool === 'laser') {
    drag = { mode: 'laser' };
    laser.push([...p, performance.now()]);
    return render();
  }
  if (tool === 'eraser') {
    drag = { mode: 'erase', removed: 0 };
    eraseAt(p);
    return;
  }
  if (tool === 'select') {
    if (sel.size === 1) {
      const e = byId([...sel][0]);
      const hs = 10 / view.z;
      const hi = e && e.type !== 'text' ? handles(e).findIndex(([hx, hy]) => Math.abs(hx - p[0]) < hs && Math.abs(hy - p[1]) < hs) : -1;
      if (hi >= 0) {
        drag = { mode: 'resize', id: e.id, hi, orig: JSON.parse(JSON.stringify(e)), s: p };
        return;
      }
    }
    const h = topHit(p);
    if (h) {
      if (ev.shiftKey) sel.has(h.id) ? sel.delete(h.id) : sel.add(h.id);
      else if (!sel.has(h.id)) sel = new Set([h.id]);
      if (ev.altKey) duplicateSelection(0);
      drag = { mode: 'move', s: p, orig: new Map([...sel].map((id) => [id, JSON.parse(JSON.stringify(byId(id)))])), moved: false };
    } else {
      if (!ev.shiftKey) sel.clear();
      drag = { mode: 'marquee', s: p, rect: { x: p[0], y: p[1], w: 0, h: 0 } };
    }
    return render();
  }
  if (tool === 'text') {
    const e = newEl('text', { x: p[0], y: p[1], text: '' });
    els.push(e);
    startEdit(e, 'text');
    if (!lockTool) setTool('select');
    return;
  }
  // drawing tools
  const type = tool === 'pen' ? 'freedraw' : tool;
  const e = newEl(type, { x: p[0], y: p[1] });
  if (type === 'line' || type === 'arrow') {
    e.points = [[0, 0], [0, 0]];
    e.fill = 'transparent';
    const s = shapeAt(p);
    if (type === 'arrow' && s) e.start = { id: s.id };
  }
  if (type === 'freedraw') e.points = [[0, 0]];
  els.push(e);
  sel = new Set([e.id]);
  drag = { mode: 'draw', id: e.id, s: p, raw: [[...p]] };
});

canvas.addEventListener('pointermove', (ev) => {
  if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, [ev.clientX, ev.clientY]);
  if (!drag) {
    if (tool === 'select') canvas.style.cursor = topHit(toScene(ev.clientX, ev.clientY)) ? 'move' : 'default';
    return;
  }
  const p = toScene(ev.clientX, ev.clientY);
  if (drag.mode === 'pinch' && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const z = clampZ(drag.z0 * (d / drag.d0));
    const anchor = [drag.mid[0] / drag.v0.z + drag.v0.x, drag.mid[1] / drag.v0.z + drag.v0.y];
    view = { z, x: anchor[0] - mid[0] / z, y: anchor[1] - mid[1] / z };
    return render();
  }
  if (drag.mode === 'pan') {
    view.x = drag.v0.x - (ev.clientX - drag.s[0]) / view.z;
    view.y = drag.v0.y - (ev.clientY - drag.s[1]) / view.z;
    return render();
  }
  if (drag.mode === 'laser') {
    laser.push([...p, performance.now()]);
    return render();
  }
  if (drag.mode === 'erase') return eraseAt(p);
  if (drag.mode === 'marquee') {
    drag.rect = { x: Math.min(p[0], drag.s[0]), y: Math.min(p[1], drag.s[1]), w: Math.abs(p[0] - drag.s[0]), h: Math.abs(p[1] - drag.s[1]) };
    sel = new Set(els.filter((e) => intersects(e, drag.rect)).map((e) => e.id));
    return render();
  }
  if (drag.mode === 'move') {
    let dx = p[0] - drag.s[0];
    let dy = p[1] - drag.s[1];
    if (grid) [dx, dy] = [Math.round(dx / 10) * 10, Math.round(dy / 10) * 10];
    drag.moved = true;
    for (const [id, o] of drag.orig) {
      const e = byId(id);
      e.x = o.x + dx;
      e.y = o.y + dy;
      if (e.type === 'arrow' && !(sel.has(e.start?.id) && sel.has(e.end?.id))) {
        delete e.start;
        delete e.end;
      }
      touch(e);
    }
    rerouteFor(new Set(drag.orig.keys()));
    return render();
  }
  if (drag.mode === 'resize') {
    const e = byId(drag.id);
    const o = drag.orig;
    if (e.points && e.type !== 'freedraw') {
      const abs = o.points.map((q) => [q[0] + o.x, q[1] + o.y]);
      abs[drag.hi === 0 ? 0 : abs.length - 1] = p;
      e.x = abs[0][0];
      e.y = abs[0][1];
      e.points = abs.map((q) => [q[0] - e.x, q[1] - e.y]);
      if (e.type === 'arrow') {
        const key = drag.hi === 0 ? 'start' : 'end';
        const s = shapeAt(p, e.id);
        if (s) e[key] = { id: s.id };
        else delete e[key];
      }
    } else if (e.type === 'freedraw') {
      const ob = bounds(o);
      const sx = Math.max(0.05, (p[0] - ob.x) / (ob.w || 1));
      const sy = Math.max(0.05, (p[1] - ob.y) / (ob.h || 1));
      e.points = o.points.map((q) => [q[0] * sx, q[1] * sy]);
    } else {
      const ob = bounds(o);
      const corners = [[ob.x + ob.w, ob.y + ob.h], [ob.x, ob.y + ob.h], [ob.x + ob.w, ob.y], [ob.x, ob.y]];
      const fixed = corners[drag.hi];
      let w = p[0] - fixed[0];
      let h = p[1] - fixed[1];
      if (ev.shiftKey) w = h = Math.sign(w || 1) * Math.max(Math.abs(w), Math.abs(h));
      e.x = fixed[0];
      e.y = fixed[1];
      e.w = w;
      e.h = h;
    }
    touch(e);
    rerouteFor(new Set([e.id]));
    return render();
  }
  if (drag.mode === 'draw') {
    const e = byId(drag.id);
    if (e.type === 'freedraw') {
      drag.raw.push([...p]);
      e.points.push([p[0] - e.x, p[1] - e.y]);
    } else if (e.type === 'line' || e.type === 'arrow') {
      let q = p;
      if (ev.shiftKey) {
        const ang = Math.round(Math.atan2(p[1] - e.y, p[0] - e.x) / (Math.PI / 12)) * (Math.PI / 12);
        const L = Math.hypot(p[0] - e.x, p[1] - e.y);
        q = [e.x + L * Math.cos(ang), e.y + L * Math.sin(ang)];
      }
      e.points[1] = [q[0] - e.x, q[1] - e.y];
    } else {
      let w = p[0] - drag.s[0];
      let h = p[1] - drag.s[1];
      if (ev.shiftKey) w = h = Math.sign(w || 1) * Math.max(Math.abs(w), Math.abs(h));
      e.w = w;
      e.h = h;
    }
    touch(e);
    render();
  }
});

function endPointer(ev) {
  pointers.delete(ev.pointerId);
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.mode === 'pinch' || d.mode === 'pan' || d.mode === 'laser') return save(), render();
  if (d.mode === 'erase') {
    if (d.removed) commit();
    return render();
  }
  if (d.mode === 'move') {
    if (d.moved) commit();
    return render();
  }
  if (d.mode === 'resize') {
    const e = byId(d.id);
    normalize(e);
    commit();
    return render();
  }
  if (d.mode === 'draw') {
    const e = byId(d.id);
    const b = bounds(e);
    if (e.type === 'freedraw') {
      const shape = ink ? recognize(d.raw) : null;
      if (shape) {
        Object.assign(e, shape.points ? { type: shape.type, x: shape.points[0][0], y: shape.points[0][1], points: shape.points.map((q) => [q[0] - shape.points[0][0], q[1] - shape.points[0][1]]) } : { type: shape.type, x: shape.x, y: shape.y, w: shape.w, h: shape.h, points: undefined });
        if (!e.points) delete e.points;
        toast(`✨ Ink → ${shape.type}`);
      } else e.points = simplify(e.points, 0.6 / view.z);
    } else if (e.type === 'arrow' || e.type === 'line') {
      const end = [e.x + e.points[1][0], e.y + e.points[1][1]];
      if (Math.hypot(e.points[1][0], e.points[1][1]) < 4) {
        els = els.filter((x) => x !== e);
        sel.clear();
        return render();
      }
      if (e.type === 'arrow') {
        const t = shapeAt(end, e.id);
        if (t && t.id !== e.start?.id) e.end = { id: t.id };
        routeArrow(e);
      }
    } else if (b.w < 3 && b.h < 3) {
      e.w = e.type === 'ellipse' ? 120 : 160;
      e.h = 80;
      e.x -= e.w / 2;
      e.y -= e.h / 2;
    }
    normalize(e);
    touch(e);
    commit();
    if (!lockTool && tool !== 'pen') setTool('select');
    return render();
  }
  if (d.mode === 'marquee') render();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

function normalize(e) {
  if (e.points || e.type === 'text') return;
  const b = bounds(e);
  Object.assign(e, { x: b.x, y: b.y, w: b.w, h: b.h });
}

function eraseAt(p) {
  const h = topHit(p);
  if (!h) return;
  els = els.filter((e) => e !== h);
  for (const a of els) {
    if (a.start?.id === h.id) delete a.start;
    if (a.end?.id === h.id) delete a.end;
  }
  sel.delete(h.id);
  drag.removed++;
  render();
}

canvas.addEventListener(
  'wheel',
  (ev) => {
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) {
      const before = toScene(ev.clientX, ev.clientY);
      view.z = clampZ(view.z * Math.exp(-ev.deltaY * 0.01));
      view.x = before[0] - ev.clientX / view.z;
      view.y = before[1] - ev.clientY / view.z;
    } else {
      view.x += (ev.shiftKey ? ev.deltaY : ev.deltaX) / view.z;
      view.y += (ev.shiftKey ? 0 : ev.deltaY) / view.z;
    }
    save();
    render();
  },
  { passive: false },
);
const clampZ = (z) => Math.min(8, Math.max(0.1, z));
function zoomBy(f) {
  const c = toScene(innerWidth / 2, innerHeight / 2);
  view.z = clampZ(view.z * f);
  view.x = c[0] - innerWidth / 2 / view.z;
  view.y = c[1] - innerHeight / 2 / view.z;
  save();
  render();
}
function fit(list = els) {
  if (!list.length) {
    view = { x: -innerWidth / 2, y: -innerHeight / 2, z: 1 };
    return render();
  }
  const bs = list.map(bounds);
  const x0 = Math.min(...bs.map((b) => b.x));
  const y0 = Math.min(...bs.map((b) => b.y));
  const x1 = Math.max(...bs.map((b) => b.x + b.w));
  const y1 = Math.max(...bs.map((b) => b.y + b.h));
  const z = clampZ(Math.min((innerWidth - 160) / (x1 - x0 || 1), (innerHeight - 200) / (y1 - y0 || 1), 1.5));
  view = { z, x: (x0 + x1) / 2 - innerWidth / 2 / z, y: (y0 + y1) / 2 - innerHeight / 2 / z };
  save();
  render();
}

// ------------------------------------------------------------------ text editing
let editing = null;
const ed = $('#editor');
canvas.addEventListener('dblclick', (ev) => {
  const p = toScene(ev.clientX, ev.clientY);
  const h = topHit(p);
  if (h && h.type === 'text') return startEdit(h, 'text');
  if (h && ['rectangle', 'ellipse', 'diamond', 'arrow', 'line'].includes(h.type)) return startEdit(h, 'label');
  const e = newEl('text', { x: p[0], y: p[1], text: '' });
  els.push(e);
  startEdit(e, 'text');
});
function startEdit(e, field) {
  editing = { id: e.id, field };
  sel = new Set([e.id]);
  ed.hidden = false;
  ed.value = e[field] || '';
  ed.style.fontSize = e.fontSize * view.z + 'px';
  ed.style.color = e.stroke;
  placeEditor();
  ed.focus();
  ed.select();
  render();
}
function placeEditor() {
  const e = byId(editing.id);
  const m = measureText(e, ed.value || ' ');
  ed.style.width = (m.w + 30) * view.z + 'px';
  ed.style.height = (m.h + 6) * view.z + 'px';
  let [x, y] = toScreen(e.x, e.y);
  if (editing.field === 'label') {
    const [cx, cy] = toScreen(...center(e));
    x = cx - ((m.w + 30) * view.z) / 2;
    y = cy - (m.h * view.z) / 2;
    ed.style.textAlign = 'center';
  } else ed.style.textAlign = 'left';
  ed.style.left = x + 'px';
  ed.style.top = y + 'px';
}
ed.addEventListener('input', placeEditor);
ed.addEventListener('keydown', (ev) => {
  ev.stopPropagation();
  if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey))) finishEdit();
});
ed.addEventListener('blur', () => editing && finishEdit());
function finishEdit() {
  if (!editing) return;
  const e = byId(editing.id);
  const v = ed.value.replace(/\s+$/, '');
  const f = editing.field;
  editing = null;
  ed.hidden = true;
  if (!e) return;
  if (f === 'text' && !v) els = els.filter((x) => x !== e);
  else {
    e[f] = v || undefined;
    if (f === 'text') {
      const m = measureText(e);
      e.w = m.w;
      e.h = m.h;
    }
    touch(e);
  }
  commit();
  render();
}

// ------------------------------------------------------------------ commands
function setTool(t) {
  tool = t;
  document.querySelectorAll('#tools [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  canvas.style.cursor = { hand: 'grab', select: 'default', text: 'text', eraser: 'cell', laser: 'crosshair' }[t] || 'crosshair';
  if (t !== 'select') sel.clear();
  render();
}
function deleteSelection() {
  if (!sel.size) return;
  els = els.filter((e) => !sel.has(e.id));
  for (const a of els) {
    if (sel.has(a.start?.id)) delete a.start;
    if (sel.has(a.end?.id)) delete a.end;
  }
  sel.clear();
  commit();
  render();
}
function cloneAll(list, offset) {
  const map = new Map();
  const out = list.map((e) => {
    const c = JSON.parse(JSON.stringify(e));
    c.id = uid();
    c.seed = Math.floor(Math.random() * 2 ** 31);
    c.x += offset;
    c.y += offset;
    map.set(e.id, c.id);
    return c;
  });
  for (const c of out) {
    if (c.start) c.start.id = map.get(c.start.id) || c.start.id;
    if (c.end) c.end.id = map.get(c.end.id) || c.end.id;
  }
  return out;
}
function duplicateSelection(offset = 16) {
  const copies = cloneAll(els.filter((e) => sel.has(e.id)), offset);
  els.push(...copies);
  sel = new Set(copies.map((c) => c.id));
  commit();
  render();
}
function reorder(front) {
  const picked = els.filter((e) => sel.has(e.id));
  const rest = els.filter((e) => !sel.has(e.id));
  els = front ? [...rest, ...picked] : [...picked, ...rest];
  commit();
  render();
}
function doUndo() {
  if (!undo.length) return;
  redo.push(snapshot());
  els = JSON.parse(undo.pop());
  lastSnap = snapshot();
  sel = new Set([...sel].filter(byId));
  save();
  render();
}
function doRedo() {
  if (!redo.length) return;
  undo.push(snapshot());
  els = JSON.parse(redo.pop());
  lastSnap = snapshot();
  save();
  render();
}
function insert(list, at) {
  const bs = list.map(bounds);
  const x0 = Math.min(...bs.map((b) => b.x));
  const y0 = Math.min(...bs.map((b) => b.y));
  const x1 = Math.max(...bs.map((b) => b.x + b.w));
  const y1 = Math.max(...bs.map((b) => b.y + b.h));
  const c = at || toScene(innerWidth / 2, innerHeight / 2);
  const dx = c[0] - (x0 + x1) / 2;
  const dy = c[1] - (y0 + y1) / 2;
  for (const e of list) {
    e.x += dx;
    e.y += dy;
    if (e.type === 'text') Object.assign(e, measureText(e));
  }
  els.push(...list);
  for (const e of list) if (e.type === 'arrow') routeArrow(e);
  sel = new Set(list.map((e) => e.id));
  commit();
  fit(list);
}

// ------------------------------------------------------------------ export / import / share
function sceneBounds(list) {
  const bs = list.map(bounds);
  return { x: Math.min(...bs.map((b) => b.x)) - 30, y: Math.min(...bs.map((b) => b.y)) - 30, x1: Math.max(...bs.map((b) => b.x + b.w)) + 30, y1: Math.max(...bs.map((b) => b.y + b.h)) + 30 };
}
function toPNGCanvas(scale = 2) {
  const list = sel.size ? els.filter((e) => sel.has(e.id)) : els;
  if (!list.length) throw new Error('Nothing to export');
  const b = sceneBounds(list);
  const c = document.createElement('canvas');
  c.width = (b.x1 - b.x) * scale;
  c.height = (b.y1 - b.y) * scale;
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, c.width, c.height);
  x.setTransform(scale, 0, 0, scale, -b.x * scale, -b.y * scale);
  const r = rough.canvas(c);
  for (const e of list) drawElement(x, r, e);
  return c;
}
function download(name, blobOrUrl) {
  const a = document.createElement('a');
  a.href = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  a.download = name;
  a.click();
}
function exportSVG() {
  const list = sel.size ? els.filter((e) => sel.has(e.id)) : els;
  if (!list.length) return toast('Nothing to export');
  const b = sceneBounds(list);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('xmlns', NS);
  svg.setAttribute('viewBox', `${b.x} ${b.y} ${b.x1 - b.x} ${b.y1 - b.y}`);
  svg.setAttribute('width', b.x1 - b.x);
  svg.setAttribute('height', b.y1 - b.y);
  const bg = document.createElementNS(NS, 'rect');
  Object.entries({ x: b.x, y: b.y, width: b.x1 - b.x, height: b.y1 - b.y, fill: '#fff' }).forEach(([k, v]) => bg.setAttribute(k, v));
  svg.appendChild(bg);
  const rs = rough.svg(svg);
  const addText = (e, x, y, t, anchor) =>
    textLines(e, t).forEach((l, i) => {
      const n = document.createElementNS(NS, 'text');
      Object.entries({ x, y: y + i * e.fontSize * 1.25 + e.fontSize, 'font-family': 'Kalam, Comic Sans MS, cursive', 'font-size': e.fontSize, fill: e.stroke, 'text-anchor': anchor }).forEach(([k, v]) => n.setAttribute(k, v));
      n.textContent = l;
      svg.appendChild(n);
    });
  for (const e of list) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('opacity', e.opacity ?? 1);
    const eb = bounds(e);
    if (e.type === 'text') addText(e, e.x, e.y, e.text, 'start');
    else if (e.type === 'freedraw') {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', 'M' + e.points.map((q) => `${(q[0] + e.x).toFixed(1)} ${(q[1] + e.y).toFixed(1)}`).join(' L'));
      Object.entries({ fill: 'none', stroke: e.stroke, 'stroke-width': e.strokeWidth * 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }).forEach(([k, v]) => p.setAttribute(k, v));
      g.appendChild(p);
    } else if (e.type === 'image') {
      const im = document.createElementNS(NS, 'image');
      Object.entries({ href: e.src, x: eb.x, y: eb.y, width: eb.w, height: eb.h }).forEach(([k, v]) => im.setAttribute(k, v));
      g.appendChild(im);
    } else {
      const tx = e.points ? [e.x, e.y] : [eb.x, eb.y];
      g.setAttribute('transform', `translate(${tx[0]} ${tx[1]})`);
      for (const d of drawableFor(e)) g.appendChild(rs.draw(d));
    }
    svg.appendChild(g);
    if (e.label) {
      const [cx, cy] = center(e);
      addText(e, cx, cy - measureText(e, e.label).h / 2, e.label, 'middle');
    }
  }
  download('sketchwise.svg', new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
}
function fileJSON() {
  return JSON.stringify({ type: 'sketchwise', version: 1, elements: els }, null, 1);
}
async function share() {
  if (!els.length) return toast('Draw something first');
  if (els.some((e) => e.type === 'image')) toast('Images are not included in share links — use Save as .sketchwise');
  const data = await compress(JSON.stringify(els.filter((e) => e.type !== 'image')));
  const url = `${location.origin}${location.pathname}#board=${data}`;
  if (url.length > 60000) return toast('Board too large for a link — use Save as .sketchwise');
  try {
    await navigator.clipboard.writeText(url);
    toast('Share link copied — anyone with it gets their own copy of this board');
  } catch {
    prompt('Copy this link:', url);
  }
}
async function loadFromHash() {
  const m = location.hash.match(/board=([\w-]+)/);
  if (!m) return false;
  try {
    const list = JSON.parse(await decompress(m[1]));
    if (els.length) localStorage.setItem(STORE + ':previous', JSON.stringify({ els }));
    els = list;
    commit();
    history.replaceState(null, '', location.pathname);
    fit();
    toast('Opened shared board (your previous board was backed up)');
    return true;
  } catch {
    toast('That share link is damaged');
    return false;
  }
}
async function importFile(file) {
  if (file.type.startsWith('image/')) return addImage(file);
  try {
    const j = JSON.parse(await file.text());
    const list = j.elements || j;
    if (!Array.isArray(list)) throw new Error();
    els = list;
    sel.clear();
    commit();
    fit();
  } catch {
    toast('Not a Sketchwise file');
  }
}
function addImage(file, at) {
  if (file.size > 3e6) return toast('Image too large (max 3 MB)');
  const r = new FileReader();
  r.onload = () => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 480 / img.width);
      const c = at || toScene(innerWidth / 2, innerHeight / 2);
      const e = newEl('image', { src: r.result, x: c[0] - (img.width * s) / 2, y: c[1] - (img.height * s) / 2, w: img.width * s, h: img.height * s });
      els.push(e);
      sel = new Set([e.id]);
      commit();
      render();
    };
    img.src = r.result;
  };
  r.readAsDataURL(file);
}

// ------------------------------------------------------------------ dialogs
function dialog(html, onOk) {
  const d = $('#dlg');
  $('#dlgBody').innerHTML = html;
  d.showModal();
  $('#dlgBody').onsubmit = (e) => {
    if (e.submitter?.value === 'ok' && onOk) onOk();
  };
  $('#dlgBody').querySelectorAll('[data-tpl]').forEach((b) =>
    b.addEventListener('click', () => {
      insert(TEMPLATES[b.dataset.tpl]());
      d.close();
    }),
  );
}
const SAMPLE = `# Arrows make a flowchart.  {..} = decision, (..) = rounded, -[label]-> = labelled edge
(Idea) -> Research -> {Worth building?}
{Worth building?} -[yes]-> Build MVP -> Launch -> (Learn)
{Worth building?} -[no]-> (Next idea)
Learn -> Research

# Or, with no arrows, indentation makes a mind map:
#  Product
#    Marketing
#    Engineering`;
function openDiagram() {
  dialog(
    `<h3>Text → diagram</h3><p class="muted">Type a flowchart with <code>-&gt;</code> arrows, or an indented list for a mind map. Shapes stay editable.</p>
     <textarea id="diagramSrc" spellcheck="false">${SAMPLE.replace(/</g, '&lt;')}</textarea>
     <div class="row"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok">Insert diagram</button></div>`,
    () => {
      const src = $('#diagramSrc').value;
      const list = diagramElements(src);
      if (!list.length) return toast('Nothing to draw — try “A -> B -> C”');
      insert(list);
      toast(`Inserted ${list.filter((e) => e.type !== 'arrow').length} nodes`);
    },
  );
}
function openTemplates() {
  dialog(`<h3>Templates</h3><div class="tgrid">${Object.keys(TEMPLATES).map((k) => `<button type="button" data-tpl="${k}">${k}</button>`).join('')}</div><div class="row"><button class="btn" value="cancel">Close</button></div>`);
}
function openHelp() {
  const rows = [['V / H', 'Select / pan (or hold Space, or middle-drag)'], ['R D O', 'Rectangle, diamond, ellipse'], ['A / L', 'Arrow (drop on shapes to connect) / line'], ['P', 'Pen — ✨ ink → shape turns rough strokes into clean shapes'], ['T or double-click', 'Text; double-click a shape to label it'], ['E / K', 'Eraser / laser pointer'], ['Q', 'Keep the current tool after drawing'], ['Shift', 'Square / circle / 15° angles while drawing'], ['Alt + drag', 'Duplicate while moving'], ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'], ['Ctrl+D, Ctrl+C / V, Del', 'Duplicate, copy / paste (images too), delete'], ['[ / ]', 'Send to back / bring to front'], ['Ctrl + wheel, pinch', 'Zoom'], ['Shift+1', 'Zoom to fit']];
  dialog(`<h3>Shortcuts</h3><table>${rows.map(([k, v]) => `<tr><td><kbd>${k}</kbd></td><td>${v}</td></tr>`).join('')}</table><p class="muted">Everything stays in your browser. Boards sync live across tabs. Share links embed the board in the URL — no server.</p><div class="row"><button class="btn" value="cancel">Close</button></div>`);
}

// ------------------------------------------------------------------ style panel
function selected() {
  return els.filter((e) => sel.has(e.id));
}
function syncPanel() {
  const panel = $('#stylePanel');
  const show = sel.size > 0 || !['select', 'hand', 'eraser', 'laser'].includes(tool);
  panel.hidden = !show;
  if (!show) return;
  const src = selected()[0] || style;
  panel.querySelectorAll('.swatches').forEach((sw) => sw.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === src[sw.dataset.prop])));
  panel.querySelectorAll('.seg[data-prop]').forEach((sg) => sg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(src[sg.dataset.prop]) === b.dataset.v)));
  panel.querySelector('input[data-prop=opacity]').value = src.opacity ?? 1;
}
function applyStyle(prop, val) {
  style[prop] = val;
  if (sel.size) {
    for (const e of selected()) {
      e[prop] = val;
      if (e.type === 'text' && prop === 'fontSize') Object.assign(e, measureText(e));
      touch(e);
    }
    commit();
  } else save();
  render();
}
(function buildPanel() {
  const sw = (prop, list) => ($(`.swatches[data-prop=${prop}]`).innerHTML = list.map((c) => `<button data-v="${c}" class="${c === 'transparent' ? 'none' : ''}" style="background:${c}" title="${c}"></button>`).join(''));
  sw('stroke', STROKES);
  sw('fill', FILLS);
  $('#stylePanel').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    const holder = b.closest('[data-prop]');
    if (holder) return applyStyle(holder.dataset.prop, isNaN(b.dataset.v) || b.dataset.v === '' ? b.dataset.v : Number(b.dataset.v));
    ({ back: () => reorder(false), front: () => reorder(true), dup: () => duplicateSelection(), del: deleteSelection })[b.dataset.act]?.();
  });
  $('#stylePanel input[data-prop=opacity]').addEventListener('change', (ev) => applyStyle('opacity', Number(ev.target.value)));
})();

// ------------------------------------------------------------------ wiring
$('#tools').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-tool]');
  if (b) setTool(b.dataset.tool);
});
$('#lockBtn').addEventListener('click', () => {
  lockTool = !lockTool;
  $('#lockBtn').classList.toggle('on', lockTool);
});
$('#inkBtn').addEventListener('click', () => {
  ink = !ink;
  $('#inkBtn').classList.toggle('on', ink);
  toast(ink ? '✨ Ink → shape on' : 'Ink → shape off');
});
$('#undoBtn').onclick = doUndo;
$('#redoBtn').onclick = doRedo;
$('#zoomIn').onclick = () => zoomBy(1.2);
$('#zoomOut').onclick = () => zoomBy(1 / 1.2);
$('#zoomReset').onclick = () => zoomBy(1 / view.z);
$('#fitBtn').onclick = () => fit();
$('#shareBtn').onclick = share;
$('#diagramBtn').onclick = openDiagram;
$('#templatesBtn').onclick = openTemplates;
$('#menuBtn').onclick = () => ($('#menu').hidden = !$('#menu').hidden);
$('#menu').addEventListener('click', async (ev) => {
  const m = ev.target.closest('[data-m]')?.dataset.m;
  if (!m) return;
  $('#menu').hidden = true;
  try {
    if (m === 'new' && (!els.length || confirm('Clear the board? (Undo can bring it back.)'))) {
      els = [];
      sel.clear();
      commit();
      render();
    }
    if (m === 'open') $('#fileIn').click();
    if (m === 'save') download('board.sketchwise', new Blob([fileJSON()], { type: 'application/json' }));
    if (m === 'png') download('sketchwise.png', toPNGCanvas().toDataURL('image/png'));
    if (m === 'svg') exportSVG();
    if (m === 'copy') {
      const blob = await new Promise((r) => toPNGCanvas().toBlob(r));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('PNG copied to clipboard');
    }
    if (m === 'grid') {
      grid = !grid;
      save();
      render();
    }
    if (m === 'theme') {
      document.body.classList.toggle('dark');
      localStorage.setItem('sketchwise:dark', document.body.classList.contains('dark') ? '1' : '');
    }
    if (m === 'help') openHelp();
    if (m === 'diagram') openDiagram();
    if (m === 'templates') openTemplates();
  } catch (e) {
    toast(e.message);
  }
});
$('#fileIn').addEventListener('change', (ev) => {
  const f = ev.target.files[0];
  if (f) importFile(f);
  ev.target.value = '';
});
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('#menu, #menuBtn')) $('#menu').hidden = true;
});
addEventListener('dragover', (ev) => ev.preventDefault());
addEventListener('drop', (ev) => {
  ev.preventDefault();
  const f = ev.dataTransfer.files[0];
  if (f) f.type.startsWith('image/') ? addImage(f, toScene(ev.clientX, ev.clientY)) : importFile(f);
});
addEventListener('paste', (ev) => {
  if (editing || document.activeElement?.tagName === 'TEXTAREA') return;
  const item = [...(ev.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) return addImage(item.getAsFile());
  const txt = ev.clipboardData?.getData('text/plain');
  if (clipboard.length && !txt) return pasteInternal();
  if (txt && /->/.test(txt)) {
    ev.preventDefault();
    return insert(diagramElements(txt));
  }
  if (clipboard.length) return pasteInternal();
  if (txt) {
    const e = newEl('text', { text: txt.slice(0, 5000) });
    insert([e]);
  }
});
function pasteInternal() {
  const copies = cloneAll(clipboard, 24);
  els.push(...copies);
  sel = new Set(copies.map((c) => c.id));
  commit();
  render();
}
addEventListener('keydown', (ev) => {
  if (editing || ev.target.closest?.('dialog, textarea, input')) return;
  const k = ev.key.toLowerCase();
  const mod = ev.metaKey || ev.ctrlKey;
  if (k === ' ') {
    spaceDown = true;
    canvas.style.cursor = 'grab';
    ev.preventDefault();
    return;
  }
  if (mod && k === 'z') return ev.preventDefault(), ev.shiftKey ? doRedo() : doUndo();
  if (mod && k === 'y') return ev.preventDefault(), doRedo();
  if (mod && k === 'd') return ev.preventDefault(), duplicateSelection();
  if (mod && k === 'a') return ev.preventDefault(), (sel = new Set(els.map((e) => e.id))), render();
  if (mod && k === 'c') return (clipboard = JSON.parse(JSON.stringify(selected()))), navigator.clipboard?.writeText('').catch(() => {});
  if (mod && k === 's') return ev.preventDefault(), download('board.sketchwise', new Blob([fileJSON()], { type: 'application/json' }));
  if (mod) return;
  if (k === 'delete' || k === 'backspace') return deleteSelection();
  if (k === 'escape') return (sel.clear(), setTool('select'));
  if (ev.shiftKey && (k === '!' || k === '1')) return fit();
  if (k === '[') return reorder(false);
  if (k === ']') return reorder(true);
  if (k.startsWith('arrow') && sel.size) {
    const d = ev.shiftKey ? 10 : 1;
    for (const e of selected()) {
      e.x += k === 'arrowleft' ? -d : k === 'arrowright' ? d : 0;
      e.y += k === 'arrowup' ? -d : k === 'arrowdown' ? d : 0;
      touch(e);
    }
    rerouteFor(sel);
    commit();
    return render();
  }
  const map = { v: 'select', h: 'hand', r: 'rectangle', d: 'diamond', o: 'ellipse', a: 'arrow', l: 'line', p: 'pen', t: 'text', e: 'eraser', k: 'laser' };
  if (map[k]) return setTool(map[k]);
  if (k === 'q') return $('#lockBtn').click();
});
addEventListener('keyup', (ev) => {
  if (ev.key === ' ') {
    spaceDown = false;
    setTool(tool);
  }
});
addEventListener('resize', render);

if (localStorage.getItem('sketchwise:dark') || (localStorage.getItem('sketchwise:dark') === null && matchMedia('(prefers-color-scheme: dark)').matches)) document.body.classList.add('dark');
document.fonts?.load(`20px Kalam`).then(() => {
  cache.clear();
  render();
});
window.sketchwise = { get els() { return els; }, insert, diagramElements, fit, render };
loadFromHash().then((loaded) => {
  if (!loaded && !els.length) view = { x: -innerWidth / 2, y: -innerHeight / 2, z: 1 };
  render();
});
addEventListener('hashchange', loadFromHash);
