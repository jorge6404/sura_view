// Displays de la vista 3D, como los de rviz. Cada uno dibuja en coordenadas ROS dentro de
// `holder(frame)`, un grupo que la vista coloca en el fixed frame con /tf en cada fotograma.
import * as THREE from 'three';
import { decodePointCloud2, base64ToBytes } from './cloud.js';
import { UrdfRobot, parseUrdf, fetchUrdf, loadMesh, meshUrl } from './urdf.js';
import { drawRaw } from './pilot.js';

const FIXED = '<Fixed Frame>';
const col = (c) => new THREE.Color(c.r ?? 1, c.g ?? 1, c.b ?? 1);
const v3 = (p) => new THREE.Vector3(p.x, p.y, p.z);
const quat = (q) => new THREE.Quaternion(q.x, q.y, q.z, q.w);
const lineMat = (color, opacity = 1) => new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
const std = (color, opacity = 1) => new THREE.MeshStandardMaterial({ color, transparent: opacity < 1, opacity, roughness: 0.6 });

// Flecha sólida a lo largo de +X (como las de rviz)
export function arrow(len, color, { shaft = len * 0.05, head = len * 0.1, headLen = len * 0.23, opacity = 1 } = {}) {
  const g = new THREE.Group(), m = std(color, opacity);
  const s = new THREE.Mesh(new THREE.CylinderGeometry(shaft, shaft, Math.max(len - headLen, 1e-4), 12), m);
  s.rotation.z = -Math.PI / 2; s.position.x = (len - headLen) / 2;
  const h = new THREE.Mesh(new THREE.ConeGeometry(head, headLen, 16), m);
  h.rotation.z = -Math.PI / 2; h.position.x = len - headLen / 2;
  g.add(s, h);
  return g;
}
export function axes(len, radius = len * 0.05) {
  const g = new THREE.Group();
  [[0xe5484d, 'x'], [0x4fb37a, 'y'], [0x3b82f6, 'z']].forEach(([c, a]) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 10), std(c));
    if (a === 'x') { m.rotation.z = -Math.PI / 2; m.position.x = len / 2; }
    if (a === 'y') m.position.y = len / 2;
    if (a === 'z') { m.rotation.x = Math.PI / 2; m.position.z = len / 2; }
    g.add(m);
  });
  return g;
}
export function label(text, { color = '#eef0f1', height = 0.18 } = {}) {
  const c = document.createElement('canvas'), ctx = c.getContext('2d');
  const font = '600 44px Barlow, system-ui, sans-serif';
  ctx.font = font;
  c.width = Math.ceil(ctx.measureText(text).width) + 16; c.height = 60;
  ctx.font = font; ctx.fillStyle = color; ctx.textBaseline = 'middle';
  ctx.shadowColor = '#000'; ctx.shadowBlur = 6;
  ctx.fillText(text, 8, 31);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(height * c.width / c.height, height, 1);
  s.renderOrder = 10;
  return s;
}
function disposeTree(o) {
  o.traverse((x) => {
    if (!x.geometry?.userData.cached) x.geometry?.dispose();    // las mallas de loadMesh son de la caché
    for (const m of [].concat(x.material || [])) if (!m.userData.cached) { m.map?.dispose(); m.dispose(); }
  });
}

