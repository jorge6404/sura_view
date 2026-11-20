// Catálogo de widgets del panel de Pilotar. Cada uno: { type, name, icon, group, desc, size,
// settings?, mount(el, ctx, settings) -> { destroy } } con ctx = { sura, ros, pilot, mission,
// diag, imu, show }. Se suscriben a lo que necesitan y lo sueltan en destroy; un valor con más
// de 3 s sin llegar se muestra como «sin datos» (PRODUCT.md: nunca un dato viejo como actual).
import { $, errMsg, icons, replay, toast } from './ui.js';
import { deg, esc, fmt, fresh, wrap360, yawFromQuaternion } from './util.js';
import { cells, depthTape, horizon, rose, spark } from './dashinstruments.js';
import { chooseMode, modeButtonsHtml, modeStatusText, paintModes, setDepthTarget, surface } from './pilotactions.js';
import { drawRaw } from './pilot.js';
import { siteSvg } from './sites.js';
import { PtyTerm } from './term.js';
import { ownKey } from './dashgrid.js';

export const GROUPS = ['Vídeo', 'Mando', 'Instrumentos', 'Sistema', 'Accesos'];
const STALE = 3000;

// suscripciones y temporizadores de un widget, para soltarlos todos en destroy
function life() {
  const offs = [];
  return {
    on(target, ev, fn) { target.addEventListener(ev, fn); offs.push(() => target.removeEventListener(ev, fn)); },
    every(ms, fn) { const t = setInterval(fn, ms); offs.push(() => clearInterval(t)); },
    add(fn) { offs.push(fn); },
    destroy() { for (const f of offs.splice(0)) f(); },
  };
}
const html = (el, s) => { el.innerHTML = s; icons(); return el; };
const yawOf = (m) => deg(m.rpy?.z ?? yawFromQuaternion(m.position.orientation));
const navFresh = (sura, now = Date.now()) => sura.nav && fresh(sura.navStamp, now, STALE);

// ================================================================ Vídeo

// el topic elegido en los ajustes, si es de este robot (los topics llevan /<robot>/ delante)
export function robotTopic(topic, robot) {
  return topic && robot && topic.startsWith(`/${robot}/`) ? topic : null;
}

// Cámara: suscripción propia (el topic de sus ajustes o, sin elegir, el que vea Pilotar)
function mountCamera(el, { sura, ros, pilot }, settings) {
  const L = life();
  html(el, `<div class="dw-cam">
      <img alt="Cámara del robot" hidden><canvas hidden></canvas>
      <div class="dw-cam-empty"><i data-lucide="video-off"></i><b>Sin imagen</b><span></span></div>
      <div class="dw-cam-hud"><div class="dw-cam-hz"></div><div class="dw-cam-ret"></div></div>
      <div class="dw-cam-top"><span class="dw-cam-name"></span><span class="dw-cam-fps"></span></div>
      <button class="ovbtn dw-cam-shot" title="Guardar el fotograma"><i data-lucide="camera"></i>Foto</button>
      <div class="flash"></div>
    </div>`);
  const img = el.querySelector('img'), cv = el.querySelector('canvas'), empty = el.querySelector('.dw-cam-empty');
  const hz = el.querySelector('.dw-cam-hz'), name = el.querySelector('.dw-cam-name'), fpsEl = el.querySelector('.dw-cam-fps');
  el.querySelector('.dw-cam-hud').hidden = settings.hud === 'off';
  let unsub = null, cur = null, last = 0, frames = [];
  const want = () => {
    const t = settings.topic ? robotTopic(settings.topic, sura.robot) : pilot.camTopic;
    if (!t) return null;
    const known = (pilot.cameraTopics || []).find((c) => c.t === t);
    return { t, compressed: known ? known.compressed : /\/compressed$/.test(t) || (!settings.topic && !$('#camImg').hidden) };
  };
  const sub = () => {
    const w = want();
    if (w?.t === cur?.t && w?.compressed === cur?.compressed) return;
    unsub?.(); unsub = null; cur = w; last = 0;
    img.hidden = cv.hidden = true;
    name.textContent = w ? ((pilot.cameraTopics || []).find((c) => c.t === w.t)?.label || w.t.split('/').slice(-2, -1)[0]) : '';
    if (!w) return;
    const type = w.compressed ? 'sensor_msgs/msg/CompressedImage' : 'sensor_msgs/msg/Image';
    unsub = ros.subscribe(w.t, type, (m) => {
      last = Date.now(); frames.push(last);
      if (w.compressed) { img.src = `data:image/${m.format.includes('png') ? 'png' : 'jpeg'};base64,${m.data}`; img.hidden = false; }
      else { drawRaw(cv, m); cv.hidden = false; }
    }, { throttle_rate: w.compressed ? 66 : 200, queue_length: 1 });
  };
  const watch = () => {
    sub();
    const now = Date.now();
    frames = frames.filter((t) => now - t < 2000);
    fpsEl.textContent = frames.length ? `${(frames.length / 2).toFixed(0)} fps` : '';
    const live = fresh(last, now, STALE);
    empty.hidden = live;
    empty.querySelector('span').textContent = settings.topic && !cur ? `${settings.topic} no es de ${sura.robot}: elige otra cámara en los ajustes`
      : !cur ? 'Elige una cámara en los ajustes del widget o en la vista clásica'
      : last ? 'La imagen se ha parado' : `Esperando ${cur.t}…`;
    if (navFresh(sura, now)) {
      const m = sura.nav;
      hz.style.transform = `translateY(${Math.max(-60, Math.min(60, deg(m.rpy.y) * 4))}px) rotate(${-deg(m.rpy.x)}deg)`;
    }
  };
  el.querySelector('.dw-cam-shot').addEventListener('click', () => {
    const src = cv.hidden ? img.src : cv.toDataURL('image/png');
    if (!fresh(last, Date.now(), STALE) || !src) { toast('Todavía no hay imagen que guardar', 'warn'); return; }
    replay(el.querySelector('.flash'), 'go');
    const a = document.createElement('a');
    a.href = src;
    a.download = `${sura.robot}_${new Date().toISOString().replace(/[:.]/g, '-')}.${src.startsWith('data:image/png') ? 'png' : 'jpg'}`;
    a.click();
    toast(`Foto guardada en Descargas: ${a.download}`, 'ok', 'camera');
  });
  L.every(250, watch);
  L.add(() => unsub?.());
  watch();
  return L;
}

