// Pestaña Comportamientos: árboles XML (BehaviorTree.CPP v3) ejecutados por sura_view_server.
import { $, errMsg, toast } from './ui.js';
import { esc } from './util.js';
import { layoutTree } from './btlayout.js';

const COLORS = { success: 'var(--ok)', running: 'var(--deck)', failure: 'var(--red)', idle: 'currentColor' };
const ROLE = { control: 'CONTROL', decorator: 'DECORADOR', leaf: 'ACCIÓN', subtree: 'SUBÁRBOL' };
const TEMPLATE = `<?xml version="1.0"?>
<!-- Describe aquí qué hace el árbol -->
<root main_tree_to_execute="nuevo">
  <BehaviorTree ID="nuevo">
    <Sequence name="Principal">
      <BatteryAbove name="Batería > 30 %" percent="30"/>
      <GoToDepth name="Bajar a 2 m" depth="2.0"/>
      <Wait name="Esperar 5 s" seconds="5"/>
      <Surface name="Emerger"/>
    </Sequence>
  </BehaviorTree>
</root>
`;

export class BtView {
  constructor(sura) {
    this.sura = sura;
    this.trees = [];
    this.name = '';
    this.tree = null;
    this.sel = null;
    this.live = false;
    sura.ros.subscribe('/sura_view/bt/status', 'std_msgs/msg/String', (m) => this.onStatus(JSON.parse(m.data)));
    sura.addEventListener('server', () => this.onServer());
    $('#btRun').addEventListener('click', () => this.run());
    $('#btStop').addEventListener('click', () => this.stop());
    $('#btEdit').addEventListener('click', () => this.toggleEditor());
    $('#btSave').addEventListener('click', () => this.saveXml());
    $('#btNew').addEventListener('click', () => this.newTree());
    $('#btsvg').addEventListener('click', (e) => {
      const g = e.target.closest('.btnode');
      if (g) { this.sel = g.dataset.id; this.draw(); }
    });
  }

  async refresh() {
    try {
      const r = await this.sura.rpc('bt.list');
      this.trees = r.trees;
      $('#btLeaves').textContent = r.leaves.join(' · ');
      this.renderList();
      if (!this.name && this.trees.length) this.open(this.trees[0].name);
    } catch (e) {
      $('#btList').innerHTML = `<p class="muted">${esc(errMsg(e))}</p>`;
    }
  }

  renderList() {
    $('#btList').innerHTML = this.trees.map((t) => `
      <button data-name="${esc(t.name)}" aria-current="${t.name === this.name}"><i data-lucide="git-fork"></i>
        <div>${esc(t.name)}<small>${esc(t.description || (t.editable ? 'Tuyo' : 'De ejemplo'))}</small></div></button>`).join('')
      || '<p class="muted">No hay árboles. Crea uno con +.</p>';
    for (const b of $('#btList').querySelectorAll('button')) b.addEventListener('click', () => this.open(b.dataset.name));
    window.lucide?.createIcons();
  }

