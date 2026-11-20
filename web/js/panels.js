// Telemetría (gráficas), Diagnóstico (/diagnostics_agg + SURA) y Desarrollador (topics, echo,
// terminal, /rosout).
import { $, $$, errMsg, toast } from './ui.js';
import { Series, deg, esc, fmt } from './util.js';
import { PtyTerm, stripAnsi } from './term.js';

// ---------------- Telemetría ----------------
export class Telemetry {
  constructor(sura) {
    const span = 10 * 60 * 1000;
    this.s = {
      depth: [new Series(span)], volt: [new Series(span)],
      att: [new Series(span), new Series(span)], vel: [new Series(span), new Series(span), new Series(span)],
    };
    this.colors = { depth: ['var(--info)'], volt: ['var(--fg)'], att: ['var(--deck)', 'var(--info)'], vel: ['var(--ok)', 'var(--info)', 'var(--deck)'] };
    sura.addEventListener('nav', (e) => {
      const m = e.detail, t = Date.now();
      this.s.depth[0].push(t, m.position.position.z);
      this.s.att[0].push(t, deg(m.rpy.y)); this.s.att[1].push(t, deg(m.rpy.x));
      const v = m.body_velocity.linear;
      this.s.vel[0].push(t, v.x); this.s.vel[1].push(t, v.y); this.s.vel[2].push(t, v.z);
    });
    sura.addEventListener('battery', (e) => this.s.volt[0].push(Date.now(), e.detail.voltage));
    sura.addEventListener('robot', () => { for (const list of Object.values(this.s)) for (const x of list) x.data = []; });
    setInterval(() => { if ($('#v-telem').classList.contains('on')) this.draw(); }, 500);
  }

  draw() {
    for (const svg of $$('[data-chart]')) {
      const key = svg.dataset.chart, list = this.s[key];
      const r = svg.getBoundingClientRect();
      const W = Math.max(100, r.width), H = Math.max(80, r.height), P = 40;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      const all = list.flatMap((x) => x.data);
      if (!all.length) {
        svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="currentColor" font-size="14">Sin datos todavía</text>`;
        continue;
      }
      let lo = Math.min(...all.map((d) => d[1])), hi = Math.max(...all.map((d) => d[1]));
      if (hi - lo < 1e-3) { lo -= 0.5; hi += 0.5; }
      const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
      const t1 = Date.now(), t0 = t1 - 10 * 60 * 1000;
      const invert = key === 'depth';
      const y = (v) => { const k = (v - lo) / (hi - lo); return invert ? 8 + k * (H - 30) : H - 22 - k * (H - 30); };
      const x = (t) => P + ((t - t0) / (t1 - t0)) * (W - P - 8);
      let s = '';
      for (let i = 0; i <= 4; i++) {
        const v = lo + ((hi - lo) * i) / 4;
        s += `<line x1="${P}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="currentColor" stroke-opacity=".12"/><text x="0" y="${y(v) + 4}" font-size="12" fill="currentColor">${fmt(v, Math.abs(hi - lo) < 5 ? 1 : 0)}</text>`;
      }
      for (const [m, lbl] of [[10, '−10 min'], [5, '−5 min'], [0, 'ahora']]) {
        s += `<text x="${x(t1 - m * 60000)}" y="${H - 4}" font-size="12" fill="currentColor" text-anchor="${m ? 'middle' : 'end'}">${lbl}</text>`;
      }
      list.forEach((ser, i) => {
        if (ser.data.length < 2) return;
        s += `<polyline fill="none" stroke="${this.colors[key][i]}" stroke-width="2" points="${ser.data.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`;
      });
      svg.innerHTML = s;
    }
  }
}

// ---------------- Diagnóstico ----------------
const LVL = { 0: ['ok', 'OK'], 1: ['warn', 'Aviso'], 2: ['err', 'Error'], 3: ['off', 'Sin datos'] };

export class Diagnostics {
  constructor(sura) {
    this.sura = sura;
    this.open = new Set();
    sura.addEventListener('diag', () => this.render());
    sura.addEventListener('server', () => this.renderSura());
    sura.addEventListener('log', (e) => this.log(e.detail));
    $('#diagGroups').addEventListener('click', (e) => {
      const row = e.target.closest('.ditem');
      if (!row) return;
      const k = row.dataset.k;
      if (this.open.has(k)) this.open.delete(k); else this.open.add(k);
      row.classList.toggle('open');
    });
    $('#suraStop').addEventListener('click', async () => {
      try { await sura.rpc('sura.stop', {}, 30000); toast('SURA detenida', 'ok', 'power'); } catch (e) { toast(errMsg(e), 'err'); }
    });
    $('#suraRestart').addEventListener('click', async () => {
      try { await sura.rpc('sura.stop', { simulator: false }, 30000); await sura.rpc('sura.start'); toast('SURA reiniciada', 'ok', 'rotate-ccw'); } catch (e) { toast(errMsg(e), 'err'); }
    });
  }