// ================================================================ Mando

function mountModes(el, { sura }) {
  const L = life();
  html(el, `<p class="dw-sub dw-mode-now"></p><div class="modes dw-modes" role="group" aria-label="Modo de control"></div>
    <form class="depthset" hidden><label>Mantener a</label><input inputmode="decimal" autocomplete="off" placeholder="—" aria-label="Profundidad a mantener (m)"><span>m</span><button class="btn small" type="submit">Fijar</button></form>
    <button class="btn small dw-surface"><i data-lucide="arrow-up-to-line"></i>Emerger</button>`);
  const box = el.querySelector('.dw-modes'), form = el.querySelector('form'), input = form.querySelector('input');
  const build = () => { box.innerHTML = modeButtonsHtml(sura.profile?.family); paint(); };
  const paint = () => {
    paintModes(box, sura);
    el.querySelector('.dw-mode-now').textContent = modeStatusText(sura);
    form.hidden = sura.ctrlMode !== 'DEPTH';
    if (!form.hidden && document.activeElement !== input && sura.nav) input.placeholder = fmt(sura.nav.position.position.z, 2);
  };
  box.addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b) chooseMode(sura, b.dataset.mode); });
  form.addEventListener('submit', (e) => { e.preventDefault(); if (setDepthTarget(sura, input.value)) input.value = ''; });
  el.querySelector('.dw-surface').addEventListener('click', () => surface(sura));
  L.on(sura, 'robot', build);
  L.on(sura, 'mode', paint);
  L.on(sura, 'controllers', paint);
  L.every(1000, paint);
  build();
  return L;
}

// Armar: refleja el «siguiente paso» de la vista clásica y le pasa las pulsaciones (mantener para
// armar), para que la lógica de las etapas siga en un solo sitio
function mountArm(el) {
  const L = life();
  html(el, '<div class="dw-step" aria-hidden="true"><i></i><i></i><i></i><i></i></div><h3 class="dw-arm-title"></h3><p class="dw-sub dw-arm-text"></p><button class="btn big primary dw-arm-btn"></button>');
  const btn = el.querySelector('.dw-arm-btn'), nb = $('#nextBtn');
  const sync = () => {
    el.querySelector('.dw-arm-title').textContent = $('#nextTitle').textContent;
    el.querySelector('.dw-arm-text').textContent = $('#nextText').textContent;
    btn.textContent = nb.textContent;
    btn.disabled = nb.disabled;
    btn.className = `${nb.className} dw-arm-btn`;     // big primary, hold y charging (mantener para armar)
    [...el.querySelectorAll('.dw-step i')].forEach((i, k) => { i.className = $('#stepBar').children[k]?.className || ''; });
  };
  for (const ev of ['pointerdown', 'pointerup', 'pointerleave']) {
    btn.addEventListener(ev, (e) => { nb.dispatchEvent(new PointerEvent(ev, { bubbles: true, cancelable: true })); if (ev === 'pointerdown') e.preventDefault(); });
  }
  for (const ev of ['keydown', 'keyup']) btn.addEventListener(ev, (e) => nb.dispatchEvent(new KeyboardEvent(ev, { key: e.key, repeat: e.repeat, bubbles: true, cancelable: true })));
  btn.addEventListener('click', () => nb.click());
  L.every(200, sync);
  sync();
  return L;
}

