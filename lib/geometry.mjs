// Sketchwise pure helpers — geometry, hit-testing, ink→shape recognition, text→diagram. (Unit-tested.)

export const uid = () => Math.random().toString(36).slice(2, 10);

export function bounds(el) {
  if (el.points?.length) {
    const xs = el.points.map((p) => p[0] + el.x);
    const ys = el.points.map((p) => p[1] + el.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  const x = Math.min(el.x, el.x + el.w);
  const y = Math.min(el.y, el.y + el.h);
  return { x, y, w: Math.abs(el.w), h: Math.abs(el.h) };
}

export function center(el) {
  const b = bounds(el);
  return [b.x + b.w / 2, b.y + b.h / 2];
}

export function distToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Is scene point p on element el (tolerance tol in scene units)? */
export function hit(el, p, tol = 6) {
  const b = bounds(el);
  if (p[0] < b.x - tol || p[0] > b.x + b.w + tol || p[1] < b.y - tol || p[1] > b.y + b.h + tol) return false;
  if (el.points) {
    for (let i = 1; i < el.points.length; i++) {
      const a = [el.points[i - 1][0] + el.x, el.points[i - 1][1] + el.y];
      const c = [el.points[i][0] + el.x, el.points[i][1] + el.y];
      if (distToSegment(p, a, c) <= tol + (el.strokeWidth || 2)) return true;
    }
    return el.points.length === 1;
  }
  if (el.type === 'ellipse') {
    const [cx, cy] = [b.x + b.w / 2, b.y + b.h / 2];
    const rx = b.w / 2 + tol;
    const ry = b.h / 2 + tol;
    return ((p[0] - cx) / rx) ** 2 + ((p[1] - cy) / ry) ** 2 <= 1;
  }
  if (el.type === 'diamond') {
    const [cx, cy] = [b.x + b.w / 2, b.y + b.h / 2];
    return Math.abs(p[0] - cx) / (b.w / 2 + tol) + Math.abs(p[1] - cy) / (b.h / 2 + tol) <= 1;
  }
  return true; // rectangle, text, image: bbox
}

export function intersects(el, r) {
  const b = bounds(el);
  return b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h;
}

/** Point where the ray from el's centre towards `toward` leaves el's outline (for bound arrows). */
export function edgePoint(el, toward, gap = 6) {
  const b = bounds(el);
  const [cx, cy] = [b.x + b.w / 2, b.y + b.h / 2];
  let dx = toward[0] - cx;
  let dy = toward[1] - cy;
  if (!dx && !dy) return [cx, cy];
  const hw = b.w / 2 + gap;
  const hh = b.h / 2 + gap;
  let t;
  if (el.type === 'ellipse') t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
  else if (el.type === 'diamond') t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else t = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  return [cx + dx * t, cy + dy * t];
}

export function pathLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** Ramer–Douglas–Peucker simplification. */
export function simplify(pts, eps = 1.5) {
  if (pts.length < 3) return pts;
  let idx = 0;
  let max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSegment(pts[i], pts[0], pts.at(-1));
    if (d > max) [max, idx] = [d, i];
  }
  if (max <= eps) return [pts[0], pts.at(-1)];
  return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)];
}

/**
 * Ink → shape. Given absolute points of a freehand stroke, returns
 * { type: 'line'|'arrow'|'rectangle'|'ellipse'|'diamond', ... } or null if it doesn't look like one.
 */
export function recognize(pts) {
  if (pts.length < 4) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const b = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  const diag = Math.hypot(b.w, b.h);
  if (diag < 20) return null;
  const L = pathLength(pts);
  const gap = Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]);

  // Open strokes: straight line, or a line with an arrow-head scribble at the end.
  if (gap > diag * 0.3) {
    const chord = gap;
    if (chord / L > 0.92) return { type: 'line', points: [pts[0], pts.at(-1)] };
    const s = simplify(pts, diag * 0.06);
    if (s.length >= 4 && s.length <= 6) {
      // Arrow: long shaft followed by a short "head" stroke that doubles back.
      const shaft = Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);
      if (shaft > L * 0.55) return { type: 'arrow', points: [s[0], s[1]] };
    }
    return null;
  }
  if (L < diag * 1.6) return null; // closed but too small a loop to be meaningful
  // Closed strokes: score how well points fit each candidate outline.
  const [cx, cy] = [b.x + b.w / 2, b.y + b.h / 2];
  const rx = b.w / 2 || 1;
  const ry = b.h / 2 || 1;
  const err = { ellipse: 0, rectangle: 0, diamond: 0 };
  for (const [x, y] of pts) {
    const nx = (x - cx) / rx;
    const ny = (y - cy) / ry;
    err.ellipse += Math.abs(Math.hypot(nx, ny) - 1);
    err.rectangle += Math.abs(Math.max(Math.abs(nx), Math.abs(ny)) - 1);
    err.diamond += Math.abs(Math.abs(nx) + Math.abs(ny) - 1);
  }
  const best = Object.entries(err).sort((a, c) => a[1] - c[1])[0];
  if (best[1] / pts.length > 0.22) return null;
  return { type: best[0], x: b.x, y: b.y, w: b.w, h: b.h };
}

