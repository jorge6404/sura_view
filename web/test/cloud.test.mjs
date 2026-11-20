import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePointCloud2 } from '../js/cloud.js';
import { layoutTree } from '../js/btlayout.js';

test('PointCloud2 xyz float32, salta NaN', () => {
  const pts = [[1, 2, 3], [NaN, 0, 0], [4, 5, 6]];
  const buf = new ArrayBuffer(pts.length * 16);
  const dv = new DataView(buf);
  pts.forEach((p, i) => p.forEach((v, k) => dv.setFloat32(i * 16 + k * 4, v, true)));
  const msg = {
    width: 3, height: 1, point_step: 16, row_step: 48, is_bigendian: false,
    fields: ['x', 'y', 'z'].map((name, k) => ({ name, offset: k * 4, datatype: 7, count: 1 })),
    data: typeof Buffer !== 'undefined' ? Buffer.from(buf).toString('base64') : btoa(String.fromCharCode(...new Uint8Array(buf))),
  };
  assert.deepEqual([...decodePointCloud2(msg)], [1, 2, 3, 4, 5, 6]);
});

test('layout del árbol: padre centrado sobre sus hijos', () => {
  const t = { id: '0', children: [{ id: 'a', children: [] }, { id: 'b', children: [] }] };
  const { nodes, edges } = layoutTree(t, { w: 100, h: 40, gx: 20, gy: 50 });
  const by = Object.fromEntries(nodes.map((n) => [n.node.id, n]));
  assert.equal(by['0'].x, (by.a.x + by.b.x) / 2);
  assert.equal(edges.length, 2);
  assert.ok(edges.every(([p]) => p.node.id === '0'));
});
