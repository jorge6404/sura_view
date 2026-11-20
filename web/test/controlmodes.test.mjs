import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modeFromActive, modesFor, switchPlan, togglePlan } from '../js/controlmodes.js';

test('profundidad desde fuerza: solo activa depth_hold', () => {
  assert.deepEqual(switchPlan('DEPTH', new Set(['body_force']), 'auv'), { activate: ['depth_hold'], deactivate: [] });
});

test('de posición a profundidad: STRICT solo con lo que cambia', () => {
  const active = new Set(['body_force', 'depth_hold', 'body_velocity', 'position_hold']);
  assert.deepEqual(switchPlan('DEPTH', active, 'auv'), { activate: [], deactivate: ['body_velocity', 'position_hold'] });
});

test('superficie: sin depth_hold ni stabilize', () => {
  assert.deepEqual(modesFor('surface'), ['FORCE', 'VELOCITY', 'POSITION']);
  assert.deepEqual(switchPlan('VELOCITY', new Set(['body_force']), 'surface'), { activate: ['body_velocity'], deactivate: [] });
});

test('modo a partir de los controladores activos', () => {
  assert.equal(modeFromActive(new Set()), null);
  assert.equal(modeFromActive(new Set(['body_force'])), 'FORCE');
  assert.equal(modeFromActive(new Set(['body_force', 'depth_hold'])), 'DEPTH');
  assert.equal(modeFromActive(new Set(['body_force', 'depth_hold', 'body_velocity'])), 'VELOCITY');
  assert.equal(modeFromActive(new Set(['body_force', 'depth_hold', 'body_velocity', 'position_hold'])), 'POSITION');
});

test('controlador suelto: encadenados arrastran a los que dependen', () => {
  const list = [
    { name: 'body_force', state: 'active', chain_connections: [] },
    { name: 'body_velocity', state: 'inactive', chain_connections: [{ name: 'body_force', reference_interfaces: [] }] },
    { name: 'position_hold', state: 'inactive', chain_connections: [{ name: 'body_velocity', reference_interfaces: [] }] },
    { name: 'stabilize', state: 'unconfigured', chain_connections: [] },
  ];
  assert.deepEqual(togglePlan('position_hold', true, list), { activate: ['body_velocity', 'position_hold'], deactivate: [] });
  assert.deepEqual(togglePlan('body_force', false, list), { activate: [], deactivate: ['body_force'] });
  list[1].state = list[2].state = 'active';
  assert.deepEqual(togglePlan('body_force', false, list), { activate: [], deactivate: ['body_force', 'body_velocity', 'position_hold'] });
  assert.deepEqual(togglePlan('body_velocity', true, list), { activate: [], deactivate: [] });
});
