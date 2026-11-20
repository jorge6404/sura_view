import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/mission.js';

test('longitud y tiempo de la ruta', () => {
  const wps = [M.newWaypoint(0, 0, 0), M.newWaypoint(3, 4, 0, { speed: 1 })];
  assert.equal(M.routeLength(wps), 5);
  assert.equal(M.routeTime(wps), 5);
});

test('cortacésped: transectos alternos dentro del rectángulo', () => {
  const pts = M.lawnmower({ x0: 0, y0: 0, width: 10, height: 4, spacing: 2, z: 3 });
  assert.equal(pts.length, 6);
  assert.deepEqual(pts.map((p) => [Math.round(p.x), Math.round(p.y)]), [[0, 0], [0, 10], [2, 10], [2, 0], [4, 0], [4, 10]]);
  assert.ok(pts.every((p) => p.z === 3));
});

test('polígono cerrado y estrella', () => {
  const poly = M.polygon({ cx: 0, cy: 0, radius: 5, sides: 4, z: 1 });
  assert.equal(poly.length, 5);
  assert.ok(Math.abs(poly[0].x - poly[4].x) < 1e-9 && Math.abs(poly[0].y - poly[4].y) < 1e-9);
  assert.equal(M.star({ cx: 0, cy: 0, radius: 5, directions: 3, z: 1 }).length, 7);
});

test('meta de FollowPath: frame, poses y orientación hacia el siguiente', () => {
  const g = M.followPathGoal([M.newWaypoint(0, 0, 2), M.newWaypoint(0, 10, 2)]);
  assert.equal(g.path.header.frame_id, 'world_ned');
  assert.equal(g.path.poses.length, 2);
  const q = g.path.poses[0].pose.orientation;
  assert.ok(Math.abs(2 * Math.atan2(q.z, q.w) - Math.PI / 2) < 1e-9); // mira al este
  assert.equal(g.path.poses[1].pose.position.z, 2);
  assert.equal(g.use_saved_path, false);
});

test('NED <-> lat/lon ida y vuelta', () => {
  const d = { latitude: 39.9944, longitude: -0.0741 };
  const [lat, lon] = M.nedToLatLon(d, 100, -50);
  const [n, e] = M.latLonToNed(d, lat, lon);
  assert.ok(Math.abs(n - 100) < 1e-6 && Math.abs(e + 50) < 1e-6);
  const [tx, ty] = M.tileOf(lat, lon, 18);
  const b = M.tileBounds(tx, ty, 18);
  assert.ok(lat <= b.north && lat >= b.south && lon >= b.west && lon <= b.east);
});

test('fromJSON valida y toJSON es reversible', () => {
  const wps = [M.newWaypoint(1, 2, 3)];
  assert.deepEqual(M.fromJSON(M.toJSON(wps)), wps);
  assert.throws(() => M.fromJSON('{"waypoints":[{"x":"a","y":1}]}'), /no válidas/);
  assert.throws(() => M.fromJSON('{}'), /no tiene waypoints/);
});
