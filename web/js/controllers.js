// Pestaña SURA Controllers: los controladores de ros2_control del robot, lo principal para
// operar. Lee list_controllers (Sura.pollControllers, cada segundo) y list_hardware_components
// (solo con la pestaña abierta). Los cambios van por el árbitro (Sura.toggleController).
import { CTRL_MODES, modesFor } from './controlmodes.js';
import { $, errMsg, icons, toast } from './ui.js';
import { esc } from './util.js';

const bcast = (c) => /broadcaster/i.test(c.type) || /_broadcaster$/.test(c.name);
const STATE = {
  active: ['ok', 'Activo'], inactive: ['off', 'Inactivo'], unconfigured: ['warn', 'Sin configurar'],
};

export class ControllersView {
  constructor(sura, ros) {
    this.sura = sura;
    this.ros = ros;
    this.busy = null;
    sura.addEventListener('controllers', () => this.render());
    sura.addEventListener('mode', () => this.renderModes());
    sura.addEventListener('robot', () => { this.hw = null; this.buildModes(); this.render(); this.renderHw(); });
    for (const id of ['#ctlMain', '#ctlSensors']) $(id).addEventListener('click', (e) => this.click(e));
    $('#ctlModes').addEventListener('click', (e) => this.modeClick(e));
    setInterval(() => { if (this.visible()) this.pollHw(); }, 2000);
    this.buildModes();
    this.render();
  }

  visible() { return $('#v-ctrl').classList.contains('on'); }

  shown() { this.render(); this.renderModes(); this.pollHw(); }

  render() {
    const list = this.sura.ctrlList;
    if (!list) {
      $('#ctlSummary').textContent = 'sin datos';
      $('#ctlMain').innerHTML = `<div class="ctl-empty"><i data-lucide="plug-zap"></i><p>Sin <code>controller_manager</code> de /${esc(this.sura.robot || '…')}.<br>Lanza SURA desde Pilotar o Diagnóstico.</p></div>`;
      $('#ctlSensors').innerHTML = '';
      icons();
      return;
    }
    const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
    const main = sorted.filter((c) => !bcast(c)), sens = sorted.filter(bcast);
    const on = (l) => l.filter((c) => c.state === 'active').length;
    $('#ctlSummary').textContent = `${on(main)} de ${main.length} activos`;
    $('#ctlSensCount').textContent = `${on(sens)} de ${sens.length}`;
    $('#ctlMain').innerHTML = main.map((c) => this.card(c)).join('') || '<p class="muted">No hay controladores de control cargados.</p>';
    $('#ctlSensors').innerHTML = sens.map((c) => this.line(c)).join('') || '<p class="muted">Ninguno.</p>';
  }

  // interruptor tipo macOS: on = activo; «Configurar» si está sin configurar
  control(c) {
    const busy = this.busy === c.name, dis = this.busy ? 'disabled' : '';
    if (c.state === 'unconfigured') return `<button class="btn small" data-ctrl="${esc(c.name)}" data-act="configure" ${dis}>${busy ? '…' : 'Configurar'}</button>`;
    if (c.state !== 'active' && c.state !== 'inactive') return '';
    const on = c.state === 'active';
    return `<button class="switch ${busy ? 'busy' : ''}" role="switch" aria-checked="${on}" aria-label="${on ? 'Desactivar' : 'Activar'} ${esc(c.name)}"
      data-ctrl="${esc(c.name)}" data-act="${on ? 'off' : 'on'}" ${dis}><i></i></button>`;
  }

  card(c) {
    const [dot, label] = STATE[c.state] || ['err', c.state];
    const chain = (c.chain_connections || []).map((k) => k.name);
    const claimed = c.claimed_interfaces || [];
    return `<article class="ctl-card glass ${c.state}">
      <header><span class="dot ${dot}"></span><b>${esc(c.name)}</b>${this.control(c)}</header>
      <p class="ctl-type" title="${esc(c.type)}">${esc(c.type)}</p>
      <dl>
        <dt>Estado</dt><dd>${esc(label)}</dd>
        <dt>Interfaces</dt><dd title="${esc(claimed.join('\n'))}">${claimed.length ? `${claimed.length} reclamadas` : '—'}</dd>
        ${chain.length ? `<dt>Manda a</dt><dd>${esc(chain.join(', '))}</dd>` : ''}
      </dl></article>`;
  }

