import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Series, allKeys, fieldsFromTypedefs, flattenMsg, getter, leaves, matches, newLeaf, parseLayout, remove,
  serializeLayout, split, toCsv,
} from '../js/plotdata.js';

const imu = [
  { type: 'sensor_msgs/Imu', fieldnames: ['header', 'orientation', 'orientation_covariance'],
    fieldtypes: ['std_msgs/Header', 'geometry_msgs/Quaternion', 'double'], fieldarraylen: [-1, -1, 9] },
  { type: 'std_msgs/Header', fieldnames: ['stamp', 'frame_id'], fieldtypes: ['builtin_interfaces/Time', 'string'], fieldarraylen: [-1, -1] },
  { type: 'builtin_interfaces/Time', fieldnames: ['sec', 'nanosec'], fieldtypes: ['int32', 'uint32'], fieldarraylen: [-1, -1] },
  { type: 'geometry_msgs/Quaternion', fieldnames: ['x', 'y', 'z', 'w'], fieldtypes: ['double', 'double', 'double', 'double'], fieldarraylen: [-1, -1, -1, -1] },
];

test('campos desde typedefs: anidados, arrays fijos por índice, sin strings', () => {
  const { fields, dynamic } = fieldsFromTypedefs(imu, 'sensor_msgs/msg/Imu');
  assert.deepEqual(fields.slice(0, 6), ['header/stamp/sec', 'header/stamp/nanosec', 'orientation/x', 'orientation/y', 'orientation/z', 'orientation/w']);
  assert.equal(fields.length, 6 + 9);
  assert.equal(fields.at(-1), 'orientation_covariance[8]');
  assert.deepEqual(dynamic, []);
});

test('arrays variables: se apuntan aparte, salvo los de bytes', () => {
  const defs = [{ type: 'x/Scan', fieldnames: ['ranges', 'data', 'n'], fieldtypes: ['float32', 'uint8', 'int32'], fieldarraylen: [0, 0, -1] }];
  assert.deepEqual(fieldsFromTypedefs(defs, 'x/Scan'), { fields: ['n'], dynamic: ['ranges'] });
});

test('flattenMsg y getter leen lo mismo', () => {
  const msg = { a: { b: [1, 2], ok: true }, s: 'texto', c: [{ d: 5 }] };
  const paths = flattenMsg(msg);
  assert.deepEqual(paths, ['a/b[0]', 'a/b[1]', 'a/ok', 'c[0]/d']);
  assert.deepEqual(paths.map((p) => getter(p)(msg)), [1, 2, 1, 5]);
  assert.equal(getter('a/nada/x')(msg), null);
  assert.equal(getter('s')(msg), null);
});

test('buscador por trozos en orden', () => {
  const k = '/bluerov/navigator/navigation|position/position/z';
  assert.ok(matches(k, 'nav pos z'));
  assert.ok(matches(k, 'NAVIGATION Z'));
  assert.ok(!matches(k, 'z nav'));
  assert.ok(matches(k, ''));
});

test('Series recorta por edad y encuentra valores', () => {
  const s = new Series(10);
  for (let t = 0; t <= 30; t += 1) s.push(t, t * 2);
  assert.equal(s.t[s.start], 20);
  assert.equal(s.length, 11);
  assert.equal(s.valueAt(25.5), 50);
  assert.equal(s.valueAt(5), null);
  assert.equal(s.indexAt(22) - s.start, 2);
  assert.equal(s.last(), 60);
});

test('partir y quitar paneles', () => {
  const a = newLeaf(), b = newLeaf(), c = newLeaf();
  let root = split(a, a.id, 'right', b);
  assert.equal(root.dir, 'row');
  assert.deepEqual(leaves(root).map((l) => l.id), [a.id, b.id]);
  root = split(root, b.id, 'top', c);
  assert.deepEqual(leaves(root).map((l) => l.id), [a.id, c.id, b.id]);
  root = remove(root, a.id);
  assert.equal(root.dir, 'col');
  root = remove(root, c.id);
  assert.equal(root.id, b.id);
  const last = remove(root, b.id);
  assert.ok(!last.dir && last.id !== b.id && last.curves.length === 0);
});

test('disposición: guardar, abrir y claves en uso', () => {
  const l = newLeaf();
  l.curves.push({ key: '/a|x', type: 'std_msgs/msg/Float64', hidden: false });
  l.xy = { x: '/b|y', xType: 't/B' };
  const st = parseLayout(serializeLayout({ window: 20, tabs: [{ name: 'Uno', root: l }] }));
  assert.equal(st.window, 20);
  assert.deepEqual([...allKeys(st.tabs).keys()].sort(), ['/a|x', '/b|y']);
  assert.throws(() => parseLayout('{"tabs":[]}'), /disposición/);
});

test('CSV ancho con huecos', () => {
  const a = new Series(), b = new Series();
  a.push(1, 10); a.push(2, 20); b.push(2, 7);
  assert.equal(toCsv([{ name: 'a', series: a }, { name: 'b,c', series: b }]), 't,a,"b,c"\n1.0000,10,\n2.0000,20,7\n');
});