// Mando y autonomía: lo mismo que el recuadro de la vista clásica
function mountPad(el) {
  const L = life();
  html(el, `<div class="pad dw-pad" role="button" tabindex="0"><i data-lucide="gamepad-2"></i><span class="dw-pad-txt"></span><span class="dot off dw-pad-dot" style="margin-left:auto"></span></div>
    <div class="auto"><span class="dot off dw-auto-dot"></span><span class="dw-auto-txt"></span></div>
    <button class="btn small dw-virtual" hidden><i data-lucide="hand"></i>Ceder control al robot (simulación)</button>`);
  const sync = () => {
    el.querySelector('.dw-pad-txt').innerHTML = $('#padTxt').innerHTML;
    el.querySelector('.dw-pad-dot').className = `${$('#padDot').className} dw-pad-dot`;
    el.querySelector('.dw-auto-txt').innerHTML = $('#autoTxt').innerHTML;
    el.querySelector('.dw-auto-dot').className = `${$('#autoDot').className} dw-auto-dot`;
    const v = el.querySelector('.dw-virtual');
    v.hidden = $('#virtualBtn').hidden;
    v.setAttribute('aria-pressed', $('#virtualBtn').getAttribute('aria-pressed'));
  };
  el.querySelector('.dw-pad').addEventListener('click', () => $('#padBox').click());
  el.querySelector('.dw-virtual').addEventListener('click', () => $('#virtualBtn').click());
  L.every(300, sync);
  sync();
  return L;
}

// ================================================================ Instrumentos

function mountBattery(el, { sura }) {
  const L = life();
  const c = cells(10);
  html(el, '<div class="dw-bat"><b class="dw-big num">—</b><small class="dw-sub dw-age"></small></div><div class="dw-cells"></div><div class="dw-row"><span class="dw-v">— V</span><span class="dw-a">— A</span></div>');
  el.querySelector('.dw-cells').append(c.el);
  const paint = () => {
    const b = sura.battery, ok = b && fresh(sura.batteryStamp, Date.now(), 5000);
    el.querySelector('.dw-big').textContent = b?.pct !== null && b?.pct !== undefined ? `${Math.round(b.pct)} %` : '—';
    el.querySelector('.dw-big').classList.toggle('low', !!b && b.pct !== null && b.pct < 20);
    c.set(b?.pct);
    el.querySelector('.dw-v').textContent = b ? `${fmt(b.voltage, 1)} V` : '— V';
    el.querySelector('.dw-a').textContent = b && Number.isFinite(b.current) ? `${fmt(b.current, 1)} A` : '— A';
    el.querySelector('.dw-age').textContent = !b ? 'sin datos' : ok ? '' : 'dato antiguo';
    el.classList.toggle('stale', !ok);
  };
  L.on(sura, 'battery', paint);
  L.every(1000, paint);
  paint();
  return L;
}

function mountHeading(el, { sura }) {
  const L = life();
  const r = rose();
  el.append(r.el);
  const paint = () => { r.set(navFresh(sura) ? yawOf(sura.nav) : null); el.classList.toggle('stale', !navFresh(sura)); };
  L.on(sura, 'nav', paint);
  L.every(1000, paint);
  L.add(() => r.destroy());
  paint();
  return L;
}

function mountAttitude(el, { sura }) {
  const L = life();
  const h = horizon();
  html(el, '<div class="dw-inst"></div><div class="dw-row"><span>Cabeceo <b class="dw-p num">—</b></span><span>Alabeo <b class="dw-r num">—</b></span></div>');
  el.querySelector('.dw-inst').append(h.el);
  const paint = () => {
    const ok = navFresh(sura), m = sura.nav;
    h.set(ok ? { pitchDeg: deg(m.rpy.y), rollDeg: deg(m.rpy.x) } : null);
    el.querySelector('.dw-p').textContent = ok ? `${fmt(deg(m.rpy.y), 1)}°` : '—';
    el.querySelector('.dw-r').textContent = ok ? `${fmt(deg(m.rpy.x), 1)}°` : '—';
    el.classList.toggle('stale', !ok);
  };
  L.on(sura, 'nav', paint);
  L.every(1000, paint);
  paint();
  return L;
}

function mountDepth(el, { sura }) {
  const L = life();
  const t = depthTape();
  el.append(t.el);
  const paint = () => {
    const ok = navFresh(sura), m = sura.nav;
    t.set(ok ? { depth: m.position.position.z, altitude: m.altitude, maxDepth: sura.profile?.maxDepth,
      target: sura.ctrlMode === 'DEPTH' ? sura.depthTarget : undefined } : null);
    el.classList.toggle('stale', !ok);
  };
  L.on(sura, 'nav', paint);
  L.every(1000, paint);
  paint();
  return L;
}

