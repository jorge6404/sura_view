# Panel personalizado en Pilotar — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** En Pilotar, un selector «Clásica / Mi panel» con una cuadrícula libre de widgets reales, bloqueada al pilotar y editable.

**Architecture:** Motor de cuadrícula puro (`dashgrid.js`, testeado), catálogo de widgets con contrato `mount → destroy` (`dashwidgets.js`, `dashinstruments.js`), vista que une ambos dentro de `#v-pilot` (`dashboard.js`). La lógica de los modos se saca de `app.js` a `pilotactions.js` para que la vista clásica y el widget hagan lo mismo.

**Tech Stack:** JS vanilla en módulos ES, sin compilación ni dependencias nuevas; SVG para instrumentos; tests en navegador (`web/test/run.html`, shims de `node:test`).

**Spec:** `docs/superpowers/specs/2026-11-20-panel-pilotar-design.md`

## Global Constraints

- Nada nuevo en `web/vendor/`; funciona sin internet.
- Textos de la interfaz y comentarios en español, como el resto del código.
- Colores y radios con los tokens de `app.css` (`--glass*`, `--r-sm/--r/--r-lg`, `--fg-*`, `--ok`, `--deck`, `--red`); números en Barlow Condensed (`var(--cond)`).
- Un valor con más de 3 s sin actualizar se muestra como «sin datos» (`fresh(stamp, now, 3000)` de `util.js`).
- 12 columnas; alto de fila = alto del panel / 12, mínimo 44 px.
- `localStorage['sura_view.dash'] = { view: 'classic'|'dash', current: string, layouts: { [nombre]: Item[] } }`, siempre dentro de `try/catch`.
- Objetivos táctiles de 44 px con `pointer: coarse`; animaciones bajo `prefers-reduced-motion`.
- Cada cambio de `web/` necesita `colcon build --packages-select sura_view` para llegar a `install/`.

## Review Focus

1. **Arrastrar mientras llega navegación a 10 Hz:** el widget no salta ni se pierde el arrastre (la vista no re-renderiza el DOM del widget mientras se mueve). Test manual en Task 5.
2. **Importar un JSON roto o de otra versión:** el panel actual queda igual y sale un aviso. Test `sanitize` en Task 1.
3. **Ventana muy estrecha (móvil, < 700 px):** el panel pasa a una sola columna apilada en orden de `y, x` sin solapes. Test `stack` en Task 1.
4. **Volver a «Clásica» y luego a «Mi panel»:** no se duplican suscripciones ni temporizadores (los widgets se desmontan al salir). Comprobación en Task 5.
5. **Cambiar de robot con el panel abierto:** las cámaras se vuelven a suscribir al topic del robot nuevo o muestran «sin imagen»; nada se queda con datos del anterior. Comprobación en Task 5.

---

### Task 0: Guardar lo que hay

- [ ] **Step 1: Commit del estado actual (pestaña «Personalizar» con los arreglos) para no perderlo**

```bash
git add -A && git commit -m "Pestaña Personalizar (primer intento, modelo local) con arreglos"
```

### Task 1: Motor de cuadrícula

**Files:**
- Create: `web/js/dashgrid.js`
- Create: `web/test/dashgrid.test.mjs`
- Modify: `web/test/run.html` (añadir `'dashgrid'` a `files`)

**Interfaces:**
- Produces (todas puras, devuelven layouts nuevos, nunca mutan):
  - `COLS = 12`
  - `collides(a, b) → boolean`
  - `clamp(item, def?) → item` (x ≥ 0, x + w ≤ 12, w ≥ def.minW ?? 1, h ≥ def.minH ?? 1)
  - `compact(layout) → layout` (cada elemento sube mientras no choque; orden por `y, x`)
  - `move(layout, id, x, y) → layout` (coloca, empuja hacia abajo lo que choca, compacta)
  - `resize(layout, id, w, h) → layout` (igual que move)
  - `add(layout, item) → layout` (primer hueco libre recorriendo filas y columnas; si `item.x/y` vienen dados, se usa `move`)
  - `remove(layout, id) → layout`
  - `bottom(layout) → number` (máximo de `y + h`)
  - `stack(layout) → layout` (una columna: `x = 0, w = 12`, en orden `y, x`, sin huecos)
  - `sanitize(raw, knownTypes: Set<string>) → { layout, dropped: number }` (descarta no-objetos, tipo desconocido, números no finitos; recorta con `clamp`; ids repetidos se renumeran; devuelve compactado)
- Item: `{ id: string, type: string, x, y, w, h: number, settings?: object }`

- [ ] **Step 1: Tests**

