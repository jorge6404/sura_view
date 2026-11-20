# Panel personalizado en Pilotar

Fecha: 2026-11-20 · Estado: propuesto

## Por qué

El operador quiere montar su propia pantalla de pilotaje con los widgets que le sirvan, en
lugar de la distribución fija de Pilotar. Un primer intento (pestaña «Personalizar», hecha con
un modelo local) validó la idea pero no la ejecución: lienzo de celdas fijas de 160 px que no
llena la pantalla, widgets que se pisan, la mitad de los widgets eran texto de relleno.

## Objetivos

- En Pilotar, un selector **Clásica / Mi panel**. La vista clásica no cambia.
- **Mi panel** es una cuadrícula libre: el usuario pone, quita, mueve y redimensiona lo que quiera.
  Nada es obligatorio (si no pone cámara, no hay cámara).
- Widgets de verdad, con datos reales y el mismo acabado que el resto de la app (liquid glass,
  tokens de `app.css`, DESIGN.md).
- Plantillas y paneles guardados con nombre; exportar/importar JSON.
- Funciona sin internet (nada nuevo en `vendor/`).

## No objetivos

- Paneles compartidos entre navegadores u operadores (se guarda en `localStorage`).
- Meter Misión, Vista 3D, Gráficas o BT completos dentro del panel: tienen un solo lienzo cada una.
  En el panel son accesos que abren su pestaña.

## Anti-objetivos (sería un fracaso aunque funcione)

- Mover un widget sin querer mientras se pilota.
- Un widget que enseña un valor viejo como si fuera actual (PRODUCT.md: estado real siempre).
- Perder el panel del usuario por un error al cargar o al importar.
- Romper o ralentizar la vista clásica.

## Enfoques considerados

| Enfoque | A favor | En contra |
|---|---|---|
| Arreglar el lienzo de «Personalizar» | Código ya escrito | Celdas fijas, no llena la pantalla, solapes; habría que reescribirlo igual |
| Librería (gridstack.js) | Probada | Dependencia nueva en `vendor/` para ~200 líneas de lógica; estilo ajeno al de la app |
| **Motor de cuadrícula propio (elegido)** | Encaja con la app, lógica pura y testeable, sin dependencias | Hay que escribirlo y probarlo |

Decidido con el usuario: cuadrícula libre sin widgets obligatorios; el resto del *cómo* lo deja
en nuestras manos.

## Diseño

### Dónde vive

- `#v-pilot` gana un control segmentado **Clásica / Mi panel** (en la barra de la cámara o, en
  modo panel, en la barra del panel). Con «Mi panel», `#v-pilot` lleva la clase `dash`: se ocultan
  `.lcol`, `.stage` y `.rcol` y se muestra `.dash-root`, que ocupa toda la vista.
- La elección se recuerda (`localStorage`).
- Se elimina la pestaña «Personalizar» (`widgets.js`, `workspace.js`, su sección de `index.html`,
  su bloque de `app.css`, la tecla 7). Lo aprovechable de sus widgets pasa a los nuevos.

### Ficheros

- `web/js/dashgrid.js`: motor de cuadrícula, **sin DOM** (funciones puras).
- `web/js/dashwidgets.js`: catálogo de widgets.
- `web/js/dashboard.js`: la vista (bloqueo/edición, arrastre, catálogo, plantillas, guardado).
- `web/test/dashgrid.test.mjs`: tests del motor (en `web/test/run.html`).

### Motor de cuadrícula (`dashgrid.js`)

- 12 columnas. Un elemento es `{ id, type, x, y, w, h, settings }` en unidades de celda.
- Alto de fila = alto del panel / 12 (mínimo 44 px): una plantilla de 12 filas llena la pantalla
  justa; si hay más filas, el panel hace scroll vertical.
- Funciones: `collides`, `move(layout, id, x, y)`, `resize(layout, id, w, h)`, `add(layout, item)`
  (primer hueco libre), `remove`, `compact` (sube todo lo que pueda, como Grafana) y `clamp` a
  12 columnas y a los mínimos de cada widget. Al mover o redimensionar, lo que choca baja; luego
  se compacta. Nunca hay solapes.
- Validación al cargar o importar: los elementos con tipo desconocido o medidas absurdas se
  descartan con aviso; si el JSON no vale, el panel actual no se toca.

### Bloqueado y edición

