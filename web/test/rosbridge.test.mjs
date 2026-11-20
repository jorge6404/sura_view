import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RosbridgeClient } from '../js/rosbridge.js';

class FakeSocket {
  constructor() { this.sent = []; this.readyState = 1; setTimeout(() => this.onopen?.(), 0); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() {}
  reply(o) { this.onmessage({ data: JSON.stringify(o) }); }
}

function client() {
  let sock;
  const c = new RosbridgeClient('ws://x', { socketFactory: () => (sock = new FakeSocket()) });
  c.connect();
  return { c, sock: () => sock };
}

test('reanuncia y resuscribe al conectar, con throttle', async () => {
  const { c, sock } = client();
  c.subscribe('/a', 'std_msgs/msg/String', () => {}, { throttle_rate: 100 });
  c.advertise('/b', 'std_msgs/msg/String');
  await new Promise((r) => setTimeout(r, 5));
  const ops = sock().sent.map((m) => `${m.op}:${m.topic}`);
  assert.ok(ops.includes('subscribe:/a') && ops.includes('advertise:/b'));
  assert.equal(sock().sent.find((m) => m.op === 'subscribe').throttle_rate, 100);
});

test('servicios: resuelve con values y rechaza con result=false', async () => {
  const { c, sock } = client();
  await new Promise((r) => setTimeout(r, 5));
  const ok = c.callService('/s', { a: 1 });
  const id = sock().sent.at(-1).id;
  sock().reply({ op: 'service_response', id, result: true, values: { success: true } });
  assert.deepEqual(await ok, { success: true });
  const bad = c.callService('/s');
  sock().reply({ op: 'service_response', id: sock().sent.at(-1).id, result: false, values: 'nope' });
  await assert.rejects(bad, /nope/);
});

test('acciones: feedback, resultado y cancelación', async () => {
  const { c, sock } = client();
  await new Promise((r) => setTimeout(r, 5));
  const fb = [];
  const g = c.sendActionGoal('/r/actions/go_to_depth', 'sura_actions/action/GoToDepth', { target_depth: 2 }, { onFeedback: (v) => fb.push(v) });
  const sent = sock().sent.at(-1);
  assert.equal(sent.op, 'send_action_goal');
  assert.equal(sent.feedback, true);
  sock().reply({ op: 'action_feedback', id: g.id, values: { current_depth: 1 } });
  sock().reply({ op: 'action_result', id: g.id, status: 4, result: true, values: { success: true } });
  const r = await g.result;
  assert.equal(r.status, 4);
  assert.deepEqual(fb, [{ current_depth: 1 }]);
  g.cancel();
  assert.equal(sock().sent.at(-1).op, 'cancel_action_goal');
});

test('darse de baja quita la suscripción cuando no quedan oyentes', async () => {
  const { c, sock } = client();
  await new Promise((r) => setTimeout(r, 5));
  const off = c.subscribe('/t', 'x', () => {});
  off();
  assert.equal(sock().sent.at(-1).op, 'unsubscribe');
});
