// sura_view: arranque, navegación, asistente de robot, paso guiado y estado global.
import { BrowserJoy } from './joy.js';
import { MissionView } from './missionview.js';
import { Diagnostics, Dev, Telemetry } from './panels.js';
import { Pilot } from './pilot.js';
import { PlotView } from './plotview.js';
import { RosbridgeClient } from './rosbridge.js';
import { MODES, Sura } from './sura.js';
import { chooseMode, holdToArm, modeButtonsHtml, modeStatusText, paintModes, setDepthTarget, surface } from './pilotactions.js';
import { $, $$, errMsg, icons, replay, toast } from './ui.js';
import { BtView } from './btview.js';
import { ControllersView } from './controllers.js';
import { ImuCalibView } from './imucal.js';
import { esc, fmt, fresh, normalizeAddress } from './util.js';
import { Dashboard } from './dashboard.js';

const params = new URLSearchParams(location.search);
const wsUrl = params.get('ws') || `ws://${location.hostname || 'localhost'}:9090`;
const ros = new RosbridgeClient(wsUrl);
const sura = new Sura(ros);
const joy = new BrowserJoy(ros);
const mission = new MissionView(sura);
const pilot = new Pilot(sura, mission);
const bt = new BtView(sura);
const telem = new Telemetry(sura); // eslint-disable-line no-unused-vars
const diag = new Diagnostics(sura);
const ctl = new ControllersView(sura, ros);
const imu = new ImuCalibView(sura, ros);
const dashboard = new Dashboard({ sura, ros, pilot, mission, diag, imu, show: (v) => show(v), scene: () => scene });
const dev = new Dev(sura);
const plots = new PlotView(sura);
let scene = null;
import('./viz3d.js').then((m) => { scene = new m.Viz3D(sura, mission); if (ros.connected) scene.refreshTopics(); })
  .catch((e) => { $('#empty3d').innerHTML = `<b>La vista 3D no está disponible</b><span>${esc(errMsg(e))}</span>`; });

// ---------------- navegación ----------------
function moveInk() {
  const sel = $('.tab[aria-selected="true"]'), ink = $('#tabInk');
  if (!sel) { ink.style.width = '0'; return; }
  ink.style.left = `${sel.offsetLeft + 12}px`;
  ink.style.width = `${sel.offsetWidth - 24}px`;
}

function show(view) {
  if (view === 'ws') view = 'pilot';     // la antigua pestaña Personalizar es ahora «Mi panel» de Pilotar
  if (view !== 'setup' && !sura.robot) view = 'setup';
  for (const v of $$('.view')) v.classList.toggle('on', v.id === `v-${view}`);
  for (const t of $$('.tab')) t.setAttribute('aria-selected', t.dataset.view === view);
  // las vistas del menú marcan su pestaña «madre» para saber dónde estás
  const parent = { telem: 'diag', dev: 'diag' }[view];
  if (parent) $(`.tab[data-view="${parent}"]`).setAttribute('aria-selected', 'true');
  // tabindex itinerante: solo la pestaña activa entra en el orden de Tab; las flechas mueven entre ellas
  const tabs = $$('.tab'), cur = tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0];
  for (const t of tabs) t.tabIndex = t === cur ? 0 : -1;
  closeMenu();
  history.replaceState(null, '', `${location.search}#${view}`);
  moveInk();
  if (view === 'bt') bt.refresh();
  if (view === 'ctrl') ctl.shown();
  if (view === 'dev') { dev.refresh(); dev.renderLogs(); }
  if (view === '3d') scene?.refreshTopics();
  dashboard.setActive(view === 'pilot');
  if (view === 'mission') requestAnimationFrame(() => mission.draw());
  if (view === 'plots' && !plots.topics.length) plots.refresh();
}
for (const t of $$('.tab')) {
  t.id = `tab-${t.dataset.view}`;
  t.setAttribute('aria-controls', `v-${t.dataset.view}`);
  $(`#v-${t.dataset.view}`)?.setAttribute('aria-labelledby', t.id);
  t.addEventListener('click', () => show(t.dataset.view));
}
$('.tabs').addEventListener('keydown', (e) => {
  const tabs = $$('.tab'), i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (j === undefined) return;
  e.preventDefault();
  const t = tabs[(j + tabs.length) % tabs.length];
  show(t.dataset.view);
  t.focus();
});
document.addEventListener('click', (e) => { const g = e.target.closest('[data-go]'); if (g) show(g.dataset.go); });
// La barra se compacta por escalones hasta que las pestañas caben enteras.
function fitTopbar() {
  const bar = $('.topbar'), tabs = $('.tabs');
  const fits = () => tabs.scrollWidth <= tabs.clientWidth + 1;
  bar.classList.remove('c1', 'c2', 'c3', 'over');
  if (innerWidth > 860) {
    for (const c of ['c1', 'c2', 'c3']) {
      if (fits()) break;
      bar.classList.add(c);
    }
  }
  bar.classList.toggle('over', !fits());
  moveInk();
}
addEventListener('resize', fitTopbar);
new ResizeObserver(fitTopbar).observe($('.topbar .right'));
sura.addEventListener('robot', () => requestAnimationFrame(fitTopbar));
document.fonts?.ready.then(fitTopbar);