```js
import { add, bottom, clamp, collides, compact, move, remove, resize, sanitize, stack } from '../js/dashgrid.js';
const it = (id, x, y, w, h) => ({ id, type: 't', x, y, w, h });
const noOverlap = (l) => l.every((a, i) => l.every((b, j) => i === j || !collides(a, b)));

test('choques', () => { assert.ok(collides(it('a',0,0,2,2), it('b',1,1,2,2))); assert.ok(!collides(it('a',0,0,2,2), it('b',2,0,2,2))); });
test('clamp a 12 columnas y mínimos', () => { assert.deepEqual(clamp(it('a',11,0,4,1), { minW: 2, minH: 2 }), it('a',8,0,4,2)); assert.equal(clamp(it('a',-3,-1,1,1)).x, 0); });
test('compactar sube', () => { assert.deepEqual(compact([it('a',0,5,2,2)]).map((i) => i.y), [0]); });
test('mover empuja y no solapa', () => {
  const l = move([it('a',0,0,4,2), it('b',0,2,4,2)], 'b', 0, 0);
  assert.ok(noOverlap(l)); assert.equal(l.find((i) => i.id === 'b').y, 0); assert.equal(l.find((i) => i.id === 'a').y, 2);
});
test('redimensionar empuja', () => { const l = resize([it('a',0,0,4,2), it('b',4,0,4,2)], 'a', 8, 2); assert.ok(noOverlap(l)); assert.equal(l.find((i) => i.id === 'b').y, 2); });
test('añadir en el primer hueco', () => { const l = add([it('a',0,0,6,2)], { id: 'b', type: 't', w: 6, h: 2 }); assert.deepEqual([l[1].x, l[1].y], [6, 0]); });
test('quitar y fondo', () => { assert.equal(bottom(remove([it('a',0,0,2,3), it('b',0,3,2,2)], 'b')), 3); });
test('una columna en móvil', () => { const l = stack([it('b',6,0,6,2), it('a',0,0,6,3)]); assert.deepEqual(l.map((i) => [i.id, i.x, i.y, i.w]), [['a',0,0,12], ['b',0,3,12]]); });
test('sanitize descarta basura y renumera ids', () => {
  const { layout, dropped } = sanitize([it('a',0,0,2,2), { id: 'a', type: 't', x: 0, y: 0, w: 2, h: 2 }, { type: 'x', x: 0, y: 0, w: 1, h: 1 }, null, { id: 'c', type: 't', x: NaN }], new Set(['t']));
  assert.equal(dropped, 3); assert.equal(layout.length, 2); assert.ok(noOverlap(layout)); assert.notEqual(layout[0].id, layout[1].id);
});
test('sanitize de algo que no es lista', () => { assert.deepEqual(sanitize({ a: 1 }, new Set()), { layout: [], dropped: 0 }); });
```

- [ ] **Step 2:** Abrir `test/run.html` (servidor de prueba, ver «Probar» abajo): fallan los de dashgrid (módulo no existe).
- [ ] **Step 3:** Implementar `dashgrid.js`. `move/resize`: colocar el elemento con `clamp`, luego recorrer los demás en orden `y, x` y bajar a `y = movido.y + movido.h` cada uno que choque (repitiendo hasta que no haya choques), y `compact` final sin mover el elemento activo por encima de su `y` pedida.
- [ ] **Step 4:** `run.html`: todos los tests en verde.
- [ ] **Step 5:** Commit `Panel de Pilotar: motor de cuadrícula`.

### Task 2: Acciones de pilotaje compartidas

**Files:**
- Create: `web/js/pilotactions.js`
- Modify: `web/js/app.js:396-470` (armar, modos, consigna, emerger usan el módulo)

**Interfaces:**
- Produces:
  - `modeButtonsHtml(family) → string` (los `<button data-mode>` que hoy hace `buildModes`)
  - `paintModes(container, sura)` (aria-pressed / `.pending` como `renderModes`)
  - `modeStatusText(sura) → string` («activo: …», «enviando …», «desarmado», «sin datos»)
  - `chooseMode(sura, mode) → Promise<void>` (si no está armado guarda el modo para armar —`getArmMode()/setArmMode()`— y avisa; si lo está, `setCtrlMode` con toasts)
  - `setDepthTarget(sura, text) → boolean` (valida con `parseNum`, ≥ 0, toasts)
  - `surface(sura) → Promise<void>`
- `app.js` conserva el mismo comportamiento: la vista clásica pasa a llamar a estas funciones.

- [ ] **Step 1:** Mover el código, sin cambiar textos ni comportamiento.
- [ ] **Step 2:** Comprobar en el navegador (vista clásica): los modos se marcan con `list_controllers`, elegir modo desarmado avisa «Al armar se usará…», Emerger y Fijar profundidad mandan lo mismo que antes.
- [ ] **Step 3:** Commit `Pilotar: acciones de modo en pilotactions.js`.

### Task 3: Instrumentos

