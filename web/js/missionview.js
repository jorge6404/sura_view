// Pestaña Misión (estilo IQUAview): mapa world_ned con capas, waypoints, plantillas,
// ejecución con sura_actions/FollowPath y acciones rápidas (Ir a, profundidad, emerger).
import { GOAL } from './rosbridge.js';
import * as M from './mission.js';
import * as S from './sites.js';
import { $, $$, REDUCED, errMsg, replay, toast } from './ui.js';
import { deg, fmt, parseNum } from './util.js';

const STORE = 'sura_view.mission';
const SITE_STORE = 'sura_view.site', MAP_STORE = 'sura_view.sitemap';

export class MissionView {
  constructor(sura) {
    this.sura = sura;
    this.wps = load();
    this.cur = this.wps.length ? 0 : -1;
    this.tool = 'add';
    this.view = { cx: 0, cy: 0, ppm: 12 };   // centro (este, -norte) y píxeles por metro
    this.cage = null;                         // {x0,y0,x1,y1} en NED
    this.layers = { mission: true, trail: true, origin: true, cage: true, grid: true, sat: false };
    this.run = null;                          // { goal, from, total }
    this.robot = null;
    this.trail = [];
    this.svg = $('#mapsvg');
    this.site = loadKey(SITE_STORE) || 'tank';
    try { this.custom = JSON.parse(loadKey(MAP_STORE) || 'null'); } catch { this.custom = null; }
    this.bind();
    this.bindSite();
    sura.addEventListener('nav', (e) => this.onNav(e.detail));
    sura.addEventListener('robot', () => { this.trail = []; this.renderTracks(); });
    sura.addEventListener('server', () => this.renderTracks());
    new ResizeObserver(() => this.draw()).observe($('#map'));
    this.draw();
    this.renderEditor();
  }

  save() { try { localStorage.setItem(STORE, M.toJSON(this.wps)); } catch { /* sin almacenamiento */ } }