function mountSpeed(el, { sura }) {
  const L = life();
  html(el, '<div class="dw-kv"><span>Avance</span><b class="dw-x num">—</b><span>Lateral</span><b class="dw-y num">—</b><span>Vertical</span><b class="dw-z num">—</b></div>');
  const paint = () => {
    const ok = navFresh(sura), v = sura.nav?.body_velocity?.linear;
    for (const k of ['x', 'y', 'z']) el.querySelector(`.dw-${k}`).textContent = ok && v ? `${fmt(v[k], 2)} m/s` : '—';
    el.classList.toggle('stale', !ok);
  };
  L.on(sura, 'nav', paint);
  L.every(1000, paint);
  paint();
  return L;
}

function mountSafety(el, { sura }) {
  const L = life();
  let pressureT = 0, wdT = 0;
  html(el, `<ul class="dw-list">
    <li><span class="dot off dw-leak-dot"></span>Fugas<b class="dw-leak">—</b></li>
    <li><span class="dot off dw-wd-dot"></span>Watchdog<b class="dw-wd">—</b></li>
    <li><span class="dot off dw-pr-dot"></span>Presión<b class="dw-pr num">—</b></li></ul>`);
  const set = (k, txt, lvl) => { el.querySelector(`.dw-${k}`).textContent = txt; el.querySelector(`.dw-${k}-dot`).className = `dot ${lvl} dw-${k}-dot`; };
  const paint = () => {
    const now = Date.now();
    const leakOk = sura.leak !== null && sura.leak !== undefined && fresh(sura.leakStamp, now, 5000);
    set('leak', !leakOk ? 'sin datos' : sura.leak ? '¡FUGA!' : 'secos', !leakOk ? 'off' : sura.leak ? 'err' : 'ok');
    const wd = sura.watchdog, wdOk = wd && fresh(wdT, now, 5000);
    set('wd', !wdOk ? 'sin datos' : wd.state_name || ['OK', 'aviso', 'error'][wd.state] || '—', !wdOk ? 'off' : ['ok', 'warn', 'err'][wd.state] || 'off');
    const pOk = Number.isFinite(sura.pressure) && fresh(pressureT, now, 5000);
    set('pr', pOk ? `${fmt(sura.pressure / 1e5, 3)} bar` : 'sin datos', pOk ? 'ok' : 'off');
    el.classList.toggle('alarm', !!(leakOk && sura.leak) || !!(wdOk && wd.state === 2));
  };
  L.on(sura, 'pressure', () => { pressureT = Date.now(); paint(); });
  L.on(sura, 'watchdog', () => { wdT = Date.now(); paint(); });
  L.on(sura, 'leak', paint);
  L.every(1000, paint);
  paint();
  return L;
}

const SPARK = {
  depth: { label: 'Profundidad', unit: 'm', dec: 2, invert: true, get: (s) => (navFresh(s) ? s.nav.position.position.z : null) },
  heading: { label: 'Rumbo', unit: '°', dec: 0, get: (s) => (navFresh(s) ? wrap360(yawOf(s.nav)) : null) },
  speed: { label: 'Velocidad', unit: 'm/s', dec: 2, get: (s) => (navFresh(s) ? Math.hypot(s.nav.body_velocity.linear.x, s.nav.body_velocity.linear.y) : null) },
  battery: { label: 'Batería', unit: 'V', dec: 2, get: (s) => (s.battery && fresh(s.batteryStamp, Date.now(), 5000) ? s.battery.voltage : null) },
};
function mountSpark(el, { sura }, settings) {
  const L = life();
  const k = ownKey(SPARK, settings.what) ? SPARK[settings.what] : SPARK.depth, s = spark(60000, !!k.invert);
  html(el, `<div class="dw-spark-head"><span class="dw-sub">${k.label} · último minuto</span><b class="num dw-spark-v">—</b></div>`);
  el.append(s.el);
  L.every(500, () => {
    const v = k.get(sura);
    if (v !== null) s.push(Date.now(), v);
    s.draw();
    el.querySelector('.dw-spark-v').textContent = v === null ? 'sin datos' : `${fmt(v, k.dec)} ${k.unit}`;
    el.classList.toggle('stale', v === null);
  });
  return L;
}

// ================================================================ Sistema