// ------------------------------------------------------------------ text → diagram
/**
 * Flowchart syntax (one edge chain per line):
 *   Idea -> Research -> Build
 *   Research -[no]-> Idea          (edge label)
 *   Build -> {Ship?}               ({...} diamond, (...) ellipse, [...] rectangle)
 * Mind-map syntax (indentation, no arrows):
 *   Product launch
 *     Marketing
 *       Blog post
 */
export function parseDiagram(src) {
  const lines = String(src).split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() && !l.trim().startsWith('#') && !/^(graph|flowchart)\b/i.test(l.trim()));
  const isFlow = lines.some((l) => /-(\[[^\]]*\])?-?>|=>|→/.test(l));
  const nodes = new Map();
  const edges = [];
  const node = (raw) => {
    let t = raw.trim();
    let shape = 'rectangle';
    if (/^\{.*\}$/.test(t)) [shape, t] = ['diamond', t.slice(1, -1)];
    else if (/^\(.*\)$/.test(t)) [shape, t] = ['ellipse', t.slice(1, -1)];
    else if (/^\[.*\]$/.test(t)) t = t.slice(1, -1);
    t = t.trim();
    if (!nodes.has(t)) nodes.set(t, { id: t, label: t, shape });
    else if (shape !== 'rectangle') nodes.get(t).shape = shape;
    return t;
  };
  if (isFlow) {
    for (const line of lines) {
      const parts = line.split(/\s*(-\[[^\]]*\]->|-->|->|=>|→)\s*/);
      for (let i = 0; i + 2 < parts.length; i += 2) {
        const a = node(parts[i]);
        const b = node(parts[i + 2]);
        const lab = parts[i + 1].match(/\[([^\]]*)\]/)?.[1] || '';
        edges.push({ from: a, to: b, label: lab });
      }
      if (parts.length === 1) node(parts[0]);
    }
    return { kind: 'flow', nodes: [...nodes.values()], edges };
  }
  const stack = [];
  for (const line of lines) {
    const depth = line.match(/^\s*/)[0].replace(/\t/g, '  ').length;
    const label = line.trim().replace(/^[-*•]\s*/, '');
    let id = label;
    for (let k = 2; nodes.has(id); k++) id = `${label} (${k})`;
    nodes.set(id, { id, label, shape: stack.length ? 'rectangle' : 'ellipse' });
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    if (stack.length) edges.push({ from: stack.at(-1).id, to: id, label: '' });
    stack.push({ id, depth });
  }
  return { kind: 'mind', nodes: [...nodes.values()], edges };
}

/** Layered left→right layout (longest-path ranks, barycentre ordering). Returns {id: {x, y, w, h}}. */
export function layoutDiagram(d, { nodeW = 160, nodeH = 64, gapX = 90, gapY = 36 } = {}) {
  const ids = d.nodes.map((n) => n.id);
  // Find back edges with a DFS so cycles (e.g. "Learn -> Research") don't stretch the layout.
  const out = Object.fromEntries(ids.map((i) => [i, []]));
  for (const e of d.edges) if (e.from !== e.to) out[e.from].push(e.to);
  const state = {};
  const back = new Set();
  const dfs = (u) => {
    state[u] = 1;
    for (const v of out[u]) {
      if (state[v] === 1) back.add(u + '\u0000' + v);
      else if (!state[v]) dfs(v);
    }
    state[u] = 2;
  };
  ids.forEach((i) => !state[i] && dfs(i));
  const preds = Object.fromEntries(ids.map((i) => [i, []]));
  for (const e of d.edges) if (e.from !== e.to && !back.has(e.from + '\u0000' + e.to)) preds[e.to].push(e.from);
  const rank = {};
  const r = (id) => {
    if (rank[id] != null) return rank[id];
    rank[id] = 0;
    rank[id] = preds[id].length ? Math.max(...preds[id].map(r)) + 1 : 0;
    return rank[id];
  };
  ids.forEach(r);
  const cols = [];
  for (const id of ids) (cols[rank[id]] ||= []).push(id);
  const pos = {};
  cols.forEach((col, ci) => {
    if (ci > 0) {
      const bary = (id) => {
        const p = preds[id].filter((x) => pos[x]);
        return p.length ? p.reduce((s, x) => s + pos[x].y, 0) / p.length : 0;
      };
      col.sort((a, b) => bary(a) - bary(b));
    }
    const total = col.length * nodeH + (col.length - 1) * gapY;
    col.forEach((id, i) => {
      const n = d.nodes.find((x) => x.id === id);
      const w = Math.max(nodeW, Math.min(320, n.label.length * 9 + 40));
      pos[id] = { x: ci * (nodeW + gapX + 40), y: -total / 2 + i * (nodeH + gapY), w, h: n.shape === 'diamond' ? nodeH * 1.3 : nodeH };
    });
  });
  return pos;
}

// ------------------------------------------------------------------ share links
export async function compress(str) {
  const cs = new CompressionStream('deflate-raw');
  const buf = await new Response(new Blob([str]).stream().pipeThrough(cs)).arrayBuffer();
  let bin = '';
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function decompress(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const ds = new DecompressionStream('deflate-raw');
  return new Response(new Blob([bytes]).stream().pipeThrough(ds)).text();
}
