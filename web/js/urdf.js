// URDF -> three.js, como el RobotModel de rviz. Todo en coordenadas ROS (x adelante, z arriba);
// quien lo dibuje pone el cambio de ejes una sola vez en la raíz de la escena.
import * as THREE from 'three';
import { ColladaLoader } from '../vendor/addons/loaders/ColladaLoader.js';
import { OBJLoader } from '../vendor/addons/loaders/OBJLoader.js';
import { STLLoader } from '../vendor/addons/loaders/STLLoader.js';
import { GLTFLoader } from '../vendor/addons/loaders/GLTFLoader.js';

const nums = (s, n, d = 0) => {
  const v = (s || '').trim().split(/\s+/).filter(Boolean).map(Number);
  return Array.from({ length: n }, (_, i) => (Number.isFinite(v[i]) ? v[i] : d));
};
const origin = (el) => {
  const o = el?.querySelector(':scope > origin');
  return { xyz: nums(o?.getAttribute('xyz'), 3), rpy: nums(o?.getAttribute('rpy'), 3) };
};

// texto URDF -> { name, links: {nombre: {visuals}}, joints: [], root }
export function parseUrdf(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const robot = doc.querySelector('robot');
  if (!robot || doc.querySelector('parsererror')) throw new Error('No es un URDF válido');
  const materials = {};
  for (const m of robot.querySelectorAll(':scope > material')) {
    const c = m.querySelector('color');
    if (c) materials[m.getAttribute('name')] = nums(c.getAttribute('rgba'), 4, 1);
  }
  const links = {};
  for (const l of robot.querySelectorAll(':scope > link')) {
    const visuals = [];
    for (const v of l.querySelectorAll(':scope > visual')) {
      const g = v.querySelector('geometry > *');
      if (!g) continue;
      let geometry;
      const t = g.tagName;
      if (t === 'mesh') geometry = { type: 'mesh', filename: g.getAttribute('filename') || '', scale: nums(g.getAttribute('scale') || '1 1 1', 3, 1) };
      else if (t === 'box') geometry = { type: 'box', size: nums(g.getAttribute('size'), 3) };
      else if (t === 'cylinder') geometry = { type: 'cylinder', radius: +g.getAttribute('radius') || 0, length: +g.getAttribute('length') || 0 };
      else if (t === 'sphere') geometry = { type: 'sphere', radius: +g.getAttribute('radius') || 0 };
      else continue;
      const mat = v.querySelector('material');
      const rgba = mat?.querySelector('color')?.getAttribute('rgba');
      const color = rgba ? nums(rgba, 4, 1) : materials[mat?.getAttribute('name')] || null;
      visuals.push({ origin: origin(v), geometry, color });
    }
    links[l.getAttribute('name')] = { visuals };
  }
  const joints = [...robot.querySelectorAll(':scope > joint')].map((j) => ({
    name: j.getAttribute('name'),
    type: j.getAttribute('type') || 'fixed',
    parent: j.querySelector('parent')?.getAttribute('link'),
    child: j.querySelector('child')?.getAttribute('link'),
    origin: origin(j),
    axis: nums(j.querySelector('axis')?.getAttribute('xyz') || '1 0 0', 3),
  }));
  const children = new Set(joints.map((j) => j.child));
  const root = Object.keys(links).find((n) => !children.has(n)) || Object.keys(links)[0];
  return { name: robot.getAttribute('name') || '', links, joints, root };
}

// package://pkg/ruta -> la ruta que sirve sura_view_web
export function meshUrl(filename) {
  const m = /^package:\/\/([^/]+)\/(.+)$/.exec(filename);
  if (m) return `pkg/${m[1]}/${m[2]}`;
  return /^(https?:)?\/\//.test(filename) || !filename.includes('://') ? filename : null;
}

const meshCache = new Map();   // url -> Promise<Object3D> (la malla del BlueROV pesa 50 MB: una vez)
// Las copias de la caché comparten geometría y materiales: quien las quite no los libera
// (userData.cached), o la siguiente copia los vuelve a subir a la GPU y recompila los shaders.
function cached(o) {
  o.traverse((x) => {
    if (x.geometry) x.geometry.userData.cached = true;
    for (const m of [].concat(x.material || [])) m.userData.cached = true;
  });
  return o;
}
// Como rviz: sin las cámaras y luces que exporta Blender (una luz más hace recompilar todos los
// shaders de la escena) y en gris, no en blanco, lo que no trae material
const GREY = () => new THREE.MeshStandardMaterial({ color: 0xb0b8c0, roughness: 0.8 });
function cleanCollada(scene) {
  const extras = [];
  scene.traverse((x) => {
    if (x.isLight || x.isCamera) extras.push(x);
    else if (x.isMesh) {
      const fix = (m) => (m.isMeshPhongMaterial && !m.name && !m.map ? GREY() : m);
      x.material = Array.isArray(x.material) ? x.material.map(fix) : fix(x.material);
    }
  });
  for (const x of extras) x.removeFromParent();
  return scene;
}
// formato de una malla: por su contenido si es un .glb (sura_view_web sirve el .glb de robots/
// cuando el *_description no está instalado, con la ruta original .dae) y si no, por la extensión
export function meshFormat(buffer, url) {
  const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  if (String.fromCharCode(...head) === 'glTF') return 'glb';
  return url.split('?')[0].split('.').pop().toLowerCase();
}