export class Display {
  static props = [];
  static msgTypes = [];
  constructor(viz, cfg = {}) {
    this.viz = viz;
    this.name = cfg.name || this.constructor.label;
    this.enabled = cfg.enabled ?? true;
    this.p = Object.fromEntries(this.constructor.props.map((d) => [d.k, d.def]));
    Object.assign(this.p, cfg.p || {});
    if (this.constructor.msgTypes.length && cfg.topic) this.p.topic = cfg.topic;
    this.root = new THREE.Group();
    viz.world.add(this.root);
    this.holders = new Map();
    this.unsubs = [];
    this.status = { lvl: 'warn', text: '' };
    this.expanded = !!cfg.expanded;
  }
  get type() { return this.constructor.type; }
  frame() { return this.p.frame && this.p.frame !== FIXED ? this.p.frame : this.viz.fixedFrame; }
  setStatus(lvl, text) {
    if (this.status.lvl === lvl && this.status.text === text) return;
    this.status = { lvl, text };
    this.viz.statusChanged(this);
  }
  // grupo colocado en `frame` respecto al fixed frame
  holder(frame) {
    frame = (frame || '').replace(/^\//, '') || this.viz.fixedFrame;
    let h = this.holders.get(frame);
    if (!h) { h = new THREE.Group(); h.userData.frame = frame; this.holders.set(frame, h); this.root.add(h); }
    return h;
  }
  sub(topic, type, fn, opts = {}) {
    if (!topic) { this.setStatus('warn', 'Elige un topic'); return; }
    this.setStatus('warn', 'Sin mensajes todavía');
    this.unsubs.push(this.viz.ros.subscribe(topic, type, (m) => { try { fn(m); } catch (e) { this.setStatus('err', e.message); } }, opts));
  }
  start() {}
  stop() { for (const u of this.unsubs.splice(0)) u(); }
  clear() { for (const h of this.holders.values()) { disposeTree(h); h.clear(); } }
  restart() { this.stop(); this.clear(); for (const h of this.holders.values()) this.root.remove(h); this.holders.clear(); if (this.enabled) this.start(); }
  setEnabled(on) { this.enabled = on; this.root.visible = on; this.restart(); }
  changed() { this.restart(); }
  update() {}
  destroy() { this.stop(); this.clear(); this.viz.world.remove(this.root); }
  toJSON() { return { type: this.type, name: this.name, enabled: this.enabled, p: this.p }; }
  // marca sin transformación (lo llama la vista)
  tfMissing(frame) { this.setStatus('err', `No hay transformación de ${frame} a ${this.viz.fixedFrame}`); }
}

// ------------------------------------------------------------------ básicos
class Grid extends Display {
  static type = 'Grid'; static label = 'Cuadrícula'; static icon = 'grid-3x3';
  static desc = 'Rejilla en el plano XY de un marco.';
  static props = [
    { k: 'frame', label: 'Marco', t: 'frame', def: FIXED },
    { k: 'cells', label: 'Celdas', t: 'num', def: 40, min: 1, max: 500, step: 1 },
    { k: 'size', label: 'Tamaño de celda (m)', t: 'num', def: 1, min: 0.01, step: 0.1 },
    { k: 'color', label: 'Color', t: 'color', def: '#3a434c' },
    { k: 'alpha', label: 'Opacidad', t: 'num', def: 0.8, min: 0, max: 1, step: 0.1 },
    { k: 'z', label: 'Desplazamiento Z (m)', t: 'num', def: 0, step: 0.1 },
  ];
  start() {
    const { cells, size, color, alpha, z } = this.p, half = cells * size / 2, pts = [];
    for (let i = 0; i <= cells; i++) {
      const a = -half + i * size;
      pts.push(-half, a, z, half, a, z, a, -half, z, a, half, z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.holder(this.frame()).add(new THREE.LineSegments(g, lineMat(color, alpha)));
    this.setStatus('ok', `${cells}×${cells} de ${size} m`);
  }
}

class Axes extends Display {
  static type = 'Axes'; static label = 'Ejes'; static icon = 'move-3d';
  static desc = 'Los ejes X (rojo), Y (verde) y Z (azul) de un marco.';
  static props = [
    { k: 'frame', label: 'Marco', t: 'frame', def: FIXED },
    { k: 'length', label: 'Longitud (m)', t: 'num', def: 1, min: 0.01, step: 0.1 },
    { k: 'radius', label: 'Radio (m)', t: 'num', def: 0.03, min: 0.001, step: 0.01 },
  ];
  start() { this.holder(this.frame()).add(axes(this.p.length, this.p.radius)); this.setStatus('ok', this.frame()); }
}

class TF extends Display {
  static type = 'TF'; static label = 'TF'; static icon = 'git-fork';
  static desc = 'Todos los marcos de /tf con sus nombres y la flecha hacia su padre.';
  static props = [
    { k: 'names', label: 'Mostrar nombres', t: 'bool', def: false },
    { k: 'axes', label: 'Mostrar ejes', t: 'bool', def: true },
    { k: 'arrows', label: 'Flechas al padre', t: 'bool', def: true },
    { k: 'scale', label: 'Escala', t: 'num', def: 0.3, min: 0.01, step: 0.05 },
    { k: 'filter', label: 'Filtro (texto)', t: 'text', def: '' },
  ];
  start() {
    this.objs = new Map();
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat(0xe8b931, 0.8));
    this.root.add(this.lines);
    this.setStatus('ok', '');
  }
  clear() { super.clear(); if (this.lines) { this.root.remove(this.lines); this.lines.geometry.dispose(); } this.objs?.clear(); }
  update(tick) {
    if (tick % 5 || !this.objs) return;
    const tf = this.viz.tf, fixed = this.viz.fixedFrame, pts = [];
    let shown = 0, lost = 0;
    const f = this.p.filter.toLowerCase();
    for (const frame of tf.frames()) {
      if (f && !frame.toLowerCase().includes(f)) continue;
      const pose = tf.lookup(fixed, frame);
      if (!pose) { lost++; continue; }
      shown++;
      let o = this.objs.get(frame);
      if (!o) {
        o = new THREE.Group();
        if (this.p.axes) o.add(axes(this.p.scale, this.p.scale * 0.04));
        if (this.p.names) { const l = label(frame.split('/').pop(), { height: this.p.scale * 0.35 }); l.position.z = this.p.scale * 0.3; o.add(l); }
        this.objs.set(frame, o); this.root.add(o);
      }
      o.position.copy(pose.t); o.quaternion.copy(pose.q);
      const parent = tf.parentOf(frame), pp = parent && tf.lookup(fixed, parent);
      if (this.p.arrows && pp) pts.push(pose.t.x, pose.t.y, pose.t.z, pp.t.x, pp.t.y, pp.t.z);
    }
    for (const [frame, o] of this.objs) if (!tf.has(frame)) { disposeTree(o); this.root.remove(o); this.objs.delete(frame); }
    this.lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.setStatus(shown ? 'ok' : 'warn', `${shown} marcos${lost ? ` · ${lost} sin conexión con ${fixed}` : ''}`);
  }
}

class RobotModel extends Display {
  static type = 'RobotModel'; static label = 'Modelo del robot'; static icon = 'bot';
  static desc = 'El URDF del robot (mallas incluidas), colocado con /tf y /joint_states.';
  static props = [
    { k: 'source', label: 'Origen', t: 'sel', def: 'Paquete', opts: ['Paquete', 'Topic'] },
    { k: 'topic', label: 'Topic (std_msgs/String)', t: 'topic', types: ['std_msgs/msg/String'], def: '' },
    { k: 'alpha', label: 'Opacidad', t: 'num', def: 1, min: 0, max: 1, step: 0.1 },
    { k: 'joints', label: 'Topic de /joint_states', t: 'topic', types: ['sensor_msgs/msg/JointState'], def: '' },
  ];
  async start() {
    const gen = this.gen = (this.gen || 0) + 1;
    this.robot = null;
    const p = this.viz.sura.profile;
    try {
      if (this.p.source === 'Topic') {
        // robot_description es TRANSIENT_LOCAL y rosbridge no la recibe: se pide al servidor
        const topic = this.p.topic || (p ? `/${p.name}/robot_description` : '');
        if (!topic) { this.setStatus('warn', 'Elige un topic'); return; }
        this.setStatus('warn', `Esperando ${topic}…`);
        for (let i = 0; i < 10 && gen === this.gen && this.enabled; i++) {
          const text = await this.viz.sura.rpc('latched.string', { topic }, 3000);
          if (text) { this.build(parseUrdf(text)); break; }
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (!this.robot && gen === this.gen) this.setStatus('err', `Nadie publica ${topic}`);
      } else {
        if (!p) { this.setStatus('warn', 'Elige un robot en la pantalla de inicio'); return; }
        this.setStatus('warn', 'Generando el URDF con xacro…');
        const urdf = await fetchUrdf(p, this.viz.sura.server?.environment);
        if (gen === this.gen && this.enabled) this.build(urdf);
      }
      if (this.p.joints) this.sub(this.p.joints, 'sensor_msgs/msg/JointState', (m) => m.name.forEach((n, i) => this.robot?.setJoint(n, m.position[i])));
    } catch (e) { this.setStatus('err', e.message); }
  }
  build(urdf) {
    this.clear();
    this.errors = [];
    this.robot = new UrdfRobot(urdf, { onError: (e) => this.errors.push(e) });
    this.robot.setAlpha(this.p.alpha);
    this.holder(urdf.root).add(this.robot);
    const report = () => {
      const n = Object.keys(urdf.links).length;
      if (this.errors.length) this.setStatus('err', this.errors[0]);
      else this.setStatus(this.robot.pending ? 'warn' : 'ok', this.robot.pending ? `Cargando mallas (${this.robot.pending})…` : `${urdf.name}: ${n} links`);
    };
    this.robot.addEventListener('loaded', report);
    report();
  }
  changed(k) { if (k === 'alpha' && this.robot) this.robot.setAlpha(this.p.alpha); else this.restart(); }
}

// ------------------------------------------------------------------ SURA
class Trail extends Display {
  static type = 'Trail'; static label = 'Rastro del navigator'; static icon = 'route';
  static desc = 'El camino recorrido según navigator/navigation.';
  static props = [
    { k: 'color', label: 'Color', t: 'color', def: '#4fb37a' },
    { k: 'keep', label: 'Puntos', t: 'num', def: 3000, min: 10, step: 100 },
  ];
  start() {
    this.pts = [];
    this.line = new THREE.Line(new THREE.BufferGeometry(), lineMat(this.p.color));
    this.holder('world_ned').add(this.line);
    this.on = (e) => {
      const p = v3(e.detail.position.position), last = this.pts[this.pts.length - 1];
      if (last && last.distanceTo(p) < 0.1) return;
      this.pts.push(p);
      if (this.pts.length > this.p.keep) this.pts.shift();
      this.line.geometry.dispose();
      this.line.geometry = new THREE.BufferGeometry().setFromPoints(this.pts);
      this.setStatus('ok', `${this.pts.length} puntos`);
    };
    this.viz.sura.addEventListener('nav', this.on);
    this.setStatus('warn', 'Sin navigator/navigation');
  }
  stop() { super.stop(); if (this.on) this.viz.sura.removeEventListener('nav', this.on); }
}

class Mission extends Display {
  static type = 'Mission'; static label = 'Misión'; static icon = 'map-pin';
  static desc = 'Los waypoints de la pestaña Misión (world_ned).';
  static props = [{ k: 'color', label: 'Color', t: 'color', def: '#eef0f1' }];
  start() { this.key = null; }
  update(tick) {
    if (tick % 15) return;
    const wps = this.viz.mission?.wps || [], key = JSON.stringify(wps);
    if (key === this.key) return;
    this.key = key;
    this.clear();
    const h = this.holder('world_ned'), pts = wps.map((w) => new THREE.Vector3(w.x, w.y, w.z ?? 0));
    if (pts.length > 1) {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: this.p.color, dashSize: 0.5, gapSize: 0.3 }));
      l.computeLineDistances(); h.add(l);
    }
    pts.forEach((p, i) => {
      const s = new THREE.Mesh(new THREE.SphereGeometry(i === 0 ? 0.22 : 0.15, 16, 12), std(this.p.color));
      s.position.copy(p); h.add(s);
      const l = label(String(i + 1), { height: 0.3 }); l.position.copy(p).add(new THREE.Vector3(0, 0, -0.4)); h.add(l);
    });
    this.setStatus(pts.length ? 'ok' : 'warn', pts.length ? `${pts.length} waypoints` : 'La misión está vacía');
  }
}

