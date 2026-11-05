import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hit, bounds, edgePoint, recognize, simplify, parseDiagram, layoutDiagram, compress, decompress } from '../lib/geometry.mjs';
import { diagramElements, TEMPLATES } from '../lib/templates.mjs';

const circle = (cx, cy, r, n = 60) => Array.from({ length: n + 1 }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)]);
const rectPts = (x, y, w, h) => {
  const out = [];
  for (let i = 0; i <= 20; i++) out.push([x + (w * i) / 20, y]);
  for (let i = 0; i <= 20; i++) out.push([x + w, y + (h * i) / 20]);
  for (let i = 0; i <= 20; i++) out.push([x + w - (w * i) / 20, y + h]);
  for (let i = 0; i <= 20; i++) out.push([x, y + h - (h * i) / 20]);
  return out;
};
const jitter = (pts, a = 2) => pts.map(([x, y], i) => [x + Math.sin(i * 1.7) * a, y + Math.cos(i * 2.3) * a]);

test('ink → shape recognises circles, rectangles, lines and rejects scribbles', () => {
  assert.equal(recognize(jitter(circle(100, 100, 60))).type, 'ellipse');
  assert.equal(recognize(jitter(rectPts(0, 0, 200, 120))).type, 'rectangle');
  const line = Array.from({ length: 30 }, (_, i) => [i * 10, i * 5 + Math.sin(i) * 1.5]);
  assert.equal(recognize(line).type, 'line');
  const scribble = Array.from({ length: 60 }, (_, i) => [Math.sin(i * 0.9) * 80 + i * 3, Math.cos(i * 1.3) * 60]);
  assert.equal(recognize(scribble), null);
});

test('hit testing per shape', () => {
  const r = { type: 'rectangle', x: 0, y: 0, w: 100, h: 50 };
  assert.ok(hit(r, [50, 25]));
  assert.ok(!hit(r, [150, 25]));
  const e = { type: 'ellipse', x: 0, y: 0, w: 100, h: 100 };
  assert.ok(hit(e, [50, 50]));
  assert.ok(!hit(e, [2, 2], 0));
  const l = { type: 'line', x: 0, y: 0, points: [[0, 0], [100, 0]], strokeWidth: 2 };
  assert.ok(hit(l, [50, 3]));
  assert.ok(!hit(l, [50, 30]));
});

test('edge points land on the outline', () => {
  const r = { type: 'rectangle', x: 0, y: 0, w: 100, h: 50 };
  const [x, y] = edgePoint(r, [500, 25], 0);
  assert.equal(Math.round(x), 100);
  assert.equal(Math.round(y), 25);
  const e = { type: 'ellipse', x: 0, y: 0, w: 100, h: 100 };
  const p = edgePoint(e, [50, -500], 0);
  assert.equal(Math.round(p[1]), 0);
});

test('negative-size shapes normalise in bounds()', () => {
  assert.deepEqual(bounds({ type: 'rectangle', x: 100, y: 100, w: -40, h: -20 }), { x: 60, y: 80, w: 40, h: 20 });
});

test('simplify keeps endpoints', () => {
  const s = simplify(Array.from({ length: 100 }, (_, i) => [i, 0]));
  assert.deepEqual(s, [[0, 0], [99, 0]]);
});

test('text → flowchart with shapes, labels and cycles', () => {
  const d = parseDiagram('(Start) -> Step A -> {OK?}\n{OK?} -[no]-> Step A\n{OK?} -[yes]-> (End)');
  assert.equal(d.kind, 'flow');
  assert.deepEqual(d.nodes.map((n) => [n.id, n.shape]), [['Start', 'ellipse'], ['Step A', 'rectangle'], ['OK?', 'diamond'], ['End', 'ellipse']]);
  assert.equal(d.edges.find((e) => e.label === 'no').to, 'Step A');
  const pos = layoutDiagram(d);
  assert.ok(pos['End'].x > pos['OK?'].x && pos['OK?'].x > pos['Start'].x);
});

test('indented list → mind map', () => {
  const d = parseDiagram('Root\n  A\n    A1\n  B');
  assert.equal(d.kind, 'mind');
  assert.deepEqual(d.edges.map((e) => `${e.from}>${e.to}`), ['Root>A', 'A>A1', 'Root>B']);
});

test('diagram + templates produce bound arrows', () => {
  const els = diagramElements('A -> B -> C');
  const arrows = els.filter((e) => e.type === 'arrow');
  assert.equal(arrows.length, 2);
  const ids = new Set(els.map((e) => e.id));
  assert.ok(arrows.every((a) => ids.has(a.start.id) && ids.has(a.end.id)));
  for (const t of Object.values(TEMPLATES)) assert.ok(t().length > 3);
});

test('share-link compression round-trips', async () => {
  const s = JSON.stringify(diagramElements('A -> B'));
  const c = await compress(s);
  assert.match(c, /^[\w-]+$/);
  assert.equal(await decompress(c), s);
});

test('cycles do not stretch the layout', () => {
  const d = parseDiagram('Idea -> Research -> Build -> Learn\nLearn -> Research');
  const pos = layoutDiagram(d);
  assert.ok(pos['Research'].x < pos['Build'].x && pos['Build'].x < pos['Learn'].x);
});