function closeMenu() { $('#menu').classList.remove('on'); $('#moreBtn').setAttribute('aria-expanded', 'false'); }
$('#moreBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#moreBtn').setAttribute('aria-expanded', $('#menu').classList.toggle('on'));
});
document.addEventListener('click', (e) => { if (!e.target.closest('#menu')) closeMenu(); });

function setSun(on) {
  if (on) document.documentElement.dataset.theme = 'sun'; else delete document.documentElement.dataset.theme;
  $('#themeBtn').setAttribute('aria-label', on ? 'Cambiar a modo grafito' : 'Cambiar a modo sol');
  try { localStorage.setItem('sura_view.sun', on ? '1' : ''); } catch { /* sin almacenamiento */ }
}
$('#themeBtn').addEventListener('click', () => setSun(document.documentElement.dataset.theme !== 'sun'));
try { if (localStorage.getItem('sura_view.sun')) setSun(true); } catch { /* idem */ }

// ---------------- conexión ----------------
ros.addEventListener('state', (e) => {
  const st = e.detail;
  $('#dotLink').className = `dot ${st === 'connected' ? 'ok live' : st === 'connecting' ? 'warn' : 'err'}`;
  $('#txtLink').textContent = st === 'connected' ? 'ok' : st === 'connecting' ? '…' : 'sin enlace';
  if (st === 'connected') {
    loadRobots();
    if ($('#v-bt').classList.contains('on')) bt.refresh();
    scene?.refreshTopics();
  }
  banner();
});
ros.connect();

function banner() {
  const b = $('#banner');
  if (ros.state !== 'connected') {
    b.hidden = false;
    b.className = 'banner err';
    b.innerHTML = `<i data-lucide="wifi-off"></i><span>Sin conexión con rosbridge en <b>${esc(wsUrl)}</b>. Lanza <code>ros2 launch sura_view sura_view.launch.py</code>. Reintentando…</span>`;
  } else if (!sura.serverAlive) {
    b.hidden = false;
    b.className = 'banner';
    b.innerHTML = '<i data-lucide="server-off"></i><span>rosbridge responde pero <b>sura_view_server</b> no. Sin él no se puede lanzar SURA ni elegir robot.</span>';
  } else {
    b.hidden = true;
  }
  icons();
}

// ---------------- ping visible ----------------
$('#pingBtn').addEventListener('click', async () => {
  $('#pingTxt').textContent = '…';
  const t0 = performance.now();
  try {
    await ros.callService('/rosapi/get_time', {}, { timeoutMs: 3000 });
    const rosMs = Math.round(performance.now() - t0);
    let robotTxt = '';
    if (sura.serverAlive && sura.robot) {
      const r = await sura.rpc('ping', {}, 6000);
      robotTxt = r.reachable ? ` · robot ${fmt(r.ms, 0)} ms` : ` · robot ${r.address} no responde`;
      $('#pingTxt').textContent = r.reachable ? `${Math.round(r.ms)} ms` : 'sin ping';
      toast(`ROS ${rosMs} ms${robotTxt}`, r.reachable ? 'ok' : 'warn', 'radio');
    } else {
      $('#pingTxt').textContent = `${rosMs} ms`;
      toast(`rosbridge responde en ${rosMs} ms`, 'ok', 'radio');
    }
  } catch (e) {
    $('#pingTxt').textContent = 'sin ping';
    toast(errMsg(e), 'err', 'radio');
  }
});

