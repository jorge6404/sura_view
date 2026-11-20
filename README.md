# sura_view

Estación de tierra web para robots SURA: pilotar con cámara, misiones en el mapa, vista 3D tipo rviz2, gráficas, behaviour trees y diagnóstico, en simulación y en real, desde el navegador.

sura_view es un paquete de ROS 2 Humble. Lanza un servidor web y rosbridge, y cualquier navegador de la red abre la estación en `http://<ordenador>:8095`. Todo lo que necesita está dentro de esta carpeta: la web, sus librerías, sus fuentes y una copia ligera de los robots (URDF y mallas 3D). No hace falta internet ni ningún paquete `*_description`.

## Índice

- [Contexto](#contexto)
- [Instalación](#instalación)
- [Uso](#uso)
- [Robots incluidos](#robots-incluidos)
- [Qué hay en la estación](#qué-hay-en-la-estación)
- [Cómo funciona](#cómo-funciona)
- [Desarrollo](#desarrollo)
- [Limitaciones conocidas](#limitaciones-conocidas)
- [Mantenedores](#mantenedores)
- [Contribuir](#contribuir)
- [Licencia](#licencia)

## Contexto

SURA (Surface and Underwater Robotic Architecture) es la arquitectura de los robots del CIRTESU (Universitat Jaume I). Su workspace es [sura_ws_meta](https://github.com/slopezba/sura_ws_meta), que reúne los paquetes con `workspace.repos`. sura_view se pone en el `src/` de ese workspace, al lado de los demás.

La interfaz mezcla Blue Robotics Cockpit (la cámara en el centro) e IQUAview (el mapa con capas y el editor de misión), y añade una vista 3D tipo rviz2. Lo primero que se ve es lo necesario para mover el robot; las herramientas de desarrollador están en el menú ☰.

## Instalación

### Requisitos

- Ubuntu 22.04 con [ROS 2 Humble](https://docs.ros.org/en/humble/Installation.html) (`ros-humble-desktop` o `ros-humble-ros-base`).
- `python3-rosdep` y `python3-colcon-common-extensions`.
- Un navegador actual: Firefox, Chrome o Edge.

### Pasos

Los comandos van desde la raíz del workspace (aquí, `~/sura_ws_meta`).

1. Pon sura_view en `src/`. Está en `workspace.repos` de sura_ws_meta, así que `vcs import` ya lo trae:

   ```bash
   cd ~/sura_ws_meta
   vcs import src < workspace.repos
   ```

   En otro workspace, clónalo a mano:

   ```bash
   git clone https://github.com/jorge6404/sura_view.git src/sura_view
   ```

2. Comprueba que está `sura_msgs`. Con `vcs import` ya viene. En otro workspace:

   ```bash
   git clone https://github.com/inesperez03/sura_msgs.git src/sura_msgs
   ```

3. Instala las dependencias de ROS (rosbridge, rosapi, xacro, rosbag…):

   ```bash
   source /opt/ros/humble/setup.bash
   rosdep install --from-paths src --ignore-src -y
   ```

4. Compila sura_view y lo que necesita:

   ```bash
   colcon build --packages-up-to sura_view
   ```

5. Carga el workspace. Hazlo en cada terminal nueva:

   ```bash
   source install/setup.bash
   ```

### Qué necesita y qué es opcional

| Paquete | ¿Hace falta? | Para qué |
|---|---|---|
| ROS 2 Humble, rosbridge_server, rosapi, xacro, ros2bag | Sí (los instala `rosdep`) | Base de todo |
| `sura_msgs` | Sí | Para que rosbridge traduzca los mensajes de SURA (telemetría, navegación) |
| `*_description` de los robots | **No** | sura_view lleva su copia en [robots/](robots/); si el paquete está instalado, se usa el instalado |
| `sura_actions` | Opcional | Misiones, modos de control y behaviour trees |
| `sura_teleop` | Opcional | Mando de juego; sin él, el launch avisa y sigue |
| `sura_imu` | Opcional | Asistente de calibración de la IMU |
| `sura_bringup` y el resto de SURA | Opcional | Botón «Lanzar SURA» desde la web (si SURA corre en otro sitio, no hace falta) |

Para la capa de satélite del mapa hace falta internet. Todo lo demás funciona sin conexión.

## Uso

### Arrancar

```bash
source /opt/ros/humble/setup.bash
source install/setup.bash
ros2 launch sura_view sura_view.launch.py robot_namespace:=bluerov
```

Abre **http://localhost:8095** en el navegador. Desde otro ordenador de la red, usa la IP de este: `http://192.168.x.x:8095`.

La primera pantalla pregunta con qué robot trabajas (BlueROV o CIRTESUB, con sus versiones), dónde está (simulación o robot real) y qué lleva montado. Después se abre Pilotar.

### Argumentos del launch

| Argumento | Por defecto | Qué hace |
|---|---|---|
| `robot_namespace` | `bluerov` | Robot con el que se empieza (se cambia luego en la web) |
| `http_port` | `8095` | Puerto de la web. Si está ocupado: `http_port:=8097` |
| `ws_port` | `9090` | Puerto de rosbridge. La web lo usa salvo que la abras con `?ws=ws://otro:9090` |
| `teleop` | `joystick` | `joystick`: `teleop.launch.py` de `sura_teleop` con `joy_node` (manda el mando físico; la web solo cambia el modo). `browser`: el mando conectado al navegador publica `/joy`. `none`: sin teleop |
| `terminal` | `false` | `true` activa la terminal de la web. Es una shell con tu usuario: actívala solo en redes de confianza |
| `sim_command` | vacío | Comando que arranca el simulador al pulsar «Lanzar SURA» en simulación. Vacío: arráncalo tú aparte |
| `environment`, `robot_address` | de [config/sura_view.yaml](config/sura_view.yaml) | Sustituyen a los valores del fichero |

El resto de la configuración (comandos de SURA en simulación y en real por ssh, carpeta de rosbags y de árboles) está en [config/sura_view.yaml](config/sura_view.yaml).

### Ejemplo: con el simulador Stonefish

Dos terminales con el mismo `ROS_DOMAIN_ID`. En la primera, el simulador:

```bash
source /opt/ros/humble/setup.bash
source <workspace_de_stonefish>/install/setup.bash
export ROS_DOMAIN_ID=47
ros2 launch bluerov_stonefish bluerov_cirtesu.launch.py
```

En la segunda, sura_view:

```bash
cd ~/sura_ws_meta
source /opt/ros/humble/setup.bash && source install/setup.bash
export ROS_DOMAIN_ID=47
ros2 launch sura_view sura_view.launch.py robot_namespace:=bluerov teleop:=browser
```

Abre http://localhost:8095, elige «Simulación» y pulsa «Lanzar SURA», que arranca `sura_bringup` contra el simulador. `teleop:=browser` es para usar un mando conectado al navegador en lugar de uno físico.

### Ejemplo: con el robot real

Mismo `ROS_DOMAIN_ID` que el robot y en su red:

```bash
ros2 launch sura_view sura_view.launch.py robot_namespace:=bluerov environment:=real robot_address:=192.168.2.2
```

En la primera pantalla, elige «Robot real». «Lanzar SURA» entra por ssh en el robot y lanza `sura_bringup` dentro de su contenedor Docker. Para eso necesita una clave SSH sin contraseña hacia el robot. El comando es `real_sura_command` en [config/sura_view.yaml](config/sura_view.yaml).

## Robots incluidos

La pantalla de inicio y la vista 3D necesitan, de cada robot, su `bringup_description.yaml`, su URDF y sus mallas. Normalmente están en su paquete `*_description`. Para no depender de él, sura_view lleva una copia en [robots/](robots/):

| Robot | Versiones |
|---|---|
| `bluerov` | Sin brazo (`bigblue.urdf.xacro`) y con brazo Reach (`bluerov_reach.urdf.xacro`) |
| `cirtesub` | Sin brazos (`cirtesub.urdf.xacro`) y con dos brazos Alpha (`cirtesub_dual_alpha.urdf.xacro`) |

Qué lleva cada copia:

- el `config/bringup_description.yaml` del paquete;
- el URDF de cada versión ya generado con xacro, para simulación y para real;
- solo las mallas visuales, reducidas a unos 120 000 triángulos y en `.glb` (31 MB en total, frente a unos 150 MB de los originales).

Orden de búsqueda: si el `*_description` está instalado en el workspace, se usa ese, con sus mallas originales. Si no, la copia. Las mallas que pide un robot real por su `robot_description` (`package://bluerov_description/...dae`) también salen de la copia.

**Actualizar la copia** (solo quien mantiene el paquete, cuando cambia un robot): hace falta el workspace con los `*_description` compilado y Blender 3.x (`sudo apt install blender`).

```bash
source install/setup.bash
python3 src/sura_view/tools/bundle_robots.py
```

**Añadir un robot:** pon sus versiones en [config/robot_variants.yaml](config/robot_variants.yaml) y vuelve a ejecutar `bundle_robots.py`. Su paquete tiene que tener `config/bringup_description.yaml`, y sus xacro tienen que aceptar los argumentos `robot_name` y `environment`.

## Qué hay en la estación

### Pilotar

Tiene dos vistas: **Clásica** (distribución fija) y **Mi panel**, una cuadrícula de 12 columnas que montas tú con widgets. La elección se recuerda.

- **Editar panel** muestra la rejilla, el catálogo y las asas:
  - arrastrar por la cabecera mueve y la esquina cambia el tamaño;
  - el engranaje abre los ajustes y la × quita el widget;
  - con teclado, las flechas mueven, Mayús+flechas cambian el tamaño, Supr quita y Escape sale.
- **Al pilotar, el panel está bloqueado:** los botones de los widgets funcionan, pero nada se mueve.
- **Editando no se puede pulsar nada dentro de los widgets,** para no armar sin querer.
- **Nunca hay solapes:** al mover o cambiar el tamaño, lo que choca baja y luego todo sube lo que puede ([dashgrid.js](web/js/dashgrid.js)).
- **Widgets** ([dashwidgets.js](web/js/dashwidgets.js)):
  - **Cámara:** con su propio topic, horizonte, retícula, fps y foto. Se pueden poner varias.
  - **Control:** armar, modos de control, mando y autonomía.
  - **Instrumentos:** batería, rumbo, horizonte artificial, cinta de profundidad (con la consigna de depth hold), velocidad, seguridad, mini-gráfica del último minuto y minimapa.
  - **Sistema:** controladores (interruptores reales), diagnóstico, ping y calibración de la IMU.
  - **Terminal:** un emulador xterm.js de verdad (cursor, colores, `htop`, `vim`, `claude`). Ctrl+Mayús+C copia y Ctrl+Mayús+V pega. Sigue viva al salir de Pilotar y se cierra al quitar el widget. Necesita `terminal:=true`.
  - **Vista 3D:** el lienzo de la pestaña 3D, con Órbita, Cenital o Seguir. Solo una por panel.
  - **Accesos** a Misión, Gráficas y BT.
- **Datos viejos:** un valor que lleva más de 3 s sin llegar sale como «sin datos».
- **Paneles con nombre:** se pueden crear, duplicar, renombrar, borrar, exportar e importar en JSON. Hay tres plantillas: Clásica, Inspección (dos cámaras) y Mínima.
- **Dónde se guarda:** en el navegador (`localStorage['sura_view.dash']`). Para pasar un panel a otro navegador, exporta e importa.
- **Pantallas estrechas:** por debajo de 700 px el panel se ve en una columna y no se edita.

### Misión y mapa

«Lugar» elige el fondo del mapa (también lo usa el minimapa):

- **Tanque CIRTESU:** la piscina de 12 × 8 m con sus 9 ArUcos.
- **Puerto (satélite):** teselas de Esri World Imagery alrededor del `datum` de `bringup_description.yaml`. Necesita internet.
- **Mapa propio:** una imagen que colocas en tres pasos: la escala, dónde está el robot y el giro.

«Fijar pose del robot» funciona como «2D Pose Estimate» de rviz:

- **Uso:** pulsa donde está el robot y arrastra hacia donde mira.
- **Mensaje:** publica en `/<robot>/set_pose`, en el marco `<robot>/map` (ENU).
- **Si nadie escucha ese topic,** la web lo avisa.

### Vista 3D

Copia de rviz2 hecha con three.js ([viz3d.js](web/js/viz3d.js), [vizdisplays.js](web/js/vizdisplays.js), [urdf.js](web/js/urdf.js)).

- **Displays:**
  - Cuadrícula, Ejes, TF y Modelo del robot.
  - Rastro del navigator y Misión.
  - Nube de puntos, Láser y Range.
  - Imagen, Marcadores (todos menos los interactivos), Pose, PoseArray, Camino, Odometría, Polígono, Fuerza y par, y Mapa (OccupancyGrid).
  - Se añaden por tipo o por topic.
- **Modelo del robot:** el URDF del robot elegido (ver [Robots incluidos](#robots-incluidos)) o el de un topic `robot_description`. Lo coloca `/tf`; si nadie publica el `base_link`, lo coloca `navigator/navigation`.
- **Cámara:** Órbita, Cenital y Tercera persona. El ratón va como en rviz.
- **Herramientas:** Medir, Publicar punto, Pose inicial 2D y Meta 2D.
- **Configuración:** se guarda en el navegador y se exporta o abre en JSON.

### Gráficas

Pestaña tipo PlotJuggler, en directo.

- **Montar una gráfica:** arrastra un campo o un topic entero a una gráfica. Al soltar en el borde, la gráfica se parte en dos; con Mayús pasa a ser XY.
- **Navegar:** zoom con la rueda o con un recuadro, y pausa.
- **Varias pestañas.**
- **Exportar:** la disposición en JSON y los datos en CSV.

### Behaviour trees

Están en ☰ → Behaviour trees. Son XML de BehaviorTree.CPP v3:

- **Ejemplos:** en [bt/](bt/).
- **Los tuyos:** se guardan en `~/.sura_view/bt`.
- **Hojas:** `GoToDepth`, `GoToPose`, `FollowPath`, `Surface`, `SetMode`, `HoldPosition`, `EmergencyStop`, `Wait`, `BatteryAbove`, `NoLeak`, `SetBlackboard` y `Log`.

### Calibrar la IMU

Está en ☰ → Calibrar la IMU, y la web avisa si la calibración no vale.

- **Quién calibra:** lanza el `calibration_wizard` de `sura_imu` y te guía por los pasos (giróscopo, magnetómetro y brújula), con el modelo 3D haciendo el movimiento.
- **Dónde guarda:** el resultado va a `sura_imu_calibration.yaml`.

### Desarrollador

Está en ☰ → Terminal, topics y logs. Tiene:

- la lista de topics con `echo`;
- terminales (con `terminal:=true`);
- `/rosout` con filtro por nivel.

## Cómo funciona

```
navegador ──http──▶ sura_view_web     (web/, robots/, /urdf, /pkg/…)
    │
    └──ws────▶ rosbridge + rosapi ◀──ROS 2──▶ SURA / simulador
                    ▲
                    └── sura_view_server (/sura_view/*)
```

- **`sura_view_web`** ([web_server.py](sura_view/web_server.py)) sirve la web con `Cache-Control: no-store`, para que tras recompilar baste con recargar la página. Además da dos rutas:
  - `/urdf?package=&xacro=&robot_name=&environment=`: el URDF, generado con xacro o sacado de [robots/](robots/);
  - `/pkg/<paquete>/<ruta>`: las mallas de las `package://`. Solo sirve ficheros dentro del paquete y con extensión de malla o imagen.
- **`sura_view_server`** ([server_node.py](sura_view/server_node.py)) hace lo que el navegador no puede hacer solo. Habla con la web por JSON sobre `std_msgs/String` (`/sura_view/{cmd,reply,state,log}`) y se encarga de:
  - lanzar y detener SURA y el simulador;
  - el ping y la grabación de rosbags;
  - las terminales con pty y el ejecutor de behaviour trees;
  - la lista de robots y las `/tf_static`, que rosbridge no recibe.
- **La web** ([web/](web/)) no tiene paso de build. three.js, xterm.js, lucide y las fuentes Barlow están en `web/vendor` y `web/fonts`.

Interfaces de SURA que usa:

| Uso | Interfaz |
|---|---|
| Telemetría | `/<robot>/navigator/navigation` (`sura_msgs/Navigator`), `sensors/battery`, `sensors/pressure`, `sensors/leak`, `safety/robot_watchdog`, `/diagnostics_agg` |
| Cámaras | Cualquier `sensor_msgs/CompressedImage` o `Image` bajo `/<robot>/` |
| Armar / desarmar | `/<robot>/control_manager/set_mode`: armar = `MANUAL` y luego el modo elegido; desarmar = `EMERGENCY_STOP` |
| Modos del mando | `/<robot>/controller/arbitrator/switch_controller` (STRICT); el modo activo se lee de `controller/controller_manager/list_controllers` |
| Acciones | `/<robot>/actions/{go_to_depth,go_to_pose,follow_path,surface}` (nodos lifecycle: la web los configura y activa) |
| Autonomía | `/<robot>/teleop/autonomous_enabled`: `sura_teleop` solo cede el control mientras se mantiene LT |

## Desarrollo

Tests:

```bash
cd src/sura_view
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest -q test   # Python: árboles, perfiles, procesos, robots incluidos
python3 web/test/run_headless.py                             # web, sin Node: run.html en Firefox sin ventana
node --test web/test/                                        # web, si tienes Node
```

Cómo está organizado el paquete:

| Carpeta | Qué hay |
|---|---|
| `sura_view/` | Nodos de Python (servidor, web, perfiles, robots incluidos) |
| `web/` | La web: `js/`, `css/`, `vendor/` (librerías con sus licencias), `test/` |
| `robots/` | Copia de los robots. La genera `tools/bundle_robots.py`; no se edita a mano |
| `config/` | `sura_view.yaml` (comandos y carpetas) y `robot_variants.yaml` (versiones de cada robot) |
| `bt/` | Behaviour trees de ejemplo |
| `docs/` | Diseños y planes de las funciones |

Tras cambiar la web: `colcon build --packages-select sura_view` y recargar el navegador con Ctrl+Mayús+R.

## Limitaciones conocidas

- **Vista 3D:** faltan los interactive markers, las cámaras como display, la selección con el ratón y leer ficheros `.rviz`.
- **Jaula virtual:** solo avisa en la web; SURA no la aplica.
- **Profundidad en simulación:** la consigna llega a `depth_hold/set_point`, pero el robot se queda a la profundidad a la que se activó. `GoToDepth` hace lo mismo; queda por revisar en los controladores de SURA.
- **Copia de los robots:** no se actualiza sola. Si cambia un `*_description`, hay que volver a ejecutar `bundle_robots.py`.

## Mantenedores

jorge ([jorgee6404@gmail.com](mailto:jorgee6404@gmail.com)), CIRTESU, Universitat Jaume I.

## Contribuir

Abre un issue o una pull request. Antes de enviar cambios, pasa los tests de [Desarrollo](#desarrollo). El código y los commits van en español.

## Licencia

Pendiente: `package.xml` aún dice `TODO`. Las librerías incluidas tienen la suya:

- three.js y xterm.js: MIT ([web/vendor/LICENSE](web/vendor/LICENSE), [web/vendor/xterm/LICENSE](web/vendor/xterm/LICENSE));
- lucide: ISC ([web/vendor/LICENSE-lucide](web/vendor/LICENSE-lucide));
- Barlow: OFL ([web/fonts/OFL.txt](web/fonts/OFL.txt)).