// ------------------------------------------------------------------ sensores
class PointCloud2 extends Display {
  static type = 'PointCloud2'; static label = 'Nube de puntos'; static icon = 'sparkles';
  static desc = 'sensor_msgs/PointCloud2 (sonar, multihaz…).';
  static msgTypes = ['sensor_msgs/msg/PointCloud2'];
  static props = [
    { k: 'topic', label: 'Topic', t: 'topic', types: PointCloud2.msgTypes, def: '' },
    { k: 'size', label: 'Tamaño (px)', t: 'num', def: 3, min: 1, max: 20, step: 1 },
    { k: 'colorBy', label: 'Color', t: 'sel', def: 'Eje Z', opts: ['Plano', 'Eje X', 'Eje Y', 'Eje Z'] },
    { k: 'color', label: 'Color plano', t: 'color', def: '#6fa8d6' },
    { k: 'max', label: 'Máx. puntos', t: 'num', def: 50000, min: 100, step: 1000 },
    { k: 'decay', label: 'Persistencia (s)', t: 'num', def: 0, min: 0, step: 1 },
  ];
  start() {
    this.clouds = [];
    this.sub(this.p.topic, 'sensor_msgs/msg/PointCloud2', (m) => {
      const pts = decodePointCloud2(m, this.p.max);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      const mat = new THREE.PointsMaterial({ size: this.p.size, sizeAttenuation: false, color: this.p.color });
      if (this.p.colorBy !== 'Plano' && pts.length) {
        const ax = { 'Eje X': 0, 'Eje Y': 1, 'Eje Z': 2 }[this.p.colorBy];
        let lo = Infinity, hi = -Infinity;
        for (let i = ax; i < pts.length; i += 3) { lo = Math.min(lo, pts[i]); hi = Math.max(hi, pts[i]); }
        const c = new Float32Array(pts.length), t = new THREE.Color();
        for (let i = 0; i < pts.length; i += 3) {
          t.setHSL(0.7 * (1 - (pts[i + ax] - lo) / (hi - lo || 1)), 0.85, 0.55);
          c[i] = t.r; c[i + 1] = t.g; c[i + 2] = t.b;
        }
        g.setAttribute('color', new THREE.BufferAttribute(c, 3));
        mat.vertexColors = true; mat.color.set(0xffffff);
      }
      const obj = new THREE.Points(g, mat);
      if (this.p.decay > 0) {
        // persistencia: se fija en el fixed frame al llegar
        const pose = this.viz.tf.lookup(this.viz.fixedFrame, m.header.frame_id);
        if (!pose) { this.tfMissing(m.header.frame_id); return; }
        obj.position.copy(pose.t); obj.quaternion.copy(pose.q);
        this.root.add(obj);
        this.clouds.push({ obj, t: performance.now() });
      } else {
        const h = this.holder(m.header.frame_id);
        for (const o of [...h.children]) { disposeTree(o); h.remove(o); }
        h.add(obj);
      }
      this.setStatus('ok', `${pts.length / 3} puntos · ${m.header.frame_id}`);
    }, { throttle_rate: 100, queue_length: 1 });
  }
  update() {
    const lim = performance.now() - this.p.decay * 1000;
    while (this.clouds?.length && this.clouds[0].t < lim) { const { obj } = this.clouds.shift(); disposeTree(obj); this.root.remove(obj); }
  }
  clear() { super.clear(); for (const { obj } of this.clouds || []) { disposeTree(obj); this.root.remove(obj); } this.clouds = []; }
  changed(k) { if (k === 'size' && this.root) this.root.traverse((o) => { if (o.isPoints) o.material.size = this.p.size; }); else this.restart(); }
}

