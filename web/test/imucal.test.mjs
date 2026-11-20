import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DUR, captureElapsed, instruction, magMove, overallProgress } from '../js/imucal.js';

test('progreso total: capturas hechas más la actual', () => {
  assert.equal(overallProgress({ phase: 'gyro', awaiting: true, results: {} }, 0), 0);
  const gyroHalf = { phase: 'gyro', capturing_since: 100, duration: DUR.gyro, results: {} };
  assert.ok(Math.abs(overallProgress(gyroHalf, 104) - 4 / 59) < 1e-9);
  const twoDirs = { phase: 'compass', results: { gyro: {}, magnetometer: {} }, directions: [{}, {}], awaiting: true };
  assert.ok(Math.abs(overallProgress(twoDirs, 0) - (8 + 35 + 8) / 59) < 1e-9);
  assert.equal(overallProgress({ phase: 'done' }, 0), 1);
  assert.equal(captureElapsed({ capturing_since: 10, duration: 8 }, 30), 8);
});

test('magnetómetro: tres vueltas seguidas', () => {
  assert.equal(magMove(0).axis, 'yaw');
  assert.equal(magMove(0.5).axis, 'roll');
  assert.equal(magMove(0.99).axis, 'pitch');
  const st = { phase: 'mag', capturing_since: 0, duration: DUR.mag };
  assert.match(instruction(st, 20).title, /de lado/);
  assert.match(instruction(st, 20).text, /Quedan 15 s/);
});

test('brújula: primero apuntar, luego girar 90° a la derecha', () => {
  const n = instruction({ phase: 'compass', step: 'North', target_deg: 0, awaiting: true }, 0);
  assert.match(n.title, /Norte \(0°\)/);
  assert.equal(n.action, 'Empezar');
  const e = instruction({ phase: 'compass', step: 'East', target_deg: 90, awaiting: true }, 0);
  assert.match(e.title, /90° a la derecha, hacia el Este/);
  assert.equal(instruction({ phase: 'gyro', awaiting: true }, 0).title, 'Deja el robot quieto');
  assert.equal(instruction({ phase: 'error', error: 'No IMU' }, 0).text, 'No IMU');
});
