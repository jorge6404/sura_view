// Cliente mínimo del protocolo rosbridge v2 (sin dependencias, funciona sin internet).
// Topics, servicios y acciones (send_action_goal de rosbridge_server 2.x). Reconecta solo
// y vuelve a anunciar/suscribir tras cada reconexión.

export class RosbridgeClient extends EventTarget {
  constructor(url, { retryMs = 2000, socketFactory = (u) => new WebSocket(u) } = {}) {
    super();
    this.url = url;
    this.retryMs = retryMs;
    this.socketFactory = socketFactory;
    this.subs = new Map();      // topic -> { type, opts, handlers:Set }
    this.adverts = new Map();   // topic -> type
    this.pending = new Map();   // id -> { resolve, reject, timer } (servicios)
    this.goals = new Map();     // id -> { onFeedback, resolve, reject }
    this.ws = null;
    this.state = 'idle';
    this.seq = 0;
    this.timer = null;
  }

  connect() {
    clearTimeout(this.timer);
    this.setState('connecting');
    let ws;
    try {
      ws = this.socketFactory(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      for (const [topic, type] of this.adverts) this.send({ op: 'advertise', topic, type });
      for (const [topic, s] of this.subs) {
        this.send({ op: 'subscribe', topic, type: s.type, ...s.opts });
        for (const o of s.extra.values()) this.send({ op: 'subscribe', topic, type: s.type, ...o });
      }
      this.setState('connected');
    };
    ws.onmessage = (ev) => this.handle(ev.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failAll('Conexión perdida');
      this.scheduleRetry();
    };
    ws.onerror = () => {};
  }

  handle(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.op) {
      case 'publish': {
        const s = this.subs.get(msg.topic);
        if (s) for (const h of s.handlers) h(msg.msg);
        break;
      }
      case 'service_response': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.result === false) p.reject(new Error(typeof msg.values === 'string' ? msg.values : 'El servicio falló'));
        else p.resolve(msg.values);
        break;
      }
      case 'action_feedback': {
        const g = this.goals.get(msg.id);
        if (g && g.onFeedback) g.onFeedback(msg.values);
        break;
      }
      case 'action_result': {
        const g = this.goals.get(msg.id);
        if (!g) return;
        this.goals.delete(msg.id);
        if (msg.result === false) g.reject(new Error(typeof msg.values === 'string' ? msg.values : 'La acción falló'));
        else g.resolve({ status: msg.status, values: msg.values });
        break;
      }
      case 'status':
        if (msg.level === 'error') this.dispatchEvent(new CustomEvent('error', { detail: msg.msg }));
        break;
      default:
    }
  }

  failAll(reason) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
    for (const [, g] of this.goals) g.reject(new Error(reason));
    this.goals.clear();
  }

  setUrl(url) {
    this.url = url;
    const old = this.ws;
    this.ws = null;
    if (old) old.close();
    this.connect();
  }

  scheduleRetry() {
    this.setState('disconnected');
    this.timer = setTimeout(() => this.connect(), this.retryMs);
  }

  setState(state) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: state }));
  }

  get connected() { return this.state === 'connected'; }

  nextId(prefix) { this.seq += 1; return `${prefix}:${this.seq}`; }

  send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  // opts: { throttle_rate (ms), queue_length, id }. Devuelve una función para darse de baja.
  // Con `id` se añade una suscripción propia aunque el topic ya esté suscrito: rosbridge
  // junta las de un cliente y usa el throttle más bajo (así las gráficas van a toda velocidad).
  subscribe(topic, type, handler, opts = {}) {
    let s = this.subs.get(topic);
    if (!s) {
      s = { type, opts, handlers: new Set(), extra: new Map() };
      this.subs.set(topic, s);
      this.send({ op: 'subscribe', topic, type, ...opts });
    } else if (opts.id && !s.extra.has(opts.id)) {
      s.extra.set(opts.id, opts);
      this.send({ op: 'subscribe', topic, type, ...opts });
    }
    s.handlers.add(handler);
    return () => {
      s.handlers.delete(handler);
      if (this.subs.get(topic) !== s) return;
      if (s.handlers.size === 0) {
        this.subs.delete(topic);
        this.send({ op: 'unsubscribe', topic });
      } else if (opts.id && s.extra.delete(opts.id)) {
        this.send({ op: 'unsubscribe', topic, id: opts.id });
      }
    };
  }

  advertise(topic, type) {
    if (this.adverts.get(topic) === type) return;
    this.adverts.set(topic, type);
    this.send({ op: 'advertise', topic, type });
  }

  publish(topic, msg) {
    return this.send({ op: 'publish', topic, msg });
  }

  // JSON no admite NaN; rosbridge (json de Python) sí lo lee. msgJson ya va serializado.
  publishRaw(topic, msgJson) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(`{"op":"publish","topic":${JSON.stringify(topic)},"msg":${msgJson}}`);
    return true;
  }

  callService(service, args = {}, { type, timeoutMs = 8000 } = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId('srv');
      const msg = { op: 'call_service', id, service, args };
      if (type) msg.type = type;
      if (!this.send(msg)) { reject(new Error('Sin conexión con rosbridge')); return; }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${service} no responde`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  // Devuelve { id, result: Promise<{status, values}>, cancel() }.
  sendActionGoal(action, actionType, args, { onFeedback } = {}) {
    const id = this.nextId('goal');
    let resolve, reject;
    const result = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.goals.set(id, { onFeedback, resolve, reject });
    if (!this.send({ op: 'send_action_goal', id, action, action_type: actionType, args, feedback: true })) {
      this.goals.delete(id);
      reject(new Error('Sin conexión con rosbridge'));
    }
    return { id, result, cancel: () => this.send({ op: 'cancel_action_goal', id, action }) };
  }
}

// Estados de action_msgs/GoalStatus
export const GOAL = { UNKNOWN: 0, ACCEPTED: 1, EXECUTING: 2, CANCELING: 3, SUCCEEDED: 4, CANCELED: 5, ABORTED: 6 };
