// Vista 3D tipo rviz2: displays con propiedades, fixed frame, vistas, herramientas
// (medir, publicar punto, pose inicial, meta) y configuración que se guarda.
// Todo se dibuja en coordenadas ROS del fixed frame; `world` lo pasa a three (Y arriba).
import * as THREE from 'three';
import { $, $$, toast } from './ui.js';
import { esc } from './util.js';
import { DISPLAY_TYPES, FIXED_FRAME, makeDisplay, displayForType, arrow } from './vizdisplays.js';

const STORE = 'sura_view.viz3d';
const norm = (f) => (f || '').replace(/^\//, '');

// ---------------------------------------------------------------- buffer de /tf
export class TfBuffer {
  constructor() { this.map = new Map(); }   // hijo -> { parent, t, q, virtual }
  set(child, parent, t, q, virtual = false) {
    child = norm(child); parent = norm(parent);
    const cur = this.map.get(child);
    if (virtual && cur && !cur.virtual) return;   // el /tf real manda
    this.map.set(child, { parent, t, q, virtual });
  }
  has(f) { return this.map.has(norm(f)); }
  parentOf(f) { return this.map.get(norm(f))?.parent || null; }
  frames() {
    const s = new Set(this.map.keys());
    for (const e of this.map.values()) s.add(e.parent);
    return [...s].filter(Boolean).sort();
  }
  // pose de `frame` en la raíz de su árbol
  chain(frame) {
    let t = new THREE.Vector3(), q = new THREE.Quaternion(), f = norm(frame);
    for (let i = 0; i < 64; i++) {
      const e = this.map.get(f);
      if (!e) return { root: f, t, q };
      t = t.applyQuaternion(e.q).add(e.t);
      q = e.q.clone().multiply(q);
      f = e.parent;
    }
    return null;   // ciclo
  }
  // pose de `source` expresada en `target`, o null si no están conectados
  lookup(target, source) {
    const a = this.chain(target), b = this.chain(source);
    if (!a || !b || a.root !== b.root) return null;
    const qi = a.q.clone().invert();
    return { t: b.t.clone().sub(a.t).applyQuaternion(qi), q: qi.multiply(b.q) };
  }
}

// ROS -> three. NED (z abajo) o z arriba
const UP = {
  '-Z': new THREE.Matrix4().set(0, 1, 0, 0, 0, 0, -1, 0, -1, 0, 0, 0, 0, 0, 0, 1),
  '+Z': new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1),
};

const TOOLS = [
  { id: 'move', icon: 'move-3d', label: 'Mover cámara', hint: 'Izquierdo: girar · Mayús o central: desplazar · derecho o rueda: acercar' },
  { id: 'measure', icon: 'ruler', label: 'Medir', hint: 'Pulsa dos puntos para medir la distancia' },
  { id: 'point', icon: 'crosshair', label: 'Publicar punto', hint: 'Pulsa un punto: se publica en /clicked_point' },
  { id: 'initpose', icon: 'locate-fixed', label: 'Pose inicial 2D', hint: 'Pulsa y arrastra hacia donde mira: /initialpose' },
  { id: 'goal', icon: 'flag', label: 'Meta 2D', hint: 'Pulsa y arrastra hacia donde mira: /goal_pose' },
];
const VIEWS = ['Órbita', 'Cenital', 'Tercera persona'];

