// Estado del robot y del servidor sura_view, a partir de topics reales.
// Nada se marca como hecho si el robot no lo ha confirmado: los modos solo cambian con la
// respuesta de set_mode y las misiones con el resultado de la acción.

import { CTRL_MODES, modeFromActive, switchPlan, togglePlan } from './controlmodes.js';
import { batteryPercent } from './util.js';

export const MODES = { MANUAL: 0, FOLLOW_PATH: 1, SURFACE: 2, HOLD_POSITION: 3, EMERGENCY_STOP: 4, BODY_VELOCITY: 5 };
export const LIFECYCLE = {
  go_to_depth: 'go_to_depth_lifecycle_action_node',
  go_to_pose: 'go_to_pose_lifecycle_action_node',
  follow_path: 'path_manager_lifecycle_node',
  go_to_pose_usv: 'go_to_pose_usv_lifecycle_action_node',
  follow_path_usv: 'path_follower_usv_lifecycle_node',
};
export const MODE_NAMES = Object.fromEntries(Object.entries(MODES).map(([k, v]) => [v, k]));

export class Sura extends EventTarget {
  constructor(ros) {
    super();
    this.ros = ros;
    this.robot = null;          // nombre (namespace)
    this.profile = null;        // resumen de bringup_description.yaml
    this.server = null;         // último /sura_view/state
    this.serverStamp = null;
    this.nav = null; this.navStamp = null;
    this.battery = null; this.batteryStamp = null;
    this.leak = null; this.leakStamp = null;
    this.watchdog = null;
    this.diag = new Map();      // name -> DiagnosticStatus
    this.diagStamp = null;
    this.mode = null;           // último modo CONFIRMADO por control_manager
    this.modePending = null;
    this.controllers = null;    // Set de controladores activos (list_controllers), null = sin leer
    this.ctrlMode = null;       // modo del mando que se deduce de los controladores
    this.ctrlPending = null;
    this.logs = [];
    this.unsubs = [];
    this.rpcWait = new Map();
    this.rpcSeq = 0;

    ros.advertise('/sura_view/cmd', 'std_msgs/msg/String');
    ros.subscribe('/sura_view/reply', 'std_msgs/msg/String', (m) => this.onReply(m));
    ros.subscribe('/sura_view/state', 'std_msgs/msg/String', (m) => {
      this.server = JSON.parse(m.data);
      this.serverStamp = Date.now();
      this.emit('server');
    });
    ros.subscribe('/sura_view/log', 'std_msgs/msg/String', (m) => this.pushLog(JSON.parse(m.data)));
    ros.subscribe('/rosout', 'rcl_interfaces/msg/Log', (m) => this.pushLog({
      src: m.name, line: m.msg, level: m.level, t: m.stamp.sec + m.stamp.nanosec * 1e-9,
    }), { throttle_rate: 0, queue_length: 50 });
    ros.subscribe('/diagnostics_agg', 'diagnostic_msgs/msg/DiagnosticArray', (m) => {
      for (const s of m.status) this.diag.set(s.name, s);
      this.diagStamp = Date.now();
      this.emit('diag');
    }, { throttle_rate: 1000 });
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  ns(rel) { return `/${this.robot}/${rel}`; }

  pushLog(entry) {
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.shift();
    this.emit('log', entry);
  }

  // ---------- RPC con sura_view_server ----------
  rpc(op, args = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      this.rpcSeq += 1;
      const id = `${Date.now().toString(36)}-${this.rpcSeq}`;
      const ok = this.ros.publish('/sura_view/cmd', { data: JSON.stringify({ id, op, args }) });
      if (!ok) { reject(new Error('Sin conexión con rosbridge')); return; }
      const timer = setTimeout(() => {
        this.rpcWait.delete(id);
        reject(new Error('sura_view_server no responde. ¿Está lanzado sura_view.launch.py?'));
      }, timeoutMs);
      this.rpcWait.set(id, { resolve, reject, timer });
    });
  }

  onReply(m) {
    let r;
    try { r = JSON.parse(m.data); } catch { return; }
    const w = this.rpcWait.get(r.id);
    if (!w) return;
    this.rpcWait.delete(r.id);
    clearTimeout(w.timer);
    if (r.ok) w.resolve(r.data); else w.reject(new Error(r.error));
  }

  get serverAlive() { return this.serverStamp !== null && Date.now() - this.serverStamp < 3500; }

  // ---------- robot ----------
  async select(profile, { environment, address } = {}) {
    await this.rpc('robot.select', { name: profile.name, environment: environment || profile.environment, address });
    this.useRobot(profile, environment);
  }

  useRobot(profile, environment) {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.robot = profile.name;
    this.profile = { ...profile, environment: environment || profile.environment };
    this.nav = this.battery = this.leak = this.watchdog = this.pressure = this.autonomous = null;
    this.navStamp = this.batteryStamp = this.leakStamp = null;
    this.mode = null;
    this.controllers = this.ctrlMode = null;
    clearInterval(this.ctrlTimer);
    this.ctrlTimer = setInterval(() => this.pollControllers(), 1000);
    this.unsubs.push(() => clearInterval(this.ctrlTimer));
    const sub = (rel, type, fn, opts) => this.unsubs.push(this.ros.subscribe(this.ns(rel), type, fn, opts));
    sub('navigator/navigation', 'sura_msgs/msg/Navigator', (m) => {
      this.nav = m; this.navStamp = Date.now(); this.emit('nav', m);
    }, { throttle_rate: 100, queue_length: 1 });
    sub('sensors/battery', 'sensor_msgs/msg/BatteryState', (m) => {
      this.battery = { pct: batteryPercent(m), voltage: m.voltage, current: m.current };
      this.batteryStamp = Date.now(); this.emit('battery', this.battery);
    }, { throttle_rate: 500 });
    // leak_broadcaster (ros2_control) publica std_msgs/Bool
    sub('sensors/leak', 'std_msgs/msg/Bool', (m) => {
      this.leak = !!(m.data ?? m.leak_detected); this.leakStamp = Date.now(); this.emit('leak', this.leak);
    }, { throttle_rate: 500 });
    sub('sensors/pressure', 'sensor_msgs/msg/FluidPressure', (m) => {
      this.pressure = m.fluid_pressure; this.emit('pressure', this.pressure);
    }, { throttle_rate: 500 });
    sub('teleop/autonomous_enabled', 'std_msgs/msg/Bool', (m) => {
      this.autonomous = !!m.data; this.autonomousStamp = Date.now(); this.emit('autonomous', this.autonomous);
    });
    sub('safety/robot_watchdog', 'sura_msgs/msg/RobotWatchdog', (m) => {
      this.watchdog = m; this.emit('watchdog', m);
    }, { throttle_rate: 1000 });
    this.emit('robot', this.profile);
  }

  // ---------- modos (sura_actions/srv/SetControlMode) ----------
  async setMode(name, reason = 'sura_view') {
    this.modePending = name;
    this.emit('mode');
    try {
      const r = await this.ros.callService(this.ns('control_manager/set_mode'),
        { mode: MODES[name], reason }, { type: 'sura_actions/srv/SetControlMode' });
      if (!r.success) throw new Error(r.message || 'control_manager rechazó el modo');
      this.mode = MODE_NAMES[r.active_mode] ?? name;
      return r;
    } finally {
      this.modePending = null;
      this.emit('mode');
    }
  }

  get armed() {
    if (this.controllers) return this.controllers.has('body_force');
    return this.mode !== null && this.mode !== 'EMERGENCY_STOP';
  }

  // ---------- modos del mando (controladores por el árbitro, como sura_teleop) ----------
  async pollControllers() {
    if (!this.robot || !this.ros.connected || this.ctrlPolling) return;
    // sin SURA en marcha no hay controller_manager: no llenar rosbridge de timeouts
    const up = this.server?.processes?.sura?.running || (this.navStamp && Date.now() - this.navStamp < 5000);
    if (!up && !this.controllers) return;
    this.ctrlPolling = true;
    try {
      const r = await this.ros.callService(this.ns('controller/controller_manager/list_controllers'), {},
        { type: 'controller_manager_msgs/srv/ListControllers', timeoutMs: 3000 });
      const active = new Set(r.controller.filter((c) => c.state === 'active').map((c) => c.name));
      const listKey = r.controller.map((c) => `${c.name}:${c.state}`).sort().join();
      if (listKey !== this.ctrlListKey) { this.ctrlListKey = listKey; this.ctrlList = r.controller; this.emit('controllers'); }
      const key = [...active].sort().join();
      if (key !== this.ctrlKey || !this.controllers) {
        this.ctrlKey = key;
        this.controllers = active;
        this.ctrlMode = modeFromActive(active);
        this.emit('mode');
      }
    } catch {
      if (this.controllers) { this.controllers = this.ctrlMode = null; this.ctrlKey = null; this.emit('mode'); }
      if (this.ctrlList) { this.ctrlList = this.ctrlListKey = null; this.emit('controllers'); }
    } finally {
      this.ctrlPolling = false;
    }
  }

  async setCtrlMode(mode) {
    // la lista tiene que ser de ahora: con STRICT, activar algo ya activo aborta el cambio
    while (this.ctrlPolling) await new Promise((r) => setTimeout(r, 50));
    this.ctrlKey = null;
    await this.pollControllers();
    if (!this.controllers) throw new Error('No se pueden leer los controladores del robot');
    const plan = switchPlan(mode, this.controllers, this.profile?.family);
    this.ctrlPending = mode;
    this.emit('mode');
    try {
      if (plan.activate.length || plan.deactivate.length) {
        const r = await this.ros.callService(this.ns('controller/arbitrator/switch_controller'), {
          activate_controllers: plan.activate, deactivate_controllers: plan.deactivate,
          strictness: 2, activate_asap: true, timeout: { sec: 2, nanosec: 0 },
        }, { type: 'controller_manager_msgs/srv/SwitchController', timeoutMs: 6000 });
        if (!r.ok) throw new Error(`El árbitro no pudo cambiar a ${CTRL_MODES[mode].label.toLowerCase()}`);
      }
      this.ctrlKey = null;
      await this.pollControllers();
      if (this.ctrlMode !== mode) throw new Error(`El robot no confirmó el modo ${CTRL_MODES[mode].label.toLowerCase()}`);
    } finally {
      this.ctrlPending = null;
      this.emit('mode');
    }
  }

  // Panel Controladores: uno suelto, con los encadenados que haga falta (togglePlan). Va por el
  // árbitro, que respeta los bloqueos de seguridad; los robots sin árbitro (BlueBoat) van directos
  // al controller_manager, como su sura_teleop. Devuelve los nombres que cambió.
  async toggleController(name, on) {
    while (this.ctrlPolling) await new Promise((r) => setTimeout(r, 50));
    this.ctrlKey = null;
    await this.pollControllers();
    if (!this.ctrlList) throw new Error('No se pueden leer los controladores del robot');
    const plan = togglePlan(name, on, this.ctrlList);
    const names = [...plan.activate, ...plan.deactivate];
    if (!names.length) return names;
    const args = { ...plan, strictness: 2, activate_asap: true, timeout: { sec: 2, nanosec: 0 } };
    const type = 'controller_manager_msgs/srv/SwitchController';
    let r;
    try {
      r = await this.ros.callService(this.ns('controller/arbitrator/switch_controller'), args, { type, timeoutMs: 6000 });
    } catch (e) {
      // solo si no hay árbitro: si está y no responde, saltárselo quitaría los bloqueos
      if (!/does not exist|no existe/i.test(e.message)) throw e;
      r = await this.ros.callService(this.ns('controller/controller_manager/switch_controller'), args, { type, timeoutMs: 6000 });
    }
    this.ctrlKey = null;
    await this.pollControllers();
    if (!r.ok) throw new Error(`No se pudo ${on ? 'activar' : 'desactivar'} ${name} (¿bloqueado por seguridad o le falta una interfaz?)`);
    const st = this.ctrlList?.find((c) => c.name === name)?.state;
    if ((st === 'active') !== on) throw new Error(`El robot no confirmó ${name} ${on ? 'activo' : 'inactivo'}`);
    return names;
  }

  // Un controlador cargado pero «unconfigured» se configura antes de poder activarlo.
  async configureController(name) {
    const r = await this.ros.callService(this.ns('controller/controller_manager/configure_controller'), { name },
      { type: 'controller_manager_msgs/srv/ConfigureController', timeoutMs: 8000 });
    this.ctrlKey = null;
    await this.pollControllers();
    if (!r.ok) throw new Error(`${name} no se pudo configurar`);
  }

  // Consigna de depth_hold; NaN en los demás ejes = no tocarlos.
  setDepth(z) {
    const topic = this.ns('controller/depth_hold/set_point');
    this.ros.advertise(topic, 'sura_msgs/msg/AuvControllerSetPoint');
    return this.ros.publishRaw(topic,
      `{"position":{"x":NaN,"y":NaN,"z":${Number(z)}},"rpy":{"x":NaN,"y":NaN,"z":NaN}}`);
  }

  // Los servidores de sura_actions son nodos lifecycle que arrancan «unconfigured» y solo
  // aceptan metas en «active» (README de sura_actions). Se activan al primer uso.
  async ensureActive(node) {
    const st = await this.ros.callService(`/${node}/get_state`, {}, { type: 'lifecycle_msgs/srv/GetState', timeoutMs: 4000 });
    const label = st.current_state.label;
    if (label === 'active') return;
    const change = (id) => this.ros.callService(`/${node}/change_state`, { transition: { id, label: '' } },
      { type: 'lifecycle_msgs/srv/ChangeState', timeoutMs: 8000 });
    if (label === 'unconfigured') {
      const r = await change(1);   // configure
      if (!r.success) throw new Error(`${node} no se pudo configurar`);
    }
    const r = await change(3);     // activate
    if (!r.success) throw new Error(`${node} no se pudo activar`);
    this.pushLog({ src: 'sura_view', line: `${node} activado`, t: Date.now() / 1000 });
  }

  // Devuelve { id, result, cancel } como RosbridgeClient.sendActionGoal; si hay que activar
  // el nodo lifecycle antes, la meta se envía cuando termina la activación.
  action(rel, type, goal, onFeedback) {
    const node = LIFECYCLE[this.profile?.family === 'surface' ? `${rel}_usv` : rel];
    if (!node) return this.ros.sendActionGoal(this.ns(`actions/${rel}`), type, goal, { onFeedback });
    let inner = null, canceled = false;
    const result = this.ensureActive(node).then(() => {
      if (canceled) throw new Error('Cancelada');
      inner = this.ros.sendActionGoal(this.ns(`actions/${rel}`), type, goal, { onFeedback });
      return inner.result;
    });
    return { result, cancel: () => { canceled = true; if (inner) inner.cancel(); } };
  }
}
