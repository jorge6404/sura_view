// Pestaña Pilotar: cámara real, regla de calado, brújula, batería, telemetría y minimapa.
import { $, REDUCED, icons, replay, toast } from './ui.js';
import { siteSvg } from './sites.js';
import { Series, deg, fmt, fresh, headingLabel, wrap360, yawFromQuaternion } from './util.js';

const SVGNS = 'http://www.w3.org/2000/svg';

export class Pilot {
  constructor(sura, mission) {
    this.sura = sura;
    this.ros = sura.ros;
    this.mission = mission;
    this.camUnsub = null;
    this.camTopic = '';
    this.camFrames = [];
    this.lastFrame = null;
    this.head = null; this.headV = 0;
    this.depth = null; this.depthTarget = null;
    this.trail = [];
    this.voltage = new Series(30 * 60 * 1000, 2000);
    // sin navegación todavía: el minimapa ya enseña el lugar, centrado en el origen y sin robot
    requestAnimationFrame(() => { if (!this.sura.nav) this.drawMini(0, 0, 0, false); });
    this.mapBig = false;
    this.buildCompass();
    this.buildCells(null);

    sura.addEventListener('robot', () => this.onRobot());
    sura.addEventListener('nav', (e) => this.onNav(e.detail));
    sura.addEventListener('battery', (e) => this.onBattery(e.detail));
    sura.addEventListener('leak', () => this.renderSafety());
    // FluidPressure llega en pascales; se muestra en bar
    sura.addEventListener('pressure', (e) => { $('#kPress').textContent = `${fmt(e.detail / 1e5, 2)} bar`; });
    sura.addEventListener('watchdog', () => this.renderSafety());
    $('#photoBtn').addEventListener('click', () => this.photo());
    $('#recBtn').addEventListener('click', () => this.toggleRec());
    $('#pip').addEventListener('click', () => this.swap());
    this.ros.addEventListener('state', (e) => { if (e.detail === 'connected' && this.sura.robot) this.findCameras(); });
    // las cámaras aparecen cuando arrancan el simulador o SURA, a menudo después de conectar
    setInterval(() => { if (this.ros.connected && this.sura.robot) this.findCameras(); }, 5000);
    sura.addEventListener('site', () => {
      if (this.mini) this.mini.key = null;
      if (!sura.nav) this.drawMini(0, 0, 0, false);
    });
    setInterval(() => this.watch(), 1000);
    requestAnimationFrame((t) => this.frame(t));
  }

  onRobot() {
    this.trail = [];
    this.voltage = new Series(30 * 60 * 1000, 2000);
    // sin navegación todavía: el minimapa ya enseña el lugar, centrado en el origen y sin robot
    requestAnimationFrame(() => { if (!this.sura.nav) this.drawMini(0, 0, 0, false); });
    this.camKey = null;
    this.cameraTopics = [];
    // las cámaras del robot anterior no siguen (ni aquí ni en los widgets que siguen a Pilotar)
    this.camUnsub?.(); this.camUnsub = null;
    this.camTopic = null; this.lastFrame = null;
    this.sura.depthTarget = undefined;
    this.camManual = false;
    this.findCameras();
  }

  // ---------- cámaras ----------
  async findCameras() {
    if (this.camFinding) return;
    this.camFinding = true;
    try { await this.buildCameras(); } finally { this.camFinding = false; }
  }