class LaserScan extends Display {
  static type = 'LaserScan'; static label = 'Láser / sonar 2D'; static icon = 'radar';
  static desc = 'sensor_msgs/LaserScan.';
  static msgTypes = ['sensor_msgs/msg/LaserScan'];
  static props = [
    { k: 'topic', label: 'Topic', t: 'topic', types: LaserScan.msgTypes, def: '' },
    { k: 'size', label: 'Tamaño (px)', t: 'num', def: 4, min: 1, max: 20, step: 1 },
    { k: 'color', label: 'Color', t: 'color', def: '#e8b931' },
  ];
  start() {
    this.sub(this.p.topic, 'sensor_msgs/msg/LaserScan', (m) => {
      const pts = [];
      m.ranges.forEach((r, i) => {
        if (r === null || !(r >= m.range_min && r <= m.range_max)) return;
        const a = m.angle_min + i * m.angle_increment;
        pts.push(r * Math.cos(a), r * Math.sin(a), 0);
      });
      const h = this.holder(m.header.frame_id);
      for (const o of [...h.children]) { disposeTree(o); h.remove(o); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      h.add(new THREE.Points(g, new THREE.PointsMaterial({ size: this.p.size, sizeAttenuation: false, color: this.p.color })));
      this.setStatus('ok', `${pts.length / 3} puntos`);
    }, { throttle_rate: 100, queue_length: 1 });
  }
}

class Range extends Display {
  static type = 'Range'; static label = 'Distancia (Range)'; static icon = 'triangle';
  static desc = 'sensor_msgs/Range: el cono del sensor (altímetro, ecosonda).';
  static msgTypes = ['sensor_msgs/msg/Range'];
  static props = [
    { k: 'topic', label: 'Topic', t: 'topic', types: Range.msgTypes, def: '' },
    { k: 'color', label: 'Color', t: 'color', def: '#6fa8d6' },
    { k: 'alpha', label: 'Opacidad', t: 'num', def: 0.4, min: 0, max: 1, step: 0.1 },
  ];
  start() {
    this.sub(this.p.topic, 'sensor_msgs/msg/Range', (m) => {
      const h = this.holder(m.header.frame_id);
      for (const o of [...h.children]) { disposeTree(o); h.remove(o); }
      const r = Math.max(m.range, 1e-3), rad = Math.tan(m.field_of_view / 2) * r;
      const c = new THREE.Mesh(new THREE.ConeGeometry(rad, r, 24, 1, true), std(this.p.color, this.p.alpha));
      c.rotation.z = Math.PI / 2; c.position.x = r / 2;
      c.material.side = THREE.DoubleSide;
      h.add(c);
      this.setStatus('ok', `${m.range.toFixed(2)} m`);
    }, { throttle_rate: 100, queue_length: 1 });
  }
}

class ImageView extends Display {
  static type = 'Image'; static label = 'Imagen'; static icon = 'image';
  static desc = 'Una cámara en una ventanita sobre la vista 3D.';
  static msgTypes = ['sensor_msgs/msg/Image', 'sensor_msgs/msg/CompressedImage'];
  static props = [
    { k: 'topic', label: 'Topic', t: 'topic', types: ImageView.msgTypes, def: '' },
    { k: 'width', label: 'Ancho (px)', t: 'num', def: 320, min: 80, max: 1200, step: 20 },
  ];
  start() {
    this.box = document.createElement('figure');
    this.box.className = 'vz-image';
    this.box.innerHTML = `<figcaption>${this.p.topic.replace(/</g, '&lt;')}</figcaption><canvas></canvas><img alt="">`;
    this.box.style.width = `${this.p.width}px`;
    this.viz.overlays.append(this.box);
    const canvas = this.box.querySelector('canvas'), img = this.box.querySelector('img');
    // Una imagen en crudo pesa megas y rosbridge la pide en best-effort: se pierde por el camino.
    // Si existe la versión /compressed se usa esa.
    let topic = this.p.topic, type = this.viz.typeOf(topic) || 'sensor_msgs/msg/Image';
    const alt = `${topic}/compressed`;
    if (!type.endsWith('CompressedImage') && this.viz.typeOf(alt)) { topic = alt; type = this.viz.typeOf(alt); }
    this.box.querySelector('figcaption').textContent = topic;
    const compressed = type.endsWith('CompressedImage');
    canvas.hidden = compressed; img.hidden = !compressed;
    this.sub(topic, type, (m) => {
      if (compressed) img.src = `data:image/${m.format.includes('png') ? 'png' : 'jpeg'};base64,${m.data}`;
      else drawRaw(canvas, m);
      this.setStatus('ok', compressed ? m.format : `${m.width}×${m.height} ${m.encoding}`);
    }, { throttle_rate: compressed ? 66 : 200, queue_length: 1 });
  }
  stop() { super.stop(); this.box?.remove(); this.box = null; }
}

// ------------------------------------------------------------------ geometry_msgs / nav_msgs
class Pose extends Display {
  static type = 'Pose'; static label = 'Pose'; static icon = 'navigation-2';
  static desc = 'geometry_msgs/PoseStamped como flecha o ejes.';
  static msgTypes = ['geometry_msgs/msg/PoseStamped', 'geometry_msgs/msg/PoseWithCovarianceStamped'];
  static props = [
    { k: 'topic', label: 'Topic', t: 'topic', types: Pose.msgTypes, def: '' },
    { k: 'shape', label: 'Forma', t: 'sel', def: 'Flecha', opts: ['Flecha', 'Ejes'] },
    { k: 'color', label: 'Color', t: 'color', def: '#e5484d' },
    { k: 'length', label: 'Longitud (m)', t: 'num', def: 1, min: 0.05, step: 0.1 },
  ];
  start() {
    this.sub(this.p.topic, this.viz.typeOf(this.p.topic) || Pose.msgTypes[0], (m) => {
      const pose = m.pose.pose || m.pose, h = this.holder(m.header.frame_id);
      for (const o of [...h.children]) { disposeTree(o); h.remove(o); }
      const o = this.p.shape === 'Ejes' ? axes(this.p.length) : arrow(this.p.length, this.p.color);
      o.position.copy(v3(pose.position)); o.quaternion.copy(quat(pose.orientation));
      h.add(o);
      this.setStatus('ok', m.header.frame_id);
    });
  }
}

class PoseArray extends Display {
  static type = 'PoseArray'; static label = 'Varias poses'; static icon = 'list';
  static desc = 'geometry_msgs/PoseArray.';
  static msgTypes = ['geometry_msgs/msg/PoseArray'];
  static props = [
    { k: 'topic', label: 'Topic', t: 'topic', types: PoseArray.msgTypes, def: '' },
    { k: 'color', label: 'Color', t: 'color', def: '#e5484d' },
    { k: 'length', label: 'Longitud (m)', t: 'num', def: 0.4, min: 0.05, step: 0.1 },
  ];
  start() {
    this.sub(this.p.topic, 'geometry_msgs/msg/PoseArray', (m) => {
      const h = this.holder(m.header.frame_id);
      for (const o of [...h.children]) { disposeTree(o); h.remove(o); }
      for (const p of m.poses.slice(0, 2000)) {
        const a = arrow(this.p.length, this.p.color);
        a.position.copy(v3(p.position)); a.quaternion.copy(quat(p.orientation)); h.add(a);
      }
      this.setStatus('ok', `${m.poses.length} poses`);
    }, { throttle_rate: 200, queue_length: 1 });
  }
}

class Path extends Display {
  static type = 'Path'; static label = 'Camino'; static icon = 'spline';
  static desc = 'nav_msgs/Path.';
  static msgTypes = ['nav_msgs/msg/Path'];
  static props = [
    { k: 'topic', label: 'Topic', t: 'topic', types: Path.msgTypes, def: '' },
    { k: 'color', label: 'Color', t: 'color', def: '#3fb8af' },
    { k: 'poses', label: 'Ejes en cada pose', t: 'bool', def: false },
  ];
  start() {
    this.sub(this.p.topic, 'nav_msgs/msg/Path', (m) => {
      const h = this.holder(m.header.frame_id);
      for (const o of [...h.children]) { disposeTree(o); h.remove(o); }
      h.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(m.poses.map((p) => v3(p.pose.position))), lineMat(this.p.color)));
      if (this.p.poses) for (const p of m.poses.slice(0, 500)) { const a = axes(0.3); a.position.copy(v3(p.pose.position)); a.quaternion.copy(quat(p.pose.orientation)); h.add(a); }
      this.setStatus('ok', `${m.poses.length} poses`);
    }, { throttle_rate: 200, queue_length: 1 });
  }
}

