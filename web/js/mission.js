// Misión: lista de waypoints en world_ned (x = norte, y = este, z = profundidad, metros).
// Sin DOM: distancias, plantillas (cortacésped, polígono, estrella) y la meta de FollowPath.

export function newWaypoint(x, y, z = 2, extra = {}) {
  return { x, y, z, speed: 0.5, tolerance: 0.5, action: '', ...extra };
}

export function routeLength(wps) {
  let s = 0;
  for (let i = 1; i < wps.length; i++) s += Math.hypot(wps[i].x - wps[i - 1].x, wps[i].y - wps[i - 1].y, wps[i].z - wps[i - 1].z);
  return s;
}

export function routeTime(wps) {
  let t = 0;
  for (let i = 1; i < wps.length; i++) {
    const d = Math.hypot(wps[i].x - wps[i - 1].x, wps[i].y - wps[i - 1].y, wps[i].z - wps[i - 1].z);
    t += d / Math.max(0.05, wps[i].speed || 0.5);
  }
  return t;
}

// Cortacésped dentro de un rectángulo (esquina, ancho hacia el este, alto hacia el norte,
// rumbo en grados) con transectos separados `spacing` metros a profundidad `z`.
export function lawnmower({ x0, y0, width, height, spacing, z, headingDeg = 0 }) {
  const n = Math.max(1, Math.floor(height / Math.max(0.1, spacing)) + 1);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const north = Math.min(height, i * spacing);
    const row = [[north, 0], [north, width]];
    if (i % 2) row.reverse();
    pts.push(...row);
  }
  return pts.map(([n, e]) => rotate(x0, y0, n, e, headingDeg, z));
}

export function polygon({ cx, cy, radius, sides, z, headingDeg = 0 }) {
  const pts = [];
  for (let i = 0; i <= sides; i++) {
    const a = (2 * Math.PI * (i % sides)) / sides;
    pts.push(rotate(cx, cy, radius * Math.cos(a), radius * Math.sin(a), headingDeg, z));
  }
  return pts;
}

// Estrella: radios que salen y vuelven al centro
export function star({ cx, cy, radius, directions, z, headingDeg = 0 }) {
  const pts = [newWaypoint(cx, cy, z)];
  for (let i = 0; i < directions; i++) {
    const a = (Math.PI * i) / directions;
    pts.push(rotate(cx, cy, radius * Math.cos(a), radius * Math.sin(a), headingDeg, z));
    pts.push(rotate(cx, cy, -radius * Math.cos(a), -radius * Math.sin(a), headingDeg, z));
  }
  return pts;
}

function rotate(x0, y0, n, e, headingDeg, z) {
  const h = (headingDeg * Math.PI) / 180;
  return newWaypoint(x0 + n * Math.cos(h) - e * Math.sin(h), y0 + n * Math.sin(h) + e * Math.cos(h), z);
}

export function quaternionFromYaw(yaw) {
  return { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) };
}

export function poseStamped(x, y, z, yaw, frame = 'world_ned') {
  return {
    header: { frame_id: frame, stamp: { sec: 0, nanosec: 0 } },
    pose: { position: { x, y, z }, orientation: quaternionFromYaw(yaw) },
  };
}

// Meta de sura_actions/action/FollowPath. Cada pose mira hacia el siguiente waypoint.
export function followPathGoal(wps, { frame = 'world_ned', tolerance = 0.5, speed = 0, holonomic = false, timeout = 0 } = {}) {
  const poses = wps.map((w, i) => {
    const n = wps[i + 1];
    const yaw = n ? Math.atan2(n.y - w.y, n.x - w.x) : (i ? Math.atan2(w.y - wps[i - 1].y, w.x - wps[i - 1].x) : 0);
    return poseStamped(w.x, w.y, w.z, yaw, frame);
  });
  return {
    path: { header: { frame_id: frame, stamp: { sec: 0, nanosec: 0 } }, poses },
    use_saved_path: false,
    path_file: '',
    holonomic,
    goal_tolerance: tolerance,
    yaw_tolerance: 0,
    max_forward_speed: speed,
    max_yaw_rate: 0,
    timeout,
  };
}

export function goToPoseGoal(x, y, z, yaw, { frame = 'world_ned', tolerance = 0.5 } = {}) {
  return {
    target_pose: poseStamped(x, y, z, yaw, frame),
    target_yaw: yaw,
    holonomic: true,
    max_forward_speed: 0, max_vertical_speed: 0, max_yaw_rate: 0,
    position_tolerance: tolerance, yaw_tolerance: 0, slowdown_distance: 0, timeout: 0,
  };
}

// world_ned <-> lat/lon con aproximación local (equirectangular), válida a escala de una misión
const R = 6378137;
export function nedToLatLon(datum, north, east) {
  const lat = datum.latitude + (north / R) * (180 / Math.PI);
  const lon = datum.longitude + (east / (R * Math.cos((datum.latitude * Math.PI) / 180))) * (180 / Math.PI);
  return [lat, lon];
}

export function latLonToNed(datum, lat, lon) {
  const north = ((lat - datum.latitude) * Math.PI / 180) * R;
  const east = ((lon - datum.longitude) * Math.PI / 180) * R * Math.cos((datum.latitude * Math.PI) / 180);
  return [north, east];
}

// Mosaico OSM (slippy map) que contiene lat/lon a zoom z
export function tileOf(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return [x, y];
}

export function tileBounds(x, y, z) {
  const n = 2 ** z;
  const lon = (i) => (i / n) * 360 - 180;
  const lat = (j) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  return { north: lat(y), south: lat(y + 1), west: lon(x), east: lon(x + 1) };
}

export function toJSON(wps) { return JSON.stringify({ version: 1, frame: 'world_ned', waypoints: wps }, null, 2); }

export function fromJSON(text) {
  const d = JSON.parse(text);
  const list = Array.isArray(d) ? d : d.waypoints;
  if (!Array.isArray(list)) throw new Error('El fichero no tiene waypoints');
  return list.map((w) => {
    const x = Number(w.x), y = Number(w.y), z = Number(w.z ?? 0);
    if (![x, y, z].every(Number.isFinite)) throw new Error('Waypoint con coordenadas no válidas');
    return newWaypoint(x, y, z, { speed: Number(w.speed) || 0.5, tolerance: Number(w.tolerance) || 0.5, action: w.action || '' });
  });
}