  async open(name) {
    try {
      const r = await this.sura.rpc('bt.get', { name });
      this.name = name;
      this.tree = r.tree;
      this.sel = null;
      $('#btXml').value = r.xml;
      $('#btErr').textContent = '';
      this.renderList();
      this.draw();
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  onServer() {
    const st = this.sura.server?.bt;
    if (!st) return;
    const was = this.live;
    this.live = st.running;
    $('#btState').textContent = st.running ? `Ejecutando «${st.name}»` : st.result ? `Último: ${st.result}` : '';
    $('#btRun').disabled = st.running;
    $('#btStop').disabled = !st.running;
    if (was && !st.running && st.result) toast(`«${st.name}» terminó: ${st.result}`, st.result === 'success' ? 'ok' : 'warn');
  }

  onStatus(s) {
    if (s.name !== this.name) return;
    this.tree = s.tree;
    this.board = s.blackboard;
    this.draw();
  }

  async run() {
    if (!this.name) return;
    if (this.sura.autonomous === false) { toast('Mantén pulsado LT en el mando para ceder el control al robot', 'warn', 'gamepad-2'); return; }
    try { await this.sura.rpc('bt.run', { name: this.name }); toast(`Ejecutando «${this.name}»`, 'ok', 'play'); } catch (e) { toast(errMsg(e), 'err'); }
  }

  async stop() {
    try { await this.sura.rpc('bt.stop'); toast('Árbol detenido', 'ok', 'square'); } catch (e) { toast(errMsg(e), 'err'); }
  }

  toggleEditor() {
    const on = $('#btEditor').hidden;
    $('#btEditor').hidden = !on;
    $('#btsvg').hidden = on;
    $('#btEdit').setAttribute('aria-pressed', on);
  }

  newTree() {
    let name = prompt('Nombre del árbol (letras, números, _ y -)', 'mi_arbol');
    if (!name) return;
    name = name.trim().replace(/\s+/g, '_');
    this.name = name;
    $('#btXml').value = TEMPLATE.replaceAll('nuevo', name);
    if ($('#btEditor').hidden) this.toggleEditor();
    $('#btErr').textContent = 'Árbol nuevo sin guardar';
  }

  async saveXml() {
    try {
      const r = await this.sura.rpc('bt.save', { name: this.name, xml: $('#btXml').value });
      this.tree = r.tree;
      $('#btErr').textContent = '';
      toast(`«${this.name}» guardado`, 'ok', 'save');
      await this.refresh();
      this.toggleEditor();
      this.draw();
    } catch (e) {
      $('#btErr').textContent = errMsg(e);
    }
  }

  draw() {
    const svg = $('#btsvg');
    if (!this.tree) { svg.innerHTML = ''; return; }
    const { nodes, edges, width, height } = layoutTree(this.tree.children[0] || this.tree, { w: 168, h: 50, gx: 18, gy: 64 });
    svg.setAttribute('viewBox', `-20 -20 ${Math.max(width + 40, 400)} ${height + 40}`);
    let s = edges.map(([a, b]) => `<path d="M${a.x} ${a.y + 25} C${a.x} ${a.y + 57} ${b.x} ${b.y - 57} ${b.x} ${b.y - 25}" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-width="2"/>`).join('');
    for (const n of nodes) {
      const st = n.node.status, c = COLORS[st] || 'currentColor';
      const idle = st === 'idle';
      s += `<g class="btnode ${n.node.id === this.sel ? 'sel' : ''} ${st}" data-id="${esc(n.node.id)}" transform="translate(${n.x - 84} ${n.y - 25})">
        <rect width="168" height="50" rx="4" style="fill:var(--hull-3);stroke:${c}" stroke-opacity="${idle ? 0.35 : 1}" stroke-width="${st === 'running' ? 3 : 2}"/>
        <text x="12" y="19" font-size="12" font-family="Barlow Condensed" font-weight="600" letter-spacing=".06em" fill="currentColor" opacity=".75">${ROLE[n.node.role]} · ${esc(n.node.kind)}</text>
        <text x="12" y="39" font-size="15" font-weight="600" fill="currentColor">${esc(clip(n.node.name, 19))}</text>
        <circle cx="154" cy="14" r="5" style="fill:${c}" opacity="${idle ? 0.35 : 1}"/></g>`;
    }
    svg.innerHTML = s;
    const sel = nodes.find((n) => n.node.id === this.sel)?.node;
    $('#btNode').innerHTML = sel
      ? [['Tipo', ROLE[sel.role]], ['Nodo', sel.kind], ['Nombre', sel.name], ['Estado', sel.status], ...Object.entries(sel.attrs)]
        .map(([k, v]) => `<span>${esc(k)}</span><b>${esc(v)}</b>`).join('')
      : '<span>Toca un nodo</span><b></b>';
    $('#btBoard').innerHTML = this.board && Object.keys(this.board).length
      ? Object.entries(this.board).map(([k, v]) => `<span>${esc(k)}</span><b>${esc(v)}</b>`).join('')
      : '<span>Vacía</span><b></b>';
  }
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