  line(c) {
    const [dot, label] = STATE[c.state] || ['err', c.state];
    return `<div class="ctl-line"><span class="dot ${dot}"></span><div><b>${esc(c.name)}</b><small>${esc(label)} · ${esc(c.type.split('/').pop())}</small></div>${this.control(c)}</div>`;
  }

  async click(e) {
    const b = e.target.closest('[data-ctrl]');
    if (!b || this.busy) return;
    const name = b.dataset.ctrl, act = b.dataset.act;
    this.busy = name;
    this.render();
    try {
      if (act === 'configure') {
        await this.sura.configureController(name);
        toast(`${name} configurado`, 'ok', 'settings');
      } else {
        const names = await this.sura.toggleController(name, act === 'on');
        const extra = names.filter((n) => n !== name);
        toast(`${name} ${act === 'on' ? 'activado' : 'desactivado'}${extra.length ? ` (también ${extra.join(', ')})` : ''}: confirmado por el robot`, 'ok', 'toggle-right');
      }
    } catch (err) {
      toast(errMsg(err), 'err');
    } finally {
      this.busy = null;
      this.render();
    }
  }

  // ---- modos del mando (las mismas combinaciones que sura_teleop) ----
  buildModes() {
    $('#ctlModes').innerHTML = modesFor(this.sura.profile?.family).map((k) => {
      const m = CTRL_MODES[k];
      return `<button data-mode="${k}" aria-pressed="false" title="${esc(m.on.join(' + '))}">${m.label}<small>${m.combo}</small></button>`;
    }).join('');
    this.renderModes();
  }

  renderModes() {
    for (const b of $('#ctlModes').children) {
      b.setAttribute('aria-pressed', b.dataset.mode === this.sura.ctrlMode);
      b.classList.toggle('pending', b.dataset.mode === this.sura.ctrlPending);
    }
    const s = this.sura;
    $('#ctlModeNow').textContent = s.ctrlPending ? 'enviando…' : s.ctrlMode ? CTRL_MODES[s.ctrlMode].label : s.controllers ? 'desarmado' : '—';
  }

  async modeClick(e) {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    const m = b.dataset.mode;
    if (!this.sura.armed) { toast('El robot está desarmado: ármalo desde Pilotar', 'warn', 'info'); return; }
    try { await this.sura.setCtrlMode(m); toast(`Modo ${CTRL_MODES[m].label.toLowerCase()}: confirmado por el robot`, 'ok'); } catch (err) { toast(errMsg(err), 'err'); }
  }

  // ---- hardware (list_hardware_components) ----
  async pollHw() {
    if (!this.sura.robot || !this.ros.connected || !this.sura.ctrlList || this.hwPolling) return;
    this.hwPolling = true;
    try {
      const r = await this.ros.callService(this.sura.ns('controller/controller_manager/list_hardware_components'), {},
        { type: 'controller_manager_msgs/srv/ListHardwareComponents', timeoutMs: 3000 });
      this.hw = r.component;
    } catch {
      this.hw = null;
    } finally {
      this.hwPolling = false;
      this.renderHw();
    }
  }

  renderHw() {
    if (!this.hw) { $('#ctlHw').innerHTML = '<p class="muted">Sin datos.</p>'; return; }
    $('#ctlHw').innerHTML = this.hw.map((h) => {
      const st = h.state?.label || '?';
      const cmd = h.command_interfaces || [];
      const claimed = cmd.filter((i) => i.is_claimed).length;
      return `<div class="ctl-line"><span class="dot ${st === 'active' ? 'ok' : st === 'inactive' ? 'off' : 'warn'}"></span>
        <div><b>${esc(h.name)}</b><small>${esc(st)} · ${esc(h.type)} · ${claimed}/${cmd.length} mandos en uso</small></div><span></span></div>`;
    }).join('') || '<p class="muted">Ninguno.</p>';
  }
}
