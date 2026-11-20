// Calibración de la IMU: aviso si no está calibrada y asistente paso a paso.
// El trabajo lo hace calibration_wizard de sura_imu en sura_view_server (imu.calib.*);
// aquí se enseña qué hacer con el robot (su modelo 3D haciendo el movimiento), cuánto
// falta y el resultado. El estado llega por /sura_view/imu_calib y en /sura_view/state.
import { $, errMsg, icons, toast } from './ui.js';
import { esc } from './util.js';

// ---------- lógica sin DOM (tests en test/imucal.test.mjs) ----------
export const DUR = { gyro: 8, mag: 35, compass: 4 };
export const DIRS = ['North', 'East', 'South', 'West'];
const DIR_ES = { North: 'Norte', East: 'Este', South: 'Sur', West: 'Oeste' };
const TOTAL = DUR.gyro + DUR.mag + DUR.compass * DIRS.length;
export const QUALITY = { excellent: 'excelente', good: 'buena', fair: 'regular', poor: 'mala' };

// Tres giros de 360° durante la captura del magnetómetro, uno tras otro
export const MAG_MOVES = [
  { axis: 'yaw', title: 'Una vuelta completa en horizontal', text: 'Gira el robot 360° sobre sí mismo, despacio, como una peonza.' },
  { axis: 'roll', title: 'Ahora de lado', text: 'Túmbalo sobre un costado y dale otra vuelta de 360°.' },
  { axis: 'pitch', title: 'Ahora de morro', text: 'Ponlo de morro (proa abajo) y dale otra vuelta de 360°.' },
];
export const magMove = (fraction) => MAG_MOVES[Math.min(MAG_MOVES.length - 1, Math.floor(Math.max(0, fraction) * MAG_MOVES.length))];

// segundos de captura de la fase actual que ya han pasado (0 si no está capturando)
export function captureElapsed(st, nowS) {
  if (st?.capturing_since == null) return 0;
  return Math.min(st.duration || 0, Math.max(0, nowS - st.capturing_since));
}

// fracción 0..1 de toda la calibración: capturas ya hechas más lo que lleva la actual
export function overallProgress(st, nowS) {
  if (!st) return 0;
  if (st.phase === 'done') return 1;
  const r = st.results || {};
  let done = (r.gyro ? DUR.gyro : 0) + (r.magnetometer ? DUR.mag : 0) + (st.directions || []).length * DUR.compass;
  const busy = st.capturing_since != null && !(st.phase === 'gyro' && r.gyro) && !(st.phase === 'mag' && r.magnetometer);
  if (busy) done += captureElapsed(st, nowS);
  return Math.min(1, done / TOTAL);
}

// Qué decirle al operario en cada momento: { title, text, action }
export function instruction(st, nowS) {
  const phase = st?.phase || 'idle';
  const awaiting = !!st?.awaiting, capturing = st?.capturing_since != null;
  if (phase === 'idle' || phase === 'starting' || phase === 'waiting_data') {
    return { title: 'Esperando datos de la IMU…', text: 'La IMU y el magnetómetro los publica SURA: tiene que estar en marcha.' };
  }
  if (phase === 'gyro') {
    if (awaiting) return { title: 'Deja el robot quieto', text: 'Apóyalo en una superficie firme, sin vibraciones, y no lo toques. Pulsa «Empezar» cuando esté quieto.', action: 'Empezar' };
    const left = Math.ceil(DUR.gyro - captureElapsed(st, nowS));
    return { title: 'No lo muevas', text: capturing ? `Midiendo el giróscopo en reposo · quedan ${left} s` : 'Calculando…' };
  }
  if (phase === 'mag') {
    if (awaiting) return { title: 'Gira el robot en todas las direcciones', text: 'Aléjalo de metales. Durante 35 s: una vuelta de 360° en horizontal, otra de lado y otra de morro. Pulsa «Empezar» y sigue el dibujo.', action: 'Empezar' };
    if (!capturing) return { title: 'Calculando…', text: '' };
    const el = captureElapsed(st, nowS), mv = magMove(el / DUR.mag);
    return { title: mv.title, text: `${mv.text} Quedan ${Math.ceil(DUR.mag - el)} s.` };
  }
  if (phase === 'compass') {
    const i = DIRS.indexOf(st.step), to = DIR_ES[st.step] || st.step, deg = st.target_deg ?? 0;
    if (awaiting) {
      const title = i <= 0 ? `Apunta el morro al ${to} (${deg}°)` : `Gira el robot 90° a la derecha, hacia el ${to}`;
      const text = i <= 0 ? 'Usa una brújula o una referencia conocida. Con el robot quieto y apuntando, pulsa «Empezar».'
        : `Debe quedar apuntando al ${to} (${deg}°). Quieto y apuntando, pulsa «Empezar».`;
      return { title, text, action: 'Empezar' };
    }
    const left = Math.ceil(DUR.compass - captureElapsed(st, nowS));
    return { title: `Quieto apuntando al ${to}`, text: capturing ? `Midiendo el rumbo · quedan ${left} s` : 'Calculando…' };
  }
  if (phase === 'done') return { title: 'IMU calibrada', text: '' };
  if (phase === 'cancelled') return { title: 'Calibración cancelada', text: 'No se ha guardado nada.' };
  if (phase === 'error') return { title: 'No se pudo calibrar', text: st.error || '' };
  return { title: '', text: '' };
}