class Odometry extends Display {
  static type = 'Odometry'; static label = 'Odometría'; static icon = 'footprints';
  static desc = 'nav_msgs/Odometry: flechas que quedan en el fixed frame.';
  static msgTypes = ['nav_msgs/msg/Odometry'];
  static props = [
    { k: 'topic', label: 'Topic', t: 'topic', types: Odometry.msgTypes, def: '' },
    { k: 'keep', label: 'Mantener', t: 'num', def: 100, min: 1, step: 10 },
    { k: 'pos', label: 'Distancia mínima (m)', t: 'num', def: 0.1, min: 0, step: 0.05 },
    { k: 'color', label: 'Color', t: 'color', def: '#e8b931' },
    { k: 'length', label: 'Longitud (m)', t: 'num', def: 0.5, min: 0.05, step: 0.1 },
  ];
  start() {
    this.arrows = [];
    this.sub(this.p.topic, 'nav_msgs/msg/Odometry', (m) => {
      const base = this.viz.tf.lookup(this.viz.fixedFrame, m.header.frame_id);
      if (!base) { this.tfMissing(m.header.frame_id); return; }
      const p = v3(m.pose.pose.position).applyQuaternion(base.q).add(base.t);
      const q = base.q.clone().multiply(quat(m.pose.pose.orientation));
      const last = this.arrows[this.arrows.length - 1];
      if (last && last.position.distanceTo(p) < this.p.pos && last.quaternion.angleTo(q) < 0.1) return;
      const a = arrow(this.p.length, this.p.color);
      a.position.copy(p); a.quaternion.copy(q);
      this.root.add(a); this.arrows.push(a);
      while (this.arrows.length > this.p.keep) { const o = this.arrows.shift(); disposeTree(o); this.root.remove(o); }
      this.setStatus('ok', `${this.arrows.length} flechas · ${m.child_frame_id}`);
    });
  }
  clear() { super.clear(); for (const a of this.arrows || []) { disposeTree(a); this.root.remove(a); } this.arrows = []; }
}