// ---------------- asistente de robot ----------------
let robots = [];
let picked = null;
let page = 0;
const RECENTS = 'sura_view.recents';
const recents = () => { try { return JSON.parse(localStorage.getItem(RECENTS) || '[]'); } catch { return []; } };

// Versión elegida de cada robot (un xacro de su *_description); por defecto, la que arranca SURA
const VARIANT = 'sura_view.variant.';
function withVariant(r) {
  if (!r) return r;
  let x = null;
  try { x = localStorage.getItem(VARIANT + r.name); } catch { /* sin almacenamiento */ }
  const v = (r.variants || []).find((k) => k.xacro === x) || (r.variants || []).find((k) => k.default);
  return v ? { ...r, xacro: v.xacro, variant: v } : r;
}

let loadingRobots = false;
async function loadRobots() {
  if (loadingRobots) return;
  loadingRobots = true;
  try {
    robots = await sura.rpc('robots.list', {}, 8000);
  } catch (e) {
    $('#robotsHint').textContent = errMsg(e);
    return;
  } finally {
    loadingRobots = false;
  }
  $('#robotsHint').textContent = robots.length ? 'Robots instalados en este workspace (paquetes *_description):' : 'No hay ningún *_description con config/bringup_description.yaml instalado.';
  if (!picked && robots.length) picked = withVariant(robots[0]);
  $('#robotTypes').innerHTML = robots.map((r, i) => `
    <label class="rrow"><input type="radio" name="robot" value="${i}" ${picked?.name === r.name ? 'checked' : ''}>
      <i data-lucide="${r.family === 'surface' ? 'ship' : 'waves'}"></i>
      <span><b>${esc(r.name)}</b><small>${esc(r.package)}${(r.variants || []).length > 1 ? ` · ${r.variants.length} versiones` : ''}</small></span>
      <span class="badge ${r.environment}">${r.environment === 'sim' ? 'Simulación' : 'Real'}</span></label>`).join('');
  for (const inp of $$('#robotTypes input')) inp.addEventListener('change', () => { picked = withVariant(robots[+inp.value]); showPreview(); });
  showPreview();
  renderRecents();
  adopt();
}

// Vista previa 3D del robot elegido (su URDF), en vez de una tarjeta con un dibujo
let preview = null;
function showPreview() {
  const p = picked;
  renderVariants();
  $('#robotInfo').innerHTML = p ? `<b>${esc(p.name)}</b><span>${p.family === 'surface' ? 'Superficie' : 'Submarino'} · ${Object.values(p.cameras || {}).filter((c) => c.enabled).length} cámaras${p.modem ? ' · módem' : ''}${p.localization ? ' · localización' : ''}</span>` : '';
  if (!preview) {
    import('./robotpreview.js').then((m) => { preview = preview || new m.RobotPreview($('#robotPreview'), $('#robotMsg')); preview.show(picked); })
      .catch((e) => { $('#robotMsg').textContent = `Sin vista 3D: ${errMsg(e)}`; });
  } else preview.show(p);
}

// Versiones del robot elegido: cambian el modelo 3D; SURA arranca la de su bringup_description.yaml
function renderVariants() {
  const p = picked, vs = p?.variants || [];
  $('#robotVariants').hidden = vs.length < 2;
  if (vs.length < 2) return;
  $('#variantSeg').innerHTML = vs.map((v) => `<button type="button" role="radio" aria-checked="${v.xacro === p.xacro}" data-x="${esc(v.xacro)}">${esc(v.label)}${v.default ? '<small>la que arranca SURA</small>' : ''}</button>`).join('');
  const def = vs.find((v) => v.default);
  $('#variantNote').hidden = !def || p.xacro === def.xacro;
  if (def) $('#variantNote').innerHTML = `SURA arrancará <b>${esc(def.label)}</b>: para lanzar esta versión, pon <code>description.xacro: ${esc(p.xacro)}</code> en <code>${esc(p.package)}/config/bringup_description.yaml</code>.`;
}
$('#variantSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-x]');
  if (!b || !picked) return;
  try { localStorage.setItem(VARIANT + picked.name, b.dataset.x); } catch { /* sin almacenamiento */ }
  picked = withVariant(robots.find((r) => r.name === picked.name));
  showPreview();
});

