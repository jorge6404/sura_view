import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitSize, stripAnsi } from '../js/term.js';

test('terminal: quita los códigos ANSI de los logs', () => {
  assert.equal(stripAnsi('\x1b[1;32mverde\x1b[0m $ '), 'verde $ ');
});

test('terminal: filas y columnas que caben (descontando la barra de scroll)', () => {
  assert.deepEqual(fitSize(814, 400, { width: 8, height: 17 }, 14), { cols: 100, rows: 23 });
});

test('terminal: nunca menos de 20 × 4 aunque el widget sea minúsculo', () => {
  assert.deepEqual(fitSize(50, 10, { width: 8, height: 17 }, 14), { cols: 20, rows: 4 });
});

test('terminal: sin medidas de celda todavía no hay tamaño', () => {
  assert.equal(fitSize(800, 400, { width: 0, height: 0 }), null);
  assert.equal(fitSize(0, 0, { width: 8, height: 17 }), null);
});
