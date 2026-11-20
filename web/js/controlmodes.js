// Modos del mando de sura_teleop (modo AUV, R3). Son combinaciones de controladores que el
// teleop activa por el árbitro (controller/arbitrator/switch_controller, STRICT); aquí se
// usan las mismas listas para que la web y el mando digan lo mismo.

export const CTRL_MODES = {
  FORCE: { label: 'Fuerza', hint: 'el mando empuja', combo: 'RB+LB',
    on: ['body_force'], off: ['body_velocity', 'position_hold', 'stabilize', 'depth_hold'] },
  VELOCITY: { label: 'Velocidad', hint: 'el mando pide velocidad', combo: 'RB+X',
    on: ['body_force', 'body_velocity', 'depth_hold'], off: ['position_hold', 'stabilize'] },
  DEPTH: { label: 'Profundidad', hint: 'mantiene la profundidad', combo: 'RB+A', auv: true,
    on: ['body_force', 'depth_hold'], off: ['body_velocity', 'position_hold', 'stabilize'] },
  STABILIZE: { label: 'Estabilizar', hint: 'mantiene la actitud', combo: 'RB+Y', auv: true,
    on: ['body_force', 'stabilize'], off: ['body_velocity', 'position_hold', 'depth_hold'] },
  POSITION: { label: 'Posición', hint: 'se queda quieto', combo: 'RB+B',
    on: ['body_force', 'depth_hold', 'body_velocity', 'position_hold'], off: ['stabilize'] },
};

const AUV_ONLY = new Set(['depth_hold', 'stabilize']);

export function modesFor(family) {
  return Object.keys(CTRL_MODES).filter((k) => family !== 'surface' || !CTRL_MODES[k].auv);
}

// active: Set con los controladores en estado «active». Con STRICT no se puede activar lo
// que ya está activo ni desactivar lo que no lo está, así que se filtra.
export function switchPlan(mode, active, family) {
  const m = CTRL_MODES[mode];
  if (!m) throw new Error(`Modo desconocido: ${mode}`);
  const keep = (c) => family !== 'surface' || !AUV_ONLY.has(c);
  return {
    activate: m.on.filter(keep).filter((c) => !active.has(c)),
    deactivate: m.off.filter(keep).filter((c) => active.has(c)),
  };
}

// El modo que se ve con un conjunto de controladores activos (el más específico gana).
export function modeFromActive(active) {
  if (active.has('position_hold')) return 'POSITION';
  if (active.has('stabilize')) return 'STABILIZE';
  if (active.has('body_velocity')) return 'VELOCITY';
  if (active.has('depth_hold')) return 'DEPTH';
  if (active.has('body_force')) return 'FORCE';
  return null;
}

// Activar o desactivar un controlador suelto (panel Controladores). list: los ControllerState de
// list_controllers. En modo encadenado, chain_connections dice a qué controladores manda un
// controlador: para activarlo tienen que estar activos esos, y para desactivar uno hay que
// desactivar antes los activos que le mandan. Devuelve las listas para un switch STRICT.
export function togglePlan(name, on, list) {
  const byName = new Map(list.map((c) => [c.name, c]));
  const active = new Set(list.filter((c) => c.state === 'active').map((c) => c.name));
  const targets = (c) => (c?.chain_connections || []).map((k) => k.name);
  const out = [];
  const seen = new Set();
  const walk = (n, next) => {
    if (seen.has(n)) return;
    seen.add(n);
    if (on ? active.has(n) : !active.has(n)) return;
    out.push(n);
    for (const m of next(n)) walk(m, next);
  };
  if (on) walk(name, (n) => targets(byName.get(n)));
  else walk(name, (n) => list.filter((c) => targets(c).includes(n)).map((c) => c.name));
  return on ? { activate: out.reverse(), deactivate: [] } : { activate: [], deactivate: out };
}