// ---------- vista ----------

const STEPS = [['gyro', 'Giróscopo'], ['mag', 'Magnetómetro'], ['compass', 'Brújula']];
const PART_ES = { gyro: 'Giróscopo', magnetometer: 'Magnetómetro', compass: 'Brújula' };

export class ImuCalibView {
  constructor(sura, ros) {
    this.sura = sura;
    this.ros = ros;
    this.st = null;
    this.asked = new Set();   // robots a los que ya se les preguntó en esta sesión
    ros.subscribe('/sura_view/imu_calib', 'std_msgs/msg/String', (m) => this.update(JSON.parse(m.data)));
    sura.addEventListener('server', () => {
      const st = sura.server?.imucal;
      if (st && (!this.st || st.t > this.st.t)) this.update(st);
      this.maybeAsk();
    });
    sura.addEventListener('robot', () => this.maybeAsk());
    $('#imuNext').addEventListener('click', () => this.next());
    $('#imuCancel').addEventListener('click', () => this.cancel());
    $('#imuClose').addEventListener('click', () => this.close());
    $('#imuAskGo').addEventListener('click', () => { this.hideAsk(); this.open(); });
    $('#imuAskLater').addEventListener('click', () => this.hideAsk());
    $('#imuRetry').addEventListener('click', () => this.start());
    $('#imuDlg').addEventListener('cancel', (e) => { if (this.st?.running) e.preventDefault(); });
    setInterval(() => { if ($('#imuDlg').open) this.render(); }, 250);
  }

  // Con SURA en marcha, se mira una vez por robot y sesión si la IMU está calibrada
  async maybeAsk() {
    const s = this.sura, robot = s.robot;
    if (!robot || this.asked.has(robot) || !s.server?.processes?.sura?.running || this.st?.running) return;
    try { if (sessionStorage.getItem(`sura_view.imu_ask.${robot}`)) return; } catch { /* sin almacenamiento */ }
    this.asked.add(robot);
    let st;
    try { st = await s.rpc('imu.calib.status', {}, 20000); } catch { return; }
    if (st.calibrated) return;
    $('#imuAskWhy').innerHTML = st.reasons.map((r) => `<li>${esc(r)}</li>`).join('')
      + (st.applies ? '' : '<li class="muted">En simulación SURA no aplica esta calibración, pero puedes practicar el proceso.</li>');
    $('#imuAsk').hidden = false;
    icons();
  }

  hideAsk() {
    $('#imuAsk').hidden = true;
    try { sessionStorage.setItem(`sura_view.imu_ask.${this.sura.robot}`, '1'); } catch { /* idem */ }
  }

  async open() {
    if (!this.sura.robot) { toast('Elige un robot primero', 'warn'); return; }
    $('#imuDlg').showModal();
    this.loadModel();
    if (this.st?.running) { this.render(); return; }
    this.start();
  }

  async start() {
    if (!this.sura.server?.processes?.sura?.running) toast('SURA no está en marcha: el asistente esperará los datos de la IMU 12 s', 'warn', 'info');
    try { this.update(await this.sura.rpc('imu.calib.start', {}, 10000)); } catch (e) { this.update({ phase: 'error', error: errMsg(e), running: false, t: Date.now() / 1000 }); }
  }

  close() {
    if (this.st?.running) return;
    $('#imuDlg').close();
    this.anim?.stop();
  }

  async next() {
    $('#imuNext').disabled = true;
    try { this.update(await this.sura.rpc('imu.calib.next', {}, 5000)); } catch (e) { toast(errMsg(e), 'err'); }
  }