// Minimapa: el lugar (tanque, puerto, mapa propio), el rastro de Pilotar y la ruta de la misión
function mountMinimap(el, { sura, pilot, mission }) {
  const L = life();
  html(el, `<svg class="dw-map" viewBox="-14 -14 28 28" preserveAspectRatio="xMidYMid slice" aria-label="Minimapa">
    <g class="mm-bg"></g><polyline class="mm-trail" fill="none" stroke="#4fb37a" stroke-width=".25"/>
    <polyline class="mm-route" fill="none" stroke="#eef0f1" stroke-width=".25" stroke-dasharray=".6 .4"/>
    <g class="mm-robot"><path d="M0 -1.2 L.8 .9 L0 .45 L-.8 .9Z" fill="#e8b931" stroke="#14181c" stroke-width=".15"/></g></svg>
    <span class="dw-map-tag"></span>`);
  const svg = el.querySelector('svg'), bg = svg.querySelector('.mm-bg'), trail = svg.querySelector('.mm-trail');
  const route = svg.querySelector('.mm-route'), robot = svg.querySelector('.mm-robot');
  const S = 14, BG = 60;
  let key = null, cx = 0, cy = 0;
  const paint = () => {
    const ok = navFresh(sura), p = sura.nav?.position.position || { x: 0, y: 0 }, site = mission.site;
    const x = ok ? p.x : 0, y = ok ? p.y : 0;
    if (key !== site || Math.abs(y - cx) > BG - S || Math.abs(-x - cy) > BG - S) {
      key = site; cx = y; cy = -x;
      const px = (2 * S) / (svg.clientWidth || 200);
      let grid = '';
      for (let k = -BG; k <= BG; k += 5) grid += `<line x1="${cx + k}" x2="${cx + k}" y1="${cy - BG}" y2="${cy + BG}"/><line x1="${cx - BG}" x2="${cx + BG}" y1="${cy + k}" y2="${cy + k}"/>`;
      bg.innerHTML = `${siteSvg(site, mission.siteData(), { bounds: { x0: cx - BG, y0: cy - BG, x1: cx + BG, y1: cy + BG }, mpp: px, px })}<g stroke="#ffffff22" stroke-width=".05">${grid}</g>`;
    }
    svg.setAttribute('viewBox', `${y - S} ${-x - S} ${2 * S} ${2 * S}`);
    trail.setAttribute('points', (pilot.trail || []).map(([a, b]) => `${b},${-a}`).join(' '));
    route.setAttribute('points', mission.wps.map((w) => `${w.y},${-w.x}`).join(' '));
    robot.setAttribute('transform', `translate(${y} ${-x}) rotate(${ok ? yawOf(sura.nav) : 0})`);
    robot.style.display = ok ? '' : 'none';
    el.querySelector('.dw-map-tag').textContent = ok ? `N ${fmt(p.x, 1)} · E ${fmt(p.y, 1)} m` : 'sin posición';
  };
  L.on(sura, 'nav', paint);
  L.on(sura, 'site', () => { key = null; paint(); });
  L.every(1000, paint);
  paint();
  return L;
}

const bcast = (c) => /broadcaster/i.test(c.type) || /_broadcaster$/.test(c.name);
function mountControllers(el, { sura }) {
  const L = life();
  const busy = new Set();
  html(el, '<p class="dw-sub dw-ctl-sum"></p><ul class="dw-list dw-ctl"></ul>');
  const paint = () => {
    const list = (sura.ctrlList || []).filter((c) => !bcast(c)).sort((a, b) => a.name.localeCompare(b.name));
    el.querySelector('.dw-ctl-sum').textContent = sura.ctrlList ? `${list.filter((c) => c.state === 'active').length} de ${list.length} activos` : 'sin datos de controller_manager';
    el.querySelector('.dw-ctl').innerHTML = list.map((c) => {
      const on = c.state === 'active';
      return `<li><span class="dw-ctl-name" title="${esc(c.type || '')}">${esc(c.name)}</span>
        <button class="switch ${busy.has(c.name) ? 'busy' : ''}" role="switch" aria-checked="${on}" aria-label="${on ? 'Desactivar' : 'Activar'} ${esc(c.name)}" data-name="${esc(c.name)}" ${busy.has(c.name) ? 'disabled' : ''}><i></i></button></li>`;
    }).join('');
  };
  el.querySelector('.dw-ctl').addEventListener('click', async (e) => {
    const b = e.target.closest('button.switch');
    if (!b) return;
    const name = b.dataset.name, on = b.getAttribute('aria-checked') !== 'true';
    busy.add(name); paint();
    try { await sura.toggleController(name, on); toast(`${name}: ${on ? 'activo' : 'inactivo'}`, 'ok'); } catch (err) { toast(errMsg(err), 'err'); }
    busy.delete(name); paint();
  });
  L.on(sura, 'controllers', paint);
  L.every(2000, paint);
  paint();
  return L;
}

function mountDiagnostics(el, { sura, diag, show }) {
  const L = life();
  html(el, '<p class="dw-diag-sum"></p><ul class="dw-list dw-diag"></ul><button class="linkbtn dw-diag-all">Ver todo el diagnóstico</button>');
  el.querySelector('.dw-diag-all').addEventListener('click', () => show('diag'));
  const LVL = ['ok', 'warn', 'err', 'off'];
  const paint = () => {
    const { warn, err, stale, any } = diag.summary();
    const sum = el.querySelector('.dw-diag-sum');
    sum.textContent = !any ? 'Sin datos de /diagnostics' : err ? `${err} con error${warn ? ` · ${warn} con aviso` : ''}` : warn ? `${warn} con aviso` : stale ? `Todo bien · ${stale} sin datos` : 'Todo bien';
    sum.className = `dw-diag-sum ${!any ? 'off' : err ? 'err' : warn ? 'warn' : 'ok'}`;
    const worst = diag.leaves().filter((s) => s.level > 0).sort((a, b) => (b.level % 3) - (a.level % 3)).slice(0, 6);
    el.querySelector('.dw-diag').innerHTML = worst.map((s) => `<li><span class="dot ${LVL[s.level] || 'off'}"></span><span class="dw-diag-name">${esc(s.name.split('/').filter(Boolean).slice(-2).join(' / '))}</span><small>${esc(s.message || '')}</small></li>`).join('');
  };
  L.on(sura, 'diag', paint);
  L.every(2000, paint);
  paint();
  return L;
}