// Al recargar: si el servidor ya trabaja con un robot que usaste, se retoma donde estabas
const wanted = (location.hash || '#setup').slice(1);
function adopt() {
  const srv = sura.server;
  if (sura.robot || !srv || !robots.length || wanted === 'setup') return;
  const p = withVariant(robots.find((r) => r.name === srv.robot));
  if (!p || !recents().some((r) => r.name === p.name)) return;
  sura.useRobot(p, srv.environment);
  afterSelect(p, srv.environment, srv.address);
  show(wanted);
}
// el servidor puede arrancar después que rosbridge: se piden los robots en cuanto aparece
sura.addEventListener('server', () => { if (!robots.length) loadRobots(); else adopt(); });

function renderRecents() {
  const list = recents().filter((r) => robots.some((x) => x.name === r.name));
  $('#recentList').innerHTML = list.length ? list.map((r, i) => `
    <button class="hit" data-i="${i}"><i data-lucide="${r.env === 'sim' ? 'flask-conical' : 'radio'}"></i>
      <div><b>${esc(r.name)}</b><small>${r.env === 'sim' ? 'Simulación' : `Real · ${esc(r.address)}`} · ${new Date(r.t).toLocaleDateString()}</small></div>
      <i class="go" data-lucide="arrow-right"></i></button>`).join('') : '<p class="muted">Todavía no has usado ningún robot.</p>';
  for (const b of $$('#recentList button')) {
    b.addEventListener('click', () => { const r = list[+b.dataset.i]; connect(withVariant(robots.find((x) => x.name === r.name)), r.env, r.address); });
  }
  icons();
}

function setPage(p) {
  page = p;
  for (const w of $$('.wpage')) w.classList.toggle('on', +w.dataset.page === p);
  $$('#wsteps li').forEach((li, i) => { li.className = i < p ? 'done' : i === p ? 'on' : ''; });
  $('#wBack').disabled = p === 0;
  $('#wNext').innerHTML = p === 2 ? '<i data-lucide="plug-zap"></i>Conectar' : 'Siguiente<i data-lucide="arrow-right"></i>';
  if (p === 1 && picked) {
    for (const r of $$('input[name="env"]')) r.checked = r.value === picked.environment;
    $('#rosNet').textContent = `ws ${wsUrl.replace(/^ws:\/\//, '')}`;
  }
  if (p === 2 && picked) {
    const cams = Object.entries(picked.cameras || {});
    $('#components').innerHTML = [
      ...cams.map(([k, c]) => [k.replace('_', ' '), c.enabled, c.aruco ? 'con ArUco' : '']),
      ['Localización', picked.localization, ''], ['Módem acústico', picked.modem, ''],
      ['Mando del navegador', joy.connected, joy.connected ? joy.name : 'pulsa un botón del mando'],
    ].map(([n, on, note]) => `<label><i data-lucide="${on ? 'check' : 'minus'}"></i>${esc(n)}<small>${esc(note)}</small><span class="ro ${on ? 'yes' : ''}">${on ? 'Sí' : 'No'}</span></label>`).join('');
  }
  icons();
}
$('#wBack').addEventListener('click', () => setPage(page - 1));
$('#wNext').addEventListener('click', () => {
  if (page === 0 && !picked) { toast('Elige un robot', 'warn'); return; }
  if (page === 1) {
    const env = $('input[name="env"]:checked').value;
    const a = normalizeAddress($('#ip').value);
    const f = $('#fIp');
    f.classList.remove('bad');
    if (!a) { replay(f, 'bad'); return; }
    $('#ip').value = a;
    picked = { ...picked, chosenEnv: env };
  }
  if (page < 2) { setPage(page + 1); return; }
  connect(picked, picked.chosenEnv || picked.environment, $('#ip').value);
});
$('#newRobot').addEventListener('click', () => setPage(0));