  async buildCameras() {
    const sel = $('#camSel');
    let topics = [];
    try {
      const [c, r] = await Promise.all([
        this.ros.callService('/rosapi/topics_for_type', { type: 'sensor_msgs/msg/CompressedImage' }),
        this.ros.callService('/rosapi/topics_for_type', { type: 'sensor_msgs/msg/Image' }),
      ]);
      // compressedDepth es PNG de 16 bits con cabecera propia: el navegador no lo pinta
      const mine = (t) => t.startsWith(`/${this.sura.robot}/`) && !t.endsWith('/compressedDepth');
      topics = [...c.topics.filter(mine).map((t) => ({ t, compressed: true })),
        ...r.topics.filter(mine).filter((t) => !c.topics.includes(`${t}/compressed`)).map((t) => ({ t, compressed: false }))];
    } catch {
      if (!this.camTopic) $('#camEmptyTxt').textContent = 'No se pudo preguntar a rosapi por las cámaras.';
      return;
    }
    const key = topics.map((x) => x.t).join();
    if (key === this.camKey) return;
    this.camKey = key;
    sel.innerHTML = '';
    if (!topics.length) {
      $('#camEmptyTxt').textContent = `No hay topics de imagen bajo /${this.sura.robot}/. ¿Está lanzado SURA?`;
      return;
    }
    const label = (t) => {
      const m = t.match(/(front|down|left|right|bottom|rear)[_a-z]*camera|camera[_a-z]*/i);
      const name = m ? m[0].replace(/_?camera/i, '') : t.split('/').slice(-2, -1)[0];
      return ({ front: 'Frontal', down: 'Inferior', bottom: 'Inferior', left: 'Izq.', right: 'Der.', rear: 'Trasera' })[name.toLowerCase()] || name;
    };
    // para el widget de cámara del panel (elegir topic en sus ajustes)
    this.cameraTopics = topics.map(({ t, compressed }) => ({ t, compressed, label: label(t) }));
    const seen = new Set();
    for (const { t, compressed } of topics) {
      const l = label(t);
      if (seen.has(l)) continue;
      seen.add(l);
      const b = document.createElement('button');
      b.textContent = l;
      b.title = t;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => { this.camManual = true; this.useCamera(t, compressed, b); });
      b.dataset.compressed = compressed ? '1' : '';
      sel.append(b);
    }
    // al refrescar se sigue con la cámara que se estaba viendo si la eligió el piloto (o si es
    // la frontal); si se eligió sola porque no había frontal, se pasa a la frontal cuando aparece
    const cur = [...sel.children].find((b) => b.title === this.camTopic);
    const pref = [...sel.children].find((b) => b.textContent === 'Frontal') || sel.querySelector('button');
    const keep = cur && (this.camManual || cur === pref || !pref);
    if (keep) { for (const b of sel.children) b.setAttribute('aria-pressed', b === cur); return; }
    this.useCamera(pref.title, !!pref.dataset.compressed, pref);
  }

  useCamera(topic, compressed, btn) {
    for (const b of $('#camSel').children) b.setAttribute('aria-pressed', b === btn);
    if (this.camUnsub) this.camUnsub();
    this.camTopic = topic;
    this.lastFrame = null;
    $('#camEmptyTxt').textContent = `Esperando imágenes de ${topic}…`;
    const img = $('#camImg'), canvas = $('#camCanvas');
    img.hidden = !compressed; canvas.hidden = compressed;
    const type = compressed ? 'sensor_msgs/msg/CompressedImage' : 'sensor_msgs/msg/Image';
    this.camUnsub = this.ros.subscribe(topic, type, (m) => {
      this.camFrames.push(Date.now());
      this.lastFrame = Date.now();
      if (compressed) img.src = `data:image/${m.format.includes('png') ? 'png' : 'jpeg'};base64,${m.data}`;
      else drawRaw(canvas, m);
    }, { throttle_rate: compressed ? 66 : 200, queue_length: 1 });
  }

  photo() {
    const src = $('#camImg').hidden ? $('#camCanvas').toDataURL('image/png') : $('#camImg').src;
    if (!this.lastFrame || !src) { toast('Todavía no hay imagen que guardar', 'warn'); return; }
    replay($('#flash'), 'go');
    const a = document.createElement('a');
    const name = `${this.sura.robot}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
    a.href = src;
    a.download = `${name}.${src.startsWith('data:image/png') ? 'png' : 'jpg'}`;
    a.click();
    toast(`Foto guardada en Descargas: ${a.download}`, 'ok', 'camera');
  }

  async toggleRec() {
    const b = $('#recBtn');
    const on = b.getAttribute('aria-pressed') !== 'true';
    try {
      if (on) {
        if (!this.camTopic) throw new Error('No hay cámara seleccionada');
        const r = await this.sura.rpc('bag.start', { topics: [this.camTopic, `/${this.sura.robot}/navigator/navigation`] });
        toast(`Grabando en ${r.path}`, 'ok', 'circle-dot');
      } else {
        await this.sura.rpc('bag.stop');
        toast('Grabación guardada', 'ok', 'disc');
      }
      b.setAttribute('aria-pressed', on);
      b.querySelector('span').textContent = on ? 'Grabando' : 'Grabar';
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  swap() {
    this.mapBig = !this.mapBig;
    const cam = $('#camLayer'), pip = $('#pipLayer');
    const camKids = [...cam.childNodes], pipKids = [...pip.childNodes];
    cam.replaceChildren(...pipKids);
    pip.replaceChildren(...camKids);
    for (const s of ['#draft', '#horizon', '.reticle', '.cam-top', '.cam-bot']) $(s).style.display = this.mapBig ? 'none' : '';
    $('#pipTag').innerHTML = this.mapBig ? '<i data-lucide="video"></i>Cámara' : '<i data-lucide="map"></i>Mapa';
    $('#pip').setAttribute('aria-label', this.mapBig ? 'Mostrar la cámara en grande' : 'Mostrar el mapa en grande');
    replay($('#cam'), 'swapping'); replay($('#pip'), 'swapping');
    icons();
  }

  // ---------- telemetría ----------
  onNav(m) {
    const p = m.position.position;
    this.depth = p.z;
    this.depthTarget = this.depthTarget ?? p.z;
    const yaw = deg(m.rpy?.z ?? yawFromQuaternion(m.position.orientation));
    this.headTarget = wrap360(yaw);
    if (this.head === null) this.head = this.headTarget;
    $('#sDepth').textContent = `${fmt(p.z, 2)} m`;
    $('#sDepthSub').textContent = `N ${fmt(p.x, 1)} · E ${fmt(p.y, 1)}`;
    $('#sSpeed').textContent = `${fmt(m.body_velocity.linear.x, 2)} m/s`;
    $('#sAlt').textContent = m.altitude > 0 ? `${fmt(m.altitude, 2)} m` : 'sin fondo';
    $('#kPitch').textContent = `${fmt(deg(m.rpy.y), 1)}°`;
    $('#kRoll').textContent = `${fmt(deg(m.rpy.x), 1)}°`;
    $('#horizon').style.transform = `translate(-50%, ${Math.max(-60, Math.min(60, deg(m.rpy.y) * 4))}px) rotate(${-deg(m.rpy.x)}deg)`;
    const last = this.trail[this.trail.length - 1];
    if (!last || Math.hypot(last[0] - p.x, last[1] - p.y) > 0.2) {
      this.trail.push([p.x, p.y]);
      if (this.trail.length > 2000) this.trail.shift();
    }
    this.drawMini(p.x, p.y, deg(m.rpy.z));
  }

  onBattery(b) {
    $('#batPct').innerHTML = b.pct === null ? '—' : `${Math.round(b.pct)}<small>%</small>`;
    $('#batVolt').textContent = `${fmt(b.voltage, 1)} V`;
    $('#batCur').textContent = Number.isFinite(b.current) ? `${fmt(Math.abs(b.current), 1)} A` : '— A';
    this.buildCells(b.pct);
    this.voltage.push(Date.now(), b.voltage);
    this.drawHist();
  }

  buildCells(pct) {
    const n = pct === null ? 0 : Math.round(pct / 10);
    const box = $('#batCells');
    if (box.children.length !== 10) {
      box.innerHTML = Array.from({ length: 10 }, (_, i) => `<i style="animation-delay:${i * 40}ms"></i>`).join('');
    }
    [...box.children].forEach((c, i) => c.classList.toggle('e', i >= n));
  }

  drawHist() {
    const r = this.voltage.range();
    if (!r) return;
    const [lo, hi] = r, d = this.voltage.data, t0 = d[0][0], t1 = Math.max(t0 + 1, d[d.length - 1][0]);
    const pts = d.map(([t, v]) => `${((t - t0) / (t1 - t0)) * 280},${40 - ((v - lo) / (hi - lo)) * 34}`).join(' ');
    const mins = Math.max(1, Math.round((t1 - t0) / 60000));
    $('#batHist').innerHTML = `<polyline fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" points="${pts}"/>
      <text x="0" y="47" font-size="11" fill="currentColor">−${mins} min</text><text x="250" y="47" font-size="11" fill="currentColor">ahora</text>`;
  }

  renderSafety() {
    const s = this.sura;
    $('#kLeak').textContent = s.leak === null ? '—' : s.leak ? '¡FUGA!' : 'secos';
    $('#kLeak').style.color = s.leak ? 'var(--red)' : '';
    const wd = s.watchdog;
    $('#kWd').textContent = wd ? (wd.state === 0 ? 'OK' : wd.state_name || (wd.state === 1 ? 'aviso' : 'error')) : '—';
    $('#kWd').style.color = wd && wd.state === 2 ? 'var(--red)' : wd && wd.state === 1 ? 'var(--deck)' : '';
  }

  watch() {
    const now = Date.now();
    this.camFrames = this.camFrames.filter((t) => now - t < 2000);
    $('#camFps').textContent = this.camFrames.length ? `${(this.camFrames.length / 2).toFixed(0)} fps` : '';
    $('#camEmpty').hidden = fresh(this.lastFrame, now, 3000);
    if (!fresh(this.sura.navStamp, now, 3000) && this.sura.robot) {
      $('#sDepthSub').textContent = this.sura.navStamp ? 'datos antiguos' : 'sin datos';
    }
    $('#batAge').textContent = this.sura.batteryStamp && !fresh(this.sura.batteryStamp, now, 5000) ? 'dato antiguo' : '';
  }

  // ---------- brújula con continuación y regla de calado ----------
  buildCompass() {
    const g = $('#ticks');
    for (let a = 0; a < 360; a += 10) {
      const l = document.createElementNS(SVGNS, 'line');
      l.setAttribute('x1', 120); l.setAttribute('x2', 120);
      l.setAttribute('y1', 10); l.setAttribute('y2', a % 30 ? 16 : 22);
      l.setAttribute('transform', `rotate(${a} 120 120)`);
      g.appendChild(l);
    }
  }

  frame(now) {
    const dt = Math.min(0.05, (now - (this.lastT ?? now)) / 1000);
    this.lastT = now;
    if (this.head !== null && this.headTarget !== undefined) {
      let err = this.headTarget - this.head;
      err = ((err + 540) % 360) - 180;
      if (REDUCED) this.head = this.headTarget;
      else { this.headV += (err * 30 - this.headV * 6) * dt; this.head += this.headV * dt; } // muelle amortiguado
      $('#rose').setAttribute('transform', `rotate(${-this.head} 120 120)`);
      const h = String(Math.round(wrap360(this.head))).padStart(3, '0') + '°';
      $('#headTxt').textContent = h; $('#sHead').textContent = h;
      $('#sHeadSub').textContent = headingLabel(this.head);
    }
    if (this.depth !== null && !this.mapBig) this.drawDraft(this.depth);
    requestAnimationFrame((t) => this.frame(t));
  }

  drawDraft(depth) {
    const d = $('#draft');
    const h = d.clientHeight || 600, pxPerM = 150, mid = h / 2;
    let html = '';
    for (let k = Math.floor((depth - mid / pxPerM) * 5) - 2; k <= (depth + mid / pxPerM) * 5 + 2; k++) {
      const m = k / 5;
      if (m < 0) continue;
      const major = k % 5 === 0;
      html += `<div class="tick ${major ? 'major' : ''}" style="top:${mid + (m - depth) * pxPerM}px"><i></i>${major ? `<span>${m}</span>` : ''}</div>`;
    }
    const maxDepth = this.sura.profile?.maxDepth;
    const over = maxDepth && depth > maxDepth;
    html += `<div class="now ${over ? 'limit' : ''}" style="top:${mid}px"><b>${fmt(depth, 2)} m</b></div>`;
    d.innerHTML = html;
  }

  // El fondo (lugar y cuadrícula) se pinta para una zona de ±BG m y solo se rehace al salir de
  // ella o al cambiar de lugar; con cada mensaje de navegación solo se mueven robot, rastro y ruta.
  drawMini(x, y, yawDeg, live = true) {
    const svg = $('#miniMap');
    const s = 14, BG = 60;
    if (!this.mini) {
      svg.innerHTML = '<g class="mm-bg"></g><polyline class="mm-trail" fill="none" stroke="#4fb37a" stroke-width=".25"/>'
        + '<polyline class="mm-route" fill="none" stroke="#eef0f1" stroke-width=".25" stroke-dasharray=".6 .4"/>'
        + '<g class="mm-robot"><path d="M0 -1.2 L.8 .9 L0 .45 L-.8 .9Z" fill="#e8b931" stroke="#14181c" stroke-width=".15"/></g>';
      this.mini = { bg: svg.querySelector('.mm-bg'), trail: svg.querySelector('.mm-trail'), route: svg.querySelector('.mm-route'), robot: svg.querySelector('.mm-robot') };
    }
    const m = this.mini, site = this.mission.site;
    if (m.key !== site || Math.abs(y - m.cx) > BG - s || Math.abs(-x - m.cy) > BG - s) {
      m.key = site; m.cx = y; m.cy = -x;
      const bounds = { x0: y - BG, y0: -x - BG, x1: y + BG, y1: -x + BG };
      const px = (2 * s) / (svg.clientWidth || 200);
      m.bg.innerHTML = `${siteSvg(site, this.mission.siteData(), { bounds, mpp: px, px })}<g stroke="#ffffff22" stroke-width=".05">${gridLines(x, y, BG)}</g>`;
    }
    svg.setAttribute('viewBox', `${y - s} ${-x - s} ${2 * s} ${2 * s}`);
    m.trail.setAttribute('points', this.trail.map(([a, b]) => `${b},${-a}`).join(' '));
    m.route.setAttribute('points', this.mission.wps.map((w) => `${w.y},${-w.x}`).join(' '));
    m.robot.setAttribute('transform', `translate(${y} ${-x}) rotate(${yawDeg})`);
    m.robot.style.display = live ? '' : 'none';
  }
}

function gridLines(x, y, s) {
  let out = '';
  for (let k = Math.floor((y - s) / 5) * 5; k <= y + s; k += 5) out += `<line x1="${k}" x2="${k}" y1="${-x - s}" y2="${-x + s}"/>`;
  for (let k = Math.floor((-x - s) / 5) * 5; k <= -x + s; k += 5) out += `<line y1="${k}" y2="${k}" x1="${y - s}" x2="${y + s}"/>`;
  return out;
}

// sensor_msgs/Image (rgb8, bgr8, mono8) -> canvas
export function drawRaw(canvas, m) {
  const { width: w, height: h, encoding } = m;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const bin = atob(m.data);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const ch = encoding === 'mono8' ? 1 : encoding.includes('a') ? 4 : 3;
  const bgr = encoding.startsWith('bgr');
  for (let i = 0, j = 0; i < w * h; i++, j += ch) {
    const r = bin.charCodeAt(j), g = ch > 1 ? bin.charCodeAt(j + 1) : r, b = ch > 1 ? bin.charCodeAt(j + 2) : r;
    img.data[i * 4] = bgr ? b : r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = bgr ? r : b; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
