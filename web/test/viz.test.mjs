import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TfBuffer } from '../js/viz3d.js';
import { parseUrdf, meshUrl, meshFormat } from '../js/urdf.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('tf: pose de un hijo en el marco de su abuelo', () => {
  const tf = new TfBuffer();
  const yaw90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  tf.set('base', 'world', new THREE.Vector3(1, 0, 0), yaw90);
  tf.set('/cam', 'base', new THREE.Vector3(1, 0, 0), new THREE.Quaternion());
  const p = tf.lookup('world', 'cam');
  near(p.t.x, 1); near(p.t.y, 1); near(p.t.z, 0);
  const back = tf.lookup('cam', 'world');
  near(back.t.x, -1); near(back.t.y, 1);
});

test('tf: árboles separados no se conectan', () => {
  const tf = new TfBuffer();
  tf.set('a', 'world', new THREE.Vector3(), new THREE.Quaternion());
  tf.set('b', 'map', new THREE.Vector3(), new THREE.Quaternion());
  assert.equal(tf.lookup('a', 'b'), null);
});

test('tf: el /tf real manda sobre el del navigator', () => {
  const tf = new TfBuffer();
  tf.set('base', 'world', new THREE.Vector3(5, 0, 0), new THREE.Quaternion());
  tf.set('base', 'world', new THREE.Vector3(9, 0, 0), new THREE.Quaternion(), true);
  near(tf.lookup('world', 'base').t.x, 5);
});

test('urdf: links, joints, materiales y raíz', () => {
  const u = parseUrdf(`<robot name="r"><material name="azul"><color rgba="0 0 1 1"/></material>
    <link name="base"><visual><origin xyz="1 2 3" rpy="0 0 1.5"/><geometry><box size="1 2 3"/></geometry><material name="azul"/></visual></link>
    <link name="brazo"><visual><geometry><mesh filename="package://p/m.dae" scale="2 2 2"/></geometry></visual></link>
    <joint name="j" type="revolute"><parent link="base"/><child link="brazo"/><axis xyz="0 0 1"/></joint></robot>`);
  assert.equal(u.root, 'base');
  assert.deepEqual(u.links.base.visuals[0].origin, { xyz: [1, 2, 3], rpy: [0, 0, 1.5] });
  assert.deepEqual(u.links.base.visuals[0].color, [0, 0, 1, 1]);
  assert.deepEqual(u.links.brazo.visuals[0].geometry, { type: 'mesh', filename: 'package://p/m.dae', scale: [2, 2, 2] });
  assert.deepEqual(u.joints[0].axis, [0, 0, 1]);
});

test('urdf: package:// pasa por el servidor; file:// no se puede abrir', () => {
  assert.equal(meshUrl('package://bluerov_description/urdf/m.dae'), 'pkg/bluerov_description/urdf/m.dae');
  assert.equal(meshUrl('file:///home/x.stl'), null);
});

test('mallas: el formato sale del contenido (una .dae puede llegar como .glb de robots/)', () => {
  const glb = new TextEncoder().encode('glTF\x02\x00\x00\x00').buffer;
  const dae = new TextEncoder().encode('<?xml version="1.0"?><COLLADA').buffer;
  assert.equal(meshFormat(glb, 'pkg/bluerov_description/urdf/meshes/rov.dae'), 'glb');
  assert.equal(meshFormat(dae, 'pkg/bluerov_description/urdf/meshes/rov.dae'), 'dae');
  assert.equal(meshFormat(dae, 'pkg/x/m/PIEZA.STL?v=1'), 'stl');
  assert.equal(meshFormat(new ArrayBuffer(2), 'a/b.obj'), 'obj');
});