class Polygon extends Display {
  static type = 'Polygon'; static label = 'Polígono'; static icon = 'pentagon';
  static desc = 'geometry_msgs/PolygonStamped.';
  static msgTypes = ['geometry_msgs/msg/PolygonStamped'];
  static props = [
    { k: 'topic', label: 'Topic', t: 'topic', types: Polygon.msgTypes, def: '' },
    { k: 'color', label: 'Color', t: 'color', def: '#eef0f1' },
  ];
  start() {
    this.sub(this.p.topic, 'geometry_msgs/msg/PolygonStamped', (m) => {
      const h = this.holder(m.header.frame_id);
      for (const o of [...h.children]) { disposeTree(o); h.remove(o); }
      h.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(m.polygon.points.map(v3)), lineMat(this.p.color)));
      this.setStatus('ok', `${m.polygon.points.length} vértices`);
    });
  }
}

class Wrench extends Display {
  static type = 'Wrench'; static label = 'Fuerza y par'; static icon = 'arrow-up-right';
  static desc = 'geometry_msgs/WrenchStamped (fuerzas de los controladores).';
  static msgTypes = ['geometry_msgs/msg/WrenchStamped'];
  static props = [
    { k: 'topic', label: 'Topic', t: 'topic', types: Wrench.msgTypes, def: '' },
    { k: 'fscale', label: 'Escala de fuerza (m/N)', t: 'num', def: 0.02, min: 0, step: 0.01 },
    { k: 'tscale', label: 'Escala de par (m/N·m)', t: 'num', def: 0.1, min: 0, step: 0.01 },
    { k: 'fcolor', label: 'Color de fuerza', t: 'color', def: '#e5484d' },
    { k: 'tcolor', label: 'Color de par', t: 'color', def: '#e8b931' },
  ];
  start() {
    this.sub(this.p.topic, 'geometry_msgs/msg/WrenchStamped', (m) => {
      const h = this.holder(m.header.frame_id);
      for (const o of [...h.children]) { disposeTree(o); h.remove(o); }
      for (const [v, s, c] of [[m.wrench.force, this.p.fscale, this.p.fcolor], [m.wrench.torque, this.p.tscale, this.p.tcolor]]) {
        const d = v3(v), len = d.length() * s;
        if (len < 1e-3) continue;
        const a = arrow(len, c, { shaft: 0.015, head: 0.04, headLen: Math.min(0.1, len / 2) });
        a.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), d.normalize());
        h.add(a);
      }
      const f = v3(m.wrench.force).length();
      this.setStatus('ok', `|F| ${f.toFixed(1)} N`);
    }, { throttle_rate: 50, queue_length: 1 });
  }
}