async function connect(profile, env, address) {
  if (!profile) return;
  try {
    await sura.select(profile, { environment: env, address });
  } catch (e) {
    toast(errMsg(e), 'err');
    return;
  }
  afterSelect(profile, env, address);
  const list = recents().filter((r) => r.name !== profile.name);
  list.unshift({ name: profile.name, env, address, t: Date.now() });
  try { localStorage.setItem(RECENTS, JSON.stringify(list.slice(0, 5))); } catch { /* idem */ }
  show('pilot');
  toast(`Trabajando con ${profile.name} (${env === 'sim' ? 'simulación' : 'real'})`, 'ok', 'plug-zap');
}

function afterSelect(profile, env) {
  $('#robotName').textContent = profile.name;
  $('#robotType').textContent = profile.package;
  const sim = env === 'sim';
  $('#chipEnv').className = `chip ${sim ? 'sim' : 'real'}`;
  $('#chipEnvTxt').textContent = sim ? 'SIM' : 'REAL';
  $('#chipEnv').title = sim ? 'Simulación' : 'Robot real';
  checksDone = false;
  update();
}

// ---------------- paso guiado (cognitive walkthrough) ----------------
let checksDone = false;

function stage() {
  if (!sura.robot) return 'robot';
  const navOk = fresh(sura.navStamp, Date.now(), 3000);
  const proc = sura.server?.processes?.sura;
  if (!navOk) return proc?.running ? 'launching' : 'off';
  if (!checksDone) return 'checks';
  if (!sura.armed) return 'ready';
  return 'armed';
}

const STAGES = {
  robot: { n: 0, title: 'Conecta con un robot', text: 'Elige el robot con el que vas a trabajar.', btn: ['plug', 'Elegir robot', 'primary'] },
  off: { n: 0, title: 'Lanza la arquitectura SURA', text: 'No llegan datos de navegación del robot. Esto arranca controladores, sensores y localización.', btn: ['rocket', 'Lanzar SURA', 'primary'] },
  launching: { n: 0, title: 'Arrancando SURA…', text: 'Esperando los primeros datos de navigator/navigation.', btn: ['loader-circle', 'Arrancando…', ''], disabled: true },
  checks: { n: 1, title: 'Haz las comprobaciones', text: 'Antes de meterlo en el agua: fugas, batería, sensores y cámara, con sus valores reales.', btn: ['list-checks', 'Empezar comprobaciones', 'primary'] },
  ready: { n: 2, title: 'Arma el robot', text: 'Al armar, control_manager pasa a modo manual y los propulsores obedecen al mando. Comprueba que no hay nadie cerca.', btn: ['zap', 'Mantén pulsado para armar', 'go hold'] },
  armed: { n: 3, title: 'Pilota con el mando', text: 'Stick izquierdo: avanzar y girar. Derecho: subir y lateral. Mantén LT para que el robot haga misiones solo.', btn: ['route', 'Planificar una misión', ''] },
};
let lastStage = null;

