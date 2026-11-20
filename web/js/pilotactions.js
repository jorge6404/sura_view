// Acciones de pilotaje compartidas por la vista clásica de Pilotar y los widgets del panel:
// armar, modos del mando, consigna de profundidad y emerger. Los modos se marcan con lo que dice
// list_controllers, nunca antes (sura.ctrlMode / sura.ctrlPending).
import { CTRL_MODES, modesFor } from './controlmodes.js';
import { errMsg, toast } from './ui.js';
import { fmt, parseNum } from './util.js';

let armMode = 'FORCE';      // el modo con el que se arma (se elige antes de armar)
export const getArmMode = () => armMode;

const label = (m) => CTRL_MODES[m].label.toLowerCase();

export function modeButtonsHtml(family) {
  return modesFor(family).map((k) => {
    const m = CTRL_MODES[k];
    return `<button data-mode="${k}" aria-pressed="false" title="En el mando: ${m.combo}">${m.label}<small>${m.hint}</small><kbd>${m.combo}</kbd></button>`;
  }).join('');
}

export function paintModes(container, sura) {
  for (const b of container.querySelectorAll('button[data-mode]')) {
    b.setAttribute('aria-pressed', b.dataset.mode === sura.ctrlMode);
    b.classList.toggle('pending', b.dataset.mode === sura.ctrlPending);
  }
}

export function modeStatusText(sura) {
  if (sura.ctrlPending) return `enviando ${label(sura.ctrlPending)}…`;
  if (sura.ctrlMode) return `activo: ${label(sura.ctrlMode)}`;
  return sura.controllers ? 'desarmado' : 'sin datos';
}

export async function chooseMode(sura, mode) {
  if (!sura.armed) { armMode = mode; toast(`Al armar se usará el modo ${label(mode)}`, 'ok', 'info'); return; }
  try { await sura.setCtrlMode(mode); toast(`Modo ${label(mode)}: confirmado por el robot`, 'ok'); } catch (err) { toast(errMsg(err), 'err'); }
}

export async function arm(sura) {
  try {
    // armar = MANUAL en control_manager (body_force); luego el modo del mando elegido
    await sura.setMode('MANUAL', 'armar desde sura_view');
    if (armMode !== 'FORCE') await sura.setCtrlMode(armMode);
    else await sura.pollControllers();
    toast(`Armado en modo ${label(armMode)}: confirmado por el robot`, 'ok', 'zap');
  } catch (err) { toast(`No se pudo armar: ${errMsg(err)}`, 'err'); }
}

// devuelve true si se mandó la consigna
export function setDepthTarget(sura, text) {
  const z = parseNum(text);
  if (z === null || z < 0) { toast('Escribe una profundidad en metros (0 o más)', 'err'); return false; }
  if (!sura.setDepth(z)) { toast('Sin conexión con rosbridge', 'err'); return false; }
  sura.depthTarget = z;      // lo dibuja la cinta de profundidad del panel
  toast(`Consigna de profundidad: ${fmt(z, 2)} m`, 'ok', 'arrow-down-to-line');
  return true;
}

export async function surface(sura) {
  try { await sura.setMode('SURFACE', 'emerger desde sura_view'); toast('Emergiendo: confirmado por el robot', 'ok'); } catch (err) { toast(errMsg(err), 'err'); }
}

// mantener pulsado `ms` para armar; soltar antes cancela. canArm() decide si el botón arma ahora
export function holdToArm(button, sura, canArm, ms = 900) {
  let t;
  const start = (e) => {
    if (!canArm()) return;
    e.preventDefault();
    button.classList.add('charging');
    t = setTimeout(() => { button.classList.remove('charging'); arm(sura); }, ms);
  };
  const end = () => {
    if (!button.classList.contains('charging')) return;
    clearTimeout(t);
    button.classList.remove('charging');
    toast('Mantén pulsado un segundo para armar', 'warn', 'hand');
  };
  button.addEventListener('pointerdown', start);
  for (const ev of ['pointerup', 'pointerleave']) button.addEventListener(ev, end);
  button.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) start(e); });
  button.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') end(); });
}