  // Solo las hojas: los agregados (/ROBOTS, /ROBOTS/BLUEROV…) repiten el peor estado de sus hijos
  leaves() {
    const names = [...this.sura.diag.keys()];
    return [...this.sura.diag.values()].filter((s) => !names.some((n) => n !== s.name && n.startsWith(`${s.name}/`)));
  }

  summary() {
    let warn = 0, err = 0, stale = 0;
    for (const s of this.leaves()) {
      if (s.level === 1) warn++; else if (s.level === 2) err++; else if (s.level === 3) stale++;
    }
    return { warn, err, stale, any: this.sura.diag.size > 0 };
  }

  render() {
    const groups = new Map();
    for (const s of this.leaves()) {
      const parts = s.name.split('/').filter(Boolean);
      if (parts.length < 2) continue;
      const g = parts.slice(0, -1).join(' / ');
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(s);
    }
    const { warn, err, stale } = this.summary();
    $('#diagSummary').innerHTML = `<span class="chip"><span class="dot ${err ? 'err' : warn ? 'warn' : 'ok'}"></span>${err ? `${err} error(es)` : warn ? `${warn} aviso(s)` : 'Todo bien'}${stale ? ` · ${stale} sin datos` : ''}</span>`;
    if (!groups.size) return;
    const worst = (list) => Math.max(...list.map((s) => s.level));
    $('#diagGroups').innerHTML = [...groups.entries()].sort((a, b) => worst(b[1]) - worst(a[1])).map(([g, list]) => `
      <div class="dgroup"><h3><span class="dot ${LVL[worst(list)]?.[0] || 'off'}"></span>${esc(g)}</h3>
      ${list.sort((a, b) => b.level - a.level).map((s) => {
        const k = s.name, cls = LVL[s.level]?.[0] || 'off';
        return `<div class="ditem ${cls === 'warn' ? 'warn' : ''} ${this.open.has(k) ? 'open' : ''}" data-k="${esc(k)}">
          <span class="dot ${cls}"></span><span>${esc(s.name.split('/').pop())}</span><span class="msg">${esc(s.message || LVL[s.level]?.[1])}</span>
          <button class="btn small ghost">Detalles</button>
          <div class="vals">${s.values.map((v) => `${esc(v.key)}: ${esc(v.value)}`).join('<br>') || 'Sin valores'}</div></div>`;
      }).join('')}</div>`).join('');
  }

  renderSura() {
    const p = this.sura.server?.processes?.sura;
    if (!p) return;
    const st = $('#suraState');
    const navOk = this.sura.navStamp && Date.now() - this.sura.navStamp < 3000;
    st.innerHTML = p.running ? `<span class="dot ${navOk ? 'ok' : 'warn'}"></span>${navOk ? 'En marcha' : 'Arrancando'} · ${fmtUp(p.uptime)}`
      : navOk ? '<span class="dot ok"></span>En marcha (lanzada fuera de sura_view)' : `<span class="dot off"></span>Detenida${p.exit_code !== null ? ` (código ${p.exit_code})` : ''}`;
    $('#suraCmd').textContent = p.command || '—';
  }

  log(e) {
    if (!['sura', 'sim', 'bag', 'bt'].includes(e.src)) return;
    const box = $('#suraLog');
    const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
    const line = document.createElement('div');
    line.innerHTML = `<span class="src">[${esc(e.src)}]</span> ${esc(stripAnsi(e.line))}`;
    box.append(line);
    while (box.childElementCount > 400) box.firstChild.remove();
    if (atEnd) box.scrollTop = box.scrollHeight;
  }
}