function update() {
  const st = stage();
  const s = STAGES[st];
  if (st !== lastStage) {
    lastStage = st;
    $('#nextTitle').textContent = s.title;
    $('#nextText').textContent = s.text;
    const b = $('#nextBtn');
    b.className = `btn big ${s.btn[2]}`;
    b.disabled = !!s.disabled;
    b.innerHTML = `<i data-lucide="${s.btn[0]}"></i>${s.btn[1]}`;
    $$('#stepBar i').forEach((i, k) => { i.className = k < s.n ? 'done' : k === s.n ? 'now' : ''; });
    $('#stepBar').setAttribute('aria-label', `Paso ${s.n + 1} de 4`);
    replay($('#nextBox'), 'swap-in');
    icons();
  }
  let after = '';
  if (st === 'off') after = sura.serverAlive ? (sura.server?.environment === 'sim' && !sura.server?.sim_configured ? 'Arranca el simulador Stonefish aparte (sim_command está vacío).' : 'Tarda unos 20 segundos.') : 'Necesita sura_view_server.';
  if (st === 'launching') after = sura.logs.filter((l) => l.src === 'sura').slice(-1)[0]?.line?.slice(0, 90) || '';
  if (st === 'checks') after = sura.profile?.environment === 'sim' ? '<button class="linkbtn" id="skipChecks">Saltar en simulación</button>' : '';
  if (st === 'ready') after = 'Mantén pulsado 1 segundo.';
  if (st === 'armed') after = joy.connected ? `Mando: ${esc(joy.name)}` : 'No hay mando: conecta uno y pulsa un botón.';
  if ($('#nextAfter').dataset.v !== after) {
    $('#nextAfter').dataset.v = after;
    $('#nextAfter').innerHTML = after;
    $('#skipChecks')?.addEventListener('click', () => { checksDone = true; update(); });
  }
  topStatus();
}
setInterval(update, 500);
sura.addEventListener('server', () => { update(); banner(); });
sura.addEventListener('mode', () => { renderModes(); update(); });
sura.addEventListener('autonomous', () => topStatus());

// mantener pulsado para armar (anticipación); soltar antes cancela
const nb = $('#nextBtn');
holdToArm(nb, sura, () => stage() === 'ready');
nb.addEventListener('click', async () => {
  const st = stage();
  if (st === 'robot') show('setup');
  else if (st === 'off') {
    try { await sura.rpc('sura.start'); toast('Lanzando SURA…', 'ok', 'rocket'); } catch (e) { toast(errMsg(e), 'err'); }
  } else if (st === 'checks') openChecks();
  else if (st === 'armed') show('mission');
});

$('#disarmTop').addEventListener('click', async () => {
  try {
    await sura.setMode('EMERGENCY_STOP', 'desarmar desde sura_view');
    toast('Desarmado: control_manager en parada de emergencia', 'ok', 'octagon-x');
  } catch (e) { toast(`¡No se pudo desarmar! ${errMsg(e)}`, 'err'); }
});

// modos del mando: se marcan con lo que dice list_controllers, nunca antes
function buildModes() {
  $('#modes').innerHTML = modeButtonsHtml(sura.profile?.family);
}
function renderModes() {
  paintModes($('#modes'), sura);
  $('#modeNow').textContent = modeStatusText(sura);
  const depth = sura.ctrlMode === 'DEPTH';
  $('#depthSet').hidden = !depth;
  if (depth && document.activeElement !== $('#depthIn') && sura.nav) $('#depthIn').placeholder = fmt(sura.nav.position.position.z, 2);
}
$('#modes').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  await chooseMode(sura, b.dataset.mode);
});
$('#depthSet').addEventListener('submit', (e) => {
  e.preventDefault();
  if (setDepthTarget(sura, $('#depthIn').value)) $('#depthIn').value = '';
});
$('#surfaceBtn').addEventListener('click', () => surface(sura));
sura.addEventListener('robot', () => { buildModes(); renderModes(); });
buildModes();
renderModes();