- **Bloqueado** (por defecto): los widgets se usan (botones, interruptores), pero no se mueven.
- **Editar panel**: fondo con la rejilla visible, asa de arrastre en la cabecera de cada widget,
  tirador de tamaño en la esquina, botón de quitar y engranaje de ajustes (si el widget los
  tiene). Un fantasma muestra dónde caerá el widget mientras se arrastra. Se sale con «Hecho» o
  con Escape.
- Teclado en edición: flechas mueven el widget enfocado, Mayús+flechas lo redimensionan, Supr lo
  quita.
- Catálogo lateral (solo en edición): tarjetas por grupos (Vídeo, Mando, Instrumentos, Sistema,
  Accesos) con icono, descripción y tamaño; se arrastran al panel o se añaden con un clic (van al
  primer hueco).
- Panel vacío: invita a elegir una plantilla o a abrir el catálogo.

### Widgets

Contrato: `{ type, name, icon, group, desc, size: { w, h, minW, minH }, settings?, mount(el, ctx, settings) → { destroy() } }`
con `ctx = { sura, ros, pilot, mission, joy, actions }`. Cada widget se suscribe a lo que necesita
y lo suelta en `destroy`. Los valores se marcan «sin datos» cuando su sello tiene más de 3 s
(`fresh()`), como en la vista clásica. Se puede poner más de uno del mismo tipo.

| Grupo | Widget | Qué hace |
|---|---|---|
| Vídeo | Cámara | Su propio topic (ajuste), con horizonte, regla de profundidad, retícula, fps, foto |
| Mando | Modos de control | Los botones de modo, consigna de profundidad y Emerger; misma lógica que la vista clásica |
| Mando | Mando y autonomía | Estado del mando, autónomo/manual, ceder control en simulación |
| Instrumentos | Batería | Porcentaje, celdas, tensión, corriente e historial |
| Instrumentos | Rumbo | Rosa de los vientos animada |
| Instrumentos | Horizonte artificial | Cabeceo y alabeo |
| Instrumentos | Profundidad | Cinta vertical con profundidad, altitud al fondo y consigna |
| Instrumentos | Velocidad | Avance, lateral y vertical |
| Instrumentos | Seguridad | Fugas, watchdog y presión, con color de estado |
| Instrumentos | Mini-gráfica | Último minuto de una magnitud (ajuste: profundidad, rumbo, batería, velocidad) |
| Sistema | Minimapa | Posición, rastro y lugar (tanque/puerto/propio) como el de Pilotar |
| Sistema | Controladores | Interruptores reales (`sura.toggleController`) |
| Sistema | Diagnóstico | Resumen y lo peor primero |
| Sistema | Ping | Latencia al robot |
| Sistema | Calibración IMU | Estado y botón para abrir el asistente |
| Accesos | Misión / Vista 3D / Gráficas / Behaviour trees | Abren su pestaña |

La lógica de los modos (armar con un modo, `setCtrlMode`, consigna, Emerger) hoy está en
`app.js`; se saca a funciones compartidas para que la vista clásica y el widget hagan lo mismo.

### Plantillas y guardado

- Plantillas: **Clásica** (lo mismo que la vista fija), **Inspección** (dos cámaras grandes,
  profundidad, rumbo, seguridad), **Mínima** (cámara y modos).
- Paneles con nombre: guardar como, cambiar entre ellos, borrar; exportar/importar JSON.
- `localStorage['sura_view.dash'] = { view: 'classic'|'dash', current, layouts: { nombre: [items] } }`,
  todo con `try/catch` (si el almacenamiento falla, el panel funciona igual en la sesión).

### Aspecto

Liquid glass como los `.panel` actuales; cabeceras compactas (icono, título, acciones solo en
edición). Instrumentos dibujados en SVG que escalan con el tamaño del widget; los números en
Barlow Condensed como el resto. En edición, los widgets se separan un poco del fondo y aparece la
rejilla; las transiciones respetan `prefers-reduced-motion`. Funciona en táctil (objetivos de 44 px).

## A cargo del constructor

- La distribución exacta de cada widget por dentro y sus tamaños por defecto.
- Cómo reutilizar el dibujo de la brújula, el minimapa y la regla de profundidad de `pilot.js`
  (extraer funciones o duplicar lo mínimo).
- El aspecto concreto del catálogo y del fantasma de arrastre.