**Files:**
- Create: `web/js/dashinstruments.js` (SVG/DOM puros, sin ROS)
- Create: `web/test/dashinstruments.test.mjs` y `'dashinstruments'` en `run.html`

**Interfaces:**
- Produces (cada uno crea su nodo y devuelve `{ el, set(value) }`):
  - `rose()` → `set(headingDeg)` con muelle amortiguado como `Pilot.frame` (y sin animar con `prefers-reduced-motion`)
  - `horizon()` → `set({ pitchDeg, rollDeg })`
  - `depthTape()` → `set({ depth, altitude, target, maxDepth })` (ticks cada 0,2 m, mayores cada metro, como `drawDraft`)
  - `cells(n = 10)` → `set(pct)`
  - `spark(windowMs = 60000)` → `push(t, v)`, `draw()`; usa `Series` de `plotdata.js`
- Funciones puras testeadas: `headingLabel` ya existe en `util.js`; nuevas `tapeTicks(depth, halfSpanM) → [{ m, major }]` y `sparkPath(points, w, h) → string`.

- [ ] **Step 1: Tests**

```js
test('ticks de la cinta', () => { const t = tapeTicks(1.0, 0.5); assert.deepEqual(t.map((k) => k.m), [0.6, 0.8, 1, 1.2, 1.4]); assert.ok(t.find((k) => k.m === 1).major); });
test('sin profundidades negativas', () => { assert.ok(tapeTicks(0.1, 1).every((k) => k.m >= 0)); });
test('camino de la mini-gráfica', () => { assert.equal(sparkPath([[0, 0], [1, 1]], 100, 10), 'M0 10L100 0'); assert.equal(sparkPath([], 100, 10), ''); });
```

- [ ] **Step 2:** fallan. **Step 3:** implementar. **Step 4:** en verde.
- [ ] **Step 5:** Commit `Panel de Pilotar: instrumentos`.

### Task 4: Catálogo de widgets

**Files:**
- Create: `web/js/dashwidgets.js`

**Interfaces:**
- Consumes: Task 2 (`pilotactions.js`), Task 3 (instrumentos), `sura` (eventos `nav`, `battery`, `leak`, `pressure`, `watchdog`, `controllers`, `diag`, `imucal`, `robot`), `pilot` (lista de cámaras: exponer `pilot.cameraTopics → [{ t, compressed, label }]` desde `buildCameras`), `drawRaw` de `pilot.js`, `TANK`/`siteSvg` de `sites.js` para el minimapa.
- Produces:
  - `WIDGETS: Def[]`, `widgetDef(type) → Def | undefined`, `GROUPS = ['Vídeo', 'Mando', 'Instrumentos', 'Sistema', 'Accesos']`
  - `Def = { type, name, icon, group, desc, size: { w, h, minW, minH }, settings?: [{ k, label, options: () => [{ value, label }] }], mount(el, ctx, settings) → { destroy() } }`
  - `ctx = { sura, ros, pilot, mission, joy, show(view) }`
  - `TEMPLATES: { [key]: { name, items: Item[] } }` con `classic`, `inspection`, `minimal`

Tipos y tamaños por defecto (w×h, mínimo):

| type | w×h | mín | settings |
|---|---|---|---|
| `camera` | 6×7 | 3×3 | `topic` (de `pilot.cameraTopics`; vacío = la que use Pilotar) |
| `modes` | 3×5 | 2×4 | — |
| `pad` | 3×2 | 2×2 | — |
| `battery` | 3×3 | 2×2 | — |
| `heading` | 3×4 | 2×3 | — |
| `attitude` | 3×4 | 2×3 | — |
| `depth` | 2×6 | 2×4 | — |
| `speed` | 3×2 | 2×2 | — |
| `safety` | 3×2 | 2×2 | — |
| `spark` | 3×2 | 2×2 | `what`: profundidad, rumbo, batería, velocidad |
| `minimap` | 3×4 | 2×3 | — |
| `controllers` | 3×4 | 2×3 | — |
| `diagnostics` | 3×3 | 2×2 | — |
| `ping` | 2×2 | 2×2 | — |
| `imu` | 2×2 | 2×2 | — |
| `go-mission`, `go-3d`, `go-plots`, `go-bt` | 2×2 | 2×2 | — |

Cámara: `ros.subscribe(topic, type, …, { throttle_rate: 66, queue_length: 1 })` comprimida, 200 ms en crudo con `drawRaw`; superpone horizonte, regla (`depthTape`), retícula, fps y botón Foto (descarga el fotograma como hace `Pilot.photo`). Al llegar el evento `robot` se resuscribe.

Plantilla `classic`: modos, pad, cámara grande, batería, rumbo, seguridad, profundidad (la misma información que la vista fija). `inspection`: dos cámaras 6×7 lado a lado, debajo profundidad (cinta), rumbo, seguridad y spark de profundidad. `minimal`: cámara 9×12 y modos 3×6.