class Map2D extends Display {
  static type = 'Map'; static label = 'Mapa'; static icon = 'map';
  static desc = 'nav_msgs/OccupancyGrid como textura.';
  static msgTypes = ['nav_msgs/msg/OccupancyGrid'];
  static props = [
    { k: 'topic', label: 'Topic', t: 'topic', types: Map2D.msgTypes, def: '' },
    { k: 'alpha', label: 'Opacidad', t: 'num', def: 0.7, min: 0, max: 1, step: 0.1 },
  ];
  start() {
    this.sub(this.p.topic, 'nav_msgs/msg/OccupancyGrid', (m) => {
      const { width: w, height: hh, resolution: r, origin } = m.info, data = new Uint8Array(w * hh * 4);
      const src = typeof m.data === 'string' ? Int8Array.from(base64ToBytes(m.data)) : m.data;
      for (let i = 0; i < w * hh; i++) {
        const v = src[i], g = v < 0 ? 110 : 255 - Math.round(v * 2.55);
        data.set([g, g, g, v < 0 ? 60 : 255], i * 4);
      }
      const tex = new THREE.DataTexture(data, w, hh);
      tex.needsUpdate = true; tex.magFilter = THREE.NearestFilter;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w * r, hh * r), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: this.p.alpha, side: THREE.DoubleSide }));
      const o = new THREE.Group(); o.position.copy(v3(origin.position)); o.quaternion.copy(quat(origin.orientation));
      mesh.position.set(w * r / 2, hh * r / 2, 0); o.add(mesh);
      const h = this.holder(m.header.frame_id);
      for (const x of [...h.children]) { disposeTree(x); h.remove(x); }
      h.add(o);
      this.setStatus('ok', `${w}×${hh} a ${r} m`);
    }, { throttle_rate: 1000, queue_length: 1 });
  }
}

