import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Series, batteryPercent, fmt, fresh, headingLabel, normalizeAddress, normalizeName, parseNum, yawFromQuaternion } from '../js/util.js';

test('parseNum acepta coma, punto y unidades (Postel)', () => {
  assert.equal(parseNum('4,2'), 4.2);
  assert.equal(parseNum(' 4.2 m'), 4.2);
  assert.equal(parseNum('-3'), -3);
  assert.equal(parseNum('abc'), null);
  assert.equal(parseNum(''), null);
});

test('fmt usa coma decimal y no muestra -0', () => {
  assert.equal(fmt(4.256, 2), '4,26');
  assert.equal(fmt(-0.01, 1), '0,0');
  assert.equal(fmt(null), '—');
});

test('normalizeName y normalizeAddress', () => {
  assert.equal(normalizeName('Blue ROV 2'), 'blue_rov_2');
  assert.equal(normalizeName('2025'), '');
  assert.equal(normalizeAddress('ws://bluerov.local:9090/'), 'bluerov.local:9090');
  assert.equal(normalizeAddress('192.168.2.2'), '192.168.2.2');
  assert.equal(normalizeAddress('a b'), '');
});

test('batteryPercent: 0..1 a porcentaje, NaN es desconocido', () => {
  assert.equal(batteryPercent({ percentage: 0.78 }), 78);
  assert.equal(batteryPercent({ percentage: NaN }), null);
  assert.equal(batteryPercent({ percentage: 55 }), 55);
});

test('yaw desde cuaternión y rumbo', () => {
  const s = Math.SQRT1_2;
  assert.ok(Math.abs(yawFromQuaternion({ z: s, w: s }) - Math.PI / 2) < 1e-9);
  assert.equal(headingLabel(47), 'NE');
  assert.equal(headingLabel(359), 'N');
});

test('fresh y Series', () => {
  assert.equal(fresh(1000, 2500), true);
  assert.equal(fresh(1000, 3500), false);
  assert.equal(fresh(null, 0), false);
  const s = new Series(1000);
  s.push(0, 1); s.push(500, 3); s.push(1600, 2);
  assert.deepEqual(s.data.map((d) => d[0]), [1600]);
});