const fmtUp = (s) => { const m = Math.floor(s / 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };

// ---------------- Desarrollador ----------------
export class Dev {
  constructor(sura) {
    this.sura = sura;
    this.ros = sura.ros;
    this.topics = [];
    this.echoUnsub = null;
    this.echoTimes = [];
    this.terms = new Map();     // sid -> PtyTerm (una pestaña cada una)
    $('#topicFilter').addEventListener('input', () => this.renderTopics());
    $('#topicList').addEventListener('click', (e) => { const t = e.target.closest('.t'); if (t) this.echo(t.dataset.topic, t.dataset.type); });
    $('#termTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) this.tab(b.dataset.term); });
    $('#logLevel').addEventListener('change', () => this.renderLogs());
    sura.addEventListener('log', (e) => { if (e.detail.level) this.addLog(e.detail); });
  }

  async refresh() {
    try {
      const r = await this.ros.callService('/rosapi/topics', {});
      this.topics = r.topics.map((t, i) => ({ t, type: r.types[i] })).sort((a, b) => a.t.localeCompare(b.t));
      this.renderTopics();
    } catch (e) {
      $('#topicList').innerHTML = `<p class="muted">${esc(errMsg(e))}</p>`;
    }
  }

  renderTopics() {
    const q = $('#topicFilter').value.toLowerCase();
    const list = this.topics.filter((x) => `${x.t} ${x.type}`.toLowerCase().includes(q));
    $('#topicCount').textContent = `${list.length} de ${this.topics.length}`;
    $('#topicList').innerHTML = list.map((x) => `<div class="t ${x.t === this.echoTopic ? 'sel' : ''}" data-topic="${esc(x.t)}" data-type="${esc(x.type)}"><code>${esc(x.t)}</code><b class="num"></b><small>${esc(x.type)}</small></div>`).join('')
      || '<p class="muted" style="padding:12px 0">Ningún topic coincide.</p>';
  }

  echo(topic, type) {
    this.tab('echo');
    if (this.echoUnsub) this.echoUnsub();
    this.echoTopic = topic;
    this.echoTimes = [];
    this.renderTopics();
    $('#echoBox').textContent = `Esperando mensajes de ${topic}…`;
    const heavy = /Image|PointCloud/.test(type);
    this.echoUnsub = this.ros.subscribe(topic, type, (m) => {
      this.echoTimes.push(performance.now());
      this.echoTimes = this.echoTimes.filter((t) => performance.now() - t < 3000);
      const hz = this.echoTimes.length > 1 ? (this.echoTimes.length - 1) / ((this.echoTimes[this.echoTimes.length - 1] - this.echoTimes[0]) / 1000) : 0;
      const shown = heavy ? { ...m, data: `<${(m.data || '').length} caracteres base64>` } : m;
      $('#echoBox').textContent = `${topic}  ·  ${type}  ·  ~${fmt(hz, 1)} Hz (vista limitada a 4 Hz)\n\n${JSON.stringify(shown, null, 2)}`;
    }, { throttle_rate: 250, queue_length: 1 });
  }

  tab(which) {
    if (which === 'new') { this.openTerm(); return; }
    for (const b of $$('#termTabs button')) b.setAttribute('aria-pressed', b.dataset.term === which);
    $('#echoBox').hidden = which !== 'echo';
    $('#termBox').hidden = which === 'echo';
    for (const [sid, pt] of this.terms) pt.el.hidden = sid !== which;
    const pt = this.terms.get(which);
    if (pt) { pt.fit(); pt.focus(); }
  }

  async openTerm() {
    const target = this.sura.profile?.environment === 'real' && confirm('¿Abrir la terminal en el robot (ssh)? Cancelar = en este ordenador') ? 'robot' : 'local';
    const b = document.createElement('button');
    const pt = new PtyTerm(this.sura, { onEnd: () => b.classList.add('ended') });
    $('#termBox').hidden = false;
    pt.attach($('#termBox'));
    try {
      const r = await pt.open(target);
      this.terms.set(r.sid, pt);
      b.dataset.term = r.sid;
      b.textContent = target === 'robot' ? 'robot (ssh)' : 'terminal';
      b.title = 'Ctrl+Mayús+C copia y Ctrl+Mayús+V pega';
      $('#termTabs').insertBefore(b, $('#termTabs [data-term="new"]'));
      this.tab(r.sid);
    } catch (e) {
      pt.close();
      if (!this.terms.size) this.tab('echo');
      toast(errMsg(e), 'warn', 'terminal');
    }
  }

  addLog(e) {
    this.renderLogs(e);
  }

  renderLogs(one) {
    const min = +$('#logLevel').value;
    const box = $('#rosout');
    const line = (e) => {
      const d = new Date((e.t || Date.now() / 1000) * 1000);
      const name = { 10: 'DEBUG', 20: 'INFO', 30: 'WARN', 40: 'ERROR', 50: 'FATAL' }[e.level] || e.level;
      return `<div class="L${e.level}"><span>${d.toLocaleTimeString()}</span><span>${name}</span><span>${esc(e.src)}</span><span>${esc(e.line)}</span></div>`;
    };
    if (one) {
      if (one.level < min) return;
      box.insertAdjacentHTML('beforeend', line(one));
      while (box.childElementCount > 300) box.firstChild.remove();
      box.scrollTop = box.scrollHeight;
      return;
    }
    box.innerHTML = this.sura.logs.filter((e) => e.level && e.level >= min).slice(-300).map(line).join('');
    box.scrollTop = box.scrollHeight;
  }
}
