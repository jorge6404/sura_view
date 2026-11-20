import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinPixel, pixelToSvg, rotateMap, scaleFromTwo, setPoseMsg, svgToPixel } from '../js/sites.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('set_pose: NED -> ENU del EKF (este = x, norte = y, rumbo)', () => {
  const m = setPoseMsg({ north: 3, east: -2, depth: 1.5, yawNed: Math.PI / 2 }, 'bluerov/map', 1500);
  assert.equal(m.header.frame_id, 'bluerov/map');
  assert.deepEqual(m.header.stamp, { sec: 1, nanosec: 500e6 });
  const { position: p, orientation: q } = m.pose.pose;
  assert.deepEqual([p.x, p.y, p.z], [-2, 3, -1.5]);
  near(q.z, 0); near(q.w, 1);           // mirando al este en NED = yaw 0 en ENU
  const n = setPoseMsg({ north: 0, east: 0, depth: 0, yawNed: 0 }, 'm').pose.pose.orientation;
  near(2 * Math.atan2(n.z, n.w), Math.PI / 2);   // norte en NED = +90° en ENU
  assert.equal(m.pose.covariance.length, 36);
});

test('mapa propio: píxel <-> metros, escala con dos puntos, anclar y girar', () => {
  let m = { w: 100, h: 50, mpp: 0.1, rot: 0, tx: 0, ty: 0 };
  assert.deepEqual(pixelToSvg(m, 10, 20), [1, 2]);
  m = scaleFromTwo(m, [0, 0], [5, 0], 10);          // 50 px = 10 m
  near(m.mpp, 0.2);
  m = pinPixel(m, 50, 25, 7, -3);                   // el robot está en el centro de la imagen
  const [x, y] = pixelToSvg(m, 50, 25); near(x, 7); near(y, -3);
  m = rotateMap(m, 90);
  const [u, v] = svgToPixel(m, ...pixelToSvg(m, 12, 34)); near(u, 12); near(v, 34);
  const [cx, cy] = pixelToSvg(m, 50, 25); near(cx, 7); near(cy, -3);   // gira alrededor del centro
});