// ---------------- estado de la barra superior ----------------
function topStatus() {
  const srv = sura.server, now = Date.now();
  const proc = srv?.processes?.sura;
  const navOk = fresh(sura.navStamp, now, 3000);
  $('#dotSura').className = `dot ${navOk ? 'ok' : proc?.running ? 'warn' : 'off'}`;
  $('#txtSura').textContent = navOk ? 'en marcha' : proc?.running ? 'arrancando' : 'detenida';
  const { warn, err, any } = diag.summary();
  const leak = sura.leak === true, wd = sura.watchdog?.state ?? 0;
  const bad = leak || err || wd === 2, meh = warn || wd === 1;
  $('#dotVeh').className = `dot ${bad ? 'err' : meh ? 'warn' : any ? 'ok' : 'off'}`;
  $('#txtVeh').textContent = leak ? '¡fuga!' : bad ? `${err || 1} error` : meh ? `${warn || 1} aviso` : any ? 'ok' : '—';
  const b = sura.battery;
  $('#chipBatTxt').textContent = b?.pct !== null && b?.pct !== undefined ? `${Math.round(b.pct)} %` : b ? `${fmt(b.voltage, 1)} V` : '—';
  $('#chipBat').classList.toggle('low', !!b && b.pct !== null && b.pct < 20);
  $('#disarmTop').disabled = !sura.robot || !ros.connected;
  const pad = joy.connected;
  joy.publishing = srv?.teleop === 'browser';
  $('#padDot').className = `dot ${pad && joy.publishing && joy.enabled ? 'ok live' : 'off'}`;
  $('#padTxt').innerHTML = !joy.publishing ? (srv?.teleop === 'joystick' ? 'Manda el mando físico (joy_node); aquí solo se cambia el modo' : 'La web no publica /joy')
    : pad ? `<b>${esc(joy.name)}</b> · ${joy.enabled ? 'publicando /joy' : 'en pausa'}` : 'Conecta un mando y pulsa un botón';
  const auto = sura.autonomous;
  $('#autoDot').className = `dot ${auto ? 'ok' : auto === false ? 'warn' : 'off'}`;
  $('#autoTxt').innerHTML = auto ? '<b>Autónomo</b> · el robot ejecuta acciones y misiones'
    : auto === false ? '<b>Manual</b> · mantén LT para ceder el control' : 'Control: sin datos de sura_teleop';
  const simNoPad = sura.profile?.environment === 'sim' && !pad && joy.publishing;
  $('#virtualBtn').hidden = !simNoPad;
  if (!simNoPad && joy.virtualDeadman) joy.setVirtualDeadman(false);
  $('#virtualBtn').setAttribute('aria-pressed', !!joy.virtualDeadman);
  const bag = srv?.processes?.bag?.running;
  $('#menuBagTxt').innerHTML = bag ? 'Parar rosbag<small>Grabando…</small>' : 'Grabar rosbag<small>Todos los topics</small>';
}
joy.addEventListener('change', () => { update(); toast(joy.connected ? `Mando conectado: ${joy.name}` : 'Mando desconectado', joy.connected ? 'ok' : 'warn', 'gamepad-2'); });
$('#virtualBtn').addEventListener('click', () => {
  if (sura.profile?.environment !== 'sim') return;
  joy.setVirtualDeadman(!joy.virtualDeadman);
  toast(joy.virtualDeadman ? 'Control cedido al robot (solo simulación)' : 'Control devuelto al teleop', 'ok', 'hand');
  update();
});
$('#padBox').addEventListener('click', () => { if (joy.connected && joy.publishing) { joy.enabled = !joy.enabled; update(); } });

// ---------------- comprobaciones con valores reales ----------------
const CHECKS = [
  ['leak', 'Sensores de fuga', () => sura.leak === null ? ['sin datos de sensors/leak', 'na'] : sura.leak ? ['¡FUGA detectada!', 'bad'] : ['secos', 'ok']],
  ['bat', 'Batería', () => { const b = sura.battery; if (!b) return ['sin datos de sensors/battery', 'na']; const p = b.pct; return [`${p !== null ? Math.round(p) + ' % · ' : ''}${fmt(b.voltage, 1)} V`, p === null ? 'na' : p > 30 ? 'ok' : 'bad']; }],
  ['nav', 'Navegación y profundidad', () => fresh(sura.navStamp) ? [`prof. ${fmt(sura.nav.position.position.z, 2)} m · alt. ${sura.nav.altitude > 0 ? fmt(sura.nav.altitude, 2) + ' m' : '—'}`, 'ok'] : ['sin navigator/navigation', 'bad']],
  ['head', 'Brújula e IMU', () => fresh(sura.navStamp) ? [`rumbo ${Math.round((sura.nav.rpy.z * 180 / Math.PI + 360) % 360)}° · gira el robot y comprueba que lo sigue`, 'ok'] : ['sin datos', 'na']],
  ['cam', 'Cámara', () => fresh(pilot.lastFrame, Date.now(), 3000) ? [`${pilot.camTopic}`, 'ok'] : ['no llegan imágenes', 'bad']],
  ['wd', 'Watchdog de seguridad', () => !sura.watchdog ? ['sin datos de safety/robot_watchdog', 'na'] : [sura.watchdog.state_name || ['OK', 'aviso', 'error'][sura.watchdog.state], sura.watchdog.state === 0 ? 'ok' : 'bad']],
];
const verdict = {};
let checksTimer;