function mountPing(el, { sura }) {
  const L = life();
  html(el, '<div class="dw-ping"><b class="dw-big num dw-ms">—</b><small class="dw-sub dw-ping-st">sin medir</small></div><button class="btn small dw-ping-btn"><i data-lucide="radio"></i>Medir</button>');
  const st = el.querySelector('.dw-ping-st'), ms = el.querySelector('.dw-ms'), btn = el.querySelector('.dw-ping-btn');
  btn.addEventListener('click', async () => {
    btn.disabled = true; st.textContent = 'midiendo…';
    try {
      const r = await sura.rpc('ping', {}, 6000);
      ms.textContent = r.reachable ? `${fmt(r.ms, 0)} ms` : '—';
      st.textContent = r.reachable ? `${r.address} responde` : `${r.address} no responde`;
      el.classList.toggle('alarm', !r.reachable);
    } catch (e) { ms.textContent = '—'; st.textContent = errMsg(e); }
    btn.disabled = false;
  });
  return L;
}

function mountImu(el, { sura, imu }) {
  const L = life();
  html(el, '<p class="dw-imu-st dw-sub">—</p><div class="dw-bar"><i></i></div><button class="btn small dw-imu-go"><i data-lucide="compass"></i>Calibrar</button>');
  el.querySelector('.dw-imu-go').addEventListener('click', () => imu.open());
  const paint = (st = imu.st) => {
    const phase = st?.phase;
    el.querySelector('.dw-imu-st').textContent = !st || phase === 'idle' ? 'Sin calibración en curso'
      : phase === 'done' ? 'Calibración completada' : phase === 'error' ? `Error: ${st.error}` : 'Calibrando…';
    const running = st && !['idle', 'done', 'error'].includes(phase);
    el.querySelector('.dw-bar').hidden = !running;
    el.querySelector('.dw-imu-go').innerHTML = running ? '<i data-lucide="compass"></i>Ver el asistente' : '<i data-lucide="compass"></i>Calibrar';
    icons();
  };
  L.on(sura, 'imucal', (e) => paint(e.detail));
  paint();
  return L;
}

// Terminal: una pty de sura_view_server por widget, en un xterm (term.js). La sesión sigue viva al
// salir de Pilotar (el xterm se vuelve a enganchar tal cual) y se cierra al quitar el widget (forget).
const TERMS = new Map();     // id del widget -> { pt: PtyTerm, onEnd }
function mountTerminal(el, { sura }, settings, id) {
  const L = life();
  html(el, `<div class="dw-term"><div class="dw-term-box"></div>
    <div class="dw-term-start"><i data-lucide="terminal"></i><p></p><button class="btn small"><i data-lucide="play"></i><span>Abrir terminal</span></button></div></div>`);
  const box = el.querySelector('.dw-term-box'), start = el.querySelector('.dw-term-start'), msg = start.querySelector('p');
  const st = TERMS.get(id) || { pt: null, onEnd: null };
  const paint = () => {
    const robot = settings.target === 'robot';
    start.hidden = !!st.pt?.alive;
    start.classList.toggle('ended', !!st.pt);
    msg.textContent = st.pt ? 'La sesión ha terminado.' : robot ? `Shell en el robot por ssh (${sura.address || 'sin dirección'}).` : 'Shell en este ordenador (sura shell, ros2 topic, claude…).';
    start.querySelector('span').textContent = st.pt ? 'Abrir otra' : 'Abrir terminal';
  };
  st.onEnd = paint;
  if (st.pt) st.pt.attach(box);
  start.querySelector('button').addEventListener('click', async () => {
    const robot = settings.target === 'robot';
    if (robot && sura.server?.environment !== 'real') toast('El robot está en simulación: la terminal se abre en este ordenador', 'warn', 'terminal');
    st.pt?.close();
    st.pt = new PtyTerm(sura, { onEnd: () => st.onEnd?.() });
    TERMS.set(id, st);
    st.pt.attach(box);
    try {
      await st.pt.open(robot ? 'robot' : 'local');
      paint();
      st.pt.focus();
    } catch (e) {
      st.pt.close(); st.pt = null; TERMS.delete(id);
      paint();
      toast(errMsg(e), 'warn', 'terminal');
    }
  });
  L.add(() => { st.onEnd = null; });
  paint();
  return L;
}
function forgetTerminal(id) {
  TERMS.get(id)?.pt?.close();
  TERMS.delete(id);
}

