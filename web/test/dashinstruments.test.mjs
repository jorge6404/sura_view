import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attitudeTransform, spark, sparkPath, tapeTicks } from '../js/dashinstruments.js';

test('instrumentos: marcas de la cinta de profundidad', () => {
  const t = tapeTicks(1.0, 0.5);
  assert.deepEqual(t.map((k) => k.m), [0.6, 0.8, 1, 1.2, 1.4]);
  assert.ok(t.find((k) => k.m === 1).major);
  assert.ok(!t.find((k) => k.m === 0.8).major);
});

test('instrumentos: la cinta no baja de la superficie', () => {
  assert.ok(tapeTicks(0.1, 1).every((k) => k.m >= 0));
  assert.equal(tapeTicks(0.1, 1)[0].m, 0);
});

test('instrumentos: camino de la mini-gráfica', () => {
  assert.equal(sparkPath([[0, 0], [1, 1]], 100, 10), 'M0 10L100 0');
  assert.equal(sparkPath([], 100, 10), '');
  assert.equal(sparkPath([[0, 2], [1, 2]], 100, 10), 'M0 5L100 5');   // plano: a media altura
  assert.equal(sparkPath([[0, 0], [2, 1], [4, 0]], 100, 10, true), 'M0 0L50 10L100 0');   // invertida (profundidad hacia abajo)
});

test('instrumentos: horizonte artificial', () => {
  // primero el giro alrededor del centro del instrumento, luego el desplazamiento del cabeceo
  assert.equal(attitudeTransform(0, 0, 4), 'rotate(0) translate(0 0)');
  assert.equal(attitudeTransform(10, 5, 4), 'rotate(-5) translate(0 40)');
  assert.equal(attitudeTransform(90, 0, 4), 'rotate(0) translate(0 120)');   // limitado a ±30°
});

test('instrumentos: la mini-gráfica dibuja lo que recibe y devuelve el último valor', () => {
  const s = spark(60000);
  s.push(1000, 2); s.push(2000, 4);
  assert.equal(s.draw(), 4);
  assert.equal(s.el.querySelector('.di-stroke').getAttribute('d'), 'M0 28L100 0');
  s.clear();
  assert.equal(s.draw(), null);
});
