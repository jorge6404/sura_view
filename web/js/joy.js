// Mando del navegador (Gamepad API, «standard mapping») -> sensor_msgs/Joy con la misma
// disposición que joy_node (SDL) con un mando Xbox en Linux, que es la que esperan los
// teleop_params_*.yaml de sura_teleop:
//   axes:    0 LX  1 LY  2 LT  3 RX  4 RY  5 RT  6 cruceta X  7 cruceta Y
//            (palanca izquierda/arriba = +1; gatillo suelto = +1, pulsado = -1)
//   buttons: 0 A 1 B 2 X 3 Y 4 LB 5 RB 6 Back 7 Start 8 Guide 9 L3 10 R3

const dz = (v, dead) => (Math.abs(v) < dead ? 0 : v);

export function gamepadToJoy(gp, { deadzone = 0.05 } = {}) {
  const a = (i) => dz(gp.axes[i] ?? 0, deadzone);
  const b = (i) => gp.buttons[i] ?? { pressed: false, value: 0 };
  const trig = (i) => 1 - 2 * (b(i).value ?? (b(i).pressed ? 1 : 0));
  const hx = b(14).pressed ? 1 : b(15).pressed ? -1 : 0;
  const hy = b(12).pressed ? 1 : b(13).pressed ? -1 : 0;
  const axes = [-a(0), -a(1), trig(6), -a(2), -a(3), trig(7), hx, hy].map((v) => (v === 0 ? 0 : v));
  const buttons = [0, 1, 2, 3, 4, 5, 8, 9, 16, 10, 11].map((i) => (b(i).pressed ? 1 : 0));
  return { axes, buttons };
}

export function joyMessage(joy, nowMs = Date.now()) {
  return {
    header: { stamp: { sec: Math.floor(nowMs / 1000), nanosec: (nowMs % 1000) * 1e6 }, frame_id: 'sura_view' },
    axes: joy.axes,
    buttons: joy.buttons,
  };
}

// Publica /joy a `hz` mientras haya un mando y esté activado. Cuando se suelta todo,
// manda un último mensaje en reposo para que el robot no se quede con la última orden.
export class BrowserJoy extends EventTarget {
  constructor(ros, { topic = '/joy', hz = 20 } = {}) {
    super();
    this.ros = ros;
    this.topic = topic;
    this.hz = hz;
    this.enabled = true;
    // Solo con teleop:=browser. Con joy_node el mando físico manda: si la web también
    // publicara /joy, sura_teleop recibiría dos fuentes intercaladas y el robot oscilaría.
    this.publishing = false;
    this.index = null;
    this.name = '';
    this.timer = null;
    addEventListener('gamepadconnected', (e) => this.attach(e.gamepad));
    addEventListener('gamepaddisconnected', (e) => { if (e.gamepad.index === this.index) this.detach(); });
  }

  attach(gp) {
    this.index = gp.index;
    this.name = gp.id.replace(/\(.*?\)/g, '').trim() || 'Mando';
    this.ros.advertise(this.topic, 'sensor_msgs/msg/Joy');
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 1000 / this.hz);
    this.dispatchEvent(new Event('change'));
  }

  detach() {
    clearInterval(this.timer);
    this.timer = null;
    this.index = null;
    this.name = '';
    this.dispatchEvent(new Event('change'));
  }

  get connected() { return this.index !== null; }

  // Solo simulación y sin mando físico: publica un /joy en reposo con LT pulsado para que
  // sura_teleop ceda el control (su hombre muerto). Nunca en un robot real.
  setVirtualDeadman(on) {
    this.virtualDeadman = on;
    if (on) {
      this.ros.advertise(this.topic, 'sensor_msgs/msg/Joy');
      clearInterval(this.vtimer);
      this.vtimer = setInterval(() => {
        if (this.connected || !this.publishing) return;
        const joy = { axes: [0, 0, -1, 0, 0, 1, 0, 0], buttons: Array(11).fill(0) };
        this.ros.publish(this.topic, joyMessage(joy));
      }, 1000 / this.hz);
    } else {
      clearInterval(this.vtimer);
      if (!this.connected && this.publishing) this.ros.publish(this.topic, joyMessage({ axes: [0, 0, 1, 0, 0, 1, 0, 0], buttons: Array(11).fill(0) }));
    }
    this.dispatchEvent(new Event('change'));
  }

  tick() {
    const gp = navigator.getGamepads?.()[this.index];
    if (!gp || !this.enabled || !this.publishing) return;
    this.ros.publish(this.topic, joyMessage(gamepadToJoy(gp)));
  }
}