// Vista 3D: la de la pestaña 3D (mismos displays, robot, TF y marcadores), movida a este widget
// mientras se ve. Solo hay un lienzo: un segundo widget 3D lo explica en vez de dibujar.
let viz3dOwner = null;
function mountViz3d(el, { scene }, settings, id) {
  const L = life();
  html(el, `<div class="dw-3d"><div class="dw-3d-msg"><i data-lucide="box"></i><span>Cargando la vista 3D…</span></div>
    <div class="seg dw-3d-views" role="group" aria-label="Cámara 3D"><button data-v="Órbita">Órbita</button><button data-v="Cenital">Cenital</button><button data-v="Tercera persona">Seguir</button></div></div>`);
  const box = el.querySelector('.dw-3d'), msg = box.querySelector('.dw-3d-msg span');
  let attached = false;
  const tryAttach = () => {
    const v = scene();
    if (attached) return;
    if (!v) return;
    if (viz3dOwner && viz3dOwner !== id) { msg.textContent = 'Solo cabe una vista 3D en el panel: ya hay otra.'; return; }
    viz3dOwner = id;
    v.attach(box);
    attached = true;
    box.querySelector('.dw-3d-msg').hidden = true;
    paintViews();
  };
  const paintViews = () => {
    const v = scene();
    for (const b of box.querySelectorAll('.dw-3d-views button')) b.setAttribute('aria-pressed', !!v && v.view.type === b.dataset.v);
  };
  box.querySelector('.dw-3d-views').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]'), v = scene();
    if (!b || !v) return;
    v.setViewType(b.dataset.v);
    paintViews();
  });
  L.every(500, tryAttach);
  L.add(() => { if (attached) { scene()?.detach(); viz3dOwner = null; } });
  tryAttach();
  return L;
}

// ================================================================ Accesos (las vistas grandes tienen un solo lienzo)

function shortcut(type, name, icon, desc, open) {
  return {
    type, name, icon, group: 'Accesos', desc, size: { w: 2, h: 2, minW: 2, minH: 2 },
    mount(el, ctx) {
      html(el, `<button class="dw-go"><i data-lucide="${icon}"></i><b>${name}</b><small>${desc}</small></button>`);
      el.querySelector('.dw-go').addEventListener('click', () => open(ctx));
      return { destroy() {} };
    },
  };
}

// ================================================================ catálogo

