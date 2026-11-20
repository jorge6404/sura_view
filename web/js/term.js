// Terminal de la pty de sura_view_server (terminal.open, /sura_view/terminal/{in,out}) con xterm.js:
// emulador de verdad (cursor, colores, programas a pantalla completa como htop, vim o claude).
// La usan la pestaña Diagnóstico (panels.js) y el widget Terminal del panel de Pilotar.
import { Terminal } from '../vendor/xterm/xterm.mjs';
import { Unicode11Addon } from '../vendor/xterm/addon-unicode11.mjs';

export const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][0-9A-Z]/g, '');

// columnas y filas que caben en width × height px con celdas de cell px (la barra de scroll a la
// derecha no cuenta); null si aún no hay medidas
export function fitSize(width, height, cell, scrollbar = 14) {
  if (!cell?.width || !cell?.height || width <= 0 || height <= 0) return null;
  return {
    cols: Math.max(20, Math.floor((width - scrollbar) / cell.width)),
    rows: Math.max(4, Math.floor(height / cell.height)),
  };
}

const TERM_IN = '/sura_view/terminal/in';
const TERM_OUT = '/sura_view/terminal/out';

const THEME = {
  background: '#0b0e11', foreground: '#d6dde3', cursor: '#e8b931', cursorAccent: '#0b0e11',
  selectionBackground: '#3b6f9a99',
  black: '#1a2026', red: '#e5534b', green: '#7fc79c', yellow: '#e8b931', blue: '#6cb6ff', magenta: '#dcbdfb', cyan: '#76e3ea', white: '#c8d0d7',
  brightBlack: '#636e7b', brightRed: '#ff7b72', brightGreen: '#9be9a8', brightYellow: '#f2cc60', brightBlue: '#96d0ff', brightMagenta: '#eedcff', brightCyan: '#b3f0ff', brightWhite: '#f6f8fa',
};

// una sesión de pty mostrada en un xterm. `el` se mueve de un sitio a otro (attach) sin perder
// la pantalla, y sigue recibiendo salida aunque no esté en la página.
export class PtyTerm {
  constructor(sura, { onEnd } = {}) {
    this.sura = sura;
    this.ros = sura.ros;
    this.onEnd = onEnd;
    this.sid = null;
    this.size = null;
    this.el = document.createElement('div');
    this.el.className = 'xt';
    this.term = new Terminal({
      allowProposedApi: true,      // lo pide el addon de Unicode 11
      cursorBlink: true,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      fontFamily: '"DejaVu Sans Mono", "Ubuntu Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.1,
      scrollback: 5000,
      theme: THEME,
    });
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    // Ctrl+Mayús+C / Ctrl+Mayús+V copian y pegan, como en la terminal de Ubuntu
    this.term.attachCustomKeyEventHandler((e) => {
      if (!e.ctrlKey || !e.shiftKey || e.type !== 'keydown') return true;
      if (e.code === 'KeyC') {
        e.preventDefault();
        if (this.term.hasSelection()) navigator.clipboard?.writeText(this.term.getSelection()).catch(() => {});
        return false;
      }
      return e.code !== 'KeyV';      // false: el navegador pega y xterm lo recibe como paste
    });
    this.term.onData((d) => this.send({ data: d }));
    this.term.onBinary((d) => this.send({ data: d }));
    this.opened = false;
    this.ro = new ResizeObserver(() => { clearTimeout(this.t); this.t = setTimeout(() => this.fit(), 60); });
    this.ro.observe(this.el);
    this.ros.advertise(TERM_IN, 'std_msgs/msg/String');
    this.unsub = this.ros.subscribe(TERM_OUT, 'std_msgs/msg/String', (m) => {
      const o = JSON.parse(m.data);
      if (!this.sid || o.sid !== this.sid) return;
      if (o.data) this.term.write(o.data);
      if (o.closed) { this.sid = null; this.onEnd?.(); }
    });
  }

  get alive() { return !!this.sid; }

  async open(target) {
    const r = await this.sura.rpc('terminal.open', { target });
    this.sid = r.sid;
    this.size = null;
    this.fit();
    return r;
  }

  send(o) {
    if (this.sid) this.ros.publish(TERM_IN, { data: JSON.stringify({ sid: this.sid, ...o }) });
  }

  // mete el terminal en `parent` (la primera vez lo crea ahí; luego solo lo mueve)
  attach(parent) {
    parent.append(this.el);
    if (!this.opened) { this.term.open(this.el); this.opened = true; }
    document.fonts?.ready.then(() => this.fit());
    this.fit();
  }

  fit() {
    if (!this.opened || !this.el.isConnected) return;
    const cell = this.term._core?._renderService?.dimensions?.css?.cell;     // lo mismo que usa addon-fit
    const s = fitSize(this.el.clientWidth, this.el.clientHeight, cell);
    if (!s) return;
    if (s.cols !== this.term.cols || s.rows !== this.term.rows) this.term.resize(s.cols, s.rows);
    if (this.sid && (s.cols !== this.size?.cols || s.rows !== this.size?.rows)) {
      this.size = s;
      this.send(s);
    }
  }

  focus() { this.term.focus(); }

  // cierra la pty y libera el xterm
  close() {
    if (this.sid) this.sura.rpc('terminal.close', { sid: this.sid }).catch(() => {});
    this.sid = null;
    this.unsub?.();
    this.ro.disconnect();
    clearTimeout(this.t);
    this.term.dispose();
    this.el.remove();
  }
}