async function parseMesh(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${url}`);
  const buf = await r.arrayBuffer();
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const ext = meshFormat(buf, url);
  if (ext === 'dae') {
    // ColladaLoader gira Z_UP a Y arriba; rviz respeta el up_axis, así que se deshace
    const c = new ColladaLoader().parse(new TextDecoder().decode(buf), base);
    const g = new THREE.Group();
    g.rotation.x = Math.PI / 2;
    g.add(cleanCollada(c.scene));
    return g;
  }
  if (ext === 'stl') return new THREE.Mesh(new STLLoader().parse(buf), GREY());
  if (ext === 'obj') return new OBJLoader().parse(new TextDecoder().decode(buf));
  if (ext === 'glb' || ext === 'gltf') return new Promise((resolve, reject) => new GLTFLoader().parse(buf, base, (g) => resolve(g.scene), reject));
  throw new Error(`Malla no soportada: ${ext}`);
}

export function loadMesh(url) {
  if (!meshCache.has(url)) meshCache.set(url, parseMesh(url).then(cached));
  return meshCache.get(url).then((o) => o.clone(true));
}

const setOrigin = (obj, o) => {
  obj.position.set(...o.xyz);
  obj.quaternion.setFromEuler(new THREE.Euler(o.rpy[0], o.rpy[1], o.rpy[2], 'ZYX'));
};

// Un objeto por link (robot.links[nombre]) colgado de su padre por el origen de su joint.
// setJoint mueve los revolute/continuous/prismatic como /joint_states.
export class UrdfRobot extends THREE.Group {
  constructor(urdf, { onError } = {}) {
    super();
    this.urdf = urdf;
    this.links = {};
    this.joints = {};
    this.pending = 0;
    for (const [name, l] of Object.entries(urdf.links)) {
      const g = new THREE.Group();
      g.name = name;
      this.links[name] = g;
      for (const v of l.visuals) this.addVisual(g, v, onError);
    }
    for (const j of urdf.joints) {
      const parent = this.links[j.parent], child = this.links[j.child];
      if (!parent || !child) continue;
      const frame = new THREE.Group();      // origen del joint
      setOrigin(frame, j.origin);
      const motion = new THREE.Group();     // movimiento del joint
      frame.add(motion);
      motion.add(child);
      parent.add(frame);
      this.joints[j.name] = { ...j, motion, axis: new THREE.Vector3(...j.axis).normalize() };
    }
    if (this.links[urdf.root]) this.add(this.links[urdf.root]);
  }

  addVisual(link, v, onError) {
    const holder = new THREE.Group();
    setOrigin(holder, v.origin);
    link.add(holder);
    const color = v.color ? new THREE.Color(v.color[0], v.color[1], v.color[2]) : null;
    const mat = () => new THREE.MeshStandardMaterial({ color: color || 0xb0b8c0, transparent: (v.color?.[3] ?? 1) < 1, opacity: v.color?.[3] ?? 1 });
    const g = v.geometry;
    if (g.type === 'box') holder.add(new THREE.Mesh(new THREE.BoxGeometry(...g.size), mat()));
    else if (g.type === 'sphere') holder.add(new THREE.Mesh(new THREE.SphereGeometry(g.radius, 24, 16), mat()));
    else if (g.type === 'cylinder') {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(g.radius, g.radius, g.length, 24), mat());
      m.rotation.x = Math.PI / 2;            // URDF: eje z; three: eje y
      holder.add(m);
    } else if (g.type === 'mesh') {
      const url = meshUrl(g.filename);
      if (!url) { onError?.(`No se puede abrir ${g.filename}`); return; }
      this.pending++;
      loadMesh(url).then((o) => {
        o.scale.multiply(new THREE.Vector3(...g.scale));
        if (color) o.traverse((x) => { if (x.isMesh) x.material = mat(); });
        holder.add(o);
        this.setAlpha(this.alpha ?? 1);
      }).catch((e) => onError?.(`${g.filename}: ${e?.message || 'no carga'}`))
        .finally(() => { this.pending--; this.dispatchEvent({ type: 'loaded' }); });
    }
  }

  setJoint(name, value) {
    const j = this.joints[name];
    if (!j) return;
    if (j.type === 'revolute' || j.type === 'continuous') j.motion.quaternion.setFromAxisAngle(j.axis, value);
    else if (j.type === 'prismatic') j.motion.position.copy(j.axis).multiplyScalar(value);
  }

  setAlpha(a) {
    this.alpha = a;
    this.traverse((x) => {
      if (!x.isMesh) return;
      for (const m of [].concat(x.material)) {
        if (m.userData.alpha0 === undefined) m.userData.alpha0 = m.opacity;
        m.transparent = a < 1 || m.userData.alpha0 < 1;
        m.opacity = m.userData.alpha0 * a;
      }
    });
  }
}

// URDF del *_description de un perfil, generado por el servidor web con xacro
export async function fetchUrdf(profile, environment) {
  const q = new URLSearchParams({ package: profile.package, xacro: profile.xacro, robot_name: profile.name, environment: environment || profile.environment || 'sim' });
  const r = await fetch(`urdf?${q}`);
  if (!r.ok) throw new Error(`No se pudo generar el URDF (${r.status} ${r.statusText})`);
  return parseUrdf(await r.text());
}
