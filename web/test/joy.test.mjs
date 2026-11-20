import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gamepadToJoy, joyMessage } from '../js/joy.js';

const btn = (pressed = false, value = pressed ? 1 : 0) => ({ pressed, value });
const pad = (axes = [0, 0, 0, 0], pressed = []) => ({ axes, buttons: Array.from({ length: 17 }, (_, i) => btn(pressed.includes(i))) });

test('reposo: palancas a 0 y gatillos sueltos a +1 (como joy_node)', () => {
  const j = gamepadToJoy(pad());
  assert.deepEqual(j.axes, [0, 0, 1, 0, 0, 1, 0, 0]);
  assert.equal(j.buttons.length, 11);
  assert.ok(j.buttons.every((b) => b === 0));
});

test('signos: izquierda y arriba son positivos; zona muerta', () => {
  const j = gamepadToJoy(pad([-1, -0.5, 0.02, 1]));
  assert.equal(j.axes[0], 1);
  assert.equal(j.axes[1], 0.5);
  assert.equal(j.axes[3], 0);       // dentro de la zona muerta
  assert.equal(j.axes[4], -1);
});

test('gatillo izquierdo pulsado = -1 (hombre muerto de sura_teleop) y botones', () => {
  const g = pad();
  g.buttons[6] = btn(true, 1);
  g.buttons[0] = btn(true);
  g.buttons[9] = btn(true);   // Start
  g.buttons[12] = btn(true);  // cruceta arriba
  const j = gamepadToJoy(g);
  assert.equal(j.axes[2], -1);
  assert.equal(j.axes[7], 1);
  assert.equal(j.buttons[0], 1);
  assert.equal(j.buttons[7], 1);
});

test('mensaje Joy con sello de tiempo', () => {
  const m = joyMessage({ axes: [0], buttons: [1] }, 1500);
  assert.deepEqual(m.header.stamp, { sec: 1, nanosec: 500000000 });
});
