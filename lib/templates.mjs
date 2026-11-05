// Templates and text→diagram → elements.
import { uid, parseDiagram, layoutDiagram } from './geometry.mjs';

const base = (o) => ({ id: uid(), seed: Math.floor(Math.random() * 2 ** 31), stroke: '#1e1e1e', fill: 'transparent', fillStyle: 'hachure', strokeWidth: 2, roughness: 1, opacity: 1, fontSize: 20, v: 1, ...o });
export const rect = (x, y, w, h, o = {}) => base({ type: 'rectangle', x, y, w, h, ...o });
export const text = (x, y, t, o = {}) => base({ type: 'text', x, y, w: 0, h: 0, text: t, ...o });
export const arrow = (from, to, o = {}) => base({ type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [[0, 0], [1, 1]], start: { id: from }, end: { id: to }, ...o });

const NOTE = ['#ffec99', '#b2f2bb', '#a5d8ff', '#ffc9c9', '#d0bfff'];

export function diagramElements(src, origin = [0, 0]) {
  const d = parseDiagram(src);
  if (!d.nodes.length) return [];
  const pos = layoutDiagram(d);
  const ids = {};
  const els = [];
  d.nodes.forEach((n, i) => {
    const p = pos[n.id];
    const fill = d.kind === 'mind' ? NOTE[Math.min(NOTE.length - 1, depthOf(d, n.id))] : n.shape === 'diamond' ? '#ffec99' : n.shape === 'ellipse' ? '#b2f2bb' : '#a5d8ff';
    const el = base({ type: n.shape, x: origin[0] + p.x, y: origin[1] + p.y, w: p.w, h: p.h, label: n.label, fill, fillStyle: 'solid', roughness: 1 });
    ids[n.id] = el.id;
    els.push(el);
    void i;
  });
  for (const e of d.edges) els.push(arrow(ids[e.from], ids[e.to], { label: e.label || undefined, route: pos[e.to].x <= pos[e.from].x && e.from !== e.to ? 'below' : undefined }));
  return els;
}

function depthOf(d, id, seen = new Set()) {
  const parent = d.edges.find((e) => e.to === id)?.from;
  if (!parent || seen.has(parent)) return 0;
  seen.add(parent);
  return 1 + depthOf(d, parent, seen);
}

export const TEMPLATES = {
  'Kanban board': () => {
    const cols = ['To do', 'Doing', 'Done'];
    const out = [];
    cols.forEach((c, i) => {
      out.push(rect(i * 300, 0, 270, 520, { fill: '#f8f9fa', fillStyle: 'solid', roughness: 0.6 }));
      out.push(text(i * 300 + 20, 18, c, { fontSize: 28 }));
      for (let k = 0; k < 3 - i; k++) out.push(rect(i * 300 + 20, 80 + k * 120, 230, 100, { fill: NOTE[(i + k) % NOTE.length], fillStyle: 'solid', label: ['Write spec', 'Design review', 'Ship v1', 'User interviews', 'Fix bugs', 'Launch post'][(i * 3 + k) % 6] }));
    });
    return out;
  },
  'SWOT analysis': () => {
    const q = [['Strengths', '#b2f2bb'], ['Weaknesses', '#ffc9c9'], ['Opportunities', '#a5d8ff'], ['Threats', '#ffec99']];
    return q.flatMap(([t, f], i) => [rect((i % 2) * 360, Math.floor(i / 2) * 280, 340, 260, { fill: f, fillStyle: 'hachure' }), text((i % 2) * 360 + 20, Math.floor(i / 2) * 280 + 16, t, { fontSize: 30 })]);
  },
  Retrospective: () => {
    const q = [['😀 Went well', '#b2f2bb'], ['🤔 To improve', '#ffec99'], ['🚀 Actions', '#a5d8ff']];
    return q.flatMap(([t, f], i) => [rect(i * 320, 0, 300, 420, { fill: f, fillStyle: 'cross-hatch', roughness: 1.4 }), text(i * 320 + 20, 16, t, { fontSize: 28 })]);
  },
  'User signup flow': () => diagramElements('(Visit landing page) -> Sign up form -> {Email valid?}\n{Email valid?} -[yes]-> Send verification -> (Onboarding)\n{Email valid?} -[no]-> Show error -> Sign up form'),
  'System architecture': () => diagramElements('Browser -> CDN -> Load balancer\nLoad balancer -> API server\nAPI server -> (Postgres)\nAPI server -> (Redis cache)\nAPI server -> Worker queue -> Email service'),
  'Mind map': () => diagramElements('Product launch\n  Marketing\n    Blog post\n    X thread\n    Product Hunt\n  Engineering\n    Landing page\n    Analytics\n  Community\n    Discord\n    Office hours'),
};
