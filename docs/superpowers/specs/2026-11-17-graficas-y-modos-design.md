# Pestaña «Gráficas» (tipo PlotJuggler) y modos como el mando

## Por qué

En CIRTESU los robots con SURA se manejan con `sura_gcs.launch.py`: el teleop con el mando físico y rviz. Para mirar datos se usa PlotJuggler. `sura_view` tiene que poder sustituir a eso sin que el operador pierda nada:

- los mismos modos que el mando, incluido el depth hold, que hoy falta;
- graficar cualquier topic como en PlotJuggler, sin salir de la app.

## Parte A: modos como el mando

### Cómo funciona hoy en SURA

- El mando cambia de modo con combinaciones. En AUV (R3):
  - RB+LB: Fuerza (`body_force`);
  - RB+X: Velocidad (`body_force` + `body_velocity`);
  - RB+B: Posición (`position_hold`);
  - RB+Y: Estabilizar (`stabilize`);
  - RB+A: Profundidad (`body_force` + `depth_hold`).
- Las combinaciones van por el árbitro: `/<ns>/controller/arbitrator/switch_controller`, con `controller_manager_msgs/SwitchController` y STRICT.
- `control_manager` (SetControlMode) no tiene ni profundidad ni estabilizar. Solo lo usan las acciones autónomas.
- `depth_hold` mantiene la profundidad que tiene el robot al activarse. Acepta otra con `controller/depth_hold/set_point` (`sura_msgs/AuvControllerSetPoint`).
- `sura_teleop` solo sabe qué controladores hay activos cuando los cambia él mismo. Si los cambia otro, sigue con su estado viejo.

### Qué se hace

- **Panel de modos:** los cinco modos del mando, con los mismos nombres y el atajo escrito al lado («RB+A»).
- **Modo activo:** se lee de `/<ns>/controller/controller_manager/list_controllers` cada segundo. Si cambias de modo con el mando, la web lo refleja.
- **Cambiar de modo desde la web:**
  - mismas listas de activar y desactivar que el teleop, filtradas por lo que está activo (STRICT falla si desactivas algo inactivo);
  - se envía por el árbitro;
  - un modo solo se marca activo cuando `list_controllers` lo confirma.
- **Profundidad:** un campo «Mantener a __ m» que publica el `set_point`. Sin tocarlo, el robot mantiene la profundidad que tenía.
- **Armar y desarmar** no cambian: armar = MANUAL en `control_manager`; desarmar = EMERGENCY_STOP.
- **Cambio en `sura_teleop`** (repo propio, rama `bt`): resincronizar los controladores activos cada segundo con el `list_controllers` que ya usa. Solo cuando no hay un cambio en curso. Así el mando respeta un modo puesto desde la web.
- **Teleop por defecto:** `teleop:=joystick`, como `sura_gcs`. El mando en el navegador queda como opción.
- **Robots de superficie:** no se ofrecen Profundidad ni Estabilizar. Lo dice el `robot_family`, igual que en el teleop.

## Parte B: pestaña «Gráficas»

### Lo que pidió el usuario

- Una pestaña con todos los topics actuales.
- Un buscador de topics.
- Arrastrar un campo a una gráfica, como en PlotJuggler.
- Se grafica desde ese momento. No hay historial previo, igual que PlotJuggler hasta que eliges topics.

### Diseño

**Árbol de topics** (columna izquierda):
- Lista de `/rosapi/topics`, refrescada al abrir la pestaña y con un botón.
- El buscador filtra por nombre de topic y de campo. Admite trozos sueltos: «nav pos z» encuentra `/bluerov/navigator/navigation/position/position/z`.
- Al desplegar un topic, sus campos salen de `/rosapi/message_details`, sin suscribirse. Solo se muestran los numéricos y bool, aplanados: `pose/position/z`.
- Arrays:
  - los de tamaño fijo salen por índice;
  - los variables se despliegan con el primer mensaje que llega (`ranges[0..n]`).
  - Los `uint8[]` grandes (`data` de imágenes y nubes) no aparecen.

**Gráficas** (zona derecha):
- Se arrastra un campo, o un topic entero (todos sus campos), sobre una gráfica.
  - En el centro se añade a esa gráfica.
  - En un borde, parte la gráfica en dos (horizontal o vertical) y lo pone en la nueva.
- Varias pestañas de gráficas, como las de PlotJuggler.
- Eje de tiempo compartido por todas las gráficas de la pestaña. Ventana «últimos N s» (10 s por defecto).
- Botón de pausar y reanudar. En pausa se sigue recibiendo y se puede navegar.
- Zoom con la rueda y con un recuadro. Arrastrar con el botón derecho desplaza. Doble clic vuelve a seguir el directo.
- Cursor de tiempo compartido con el valor de cada curva en ese instante.
- Leyenda: clic para ocultar una curva; quitarla con su ✕.
- Gráfica XY: soltar un campo con Mayús sobre una gráfica que tenga una sola curva la convierte en Y frente a X (por ejemplo, norte frente a este).
- Disposición:
  - se guarda sola en el navegador;
  - «Guardar» y «Abrir» la exportan a JSON, para pasarla a otro ordenador;
  - al abrirla se suscribe a lo que haga falta.
- Exportar a CSV lo recibido.

**Datos:**
- Una suscripción de rosbridge por topic, compartida por todas sus curvas. Se quita cuando no queda ninguna curva del topic.
- Llegan todos los mensajes, sin limitar la frecuencia.
- El tiempo es el de llegada. Si el mensaje tiene `header.stamp`, se puede elegir usarlo (es la opción de PlotJuggler).
- **Memoria:** cada curva guarda hasta 10 min (ajustable). Lo más viejo se descarta.
- La suscripción sigue viva aunque cambies a otra pestaña de la app. Los datos no se pierden mientras la app esté abierta.

**Dibujo:**
- Con uPlot, guardado en `web/vendor/` con su licencia MIT, como three.js. Es canvas, rápido con cientos de miles de puntos.
- Colores fijos por orden, que se distinguen sobre el fondo grafito.

### Lo que no entra

- Leer rosbags.
- Fórmulas y transformaciones (derivada, Lua…).
- Publicar en topics desde la pestaña.

Quedan para más adelante si se echan en falta.

## Maneras consideradas

1. **Web con rosbridge** (elegida). Solo se suscribe a lo que se grafica. Es inmediata y funciona desde otro ordenador.
2. **El servidor graba todo.** Daría historial previo, pero el usuario no lo quiere (PlotJuggler tampoco lo tiene). Además, deserializa todo en Python.
3. **Botón que abre el PlotJuggler instalado.** No queda dentro de la app ni sirve en remoto.

## Pruebas

- **Tests de la web** (`web/test/`, en el navegador):
  - aplanar typedefs y mensajes en campos;
  - filtro del buscador;
  - buffer con recorte por tiempo;
  - partir y quitar paneles del layout;
  - guardar y cargar el JSON;
  - listas de activar y desactivar de cada modo según lo activo.
- **Contra Stonefish (mundo de la red):**
  - graficar `navigator/navigation` y una curva de un topic a 100 Hz;
  - poner Profundidad desde la web, comprobar que el mando lo respeta y cambiar la consigna.