export const WIDGETS = [
  { type: 'camera', name: 'Cámara', icon: 'video', group: 'Vídeo', desc: 'Imagen en directo con horizonte y foto. Puedes poner varias.',
    size: { w: 6, h: 7, minW: 3, minH: 3 }, mount: mountCamera,
    settings: [
      { k: 'topic', label: 'Topic', options: (ctx) => [{ value: '', label: 'La que se vea en Pilotar' }, ...(ctx.pilot.cameraTopics || []).map((c) => ({ value: c.t, label: `${c.label} · ${c.t}` }))] },
      { k: 'hud', label: 'Horizonte y retícula', options: () => [{ value: '', label: 'Sí' }, { value: 'off', label: 'No' }] },
    ] },
  { type: 'arm', name: 'Armar', icon: 'zap', group: 'Mando', desc: 'El siguiente paso: lanzar, comprobar y armar (mantener pulsado).', size: { w: 3, h: 4, minW: 2, minH: 3 }, mount: mountArm },
  { type: 'modes', name: 'Modos de control', icon: 'gamepad', group: 'Mando', desc: 'Modo del mando, mantener profundidad y emerger.', size: { w: 3, h: 6, minW: 2, minH: 4 }, mount: mountModes },
  { type: 'pad', name: 'Mando y autonomía', icon: 'gamepad-2', group: 'Mando', desc: 'Si el mando publica y quién manda: piloto o robot.', size: { w: 3, h: 2, minW: 2, minH: 2 }, mount: mountPad },
  { type: 'battery', name: 'Batería', icon: 'battery-medium', group: 'Instrumentos', desc: 'Carga, celdas, tensión y corriente.', size: { w: 3, h: 3, minW: 2, minH: 2 }, mount: mountBattery },
  { type: 'heading', name: 'Rumbo', icon: 'compass', group: 'Instrumentos', desc: 'Rosa de los vientos.', size: { w: 3, h: 4, minW: 2, minH: 3 }, mount: mountHeading },
  { type: 'attitude', name: 'Horizonte artificial', icon: 'plane', group: 'Instrumentos', desc: 'Cabeceo y alabeo.', size: { w: 3, h: 4, minW: 2, minH: 3 }, mount: mountAttitude },
  { type: 'depth', name: 'Profundidad', icon: 'arrow-down-to-line', group: 'Instrumentos', desc: 'Cinta de profundidad, altitud al fondo y consigna.', size: { w: 2, h: 6, minW: 2, minH: 4 }, mount: mountDepth },
  { type: 'speed', name: 'Velocidad', icon: 'gauge', group: 'Instrumentos', desc: 'Avance, lateral y vertical.', size: { w: 3, h: 2, minW: 2, minH: 2 }, mount: mountSpeed },
  { type: 'safety', name: 'Seguridad', icon: 'shield-check', group: 'Instrumentos', desc: 'Fugas, watchdog y presión.', size: { w: 3, h: 2, minW: 2, minH: 2 }, mount: mountSafety },
  { type: 'spark', name: 'Mini-gráfica', icon: 'chart-spline', group: 'Instrumentos', desc: 'El último minuto de una magnitud.', size: { w: 3, h: 2, minW: 2, minH: 2 }, mount: mountSpark,
    settings: [{ k: 'what', label: 'Magnitud', options: () => Object.entries(SPARK).map(([value, v]) => ({ value, label: v.label })) }] },
  { type: 'minimap', name: 'Minimapa', icon: 'map', group: 'Sistema', desc: 'Posición, rastro y ruta sobre el lugar.', size: { w: 3, h: 4, minW: 2, minH: 3 }, mount: mountMinimap },
  { type: 'controllers', name: 'Controladores', icon: 'toggle-right', group: 'Sistema', desc: 'Activar y desactivar controladores.', size: { w: 3, h: 4, minW: 2, minH: 3 }, mount: mountControllers },
  { type: 'diagnostics', name: 'Diagnóstico', icon: 'stethoscope', group: 'Sistema', desc: 'Lo que falla, primero.', size: { w: 3, h: 3, minW: 2, minH: 2 }, mount: mountDiagnostics },
  { type: 'ping', name: 'Ping', icon: 'radio', group: 'Sistema', desc: 'Latencia al robot.', size: { w: 2, h: 2, minW: 2, minH: 2 }, mount: mountPing },
  { type: 'imu', name: 'Calibración IMU', icon: 'compass', group: 'Sistema', desc: 'Estado y asistente de calibración.', size: { w: 2, h: 2, minW: 2, minH: 2 }, mount: mountImu },
  { type: 'terminal', name: 'Terminal', icon: 'terminal', group: 'Sistema', desc: 'Una shell en este ordenador o en el robot.', size: { w: 6, h: 5, minW: 3, minH: 3 }, mount: mountTerminal, forget: forgetTerminal,
    settings: [{ k: 'target', label: 'Dónde', options: () => [{ value: '', label: 'Este ordenador' }, { value: 'robot', label: 'El robot (ssh, solo robot real)' }] }] },
  { type: 'viz3d', name: 'Vista 3D', icon: 'box', group: 'Vídeo', desc: 'El robot, TF y marcadores en 3D, como la pestaña 3D.', size: { w: 6, h: 6, minW: 3, minH: 3 }, mount: mountViz3d },
  shortcut('go-mission', 'Misión', 'map-pinned', 'Mapa y waypoints', ({ show }) => show('mission')),
  shortcut('go-plots', 'Gráficas', 'chart-line', 'Cualquier topic', ({ show }) => show('plots')),
  shortcut('go-bt', 'Behaviour trees', 'git-fork', 'Editar y ejecutar', () => $('[data-go="bt"]')?.click()),
];
const BY_TYPE = new Map(WIDGETS.map((w) => [w.type, w]));
export const widgetDef = (type) => BY_TYPE.get(type);
export const WIDGET_TYPES = new Set(BY_TYPE.keys());

// plantillas: en celdas de 12 columnas; 12 filas llenan la pantalla
const W = (id, type, x, y, w, h, settings) => ({ id, type, x, y, w, h, ...(settings && { settings }) });
export const TEMPLATES = {
  classic: { name: 'Clásica', desc: 'Lo mismo que la vista fija', items: [
    W('arm', 'arm', 0, 0, 3, 4), W('modes', 'modes', 0, 4, 3, 6), W('pad', 'pad', 0, 10, 3, 2),
    W('camera', 'camera', 3, 0, 6, 10), W('speed', 'speed', 3, 10, 3, 2), W('safety', 'safety', 6, 10, 3, 2),
    W('battery', 'battery', 9, 0, 3, 3), W('heading', 'heading', 9, 3, 3, 4), W('depth', 'depth', 9, 7, 3, 5),
  ] },
  inspection: { name: 'Inspección', desc: 'Dos cámaras grandes e instrumentos debajo', items: [
    W('camera', 'camera', 0, 0, 6, 8), W('camera-2', 'camera', 6, 0, 6, 8),
    W('depth', 'depth', 0, 8, 2, 4), W('heading', 'heading', 2, 8, 3, 4), W('attitude', 'attitude', 5, 8, 3, 4),
    W('safety', 'safety', 8, 8, 4, 2), W('spark', 'spark', 8, 10, 4, 2, { what: 'depth' }),
  ] },
  minimal: { name: 'Mínima', desc: 'Cámara a pantalla completa y modos', items: [
    W('camera', 'camera', 0, 0, 9, 12), W('modes', 'modes', 9, 0, 3, 8), W('battery', 'battery', 9, 8, 3, 4),
  ] },
};