// ------------------------------------------------------------------ Marker / MarkerArray
const MK = { ARROW: 0, CUBE: 1, SPHERE: 2, CYLINDER: 3, LINE_STRIP: 4, LINE_LIST: 5, CUBE_LIST: 6, SPHERE_LIST: 7, POINTS: 8, TEXT: 9, MESH: 10, TRIANGLES: 11 };
class Marker extends Display {
  static type = 'Marker'; static label = 'Marcadores'; static icon = 'shapes';
  static desc = 'visualization_msgs/Marker y MarkerArray: cubos, flechas, líneas, texto, mallas…';
  static msgTypes = ['visualization_msgs/msg/Marker', 'visualization_msgs/msg/MarkerArray'];
  static props = [{ k: 'topic', label: 'Topic', t: 'topic', types: Marker.msgTypes, def: '' }];
  start() {
    this.markers = new Map();
    const type = this.viz.typeOf(this.p.topic) || Marker.msgTypes[0];
    this.sub(this.p.topic, type, (m) => {
      for (const mk of m.markers || [m]) this.apply(mk);
      const ns = new Set([...this.markers.keys()].map((k) => k.split('#')[0]));
      this.setStatus('ok', `${this.markers.size} marcadores · ${ns.size} namespaces`);
    }, { queue_length: 100 });
  }
  drop(key) { const e = this.markers.get(key); if (e) { disposeTree(e.obj); e.obj.parent?.remove(e.obj); this.markers.delete(key); } }
  apply(m) {
    const key = `${m.ns}#${m.id}`;
    if (m.action === 3) { for (const k of [...this.markers.keys()]) this.drop(k); return; }
    // muchos nodos (el mapa de ArUcos, a 10 Hz) reenvían lo mismo una y otra vez: si solo cambia
    // la pose se mueve lo que ya está dibujado, sin rehacerlo (la malla del tanque tardaría)
    const shape = m.action === 2 ? '' : JSON.stringify([m.header.frame_id, m.type, m.scale, m.color, m.points, m.colors, m.text, m.mesh_resource, m.mesh_use_embedded_materials]);
    let e = this.markers.get(key);
    if (!e || e.shape !== shape) {
      this.drop(key);
      if (m.action === 2) return;
      const obj = this.make(m);
      if (!obj) return;
      this.holder(m.header.frame_id).add(obj);
      e = { obj, shape };
      this.markers.set(key, e);
    }
    e.obj.position.copy(v3(m.pose.position)); e.obj.quaternion.copy(quat(m.pose.orientation));
    const life = (m.lifetime?.sec || 0) + (m.lifetime?.nanosec || 0) / 1e9;
    e.until = life > 0 ? performance.now() + life * 1000 : Infinity;
  }
  make(m) {
    const c = col(m.color), a = m.color.a ?? 1, s = m.scale;
    const mat = () => std(c, a);
    const pts = (m.points || []).map(v3);
    const colors = m.colors?.length === pts.length ? m.colors : null;
    switch (m.type) {
      case MK.ARROW: {
        if (pts.length >= 2) {
          const d = pts[1].clone().sub(pts[0]), len = d.length(), g = new THREE.Group();
          const ar = arrow(len, c, { shaft: s.x / 2, head: s.y / 2, headLen: s.z || len * 0.23, opacity: a });
          ar.position.copy(pts[0]); ar.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), d.normalize());
          g.add(ar); return g;
        }
        return arrow(s.x, c, { shaft: s.y / 2, head: s.z, headLen: s.x * 0.23, opacity: a });
      }
      case MK.CUBE: return new THREE.Mesh(new THREE.BoxGeometry(s.x, s.y, s.z), mat());
      case MK.SPHERE: { const o = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), mat()); o.scale.set(s.x, s.y, s.z); return o; }
      case MK.CYLINDER: {
        const g = new THREE.Group(), o = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 24), mat());
        o.rotation.x = Math.PI / 2; g.add(o); g.scale.set(s.x, s.y, s.z); return g;
      }
      case MK.LINE_STRIP: case MK.LINE_LIST: {
        const g = new THREE.BufferGeometry().setFromPoints(pts);
        if (colors) g.setAttribute('color', new THREE.Float32BufferAttribute(colors.flatMap((k) => [k.r, k.g, k.b]), 3));
        const lm = new THREE.LineBasicMaterial({ color: colors ? 0xffffff : c, vertexColors: !!colors, transparent: a < 1, opacity: a });
        return m.type === MK.LINE_STRIP ? new THREE.Line(g, lm) : new THREE.LineSegments(g, lm);
      }
      case MK.CUBE_LIST: case MK.SPHERE_LIST: {
        const geo = m.type === MK.CUBE_LIST ? new THREE.BoxGeometry(s.x, s.y, s.z) : new THREE.SphereGeometry(0.5, 12, 8);
        if (m.type === MK.SPHERE_LIST) geo.scale(s.x, s.y, s.z);
        const inst = new THREE.InstancedMesh(geo, std(colors ? 0xffffff : c, a), pts.length);
        const M = new THREE.Matrix4();
        pts.forEach((p, i) => { inst.setMatrixAt(i, M.makeTranslation(p.x, p.y, p.z)); if (colors) inst.setColorAt(i, col(colors[i])); });
        return inst;
      }
      case MK.POINTS: {
        const g = new THREE.BufferGeometry().setFromPoints(pts);
        if (colors) g.setAttribute('color', new THREE.Float32BufferAttribute(colors.flatMap((k) => [k.r, k.g, k.b]), 3));
        return new THREE.Points(g, new THREE.PointsMaterial({ size: s.x, color: colors ? 0xffffff : c, vertexColors: !!colors }));
      }
      case MK.TEXT: return label(m.text, { color: `#${c.getHexString()}`, height: s.z || 0.2 });
      case MK.MESH: {
        const g = new THREE.Group(), url = meshUrl(m.mesh_resource);
        if (url) loadMesh(url).then((o) => { if (!m.mesh_use_embedded_materials) o.traverse((x) => { if (x.isMesh) x.material = mat(); }); g.add(o); }).catch(() => this.setStatus('err', `No carga ${m.mesh_resource}`));
        g.scale.set(s.x, s.y, s.z);
        return g;
      }
      case MK.TRIANGLES: {
        const g = new THREE.BufferGeometry().setFromPoints(pts);
        g.computeVertexNormals();
        const o = new THREE.Mesh(g, mat()); o.material.side = THREE.DoubleSide; o.scale.set(s.x || 1, s.y || 1, s.z || 1); return o;
      }
      default: return null;
    }
  }
  update(tick) {
    if (tick % 10 || !this.markers) return;
    const now = performance.now();
    for (const [k, e] of this.markers) if (e.until < now) this.drop(k);
  }
  clear() { super.clear(); this.markers?.clear(); }
}

export const DISPLAY_TYPES = [Grid, Axes, TF, RobotModel, Trail, Mission, PointCloud2, LaserScan, Range, ImageView,
  Marker, Pose, PoseArray, Path, Odometry, Polygon, Wrench, Map2D];
export const FIXED_FRAME = FIXED;
export function makeDisplay(viz, cfg) {
  const C = DISPLAY_TYPES.find((d) => d.type === cfg.type);
  return C ? new C(viz, cfg) : null;
}
// display por defecto para un tipo de mensaje (el «Añadir por topic» de rviz)
export function displayForType(msgType) {
  const t = msgType.includes('/msg/') ? msgType : msgType.replace('/', '/msg/');
  return DISPLAY_TYPES.find((d) => d.msgTypes.includes(t)) || null;
}