- [ ] **Step 1:** Implementar los widgets. Cada uno pinta enseguida el último valor conocido (`sura.nav`, `sura.battery`…) y marca «sin datos» con `fresh(…, 3000)` en un `setInterval` de 1 s que `destroy` limpia.
- [ ] **Step 2:** Commit `Panel de Pilotar: catálogo de widgets`.

### Task 5: La vista del panel en Pilotar

**Files:**
- Create: `web/js/dashboard.js`
- Modify: `web/index.html` (`#v-pilot`: selector y `.dash-root`), `web/css/app.css` (bloque «PANEL DE PILOTAR»), `web/js/app.js` (crear `Dashboard`)

**Interfaces:**
- Consumes: Task 1 (motor), Task 4 (`WIDGETS`, `widgetDef`, `TEMPLATES`, `GROUPS`).
- Produces: `class Dashboard { constructor(ctx); setView('classic'|'dash'); }`; añade `dashboard` a `window.sura`.

Comportamiento:
- Selector `Clásica / Mi panel` (`.seg`, `aria-pressed`) en `.cam-top` de la vista clásica y en la barra del panel. Con `dash`: `#v-pilot.dash` oculta `.lcol, .stage, .rcol` y muestra `.dash-root`; al volver a clásica se desmontan todos los widgets (Review Focus 4).
- Barra del panel: nombre del panel actual (menú: cambiar, guardar como, renombrar, borrar, exportar, importar), plantillas, botón «Editar panel» / «Hecho».
- Montaje: un `div.dw` por elemento, posicionado con CSS grid (`grid-column: x+1 / span w; grid-row: y+1 / span h`), filas `grid-auto-rows: max(44px, (alto - huecos) / 12)`. Solo se crean o destruyen los widgets que entran o salen; mover o redimensionar solo cambia el `style` (Review Focus 1).
- Edición: arrastre con pointer events desde la cabecera y tirador de esquina; un fantasma (`.dw-ghost`) muestra la celda destino calculada con `move`/`resize` en cada `pointermove`; al soltar se aplica. Teclado sobre el widget enfocado: flechas mueven, Mayús+flechas redimensionan, Supr quita, Escape sale. Engranaje abre un `popover` con los `settings`.
- Catálogo (solo en edición): panel lateral con tarjetas por `GROUPS`; clic → `add` en el primer hueco; arrastrar → `add` en la celda bajo el puntero.
- Vacío: tarjeta con las tres plantillas y «Abrir catálogo».
- Ancho < 700 px: se dibuja `stack(layout)` (el guardado no cambia) y se desactiva la edición (Review Focus 3).
- Import: `sanitize`; si `layout` vacío y había `dropped`, aviso y no se cambia nada; si `dropped > 0`, aviso con el número (Review Focus 2).
- Guardado en cada cambio en `sura_view.dash`.

- [ ] **Step 1:** HTML y CSS (liquid glass como `.panel`; en edición rejilla punteada de fondo y widgets con sombra más marcada).
- [ ] **Step 2:** `dashboard.js`.
- [ ] **Step 3:** Probar en el navegador (ver «Probar»), a 1366×768, 1920×1080 y 375×812: cargar cada plantilla; arrastrar y redimensionar con datos llegando; añadir del catálogo por clic y por arrastre; ajustes de cámara; teclado; ir a Clásica y volver y comprobar en `window.sura.ros` que no aumentan las suscripciones; exportar, importar el mismo JSON, importar `{"x":1}` (no cambia nada y avisa).
- [ ] **Step 4:** Commit `Pilotar: panel personalizado con widgets`.

### Task 6: Quitar «Personalizar» y documentar

**Files:**
- Delete: `web/js/widgets.js`, `web/js/workspace.js`
- Modify: `web/index.html` (pestaña `data-view="ws"` y `#v-ws`), `web/css/app.css` (bloque WORKSPACE), `web/js/app.js` (import, `show('ws')`, tecla 7 → vuelve a 1–6), `web/js/imucal.js` (el `emit('imucal')` se queda: lo usa el widget `imu`), `README.md` (sección «Pilotar: panel personalizado»)

- [ ] **Step 1:** Quitar y comprobar que la app carga sin errores en consola y que `run.html` sigue en verde.
- [ ] **Step 2:** Commit `Quitar la pestaña Personalizar (sustituida por el panel de Pilotar)`.

## Probar

```bash
cd ~/Desktop/Documentos/CIRTESU/sura_ws_meta/src/sura_view/web && python3 -m http.server 8110
```
Tests: `http://localhost:8110/test/run.html`. La app con datos: compilar y abrir la instancia de `sura_view` del usuario (8097) o una de prueba en otro dominio.
