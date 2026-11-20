// Fondo del mapa según el lugar: el tanque del CIRTESU, el puerto (satélite alrededor del datum)
// o un mapa propio (imagen colocada a mano). Todo se dibuja en coordenadas del SVG del mapa:
// x = este, y = -norte, en metros (como missionview y el minimapa de Pilotar).
import * as M from './mission.js';

export const SITES = {
  tank: 'Tanque CIRTESU',
  port: 'Puerto (satélite)',
  custom: 'Mapa propio',
  none: 'Ninguno',
};

// Tanque del CIRTESU, del escenario de Stonefish (bluerov_stonefish/data/cirtesu/tank_phy.obj y
// cirtesu_arucos.scn): piscina de 12 × 8 m (N × E) centrada en el origen NED, 4,8 m de fondo,
// borde de 18 × 13 m y 9 ArUcos de 0,5 m en el fondo.
export const TANK = {
  pool: { n: 6, e: 4 },
  deck: { n: 9, e: 6.5 },
  depth: 4.8,
  arucos: [[4.5, 3, 1], [4.5, 0, 6], [4.5, -3, 5], [1.5, 3, 7], [1.5, 0, 4], [1.5, -3, 0], [-1.5, 3, 8], [-1.5, 0, 3], [-1.5, -3, 2]],
};

export function tankSvg(px) {
  const { pool: p, deck: d } = TANK;
  // sin <defs>: el minimapa de Pilotar y el mapa de Misión comparten documento y uno de los dos está oculto
  let s = `<rect x="${-d.e}" y="${-d.n}" width="${2 * d.e}" height="${2 * d.n}" rx=".3" fill="#5b646c" fill-opacity=".55"/>
    <rect x="${-p.e}" y="${-p.n}" width="${2 * p.e}" height="${2 * p.n}" fill="#2685a0" fill-opacity=".9" stroke="#d6e6ea" stroke-width="${2 * px}"/>`;
  for (let k = -p.e + 1; k < p.e; k += 1) s += `<line x1="${k}" x2="${k}" y1="${-p.n}" y2="${p.n}" stroke="#ffffff" stroke-opacity=".08" stroke-width="${px}"/>`;
  for (const [n, e, id] of TANK.arucos) {
    s += `<rect x="${e - 0.25}" y="${-n - 0.25}" width=".5" height=".5" fill="#f4f6f7" stroke="#14181c" stroke-width="${px}"/>
      <rect x="${e - 0.15}" y="${-n - 0.15}" width=".3" height=".3" fill="#14181c"/>`;
    if (px < 0.05) s += `<text x="${e}" y="${-n + 0.55}" text-anchor="middle" font-size="${11 * px}" fill="#eef0f1" font-family="Barlow Condensed" font-weight="600">ArUco ${id}</text>`;
  }
  s += `<text x="${-p.e + 0.3}" y="${-p.n + 0.3 + 13 * px}" font-size="${13 * px}" fill="#eef0f1" font-family="Barlow Condensed" font-weight="700" opacity=".85">TANQUE CIRTESU · ${TANK.depth.toString().replace('.', ',')} m</text>`;
  return s;
}

// Teselas que cubren la vista (sat: World Imagery de Esri, el mapa de sura_view). bounds en metros del SVG.
const TILE_URL = {
  sat: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
};
export function tilesSvg(datum, { x0, y0, x1, y1 }, mpp, kind = 'sat', opacity = 0.85) {
  if (!datum?.latitude) return '';
  const z = Math.max(1, Math.min(19, Math.round(Math.log2((156543.03 * Math.cos((datum.latitude * Math.PI) / 180)) / mpp))));
  const [la0, lo0] = M.nedToLatLon(datum, -y0, x0), [la1, lo1] = M.nedToLatLon(datum, -y1, x1);
  const [tx0, ty0] = M.tileOf(la0, lo0, z), [tx1, ty1] = M.tileOf(la1, lo1, z);
  let s = '';
  for (let x = tx0; x <= tx1 && x - tx0 < 12; x++) {
    for (let y = ty0; y <= ty1 && y - ty0 < 12; y++) {
      const b = M.tileBounds(x, y, z);
      const [n0, e0] = M.latLonToNed(datum, b.north, b.west), [n1, e1] = M.latLonToNed(datum, b.south, b.east);
      s += `<image href="${TILE_URL[kind](z, x, y)}" x="${e0}" y="${-n0}" width="${e1 - e0}" height="${n0 - n1}" preserveAspectRatio="none" opacity="${opacity}"/>`;
    }
  }
  return s;
}