  async cancel() {
    if (!this.st?.running) { this.close(); return; }
    try { this.update(await this.sura.rpc('imu.calib.cancel', {}, 8000)); } catch (e) { toast(errMsg(e), 'err'); }
  }

  update(st) {
    this.st = st;
    this.sura.emit('imucal', st);     // para el widget de calibración del panel de Pilotar
    if (st.phase === 'done' && this.lastPhase !== 'done') {
      toast('IMU calibrada y guardada', 'ok', 'compass');
      try { sessionStorage.setItem(`sura_view.imu_ask.${this.sura.robot}`, '1'); } catch { /* idem */ }
    }
    this.lastPhase = st.phase;
    if ($('#imuDlg').open) this.render();
  }

  render() {
    const st = this.st || {}, now = Date.now() / 1000;
    const ins = instruction(st, now);
    $('#imuTitle').textContent = ins.title;
    $('#imuText').textContent = ins.text;
    // pasos y progreso total
    const order = STEPS.map(([k]) => k), cur = order.indexOf(st.phase);
    $('#imuSteps').innerHTML = STEPS.map(([k, label], i) => {
      const done = st.phase === 'done' || (cur > i) || (k === 'gyro' && st.results?.gyro) || (k === 'mag' && st.results?.magnetometer);
      return `<li class="${done ? 'done' : cur === i ? 'now' : ''}"><i></i>${i + 1} · ${label}</li>`;
    }).join('');
    const total = overallProgress(st, now);
    $('#imuBar').style.width = `${(total * 100).toFixed(1)}%`;
    $('#imuPct').textContent = `${Math.round(total * 100)} %`;
    $('#imuProg').setAttribute('aria-valuenow', Math.round(total * 100));
    // progreso de la captura actual
    const dur = st.duration || 0, el = captureElapsed(st, now);
    $('#imuPhaseBar').style.width = st.capturing_since != null && dur ? `${(el / dur * 100).toFixed(1)}%` : '0%';
    $('#imuPhase').hidden = st.capturing_since == null;
    // octantes del magnetómetro y direcciones de la brújula
    $('#imuOct').hidden = st.phase !== 'mag';
    $('#imuOct').innerHTML = `<span>Orientaciones cubiertas</span>${Array.from({ length: 8 }, (_, i) => `<i class="${i < (st.octants || 0) ? 'on' : ''}"></i>`).join('')}<b>${st.octants || 0}/8</b>`;
    $('#imuDirs').hidden = st.phase !== 'compass';
    const doneDirs = new Set((st.directions || []).map((d) => d.name));
    $('#imuDirs').innerHTML = DIRS.map((d) => `<span class="${doneDirs.has(d) ? 'done' : d === st.step ? 'now' : ''}">${DIR_ES[d][0]}</span>`).join('');
    // resultado
    const r = st.results || {};
    $('#imuResult').hidden = st.phase !== 'done';
    if (st.phase === 'done') {
      $('#imuResult').innerHTML = Object.entries(PART_ES).map(([k, name]) => r[k]
        ? `<div class="q ${r[k].label}"><span>${name}</span><b>${QUALITY[r[k].label] || r[k].label}</b><small>${Math.round(r[k].score)}/100</small></div>` : '').join('')
        + `<p class="hint-sm">${this.sura.server?.environment === 'real' ? 'Se aplica la próxima vez que lances SURA.' : 'Guardada. En simulación SURA no la aplica.'}${r.magnetometer?.label === 'poor' ? ' El magnetómetro ha salido mal: repítelo lejos de metales y girándolo más.' : ''}</p>`;
    }
    // botones
    const running = !!st.running;
    $('#imuNext').hidden = !ins.action;
    $('#imuNext').disabled = !st.awaiting;
    $('#imuCancel').hidden = !running;
    $('#imuClose').hidden = running;
    $('#imuClose').textContent = st.phase === 'error' || st.phase === 'cancelled' ? 'Cerrar' : 'Hecho';
    $('#imuRetry').hidden = !(st.phase === 'error' || st.phase === 'cancelled' || (st.phase === 'done' && r.magnetometer?.label === 'poor'));
    this.anim?.set(st, now);
  }

  async loadModel() {
    if (this.anim && this.anim.robotName === this.sura.robot) { this.anim.start(); return; }
    this.anim?.dispose();
    try {
      const m = await import('./imuanim.js');
      this.anim = new m.ImuAnim($('#imuStage'), this.sura.profile);
      this.anim.start();
    } catch (e) {
      $('#imuStage').classList.add('noanim');
    }
  }
}