  // ---------- interacción ----------
  bind() {
    for (const b of $$('.mapbar [data-tool]')) {
      b.addEventListener('click', () => {
        this.setTool(b.dataset.tool);
        $('#mapHint').textContent = {
          add: 'Haz clic para añadir un waypoint al final',
          move: 'Arrastra un waypoint para moverlo, o el mapa para desplazarte',
          goto: 'Haz clic donde quieras mandar el robot (GoToPose)',
          cage: 'Arrastra para dibujar la jaula virtual',
          pose: 'Pulsa donde está el robot y arrastra hacia donde mira (como «2D Pose Estimate» de rviz)',
        }[this.tool];
        $('#mapHint').style.opacity = 1;
      });
    }
    $('#holdBtn').addEventListener('click', () => this.hold());
    for (const cb of $$('#layers input')) {
      cb.addEventListener('change', () => {
        this.layers[cb.dataset.layer] = cb.checked;
        if (cb.dataset.layer === 'sat' && cb.checked && !this.sura.profile?.datum?.latitude) {
          toast('Este robot no tiene datum en bringup_description.yaml', 'warn');
        }
        this.draw();
      });
    }
    $('#zIn').addEventListener('click', () => this.zoom(1.4));
    $('#zOut').addEventListener('click', () => this.zoom(1 / 1.4));
    $('#zRobot').addEventListener('click', () => this.centerRobot());
    this.svg.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e); }, { passive: false });

    let drag = null;
    this.svg.addEventListener('pointerdown', (e) => {
      const p = this.toNed(e);
      const hit = e.target.closest('.wpmark');
      if (hit && this.tool !== 'goto') {
        this.cur = +hit.dataset.i;
        this.renderEditor();
        this.draw();
        if (this.tool === 'move') drag = { kind: 'wp', i: this.cur };
        else drag = { kind: 'none' };
      } else if (this.tool === 'cage') {
        drag = { kind: 'cage', a: p };
      } else if (this.tool === 'pose') {
        drag = { kind: 'pose', a: p };
        this.poseDraft = { a: p, b: p };
        this.draw();
      } else {
        drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, cx: this.view.cx, cy: this.view.cy, moved: false };
      }
      this.svg.setPointerCapture(e.pointerId);
    });
    this.svg.addEventListener('pointermove', (e) => {
      const p = this.toNed(e);
      const datum = this.sura.profile?.datum;
      $('#coord').textContent = datum?.latitude
        ? `N ${fmt(p.x, 1)} m · E ${fmt(p.y, 1)} m · ${M.nedToLatLon(datum, p.x, p.y).map((v) => v.toFixed(6).replace('.', ',')).join(' · ')}`
        : `N ${fmt(p.x, 1)} m · E ${fmt(p.y, 1)} m`;
      if (!drag) return;
      if (drag.kind === 'wp') {
        Object.assign(this.wps[drag.i], { x: round(p.x), y: round(p.y) });
        this.renderEditor(); this.draw();
      } else if (drag.kind === 'cage') {
        this.cage = { x0: drag.a.x, y0: drag.a.y, x1: p.x, y1: p.y };
        this.draw();
      } else if (drag.kind === 'pose') {
        this.poseDraft = { a: drag.a, b: p };
        this.draw();
      } else if (drag.kind === 'pan') {
        const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        if (Math.hypot(dx, dy) > 4) drag.moved = true;
        if (drag.moved) {
          this.view.cx = drag.cx - dx / this.view.ppm;
          this.view.cy = drag.cy - dy / this.view.ppm;
          $('#map').classList.add('dragging');
          this.draw();
        }
      }
    });
    // gesto interrumpido (otro dedo, el sistema, perder la captura): se descarta sin aplicar nada
    const cancel = () => {
      if (!drag) return;
      drag = null;
      this.poseDraft = null;
      $('#map').classList.remove('dragging');
      this.draw();
    };
    this.svg.addEventListener('pointercancel', cancel);
    this.svg.addEventListener('lostpointercapture', cancel);
    this.svg.addEventListener('pointerup', (e) => {
      const d = drag;
      drag = null;
      $('#map').classList.remove('dragging');
      if (!d) return;
      if (d.kind === 'wp') { this.save(); return; }
      if (d.kind === 'cage') { toast('Jaula virtual dibujada (aviso visual: SURA no la aplica)', 'ok', 'square-dashed'); return; }
      if (d.kind === 'pose') { this.finishPose(); return; }
      if (d.kind === 'pan' && !d.moved) this.click(this.toNed(e));
    });

    $('#wpPrev').addEventListener('click', () => this.select(this.cur - 1));
    $('#wpNext').addEventListener('click', () => this.select(this.cur + 1));
    $('#wpDel').addEventListener('click', () => {
      if (this.cur < 0) return;
      this.wps.splice(this.cur, 1);
      this.cur = Math.min(this.cur, this.wps.length - 1);
      this.changed();
    });
    for (const id of ['#wx', '#wy', '#wz', '#ws']) {
      $(id).addEventListener('change', (e) => {
        const f = e.target.closest('.field'), n = parseNum(e.target.value);
        f.classList.remove('bad');
        if (n === null || this.cur < 0) { replay(f, 'bad'); return; }
        this.wps[this.cur][e.target.dataset.k] = n;
        e.target.value = fmt(n, e.target.dataset.k === 'speed' ? 2 : 1);
        this.changed(false);
      });
    }
    $('#mNew').addEventListener('click', () => { if (!this.wps.length || confirm('¿Borrar la misión actual?')) { this.wps = []; this.cur = -1; this.changed(); } });
    $('#mSave').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([M.toJSON(this.wps)], { type: 'application/json' }));
      a.download = `mision_${this.sura.robot || 'sura'}.json`;
      a.click();
      toast(`Misión guardada en Descargas: ${a.download}`, 'ok', 'download');
    });
    $('#mOpen').addEventListener('click', () => $('#mFile').click());
    $('#mFile').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try { this.wps = M.fromJSON(await f.text()); this.cur = 0; this.changed(); this.fit(); toast(`${this.wps.length} waypoints cargados`); } catch (err) { toast(errMsg(err), 'err'); }
      e.target.value = '';
    });

    let tpl = null;
    for (const b of $$('[data-tpl]')) {
      b.addEventListener('click', () => {
        tpl = tpl === b.dataset.tpl ? null : b.dataset.tpl;
        for (const x of $$('[data-tpl]')) x.setAttribute('aria-pressed', x.dataset.tpl === tpl);
        $('#tplForm').hidden = !tpl;
        $('#tSpacing').closest('.field').querySelector('label').textContent =
          { lawn: 'Separación (m)', poly: 'Lados', star: 'Direcciones' }[tpl] || '';
        if (tpl) $('#tSpacing').value = { lawn: 2, poly: 6, star: 3 }[tpl];
      });
    }
    $('#tplApply').addEventListener('click', () => {
      const v = (id) => parseNum($(id).value);
      const size = v('#tSize'), sp = v('#tSpacing'), z = v('#tDepth'), h = v('#tHeading') ?? 0;
      if (![size, sp, z].every((n) => n !== null && n > 0)) { toast('Revisa los números de la plantilla', 'warn'); return; }
      const r = this.robot || { x: 0, y: 0 };
      const pts = tpl === 'lawn' ? M.lawnmower({ x0: r.x + 2, y0: r.y - size / 2, width: size, height: size, spacing: sp, z, headingDeg: h })
        : tpl === 'poly' ? M.polygon({ cx: r.x + size, cy: r.y, radius: size / 2, sides: Math.max(3, Math.round(sp)), z, headingDeg: h })
          : M.star({ cx: r.x + size, cy: r.y, radius: size / 2, directions: Math.max(1, Math.round(sp)), z, headingDeg: h });
      this.wps.push(...pts.map((p) => ({ ...p, x: round(p.x), y: round(p.y) })));
      this.cur = this.wps.length - 1;
      this.changed();
      this.fit();
      toast(`${pts.length} waypoints añadidos`, 'ok', 'route');
    });

    $('#runBtn').addEventListener('click', () => { const f = this.resumeFrom ?? 0; this.resumeFrom = null; this.execute(f); });
    $('#pauseBtn').addEventListener('click', () => this.pause());
    $('#abortBtn').addEventListener('click', () => this.abort());
    $('#qDepthBtn').addEventListener('click', () => this.goDepth());
    $('#qSurface').addEventListener('click', () => this.surface());
  }

  click(p) {
    if (this.tool === 'add') {
      const prev = this.wps[this.wps.length - 1];
      this.wps.push(M.newWaypoint(round(p.x), round(p.y), prev ? prev.z : 2, { speed: prev?.speed ?? 0.5 }));
      this.cur = this.wps.length - 1;
      $('#mapHint').style.opacity = 0;
      this.changed(true);
    } else if (this.tool === 'goto') {
      this.goTo(p);
    } else if (this.tool === 'calib') {
      this.calibClick(p);
    } else if (this.tool === 'anchor') {
      this.anchorClick(p);
    }
  }

  setTool(tool) {
    this.tool = tool;
    for (const x of $$('.mapbar [data-tool], #cmSteps [data-tool]')) x.setAttribute('aria-pressed', x.dataset.tool === tool);
  }

  // ---------- lugar (fondo del mapa) ----------
  bindSite() {
    $('#siteSel').innerHTML = Object.entries(S.SITES).map(([k, v]) => `<button role="radio" data-site="${k}">${v}</button>`).join('');
    $('#siteSel').addEventListener('click', (e) => {
      const b = e.target.closest('[data-site]');
      if (b) this.setSite(b.dataset.site, true);
    });
    $('#cmLoad').addEventListener('click', () => $('#cmFile').click());
    $('#cmFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.loadImage(f); });
    $('#cmDrop').addEventListener('click', () => { this.custom = null; this.saveCustom(); this.renderSite(); this.draw(); });
    for (const b of $$('#cmSteps [data-tool]')) {
      b.addEventListener('click', () => {
        if (!this.custom) { toast('Carga primero una imagen', 'warn'); return; }
        if (b.dataset.tool === 'anchor' && !this.robot) { toast('Todavía no hay posición del robot (navigator/navigation)', 'warn'); return; }
        this.setTool(b.dataset.tool);
        this.calib = [];
        $('#mapHint').textContent = b.dataset.tool === 'calib'
          ? 'Haz clic en dos puntos del mapa cuya distancia real conozcas'
          : 'Haz clic en el punto de la imagen donde está ahora el robot';
        $('#mapHint').style.opacity = 1;
      });
    }
    $('#cmRot').addEventListener('input', (e) => {
      if (!this.custom) return;
      this.custom = S.rotateMap(this.custom, +e.target.value);
      $('#cmRotTxt').textContent = `${e.target.value}°`;
      this.draw();
    });
    $('#cmRot').addEventListener('change', () => this.saveCustom());
    this.setSite(this.site);
    if (this.site === 'tank') requestAnimationFrame(() => { this.fitTo(20); this.draw(); });
  }

  setSite(site, user) {
    this.site = site;
    try { localStorage.setItem(SITE_STORE, site); } catch { /* sin almacenamiento */ }
    if (user && site === 'port' && !this.sura.profile?.datum?.latitude) toast('Este robot no tiene datum en bringup_description.yaml', 'warn');
    if (user && site === 'tank') { this.view.cx = 0; this.view.cy = 0; this.fitTo(20); }
    this.renderSite();
    this.draw();
    this.emitSite();
  }

  renderSite() {
    for (const b of $$('#siteSel [data-site]')) b.setAttribute('aria-checked', b.dataset.site === this.site);
    $('#customMap').hidden = this.site !== 'custom';
    $('#siteHint').textContent = {
      tank: 'Piscina de 12 × 8 m y 4,8 m de fondo, centrada en el origen NED, con sus 9 ArUcos.',
      port: 'Foto de satélite alrededor del datum del robot. Necesita internet.',
      custom: '',
      none: '',
    }[this.site];
    if (this.custom) {
      $('#cmRot').value = Math.round(this.custom.rot);
      $('#cmRotTxt').textContent = `${Math.round(this.custom.rot)}°`;
      $('#cmInfo').textContent = `${this.custom.name || 'Imagen'} · ${this.custom.w}×${this.custom.h} px · ${fmt(this.custom.mpp * 100, 1)} cm/px`;
    } else $('#cmInfo').textContent = 'Carga un plano o una foto aérea y colócalo en tres pasos.';
  }

  // el minimapa de Pilotar dibuja el mismo fondo
  emitSite() { this.sura.emit('site', { site: this.site, custom: this.custom }); }

  siteData() { return { site: this.site, custom: this.custom, datum: this.sura.profile?.datum }; }

  fitTo(meters) {
    const r = this.svg.getBoundingClientRect();
    if (r.width) this.view.ppm = Math.min(r.width, r.height) / meters;
  }

  saveCustom() {
    try {
      if (this.custom) localStorage.setItem(MAP_STORE, JSON.stringify(this.custom)); else localStorage.removeItem(MAP_STORE);
    } catch {
      toast('La imagen no cabe en el almacenamiento del navegador: solo durará esta sesión', 'warn');
    }
    this.renderSite();
    this.emitSite();
  }

  // la imagen se reduce a 2048 px y se guarda como JPEG en el navegador
  async loadImage(file) {
    try {
      const url = URL.createObjectURL(file);
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('No es una imagen')); i.src = url; });
      const k = Math.min(1, 2048 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const r = this.svg.getBoundingClientRect();
      const mpp = (r.width / this.view.ppm) * 0.8 / c.width;   // que ocupe el 80 % de la vista
      this.custom = S.pinPixel({ src: c.toDataURL('image/jpeg', 0.85), w: c.width, h: c.height, mpp, rot: 0, tx: 0, ty: 0, name: file.name },
        c.width / 2, c.height / 2, this.view.cx, this.view.cy);
      this.saveCustom();
      this.draw();
      toast('Imagen cargada. Ahora fija la escala con dos puntos', 'ok', 'image');
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  calibClick(p) {
    this.calib = [...(this.calib || []), [p.y, -p.x]];
    this.draw();
    if (this.calib.length < 2) { $('#mapHint').textContent = 'Ahora el segundo punto'; return; }
    const [a, b] = this.calib;
    this.calib = [];
    const v = parseNum(prompt('¿Cuántos metros hay entre los dos puntos?', '') || '');
    if (v === null || v <= 0) { toast('Distancia no válida', 'err'); this.setTool('move'); this.draw(); return; }
    this.custom = S.scaleFromTwo(this.custom, a, b, v);
    this.saveCustom();
    this.setTool('move');
    $('#mapHint').style.opacity = 0;
    this.draw();
    toast(`Escala fijada: ${fmt(this.custom.mpp * 100, 1)} cm/px`, 'ok', 'ruler');
  }

  // el punto de la imagen donde está el robot pasa a estar en su posición actual
  anchorClick(p) {
    const [u, v] = S.svgToPixel(this.custom, p.y, -p.x);
    this.custom = S.pinPixel(this.custom, u, v, this.robot.y, -this.robot.x);
    this.saveCustom();
    this.setTool('move');
    $('#mapHint').style.opacity = 0;
    this.draw();
    toast('Mapa colocado sobre la posición del robot', 'ok', 'crosshair');
  }

  // ---------- pose estimada (set_pose de robot_localization) ----------
  async finishPose() {
    const { a, b } = this.poseDraft || {};
    this.poseDraft = null;
    this.draw();
    if (!a) return;
    const dragged = Math.hypot(b.x - a.x, b.y - a.y) * this.view.ppm > 8;
    const yawNed = dragged ? Math.atan2(b.y - a.y, b.x - a.x) : (this.robot?.yaw ?? 0);
    const depth = this.robot?.z ?? 0;
    const ns = this.sura.robot;
    if (!ns) { toast('Elige un robot primero', 'warn'); return; }
    const topic = this.sura.ns('set_pose');
    this.sura.ros.advertise(topic, 'geometry_msgs/msg/PoseWithCovarianceStamped');
    const ok = this.sura.ros.publish(topic, S.setPoseMsg({ north: a.x, east: a.y, depth, yawNed }, `${ns}/map`));
    if (!ok) { toast('Sin conexión con rosbridge', 'err'); return; }
    let subs = null;
    try { subs = (await this.sura.ros.callService('/rosapi/subscribers', { topic }, { timeoutMs: 3000 })).subscribers; } catch { /* sin rosapi */ }
    const where = `N ${fmt(a.x, 1)} · E ${fmt(a.y, 1)} m, rumbo ${fmt(((deg(yawNed) % 360) + 360) % 360, 0)}°`;
    if (subs && !subs.length) {
      toast(`Nadie escucha ${topic}: la localización real (EKF) no está lanzada${this.sura.profile?.environment === 'sim' ? '; en simulación la posición la da Stonefish' : ''}`, 'warn', 'locate');
    } else {
      toast(`Pose estimada enviada a ${topic}: ${where}`, 'ok', 'locate');
    }
    this.setTool('move');
  }

  select(i) {
    if (!this.wps.length) return;
    this.cur = (i + this.wps.length) % this.wps.length;
    this.renderEditor();
    this.draw();
  }

  changed(animate) {
    this.save();
    this.renderEditor();
    this.draw(animate ? this.cur : -1);
  }

  renderEditor() {
    const w = this.wps[this.cur];
    $('#wpEditor').classList.toggle('off', !w);
    $('#wpLabel').textContent = w ? `WP ${this.cur + 1} de ${this.wps.length}` : 'Sin waypoints';
    for (const [id, k, d] of [['#wx', 'x', 1], ['#wy', 'y', 1], ['#wz', 'z', 1], ['#ws', 'speed', 2]]) {
      $(id).value = w ? fmt(w[k], d) : '';
      $(id).disabled = !w;
    }
    $('#mWp').textContent = this.wps.length;
    $('#mDist').textContent = `${Math.round(M.routeLength(this.wps))} m`;
    const t = Math.round(M.routeTime(this.wps));
    $('#mTime').textContent = this.wps.length > 1 ? `${Math.floor(t / 60)} min ${t % 60} s` : '—';
    if (!this.run) {
      $('#runTitle').textContent = this.wps.length > 1 ? `Misión lista · ${this.wps.length} waypoints` : 'Sin misión';
      $('#runSub').textContent = this.wps.length > 1 ? 'Sin enviar al robot' : 'Añade al menos 2 waypoints en el mapa';
      $('#runBtn').disabled = this.wps.length < 2;
    }
  }

  // ---------- vista ----------
  toNed(e) {
    const r = this.svg.getBoundingClientRect();
    const east = this.view.cx + (e.clientX - r.left - r.width / 2) / this.view.ppm;
    const up = this.view.cy + (e.clientY - r.top - r.height / 2) / this.view.ppm;
    return { x: -up, y: east };
  }

  zoom(f, e) {
    const before = e ? this.toNed(e) : null;
    this.view.ppm = Math.max(0.5, Math.min(200, this.view.ppm * f));
    if (before) {
      const after = this.toNed(e);
      this.view.cx += before.y - after.y;
      this.view.cy -= before.x - after.x;
    }
    this.draw();
  }

  centerRobot() {
    if (!this.robot) { toast('Todavía no hay posición del robot', 'warn'); return; }
    this.view.cx = this.robot.y; this.view.cy = -this.robot.x;
    this.draw();
  }

  fit() {
    const pts = [...this.wps, ...(this.robot ? [this.robot] : [])];
    if (!pts.length) return;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const r = this.svg.getBoundingClientRect();
    const w = Math.max(4, Math.max(...ys) - Math.min(...ys)), h = Math.max(4, Math.max(...xs) - Math.min(...xs));
    this.view.cx = (Math.max(...ys) + Math.min(...ys)) / 2;
    this.view.cy = -(Math.max(...xs) + Math.min(...xs)) / 2;
    this.view.ppm = Math.max(0.5, Math.min(60, Math.min(r.width / (w * 1.4), r.height / (h * 1.6))));
    this.draw();
  }

  onNav(m) {
    const p = m.position.position;
    const first = !this.robot;
    this.robot = { x: p.x, y: p.y, z: p.z, yaw: m.rpy.z };
    const last = this.trail[this.trail.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 0.2) {
      this.trail.push({ x: p.x, y: p.y });
      if (this.trail.length > 4000) this.trail.shift();
    }
    if (this.cage && this.layers.cage) {
      const { x0, x1, y0, y1 } = this.cage;
      const inside = p.x >= Math.min(x0, x1) && p.x <= Math.max(x0, x1) && p.y >= Math.min(y0, y1) && p.y <= Math.max(y0, y1);
      if (!inside && this.wasInside) toast('El robot ha salido de la jaula virtual', 'warn', 'square-dashed');
      this.wasInside = inside;
    }
    if (first) this.centerRobot();
    if ($('#v-mission').classList.contains('on')) this.draw();
    this.renderTracks();
  }

  renderTracks() {
    const s = this.sura, now = Date.now();
    const live = s.navStamp && now - s.navStamp < 3000;
    const p = s.nav?.position?.position;
    $('#tracks').innerHTML = s.robot ? `
      <div class="track"><span class="dot ${live ? 'ok live' : 'off'}"></span><b>${s.robot}</b>
        <span class="v">${p ? `Prof. ${fmt(p.z, 1)} m · Alt. ${s.nav.altitude > 0 ? fmt(s.nav.altitude, 1) + ' m' : '—'}` : 'Sin posición'}</span>
        <span class="v">${live ? 'Recibiendo navigator' : s.navStamp ? 'Datos antiguos' : 'Esperando navigator/navigation'}</span></div>`
      : '<p class="muted">Elige un robot.</p>';
  }

  draw(animIdx = -1) {
    const r = this.svg.getBoundingClientRect();
    if (!r.width) return;
    const { cx, cy, ppm } = this.view;
    const W = r.width / ppm, H = r.height / ppm;
    this.svg.setAttribute('viewBox', `${cx - W / 2} ${cy - H / 2} ${W} ${H}`);
    const px = 1 / ppm;   // un píxel de pantalla en metros
    let s = '';
    const bounds = { x0: cx - W / 2, y0: cy - H / 2, x1: cx + W / 2, y1: cy + H / 2 };
    // el lugar «Puerto» ya pinta el satélite debajo: la capa no lo repite
    if (this.layers.sat && this.site !== 'port') s += S.tilesSvg(this.sura.profile?.datum, bounds, px, 'sat', 0.9);
    s += S.siteSvg(this.site, this.siteData(), { bounds, mpp: px, px });
    $('#mapAttr').hidden = !(this.site === 'port' || this.layers.sat);
    if (this.layers.grid) s += this.grid(cx, cy, W, H, px);
    if (this.layers.origin) {
      s += `<g stroke="#eef0f1" stroke-width="${2 * px}"><line x1="${-8 * px}" x2="${8 * px}" y1="0" y2="0"/><line y1="${-8 * px}" y2="${8 * px}" x1="0" x2="0"/></g>
        <text x="${6 * px}" y="${-6 * px}" font-size="${12 * px}" fill="#eef0f1" font-family="Barlow Condensed" font-weight="600">Origen NED</text>`;
    }
    if (this.cage && this.layers.cage) {
      const { x0, x1, y0, y1 } = this.cage;
      s += `<rect x="${Math.min(y0, y1)}" y="${-Math.max(x0, x1)}" width="${Math.abs(y1 - y0)}" height="${Math.abs(x1 - x0)}" fill="none" stroke="#e8b931" stroke-width="${2 * px}" stroke-dasharray="${10 * px} ${6 * px}"/>`;
    }
    if (this.layers.trail && this.trail.length > 1) {
      s += `<polyline points="${this.trail.map((t) => `${t.y},${-t.x}`).join(' ')}" fill="none" stroke="#4fb37a" stroke-width="${3 * px}" stroke-linejoin="round"/>`;
    }
    if (this.layers.mission && this.wps.length) {
      s += `<polyline points="${this.wps.map((w) => `${w.y},${-w.x}`).join(' ')}" fill="none" stroke="#eef0f1" stroke-width="${3 * px}" stroke-dasharray="${this.run ? 'none' : `${10 * px} ${5 * px}`}"/>`;
      this.wps.forEach((w, i) => {
        const sel = i === this.cur, last = i === this.wps.length - 1 && i > 0, first = i === 0;
        // el mapa siempre es oscuro: la ruta va en blanco de casco con cualquier tema
        const fill = sel ? 'fill:#e8b931' : 'fill:#eef0f1', ink = 'fill:#14181c';
        const rr = (first ? 14 : 11) * px;
        const shape = last ? `<rect x="${-rr}" y="${-rr}" width="${2 * rr}" height="${2 * rr}" rx="${2 * px}" style="${fill}" stroke="#14181c" stroke-width="${2 * px}"/>`
          : `<circle r="${rr}" style="${fill}" stroke="#14181c" stroke-width="${2 * px}"/>`;
        s += `<g class="wpmark" data-i="${i}" transform="translate(${w.y} ${-w.x})" ${i === animIdx ? 'id="newWp"' : ''}>${shape}
          <text y="${4.5 * px}" text-anchor="middle" style="${ink}" font-size="${13 * px}" font-family="Barlow Condensed" font-weight="700">${i + 1}</text></g>`;
      });
    }
    if (this.robot) {
      s += `<g transform="translate(${this.robot.y} ${-this.robot.x}) rotate(${deg(this.robot.yaw)}) scale(${px})"><path d="M0 -16 L11 12 L0 6 L-11 12Z" fill="#e8b931" stroke="#14181c" stroke-width="2"/></g>`;
    }
    for (const [x, y] of (this.tool === 'calib' && this.calib) || []) s += `<circle cx="${x}" cy="${y}" r="${6 * px}" fill="#e8b931" stroke="#14181c" stroke-width="${2 * px}"/>`;
    if (this.poseDraft) {
      const { a, b } = this.poseDraft;
      s += `<g stroke="#6fd3ff" stroke-width="${3 * px}" fill="none"><circle cx="${a.y}" cy="${-a.x}" r="${10 * px}"/><line x1="${a.y}" y1="${-a.x}" x2="${b.y}" y2="${-b.x}"/></g>`;
    }
    this.svg.innerHTML = s;
    // escala: barra de ~80 px con un valor redondo
    const target = 80 / ppm, pow = 10 ** Math.floor(Math.log10(target));
    const nice = [1, 2, 5, 10].map((k) => k * pow).find((v) => v >= target * 0.6) || target;
    $('#scalebar i').style.width = `${nice * ppm}px`;
    $('#scalebar span').textContent = nice >= 1 ? `${fmt(nice, 0)} m` : `${fmt(nice * 100, 0)} cm`;
    $('#scaleTxt').textContent = `${fmt(ppm, 1)} px/m`;
    const g = $('#newWp');
    if (g && !REDUCED && this.wps.length > 1) {
      const w = this.wps[animIdx], p = this.wps[animIdx - 1];
      const t = (y, x, sc) => `translate(${y}px, ${-x}px) scale(${sc})`;
      g.style.transformBox = 'view-box';
      g.animate([
        { transform: t(p.y, p.x, 0.4) },
        { transform: `translate(${(p.y + w.y) / 2}px, ${-Math.max(p.x, w.x) - 40 / ppm}px) scale(1.15)`, offset: 0.55 },
        { transform: `${t(w.y, w.x + 2 / ppm, 1)} scale(.9, 1.1)`, offset: 0.85 },
        { transform: t(w.y, w.x, 1) },
      ], { duration: 520, easing: 'cubic-bezier(.16,1,.3,1)' });
    }
  }

  grid(cx, cy, W, H, px) {
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((v) => v * this.view.ppm >= 40) || 1000;
    let s = `<g stroke="#ffffff" stroke-opacity=".08" stroke-width="${px}">`;
    for (let x = Math.floor((cx - W / 2) / step) * step; x <= cx + W / 2; x += step) s += `<line x1="${x}" x2="${x}" y1="${cy - H / 2}" y2="${cy + H / 2}"/>`;
    for (let y = Math.floor((cy - H / 2) / step) * step; y <= cy + H / 2; y += step) s += `<line y1="${y}" y2="${y}" x1="${cx - W / 2}" x2="${cx + W / 2}"/>`;
    return s + '</g>';
  }

  // ---------- ejecución ----------
  async execute(from = 0) {
    if (!this.sura.robot) { toast('Elige un robot primero', 'warn'); return; }
    const wps = this.wps.slice(from);
    if (wps.length < 1) return;
    $('#runBtn').disabled = true;
    if (!this.autonomyOk()) { $('#runBtn').disabled = false; return; }
    $('#runTitle').textContent = 'Enviando misión…';
    $('#runSub').textContent = 'Esperando a que el robot acepte la ruta…';
    try {
      const goal = this.sura.action('follow_path', 'sura_actions/action/FollowPath',
        M.followPathGoal(wps, { tolerance: 0.5 }), (fb) => this.feedback(fb, from));
      this.run = { goal, from, total: this.wps.length };
      $('#pauseBtn').disabled = false; $('#abortBtn').disabled = false;
      this.draw();
      const res = await goal.result;
      this.finish(res);
    } catch (e) {
      this.run = null;
      toast(`No se pudo ejecutar: ${errMsg(e)}`, 'err');
      this.renderEditor();
      $('#pauseBtn').disabled = true; $('#abortBtn').disabled = true;
    }
  }

  feedback(fb, from) {
    const idx = from + (fb.current_waypoint_index ?? 0);
    this.cur = Math.min(idx, this.wps.length - 1);
    $('#runTitle').textContent = `Ejecutando · hacia WP ${this.cur + 1} de ${this.wps.length}`;
    $('#runSub').textContent = `${fb.state || 'en curso'} · faltan ${fmt(fb.distance_to_target, 1)} m al WP`;
    $('#runProg').style.width = `${Math.max(0, Math.min(100, (fb.progress ?? 0) * (fb.progress > 1 ? 1 : 100)))}%`;
    this.run.lastIdx = idx;
    this.renderEditorLight();
  }

  renderEditorLight() {
    $('#wpLabel').textContent = `WP ${this.cur + 1} de ${this.wps.length}`;
    if ($('#v-mission').classList.contains('on')) this.draw();
  }

  finish(res) {
    const ok = res.status === GOAL.SUCCEEDED && res.values?.success !== false;
    const canceled = res.status === GOAL.CANCELED;
    if (!this.run?.paused) {
      $('#runTitle').textContent = ok ? 'Misión terminada' : canceled ? 'Misión cancelada' : 'La misión falló';
      $('#runSub').textContent = res.values?.message || (ok ? 'El robot lo ha confirmado' : '');
      $('#runProg').style.width = ok ? '100%' : $('#runProg').style.width;
      toast(ok ? 'Misión terminada: el robot lo ha confirmado' : `Misión ${canceled ? 'cancelada' : 'fallida'}: ${res.values?.message || ''}`, ok ? 'ok' : 'warn');
      this.run = null;
      $('#runBtn').innerHTML = '<i data-lucide="play"></i>Ejecutar';
      window.lucide?.createIcons();
      $('#pauseBtn').disabled = true; $('#abortBtn').disabled = true;
      $('#runBtn').disabled = this.wps.length < 2;
    }
    this.draw();
  }

  async pause() {
    if (!this.run) return;
    this.run.paused = true;
    this.run.goal.cancel();
    try {
      await this.sura.setMode('HOLD_POSITION', 'pausa de misión');
      const from = this.run.lastIdx ?? this.run.from;
      $('#runTitle').textContent = `En pausa · manteniendo posición`;
      $('#runSub').textContent = `Al reanudar, sigue desde el WP ${from + 1}`;
      this.run = null;
      this.resumeFrom = from;
      $('#runBtn').disabled = false;
      $('#runBtn').innerHTML = '<i data-lucide="play"></i>Reanudar';
      window.lucide?.createIcons();
    } catch (e) {
      toast(`No se pudo mantener posición: ${errMsg(e)}`, 'err');
    }
  }

  async abort() {
    if (this.run) { this.run.goal.cancel(); this.run = null; }
    $('#runTitle').textContent = 'Abortada · emergiendo';
    $('#runSub').textContent = 'Esperando confirmación del robot…';
    await this.surface();
  }

  // sura_teleop solo cede el control mientras se mantiene LT (hombre muerto). Sin eso,
  // las acciones se aceptan pero el teleop las tapa: mejor decirlo antes.
  autonomyOk() {
    if (this.sura.autonomous === false) {
      toast('Mantén pulsado LT en el mando para ceder el control al robot (modo autónomo)', 'warn', 'gamepad-2');
      return false;
    }
    return true;
  }

  async hold() {
    try { await this.sura.setMode('HOLD_POSITION', 'sura_view'); toast('Manteniendo posición: confirmado por el robot', 'ok', 'anchor'); } catch (e) { toast(errMsg(e), 'err'); }
  }

  async goTo(p) {
    if (!this.autonomyOk()) return;
    try {
      const z = this.robot?.z ?? 0;
      toast(`Enviando GoToPose a N ${fmt(p.x, 1)} · E ${fmt(p.y, 1)}…`, 'ok', 'send');
      const g = this.sura.action('go_to_pose', 'sura_actions/action/GoToPose', M.goToPoseGoal(p.x, p.y, z, this.robot?.yaw ?? 0),
        (fb) => { $('#runSub').textContent = `Ir a: faltan ${fmt(fb.distance_to_goal, 1)} m`; });
      const r = await g.result;
      toast(r.status === GOAL.SUCCEEDED ? 'Ha llegado al punto' : `Ir a: ${r.values?.message || 'no completado'}`, r.status === GOAL.SUCCEEDED ? 'ok' : 'warn');
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  async goDepth() {
    const z = parseNum($('#qDepth').value);
    if (z === null || z < 0) { replay($('#qDepth').closest('.field'), 'bad'); return; }
    if (!this.autonomyOk()) return;
    try {
      toast(`Bajando a ${fmt(z, 1)} m…`, 'ok', 'arrow-down-to-line');
      const g = this.sura.action('go_to_depth', 'sura_actions/action/GoToDepth', { target_depth: z, depth_tolerance: 0.2, timeout: 120 },
        (fb) => { $('#runSub').textContent = `Profundidad: ${fmt(fb.current_depth, 2)} m (error ${fmt(fb.depth_error, 2)})`; });
      const r = await g.result;
      toast(r.values?.success ? `En ${fmt(r.values.final_depth, 2)} m` : `GoToDepth: ${r.values?.message || 'no completado'}`, r.values?.success ? 'ok' : 'warn');
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  async surface() {
    if (!this.autonomyOk()) return;
    try {
      toast('Emergiendo…', 'ok', 'arrow-up-to-line');
      const g = this.sura.action('surface', 'sura_actions/action/Surface', { target_depth: 0, depth_tolerance: 0.3, timeout: 180, surface_force_z: 0 },
        (fb) => { $('#runSub').textContent = `Subiendo: ${fmt(fb.current_depth, 2)} m`; });
      const r = await g.result;
      $('#runTitle').textContent = r.values?.success ? 'En superficie' : 'Emerger no se completó';
      toast(r.values?.success ? 'En superficie: confirmado' : `Surface: ${r.values?.message || 'no completado'}`, r.values?.success ? 'ok' : 'warn');
    } catch (e) { toast(errMsg(e), 'err'); }
  }
}

const round = (v) => Math.round(v * 10) / 10;

function loadKey(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}

function load() {
  try { return M.fromJSON(localStorage.getItem(STORE) || '[]'); } catch { return []; }
}