// ---- mapa propio: imagen con { src, w, h, tx, ty, mpp, rot } ----
// El píxel (u, v) cae en T + R(rot)·(u, v)·mpp (metros del SVG; rot en grados, horario).
const rotv = (rot, x, y) => {
  const a = (rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [c * x - s * y, s * x + c * y];
};
export function pixelToSvg(m, u, v) {
  const [x, y] = rotv(m.rot, u * m.mpp, v * m.mpp);
  return [m.tx + x, m.ty + y];
}
export function svgToPixel(m, x, y) {
  const [a, b] = rotv(-m.rot, x - m.tx, y - m.ty);
  return [a / m.mpp, b / m.mpp];
}
// que el píxel (u, v) caiga en el punto (x, y) del SVG
export function pinPixel(m, u, v, x, y) {
  const [dx, dy] = rotv(m.rot, u * m.mpp, v * m.mpp);
  return { ...m, tx: x - dx, ty: y - dy };
}
// escala a partir de dos puntos (en el SVG) separados `meters` en la realidad; el primero no se mueve
export function scaleFromTwo(m, a, b, meters) {
  const [ua, va] = svgToPixel(m, ...a), [ub, vb] = svgToPixel(m, ...b);
  const dpx = Math.hypot(ub - ua, vb - va);
  if (!(dpx > 0) || !(meters > 0)) throw new Error('Puntos o distancia no válidos');
  return pinPixel({ ...m, mpp: meters / dpx }, ua, va, ...a);
}
// girar alrededor del centro de la imagen
export function rotateMap(m, rot) {
  const [cx, cy] = pixelToSvg(m, m.w / 2, m.h / 2);
  return pinPixel({ ...m, rot }, m.w / 2, m.h / 2, cx, cy);
}
export function customSvg(m) {
  if (!m?.src) return '';
  return `<image href="${m.src}" width="${m.w * m.mpp}" height="${m.h * m.mpp}" transform="translate(${m.tx} ${m.ty}) rotate(${m.rot})" preserveAspectRatio="none" opacity=".9"/>`;
}

// Fondo completo de un lugar. view: { bounds, mpp, px } (px = un píxel de pantalla en metros).
export function siteSvg(site, { datum, custom }, view) {
  if (site === 'tank') return tankSvg(view.px);
  if (site === 'port') return tilesSvg(datum, view.bounds, view.mpp, 'sat', 1);
  if (site === 'custom') return customSvg(custom);
  return '';
}

// Pose estimada para robot_localization (set_pose): NED -> ENU del EKF (sura_localization
// estima en <ns>/map, ENU). x_enu = este, y_enu = norte, z_enu = -profundidad, yaw_enu = π/2 - yaw_ned.
export function setPoseMsg({ north, east, depth, yawNed }, frame, nowMs = Date.now()) {
  const yaw = Math.PI / 2 - yawNed;
  const cov = new Array(36).fill(0);
  cov[0] = cov[7] = 0.25; cov[14] = 0.01; cov[21] = cov[28] = 0.01; cov[35] = 0.05;
  return {
    header: { frame_id: frame, stamp: { sec: Math.floor(nowMs / 1000), nanosec: (nowMs % 1000) * 1e6 } },
    pose: { pose: { position: { x: east, y: north, z: -depth }, orientation: { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) } }, covariance: cov },
  };
}
