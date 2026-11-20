import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, bottom, clamp, collides, compact, move, ownKey, readPanelFile, remove, resize, sanitize, stack } from '../js/dashgrid.js';

const it = (id, x, y, w, h) => ({ id, type: 't', x, y, w, h });
const noOverlap = (l) => l.every((a, i) => l.every((b, j) => i === j || !collides(a, b)));
const at = (l, id) => l.find((i) => i.id === id);

test('panel: choques', () => {
  assert.ok(collides(it('a', 0, 0, 2, 2), it('b', 1, 1, 2, 2)));
  assert.ok(!collides(it('a', 0, 0, 2, 2), it('b', 2, 0, 2, 2)));
});

test('panel: clamp a 12 columnas y a los mínimos', () => {
  assert.deepEqual(clamp(it('a', 11, 0, 4, 1), { minW: 2, minH: 2 }), it('a', 8, 0, 4, 2));
  assert.equal(clamp(it('a', -3, -1, 1, 1)).x, 0);
  assert.equal(clamp(it('a', 0, -1, 1, 1)).y, 0);
  assert.equal(clamp(it('a', 0, 0, 20, 1)).w, 12);
});

test('panel: compactar sube lo que puede', () => {
  assert.deepEqual(compact([it('a', 0, 5, 2, 2)]).map((i) => i.y), [0]);
  const l = compact([it('a', 0, 0, 2, 2), it('b', 0, 6, 2, 2), it('c', 4, 9, 2, 1)]);
  assert.deepEqual(l.map((i) => [i.id, i.y]), [['a', 0], ['b', 2], ['c', 0]]);
});

test('panel: mover empuja hacia abajo y no solapa', () => {
  const l = move([it('a', 0, 0, 4, 2), it('b', 0, 2, 4, 2)], 'b', 0, 0);
  assert.ok(noOverlap(l));
  assert.equal(at(l, 'b').y, 0);
  assert.equal(at(l, 'a').y, 2);
});

test('panel: mover en cadena (lo empujado empuja)', () => {
  const l = move([it('a', 0, 0, 6, 2), it('b', 0, 2, 6, 2), it('c', 0, 4, 6, 2), it('d', 6, 0, 6, 2)], 'd', 0, 0);
  assert.ok(noOverlap(l));
  assert.deepEqual(['d', 'a', 'b', 'c'].map((id) => at(l, id).y), [0, 2, 4, 6]);
});

test('panel: mover no muta la entrada', () => {
  const l0 = [it('a', 0, 0, 4, 2), it('b', 0, 2, 4, 2)];
  move(l0, 'b', 0, 0);
  assert.deepEqual(l0, [it('a', 0, 0, 4, 2), it('b', 0, 2, 4, 2)]);
});

test('panel: redimensionar empuja', () => {
  const l = resize([it('a', 0, 0, 4, 2), it('b', 4, 0, 4, 2)], 'a', 8, 2);
  assert.ok(noOverlap(l));
  assert.equal(at(l, 'a').w, 8);
  assert.equal(at(l, 'b').y, 2);
});

test('panel: añadir en el primer hueco', () => {
  const l = add([it('a', 0, 0, 6, 2)], { id: 'b', type: 't', w: 6, h: 2 });
  assert.deepEqual([at(l, 'b').x, at(l, 'b').y], [6, 0]);
  const full = add([it('a', 0, 0, 12, 3)], { id: 'b', type: 't', w: 4, h: 2 });
  assert.deepEqual([at(full, 'b').x, at(full, 'b').y], [0, 3]);
});

test('panel: añadir en una celda dada empuja', () => {
  const l = add([it('a', 0, 0, 6, 2)], { id: 'b', type: 't', x: 0, y: 0, w: 6, h: 2 });
  assert.ok(noOverlap(l));
  assert.equal(at(l, 'b').y, 0);
  assert.equal(at(l, 'a').y, 2);
});

test('panel: quitar y fondo', () => {
  assert.equal(bottom(remove([it('a', 0, 0, 2, 3), it('b', 0, 3, 2, 2)], 'b')), 3);
  assert.equal(bottom([]), 0);
});

test('panel: una columna en pantallas estrechas', () => {
  const l = stack([it('b', 6, 0, 6, 2), it('a', 0, 0, 6, 3)]);
  assert.deepEqual(l.map((i) => [i.id, i.x, i.y, i.w]), [['a', 0, 0, 12], ['b', 0, 3, 12]]);
});

test('panel: sanitize descarta basura y renumera ids repetidos', () => {
  const { layout, dropped } = sanitize([
    it('a', 0, 0, 2, 2), { id: 'a', type: 't', x: 0, y: 0, w: 2, h: 2 },
    { type: 'x', x: 0, y: 0, w: 1, h: 1 }, null, { id: 'c', type: 't', x: NaN, y: 0, w: 1, h: 1 },
  ], new Set(['t']));
  assert.equal(dropped, 3);
  assert.equal(layout.length, 2);
  assert.ok(noOverlap(layout));
  assert.notEqual(layout[0].id, layout[1].id);
});

test('panel: sanitize de algo que no es una lista', () => {
  assert.deepEqual(sanitize({ a: 1 }, new Set()), { layout: [], dropped: 0 });
  assert.deepEqual(sanitize(undefined, new Set()), { layout: [], dropped: 0 });
});

test('panel: sanitize conserva los ajustes de cada widget', () => {
  const { layout } = sanitize([{ id: 'a', type: 't', x: 0, y: 0, w: 2, h: 2, settings: { topic: '/x' } }], new Set(['t']));
  assert.deepEqual(layout[0].settings, { topic: '/x' });
});

test('panel: sanitize descarta medidas absurdas (no cuelga)', () => {
  const t0 = performance.now();
  const { layout, dropped } = sanitize([
    { type: 't', x: 0, y: 0, w: 12, h: 1e9 }, { type: 't', x: 0, y: 1e7, w: 2, h: 2 },
    { type: 't', x: 0, y: 1, w: 3, h: 2 },
  ], new Set(['t']));
  assert.equal(dropped, 2);
  assert.equal(layout.length, 1);
  assert.ok(performance.now() - t0 < 200);
});

test('panel: sanitize aplica los mínimos de cada tipo', () => {
  const { layout } = sanitize([{ type: 't', x: 0, y: 0, w: 1, h: 1 }], new Set(['t']), () => ({ minW: 3, minH: 2 }));
  assert.deepEqual([layout[0].w, layout[0].h], [3, 2]);
});

test('panel: leer un fichero de panel', () => {
  const ok = readPanelFile({ format: 'sura_view.panel', version: 1, name: 'A', items: [it('a', 0, 0, 2, 2)] }, new Set(['t']));
  assert.deepEqual([ok.layout.length, ok.warn, ok.name], [1, '', 'A']);
  assert.equal(readPanelFile([it('a', 0, 0, 2, 2)], new Set(['t'])).layout.length, 1);   // lista suelta (antiguo)
  assert.match(readPanelFile({ format: 'sura_view.panel', version: 2, items: [it('a', 0, 0, 2, 2)] }, new Set(['t'])).warn, /versión 2/);
  assert.match(readPanelFile({ format: 'otra.cosa', items: [] }, new Set(['t'])).warn, /no es un panel/);
});

test('panel: nombres de panel que son claves de Object no rompen nada', () => {
  assert.ok(ownKey({ a: 1 }, 'a'));
  assert.ok(!ownKey({ a: 1 }, 'constructor'));
  assert.ok(!ownKey({ a: 1 }, 'toString'));
});