export class Viz3D {
  constructor(sura, mission) {
    this.sura = sura;
    this.ros = sura.ros;
    this.mission = mission;
    this.host = $('#vp3d');
    this.overlays = $('#vzOverlays');
    this.tf = new TfBuffer();
    this.types = new Map();     // topic -> tipo
    this.displays = [];

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.host.prepend(this.renderer.domElement);
    const scene = this.scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x1b2a2a, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.3);
    sun.position.set(10, 30, 8);
    scene.add(sun);
    this.world = new THREE.Group();
    this.world.matrixAutoUpdate = false;
    scene.add(this.world);
    this.persp = new THREE.PerspectiveCamera(45, 1, 0.02, 1000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    this.camera = this.persp;
    this.focal = new THREE.Group();     // punto de mira mientras se mueve la cámara
    this.focal.add(new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.012, 8, 32), new THREE.MeshBasicMaterial({ color: 0xe8b931 })));
    this.focal.children[0].rotation.x = Math.PI / 2;
    this.focal.visible = false;
    scene.add(this.focal);
    this.toolLayer = new THREE.Group();
    scene.add(this.toolLayer);

    const saved = this.load();
    this.fixedFrame = saved.fixedFrame || 'world_ned';
    this.up = saved.up || 'Auto';
    this.bg = saved.bg || '#0d1115';
    this.view = { type: VIEWS.includes(saved.view?.type) ? saved.view.type : 'Órbita', target: saved.view?.target || FIXED_FRAME,
      yaw: saved.view?.yaw ?? 0.8, pitch: saved.view?.pitch ?? 0.55, dist: saved.view?.dist ?? 12,
      offset: new THREE.Vector3(...(saved.view?.offset || [0, 0, 0])) };
    this.tool = 'move';
    for (const d of saved.displays || this.defaults()) this.addDisplay(d, { quiet: true });

    this.buildUi();
    this.bindMouse();
    sura.addEventListener('nav', (e) => this.onNav(e.detail));
    sura.addEventListener('robot', () => { for (const d of this.displays) if (d.type === 'RobotModel') d.restart(); });
    this.ros.subscribe('/tf', 'tf2_msgs/msg/TFMessage', (m) => this.onTf(m), { throttle_rate: 50 });
    this.ros.subscribe('/tf_static', 'tf2_msgs/msg/TFMessage', (m) => this.onTf(m));
    this.ros.addEventListener('state', (e) => { if (e.detail === 'connected') { this.refreshTopics(); for (const d of this.displays) if (d.enabled) d.restart(); } });
    // /tf_static no llega por rosbridge (ver op_tf_static del servidor): se pide cada 5 s
    setInterval(() => this.pollStatic(), 5000);
    this.pollStatic();
    this.fps = { n: 0, t: performance.now(), v: 0 };
    this.tick = 0;
    requestAnimationFrame(() => this.frame());
  }

  defaults() {
    return [
      { type: 'Grid' }, { type: 'Axes', p: { length: 0.6 } }, { type: 'TF', enabled: false }, { type: 'RobotModel' },
      { type: 'Trail' }, { type: 'Mission' },
    ];
  }
  load() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } }
  config() {
    const v = this.view;
    return { version: 1, fixedFrame: this.fixedFrame, up: this.up, bg: this.bg,
      view: { type: v.type, target: v.target, yaw: v.yaw, pitch: v.pitch, dist: v.dist, offset: v.offset.toArray() },
      displays: this.displays.map((d) => d.toJSON()) };
  }
  save() { try { localStorage.setItem(STORE, JSON.stringify(this.config())); } catch { /* sin almacenamiento */ } }
  applyConfig(c) {
    if (!c || !Array.isArray(c.displays)) throw new Error('No es una configuración de la vista 3D de sura_view');
    for (const d of this.displays) d.destroy();
    this.displays = [];
    Object.assign(this, { fixedFrame: c.fixedFrame || 'world_ned', up: c.up || 'Auto', bg: c.bg || '#0d1115' });
    if (c.view) Object.assign(this.view, { ...c.view, offset: new THREE.Vector3(...(c.view.offset || [0, 0, 0])) });
    for (const d of c.displays) this.addDisplay(d, { quiet: true });
    this.renderGlobal(); this.renderDisplays(); this.renderView(); this.save();
  }

  // ---------------------------------------------------------------- datos
  onTf(m) {
    for (const tr of m.transforms) {
      const { translation: t, rotation: r } = tr.transform;
      this.tf.set(tr.child_frame_id, tr.header.frame_id, new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion(r.x, r.y, r.z, r.w));
    }
  }
  async pollStatic() {
    if (!this.ros.connected || !this.sura.serverAlive) return;
    try {
      for (const s of await this.sura.rpc('tf.static', {}, 3000)) {
        this.tf.set(s.child, s.parent, new THREE.Vector3(...s.t), new THREE.Quaternion(...s.q));
      }
    } catch { /* servidor viejo sin tf.static */ }
  }
  // Si nadie publica /tf del robot, su base_link se coloca con navigator/navigation (world_ned)
  onNav(m) {
    const robot = this.sura.robot;
    if (!robot) return;
    const p = m.position.position, q = m.position.orientation;
    this.tf.set(`${robot}/base_link`, 'world_ned', new THREE.Vector3(p.x, p.y, p.z), new THREE.Quaternion(q.x, q.y, q.z, q.w), true);
    $('#empty3d').hidden = true;
  }
  async refreshTopics() {
    try {
      const r = await this.ros.callService('/rosapi/topics', {});
      this.types = new Map(r.topics.map((t, i) => [t, r.types[i]]));
      this.renderDisplays();
    } catch { /* rosapi no disponible */ }
  }
  typeOf(topic) { return this.types.get(topic) || null; }
  topicsFor(types) {
    const want = new Set(types.flatMap((t) => [t, t.replace('/msg/', '/')]));
    return [...this.types].filter(([, ty]) => want.has(ty)).map(([t]) => t).sort();
  }

  // ---------------------------------------------------------------- displays
  addDisplay(cfg, { quiet = false } = {}) {
    const d = makeDisplay(this, cfg);
    if (!d) return null;
    this.displays.push(d);
    d.root.visible = d.enabled;
    if (d.enabled) d.start();
    if (!quiet) { d.expanded = true; this.renderDisplays(); this.save(); }
    return d;
  }
  removeDisplay(d) {
    d.destroy();
    this.displays = this.displays.filter((x) => x !== d);
    this.renderDisplays(); this.save();
  }
  statusChanged(d) {
    const row = $(`#vzDisplays [data-id="${this.displays.indexOf(d)}"]`);
    if (!row) return;
    row.querySelector('.vz-dot').className = `vz-dot ${d.status.lvl}`;
    const st = row.querySelector('.vz-status');
    if (st) st.textContent = d.status.text;
  }

  // ---------------------------------------------------------------- interfaz
  buildUi() {
    $('#vzTools').innerHTML = TOOLS.map((t) => `<button aria-pressed="${t.id === this.tool}" data-tool="${t.id}" title="${esc(t.hint)}"><i data-lucide="${t.icon}"></i><span>${t.label}</span></button>`).join('');
    $('#vzTools').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) this.setTool(b.dataset.tool); });
    $('#vzAdd').addEventListener('click', () => this.openAdd());
    $('#vzSave').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(this.config(), null, 1)], { type: 'application/json' }));
      a.download = 'sura_view_3d.json'; a.click(); URL.revokeObjectURL(a.href);
    });
    $('#vzOpen').addEventListener('click', () => $('#vzFile').click());
    $('#vzFile').addEventListener('change', async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      try { this.applyConfig(JSON.parse(await f.text())); toast('Configuración abierta', 'ok'); } catch (err) { toast(err.message, 'err'); }
    });
    $('#vzReset').addEventListener('click', () => { if (confirm('¿Volver a los displays por defecto?')) this.applyConfig({ displays: this.defaults() }); });
    $('#resetView').addEventListener('click', () => { Object.assign(this.view, { yaw: 0.8, pitch: 0.55, dist: 12 }); this.view.offset.set(0, 0, 0); this.save(); });
    this.renderGlobal(); this.renderDisplays(); this.renderView(); this.setTool('move');
  }

  renderGlobal() {
    const frames = this.tf.frames();
    if (!frames.includes(this.fixedFrame)) frames.unshift(this.fixedFrame);
    $('#vzGlobal').innerHTML = `
      <label><span>Fixed Frame</span><input list="vzFrames" id="vzFixed" value="${esc(this.fixedFrame)}"></label>
      <label><span>Arriba</span><select id="vzUp">${['Auto', '+Z', '-Z'].map((u) => `<option ${u === this.up ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
      <label><span>Fondo</span><input type="color" id="vzBg" value="${this.bg}"></label>
      <datalist id="vzFrames">${frames.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>`;
    $('#vzFixed').addEventListener('change', (e) => { this.fixedFrame = norm(e.target.value) || 'world_ned'; for (const d of this.displays) d.restart(); this.save(); });
    $('#vzUp').addEventListener('change', (e) => { this.up = e.target.value; this.save(); });
    $('#vzBg').addEventListener('input', (e) => { this.bg = e.target.value; this.save(); });
  }

  renderDisplays() {
    const box = $('#vzDisplays');
    if (!box) return;
    box.innerHTML = this.displays.map((d, i) => {
      const C = d.constructor;
      const props = C.props.map((p) => `<label><span>${esc(p.label)}</span>${this.propInput(d, p)}</label>`).join('');
      return `<div class="vz-disp ${d.expanded ? 'open' : ''}" data-id="${i}">
        <div class="vz-head">
          <button class="vz-chev" aria-label="Propiedades" aria-expanded="${d.expanded}"><i data-lucide="chevron-right"></i></button>
          <input type="checkbox" ${d.enabled ? 'checked' : ''} aria-label="Activar ${esc(d.name)}">
          <i data-lucide="${C.icon}" class="vz-ic"></i>
          <span class="vz-name" title="Doble clic para renombrar">${esc(d.name)}</span>
          <span class="vz-dot ${d.status.lvl}" title="${esc(d.status.text)}"></span>
          <button class="vz-x" aria-label="Quitar ${esc(d.name)}"><i data-lucide="x"></i></button>
        </div>
        <div class="vz-props"><p class="vz-status">${esc(d.status.text)}</p>${props}</div>
      </div>`;
    }).join('') || '<p class="muted">Sin displays. Pulsa «Añadir».</p>';
    for (const row of $$('.vz-disp', box)) {
      const d = this.displays[+row.dataset.id];
      row.querySelector('.vz-chev').addEventListener('click', () => { d.expanded = !d.expanded; row.classList.toggle('open', d.expanded); });
      row.querySelector('input[type=checkbox]').addEventListener('change', (e) => { d.setEnabled(e.target.checked); this.save(); });
      row.querySelector('.vz-x').addEventListener('click', () => this.removeDisplay(d));
      row.querySelector('.vz-name').addEventListener('dblclick', (e) => {
        const n = prompt('Nombre del display', d.name);
        if (n) { d.name = n; e.target.textContent = n; this.save(); }
      });
      for (const inp of $$('[data-k]', row)) {
        inp.addEventListener('change', () => {
          const def = d.constructor.props.find((p) => p.k === inp.dataset.k);
          d.p[def.k] = def.t === 'bool' ? inp.checked : def.t === 'num' ? Number(inp.value) : inp.value;
          d.changed(def.k); this.save();
        });
      }
    }
    window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } });
  }

  propInput(d, p) {
    const v = d.p[p.k], k = `data-k="${p.k}"`;
    if (p.t === 'bool') return `<input type="checkbox" ${k} ${v ? 'checked' : ''}>`;
    if (p.t === 'num') return `<input type="number" ${k} value="${v}" ${p.min !== undefined ? `min="${p.min}"` : ''} ${p.max !== undefined ? `max="${p.max}"` : ''} step="${p.step ?? 'any'}">`;
    if (p.t === 'color') return `<input type="color" ${k} value="${v}">`;
    if (p.t === 'sel') return `<select ${k}>${p.opts.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    if (p.t === 'frame') return `<input ${k} list="vzFramesP" value="${esc(v)}"><datalist id="vzFramesP"><option value="${esc(FIXED_FRAME)}">${this.tf.frames().map((f) => `<option value="${esc(f)}">`).join('')}</datalist>`;
    if (p.t === 'topic') {
      const opts = this.topicsFor(p.types);
      if (v && !opts.includes(v)) opts.unshift(v);
      return `<select ${k}><option value="">—</option>${opts.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    }
    return `<input ${k} value="${esc(v)}">`;
  }

  renderView() {
    const frames = this.tf.frames();
    $('#vzView').innerHTML = `
      <label><span>Tipo</span><select id="vzViewType">${VIEWS.map((v) => `<option ${v === this.view.type ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label><span>Seguir marco</span><select id="vzTarget"><option value="${esc(FIXED_FRAME)}">${esc(FIXED_FRAME)}</option>${frames.map((f) => `<option value="${esc(f)}" ${f === this.view.target ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label>`;
    $('#vzViewType').addEventListener('change', (e) => { this.view.type = e.target.value; this.save(); });
    $('#vzTarget').addEventListener('change', (e) => { this.view.target = e.target.value; this.view.offset.set(0, 0, 0); this.save(); });
  }

  renderTfTree() {
    const kids = new Map();
    for (const f of this.tf.frames()) { const p = this.tf.parentOf(f) || ''; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(f); }
    const roots = this.tf.frames().filter((f) => !this.tf.parentOf(f));
    const out = [];
    const walk = (f, depth) => {
      const e = this.tf.map.get(f);
      out.push(`<div style="padding-left:${depth * 12}px" title="${esc(f)}">${esc(f)}${e?.virtual ? ' <small>(navigator)</small>' : ''}</div>`);
      for (const c of (kids.get(f) || []).sort()) walk(c, depth + 1);
    };
    for (const r of roots) walk(r, 0);
    const html = out.join('') || '<p class="muted">Sin /tf todavía.</p>';
    if (html !== this.tfHtml) { $('#tfList').innerHTML = html; this.tfHtml = html; }
    const n = this.tf.frames().length;
    if (n !== this.nFrames) { this.nFrames = n; this.renderGlobal(); this.renderView(); }
  }

  openAdd() {
    const dlg = $('#vzAddDlg');
    const byType = DISPLAY_TYPES.map((C) => `<button type="button" class="vz-pick" data-type="${C.type}"><i data-lucide="${C.icon}"></i><b>${C.label}</b><small>${esc(C.desc)}</small></button>`).join('');
    const byTopic = [...this.types].map(([t, ty]) => [t, ty, displayForType(ty)]).filter(([, , C]) => C).sort()
      .map(([t, ty, C]) => `<button type="button" class="vz-pick" data-type="${C.type}" data-topic="${esc(t)}"><i data-lucide="${C.icon}"></i><b>${esc(t)}</b><small>${esc(ty)} → ${C.label}</small></button>`).join('');
    $('#vzAddByType').innerHTML = byType;
    $('#vzAddByTopic').innerHTML = byTopic || '<p class="muted">No hay topics que se puedan dibujar.</p>';
    window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } });
    dlg.onclick = (e) => {
      const b = e.target.closest('.vz-pick');
      if (b) {
        const C = DISPLAY_TYPES.find((x) => x.type === b.dataset.type);
        this.addDisplay({ type: C.type, topic: b.dataset.topic, name: b.dataset.topic ? `${C.label} · ${b.dataset.topic.split('/').pop()}` : C.label });
        dlg.close();
      } else if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
    };
    this.refreshTopics().then(() => { if (dlg.open && !byTopic) this.openAdd(); });
    if (!dlg.open) dlg.showModal();
  }

  // ---------------------------------------------------------------- herramientas
  setTool(id) {
    this.tool = id;
    for (const b of $$('#vzTools button')) b.setAttribute('aria-pressed', b.dataset.tool === id);
    $('#vzHint').textContent = TOOLS.find((t) => t.id === id).hint;
    this.measure = null;
    this.toolLayer.clear();
  }
  // punto del rayo del ratón: primero lo que haya dibujado, si no el plano z=0 del fixed frame
  pick(e, meshes = false) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    let hit = null;
    if (meshes) {
      const list = [];   // solo mallas visibles con geometría (las líneas vacías rompen el raycast)
      this.world.traverseVisible((o) => { if (o.isMesh && o.geometry?.attributes?.position) list.push(o); });
      hit = ray.intersectObjects(list, false)[0]?.point || null;
    }
    if (!hit) {
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0).applyMatrix4(this.world.matrix);
      hit = ray.ray.intersectPlane(plane, new THREE.Vector3());
    }
    return hit ? { three: hit, ros: hit.clone().applyMatrix4(this.world.matrix.clone().invert()) } : null;
  }
  header() {
    const ms = Date.now();
    return { frame_id: this.fixedFrame, stamp: { sec: Math.floor(ms / 1000), nanosec: (ms % 1000) * 1e6 } };
  }
  toolDown(e) {
    const p = this.pick(e, this.tool === 'measure' || this.tool === 'point');
    if (!p) return false;
    if (this.tool === 'measure') {
      if (!this.measure) { this.measure = p; this.marker(p.three, 0xe8b931); $('#vzSel').textContent = `Punto A: ${fmtP(p.ros)}`; }
      else {
        const d = p.ros.distanceTo(this.measure.ros);
        this.marker(p.three, 0xe8b931);
        this.toolLayer.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([this.measure.three, p.three]), new THREE.LineBasicMaterial({ color: 0xe8b931, depthTest: false })));
        $('#vzSel').innerHTML = `<b>${d.toFixed(3)} m</b><br>A ${fmtP(this.measure.ros)}<br>B ${fmtP(p.ros)}`;
        this.measure = null;
      }
      return true;
    }
    if (this.tool === 'point') {
      this.toolLayer.clear(); this.marker(p.three, 0x3fb8af);
      this.ros.advertise('/clicked_point', 'geometry_msgs/msg/PointStamped');
      this.ros.publish('/clicked_point', { header: this.header(), point: { x: p.ros.x, y: p.ros.y, z: p.ros.z } });
      $('#vzSel').textContent = `/clicked_point ${fmtP(p.ros)} (${this.fixedFrame})`;
      return true;
    }
    this.poseDrag = { start: p };
    return true;
  }
  toolMove(e) {
    if (!this.poseDrag) return;
    const p = this.pick(e);
    if (!p) return;
    const s = this.poseDrag.start.ros, yaw = Math.atan2(p.ros.y - s.y, p.ros.x - s.x);
    this.poseDrag.yaw = yaw;
    this.toolLayer.clear();
    const a = arrow(1, this.tool === 'goal' ? 0x4fb37a : 0x6fa8d6);
    const g = new THREE.Group(); g.matrixAutoUpdate = false; g.matrix.copy(this.world.matrix);
    a.position.copy(s); a.rotation.z = yaw; g.add(a); this.toolLayer.add(g);
  }
  toolUp() {
    if (!this.poseDrag) return;
    const { start, yaw = 0 } = this.poseDrag;
    this.poseDrag = null;
    const q = { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) };
    const pose = { position: { x: start.ros.x, y: start.ros.y, z: start.ros.z }, orientation: q };
    if (this.tool === 'goal') {
      this.ros.advertise('/goal_pose', 'geometry_msgs/msg/PoseStamped');
      this.ros.publish('/goal_pose', { header: this.header(), pose });
      $('#vzSel').textContent = `/goal_pose ${fmtP(start.ros)} rumbo ${(yaw * 180 / Math.PI).toFixed(0)}°`;
    } else {
      const cov = Array(36).fill(0); cov[0] = cov[7] = 0.25; cov[35] = 0.0685;
      this.ros.advertise('/initialpose', 'geometry_msgs/msg/PoseWithCovarianceStamped');
      this.ros.publish('/initialpose', { header: this.header(), pose: { pose, covariance: cov } });
      $('#vzSel').textContent = `/initialpose ${fmtP(start.ros)} rumbo ${(yaw * 180 / Math.PI).toFixed(0)}°`;
    }
  }
  marker(at, color) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false }));
    s.position.copy(at); s.renderOrder = 20; this.toolLayer.add(s);
  }

  // ---------------------------------------------------------------- cámara
  bindMouse() {
    const c = this.renderer.domElement;
    let drag = null;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      try { c.setPointerCapture(e.pointerId); } catch { /* puntero ya suelto */ }
      if (this.tool !== 'move' && e.button === 0 && this.toolDown(e)) { drag = { tool: true }; return; }
      const mode = e.button === 2 ? 'zoom' : e.button === 1 || e.shiftKey ? 'pan' : 'rotate';
      drag = { x: e.clientX, y: e.clientY, mode };
      this.focal.visible = true;
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (drag.tool) { this.toolMove(e); return; }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y, v = this.view;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.mode === 'rotate' && v.type !== 'Cenital') {
        v.yaw -= dx * 0.006;
        v.pitch = Math.max(-1.55, Math.min(1.55, v.pitch + dy * 0.006));
      } else if (drag.mode === 'zoom') v.dist = Math.max(0.2, Math.min(500, v.dist * (1 + dy * 0.01)));
      else {
        const k = (v.type === 'Cenital' ? v.dist * 1.2 : v.dist) / this.host.clientHeight * 1.1;
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
        v.offset.add(right.multiplyScalar(-dx * k)).add(up.multiplyScalar(dy * k));
      }
    });
    const end = () => { if (drag?.tool) this.toolUp(); else if (drag) this.save(); drag = null; this.focal.visible = false; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.view.dist = Math.max(0.2, Math.min(500, this.view.dist * (e.deltaY > 0 ? 1.12 : 0.89)));
      clearTimeout(this.wheelSave); this.wheelSave = setTimeout(() => this.save(), 500);
    }, { passive: false });
  }

  updateCamera() {
    const v = this.view;
    let target = new THREE.Vector3(), q = new THREE.Quaternion();
    if (v.target !== FIXED_FRAME) {
      const p = this.tf.lookup(this.fixedFrame, v.target);
      if (p) { target = p.t.applyMatrix4(this.world.matrix); q = p.q; }
    }
    const focal = target.clone().add(v.offset);
    this.focal.position.copy(focal);
    if (v.type === 'Cenital') {
      const cam = this.ortho, a = this.host.clientWidth / this.host.clientHeight, h = v.dist * 0.6;
      Object.assign(cam, { left: -h * a, right: h * a, top: h, bottom: -h });
      cam.position.copy(focal).add(new THREE.Vector3(0, 100, 0));
      cam.up.set(0, 0, -1);
      if (this.upAxis() === '+Z') cam.up.set(1, 0, 0).applyMatrix4(new THREE.Matrix4().extractRotation(this.world.matrix));
      cam.lookAt(focal);
      cam.updateProjectionMatrix();
      this.camera = cam;
      return;
    }
    const cam = this.persp;
    cam.up.set(0, 1, 0);
    let pos;
    if (v.type === 'Tercera persona' && v.target !== FIXED_FRAME) {
      const m = new THREE.Matrix4().extractRotation(this.world.matrix);
      const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(q).applyMatrix4(m);
      fwd.y = 0; fwd.normalize();
      pos = focal.clone().sub(fwd.multiplyScalar(v.dist * 0.6)).add(new THREE.Vector3(0, v.dist * 0.25, 0));
    } else {
      pos = focal.clone().add(new THREE.Vector3(Math.cos(v.yaw) * Math.cos(v.pitch), Math.sin(v.pitch), Math.sin(v.yaw) * Math.cos(v.pitch)).multiplyScalar(v.dist));
    }
    cam.position.lerp(pos, this.camera === cam ? 0.35 : 1);
    cam.lookAt(focal);
    this.camera = cam;
  }
  // el panel de Pilotar se lleva el lienzo a su widget mientras lo enseña (solo hay un renderer)
  attach(el) {
    this.host = el;
    el.prepend(this.renderer.domElement);
    this.w = this.h = 0;      // que frame() ajuste el tamaño al del widget
  }

  detach() {
    this.host = $('#vp3d');
    this.host.prepend(this.renderer.domElement);
    this.w = this.h = 0;
  }

  setViewType(type) {
    if (!VIEWS.includes(type)) return;
    this.view.type = type;
    // «Tercera persona» sigue al robot: sin marco elegido, su base_link
    if (type === 'Tercera persona' && this.view.target === FIXED_FRAME && this.sura.robot) this.view.target = `${this.sura.robot}/base_link`;
    if ($('#vzViewType')) $('#vzViewType').value = type;
    this.save();
  }

  upAxis() {
    if (this.up !== 'Auto') return this.up;
    return /ned|frd/i.test(this.fixedFrame) ? '-Z' : '+Z';
  }

  frame() {
    requestAnimationFrame(() => this.frame());
    if (!this.host.offsetParent) return;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (w && h && (this.w !== w || this.h !== h)) {
      this.w = w; this.h = h;
      this.renderer.setSize(w, h, false);
      this.renderer.domElement.style.width = '100%';
      this.renderer.domElement.style.height = '100%';
      this.persp.aspect = w / h;
      this.persp.updateProjectionMatrix();
    }
    this.tick++;
    this.world.matrix.copy(UP[this.upAxis()]);
    this.world.matrixWorldNeedsUpdate = true;
    this.scene.background = new THREE.Color(this.bg);
    // cada grupo de cada display va a la pose de su marco
    for (const d of this.displays) {
      if (!d.enabled) continue;
      for (const hd of d.holders.values()) {
        const p = this.tf.lookup(this.fixedFrame, hd.userData.frame);
        hd.visible = !!p;
        if (p) { hd.position.copy(p.t); hd.quaternion.copy(p.q); } else if (hd.children.length) d.tfMissing(hd.userData.frame);
      }
      d.update(this.tick);
    }
    if (this.tick % 20 === 0) this.renderTfTree();
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
    this.fps.n++;
    const now = performance.now();
    if (now - this.fps.t > 1000) {
      this.fps.v = Math.round(this.fps.n * 1000 / (now - this.fps.t));
      this.fps.n = 0; this.fps.t = now;
      $('#vzFps').textContent = `${this.fps.v} fps · ${this.fixedFrame} · arriba ${this.upAxis()}`;
    }
  }
}

const fmtP = (p) => `(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`;