function drawChecks() {
  $('#checks').innerHTML = CHECKS.map(([k, title, fn]) => {
    const [val, cls] = fn();
    const v = verdict[k];
    return `<div class="check ${v || ''}">
      <span class="ic">${v === 'pass' ? '<i data-lucide="check"></i>' : v === 'fail' ? '<i data-lucide="x"></i>' : ''}</span>
      <div><b>${title}</b><span class="val ${cls}">${esc(val)}</span></div>
      <div class="acts">${v ? `<button class="btn small ghost" data-undo="${k}">Cambiar</button>` : `<button class="btn small fail" data-fail="${k}" aria-label="${title}: fallo"><i data-lucide="x"></i></button><button class="btn small go" data-pass="${k}" aria-label="${title}: correcto"><i data-lucide="check"></i></button>`}</div></div>`;
  }).join('');
  $('#checksDone').disabled = CHECKS.some(([k]) => !verdict[k]);
  icons();
}
$('#checks').addEventListener('click', (e) => {
  const p = e.target.closest('[data-pass]'), f = e.target.closest('[data-fail]'), u = e.target.closest('[data-undo]');
  if (p) verdict[p.dataset.pass] = 'pass';
  if (f) verdict[f.dataset.fail] = 'fail';
  if (u) delete verdict[u.dataset.undo];
  if (p || f || u) drawChecks();
});
function openChecks() {
  closeMenu();
  drawChecks();
  clearInterval(checksTimer);
  checksTimer = setInterval(drawChecks, 1000);
  $('#sheet').classList.add('on');
  $('#scrim').classList.add('on');
}
function closeChecks() { clearInterval(checksTimer); $('#sheet').classList.remove('on'); $('#scrim').classList.remove('on'); }
$('#checksClose').addEventListener('click', closeChecks);
$('#scrim').addEventListener('click', closeChecks);
$('#menuChecks').addEventListener('click', openChecks);
$('#menuImu').addEventListener('click', () => { closeMenu(); imu.open(); });
$('#checksDone').addEventListener('click', () => {
  closeChecks();
  const fails = CHECKS.filter(([k]) => verdict[k] === 'fail').map(([, t]) => t);
  checksDone = true;
  update();
  toast(fails.length ? `Comprobaciones con fallos: ${fails.join(', ')}` : 'Todo correcto. Ya puedes armar.', fails.length ? 'warn' : 'ok');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeChecks(); closeMenu(); }
  if (e.target.matches('input, select, textarea, pre')) return;
  const views = ['pilot', 'ctrl', 'mission', '3d', 'plots', 'diag'];
  if (e.key >= '1' && e.key <= '6') show(views[+e.key - 1]);
  if (e.key === 'f' && $('#v-pilot').classList.contains('on')) $('#photoBtn').click();
});

// ---------------- menú: rosbag y perfil ----------------
$('#menuBag').addEventListener('click', async () => {
  closeMenu();
  const running = sura.server?.processes?.bag?.running;
  try {
    if (running) { await sura.rpc('bag.stop', {}, 20000); toast('rosbag guardado', 'ok', 'disc'); } else { const r = await sura.rpc('bag.start'); toast(`Grabando en ${r.path}`, 'ok', 'disc'); }
  } catch (e) { toast(errMsg(e), 'err'); }
});
$('#menuProfile').addEventListener('click', async () => {
  closeMenu();
  try {
    const r = await sura.rpc('profile.raw');
    $('#viewerTitle').textContent = r.path;
    $('#viewerText').textContent = r.text;
    $('#viewer').showModal();
  } catch (e) { toast(errMsg(e), 'err'); }
});
$('#viewerClose').addEventListener('click', () => $('#viewer').close());

// ---------------- arranque ----------------
icons();
setPage(0);
show((location.hash || '#setup').slice(1));
window.sura = { ros, sura, mission, pilot, bt, dev, plots, imu, dashboard, MODES, get preview() { return preview; } }; // para depurar desde la consola
