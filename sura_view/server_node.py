"""sura_view_server: lo que el navegador no puede hacer solo.

La web habla con este nodo por rosbridge con JSON sobre std_msgs/String:
  /sura_view/cmd    (web -> nodo)  {"id", "op", "args"}
  /sura_view/reply  (nodo -> web)  {"id", "ok", "data" | "error"}
  /sura_view/state  (1 Hz)         procesos, rosbag, árbol en ejecución, terminal
  /sura_view/log                   líneas de salida de SURA / simulador / rosbag
  /sura_view/bt/status             instantánea del árbol en ejecución
  /sura_view/terminal/{in,out}     terminal con pty (solo si terminal_enabled)
  /sura_view/imu_calib             progreso de la calibración de la IMU (al cambiar)

Ops: robots.list, robot.select, sura.start, sura.stop, ping, bag.start, bag.stop,
bt.list, bt.get, bt.save, bt.run, bt.stop, terminal.open, terminal.close, profile.raw,
imu.calib.status, imu.calib.start, imu.calib.next, imu.calib.cancel.
"""
import json
import math
import os
import re
import subprocess
import time
import uuid

import rclpy
from action_msgs.msg import GoalStatus
from lifecycle_msgs.msg import Transition
from lifecycle_msgs.srv import ChangeState, GetState
from geometry_msgs.msg import PoseStamped
from nav_msgs.msg import Path
from rclpy.action import ActionClient
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import BatteryState
from std_msgs.msg import Bool, String
from tf2_msgs.msg import TFMessage

from . import bt, bundle, imucal, msgfields, processes, profiles

try:
    from sura_actions.action import FollowPath, GoToDepth, GoToPose, Surface
    from sura_actions.srv import SetControlMode
except ImportError:  # permite usar la web sin sura_actions (p. ej. solo herramientas)
    FollowPath = GoToDepth = GoToPose = Surface = SetControlMode = None


MODES = {'MANUAL': 0, 'FOLLOW_PATH': 1, 'SURFACE': 2, 'HOLD_POSITION': 3,
         'EMERGENCY_STOP': 4, 'BODY_VELOCITY': 5}
BT_NAME = re.compile(r'^[A-Za-z0-9_\-]+$')


def yaw_quaternion(yaw):
    return math.cos(yaw / 2.0), math.sin(yaw / 2.0)


def parse_waypoints(text):
    """«x,y,z;x,y,z» -> [(x, y, z)]. Acepta coma decimal si los campos van separados por espacio."""
    pts = []
    for chunk in str(text).split(';'):
        chunk = chunk.strip()
        if not chunk:
            continue
        parts = [p for p in re.split(r'[,\s]+', chunk) if p]
        if len(parts) < 2:
            raise ValueError(f'Waypoint incompleto: «{chunk}»')
        x, y = float(parts[0]), float(parts[1])
        z = float(parts[2]) if len(parts) > 2 else 0.0
        pts.append((x, y, z))
    if not pts:
        raise ValueError('La ruta no tiene waypoints')
    return pts


class ActionLeaf:
    """Hoja de BT que ejecuta una acción ROS 2 y termina cuando el robot devuelve el resultado."""

    def __init__(self, node, client, goal, wait_server_s=5.0):
        self.node, self.client, self.goal = node, client, goal
        self.wait_until = time.monotonic() + wait_server_s
        self.handle = None
        self.send_future = self.result_future = None
        self.done = None

    def tick(self):
        if self.done:
            return self.done
        if self.send_future is None:
            if not self.client.server_is_ready():
                return bt.RUNNING if time.monotonic() < self.wait_until else bt.FAILURE
            self.send_future = self.client.send_goal_async(self.goal)
            return bt.RUNNING
        if self.result_future is None:
            if not self.send_future.done():
                return bt.RUNNING
            self.handle = self.send_future.result()
            if not self.handle.accepted:
                self.done = bt.FAILURE
                return self.done
            self.result_future = self.handle.get_result_async()
            return bt.RUNNING
        if not self.result_future.done():
            return bt.RUNNING
        res = self.result_future.result()
        ok = res.status == GoalStatus.STATUS_SUCCEEDED and getattr(res.result, 'success', True)
        self.done = bt.SUCCESS if ok else bt.FAILURE
        return self.done

    def halt(self):
        if self.handle is not None and self.done is None:
            self.handle.cancel_goal_async()


LIFECYCLE = {'go_to_depth': 'go_to_depth_lifecycle_action_node',
             'go_to_pose': 'go_to_pose_lifecycle_action_node',
             'follow_path': 'path_manager_lifecycle_node'}


class LifecycleGate:
    """Lleva un nodo lifecycle de sura_actions a «active» (configure + activate) sin bloquear."""

    def __init__(self, node, name, timeout_s=10.0):
        self.get = node.create_client(GetState, f'/{name}/get_state')
        self.change = node.create_client(ChangeState, f'/{name}/change_state')
        self.until = time.monotonic() + timeout_s
        self.future = None
        self.step = 'get'

    def tick(self):
        if time.monotonic() > self.until:
            return bt.FAILURE
        if self.step == 'done':
            return bt.SUCCESS
        if self.future is None:
            client = self.get if self.step == 'get' else self.change
            if not client.service_is_ready():
                return bt.RUNNING
            if self.step == 'get':
                self.future = client.call_async(GetState.Request())
            else:
                tid = Transition.TRANSITION_CONFIGURE if self.step == 'configure' else Transition.TRANSITION_ACTIVATE
                self.future = client.call_async(ChangeState.Request(transition=Transition(id=tid)))
            return bt.RUNNING
        if not self.future.done():
            return bt.RUNNING
        res, self.future = self.future.result(), None
        if self.step == 'get':
            label = res.current_state.label
            self.step = 'done' if label == 'active' else 'configure' if label == 'unconfigured' else 'activate'
        elif not res.success:
            return bt.FAILURE
        else:
            self.step = 'activate' if self.step == 'configure' else 'done'
        return bt.SUCCESS if self.step == 'done' else bt.RUNNING


class GatedLeaf:
    """Primero la puerta lifecycle; después la hoja de acción."""

    def __init__(self, gate, make):
        self.gate, self.make, self.leaf = gate, make, None

    def tick(self):
        if self.leaf is None:
            st = self.gate.tick()
            if st != bt.SUCCESS:
                return st
            self.leaf = self.make()
        return self.leaf.tick()

    def halt(self):
        if self.leaf is not None:
            self.leaf.halt()


class ServiceLeaf:
    def __init__(self, client, request, wait_server_s=5.0):
        self.client, self.request = client, request
        self.wait_until = time.monotonic() + wait_server_s
        self.future = None

    def tick(self):
        if self.future is None:
            if not self.client.service_is_ready():
                return bt.RUNNING if time.monotonic() < self.wait_until else bt.FAILURE
            self.future = self.client.call_async(self.request)
            return bt.RUNNING
        if not self.future.done():
            return bt.RUNNING
        res = self.future.result()
        return bt.SUCCESS if res is not None and getattr(res, 'success', True) else bt.FAILURE

    def halt(self):
        pass


class SuraViewServer(Node):
    def __init__(self):
        super().__init__('sura_view_server', namespace='sura_view')
        p = self.declare_parameter
        self.robot = p('robot_namespace', 'bluerov').value.strip('/')
        self.environment = p('environment', 'sim').value
        self.address = p('robot_address', '127.0.0.1').value
        self.user = p('robot_user', 'pi').value
        self.sim_command = p('sim_command', '').value
        self.sura_command = p('sura_command', '').value
        self.real_sura_command = p('real_sura_command', '').value
        self.bag_dir = os.path.expanduser(p('bag_dir', '~/bags').value)
        self.bt_dir = os.path.expanduser(p('bt_dir', '~/.sura_view/bt').value)
        self.bt_builtin_dir = p('bt_builtin_dir', '').value
        self.terminal_enabled = p('terminal_enabled', False).value
        # browser: la web publica /joy. joystick/none: no, para no pelearse con joy_node
        self.teleop = p('teleop', 'joystick').value
        self.terminal_cwd = os.path.expanduser(p('terminal_cwd', '~').value)
        self.frame_id = p('frame_id', 'world_ned').value
        # calibración de la IMU (calibration_wizard de sura_imu); plantillas como sura_command
        self.imu_calib_command = p('imu_calib_command', '').value
        self.real_imu_calib_command = p('real_imu_calib_command', '').value
        self.real_imu_calib_status_command = p('real_imu_calib_status_command', '').value

        self.reply_pub = self.create_publisher(String, 'reply', 10)
        self.state_pub = self.create_publisher(String, 'state', 10)
        self.log_pub = self.create_publisher(String, 'log', 100)
        self.bt_pub = self.create_publisher(String, 'bt/status', 10)
        self.term_pub = self.create_publisher(String, 'terminal/out', 100)
        self.imucal_pub = self.create_publisher(String, 'imu_calib', 10)
        self.create_subscription(String, 'cmd', self.on_cmd, 10)
        self.create_subscription(String, 'terminal/in', self.on_term_in, 100)
        # rosbridge se suscribe a /tf_static como VOLATILE y no recibe las ya publicadas:
        # se guardan aquí (TRANSIENT_LOCAL) y la web las pide con «tf.static»
        self.tf_static = {}
        self.latched = {}    # topic std_msgs/String TRANSIENT_LOCAL -> último texto
        latched = QoSProfile(depth=100, durability=DurabilityPolicy.TRANSIENT_LOCAL,
                             reliability=ReliabilityPolicy.RELIABLE)
        self.create_subscription(TFMessage, '/tf_static', self.on_tf_static, latched)

        self.procs = {name: processes.ManagedProcess(name, self.on_line, self.on_exit)
                      for name in ('sim', 'sura', 'bag', 'imucal')}
        self.imucal = imucal.new_state()
        self.terms = {}
        self.runner = None
        self.bt_name = ''
        self.bt_result = ''
        self.bb = {}
        self.battery = None
        self.leak = False
        self._ros_clients = {}
        self.telemetry_subs = []
        self._subscribe_robot()

        self.create_timer(1.0, self.publish_state)
        self.create_timer(0.1, self.tick_bt)
        self.get_logger().info(f'sura_view_server listo (robot «{self.robot}», {self.environment})')

    # ---------- utilidades ----------
    def ns(self, rel):
        return f'/{self.robot}/{rel}'

    def send(self, pub, obj):
        pub.publish(String(data=json.dumps(obj, ensure_ascii=False)))

    def on_line(self, name, line):
        self.send(self.log_pub, {'src': name, 'line': line, 't': time.time()})
        if name == 'imucal' and imucal.parse_line(self.imucal, line):
            self.send(self.imucal_pub, self.imucal)

    def on_exit(self, name, code):
        self.send(self.log_pub, {'src': name, 'line': f'[{name} terminó con código {code}]',
                                 't': time.time()})
        if name == 'imucal':
            st = self.imucal
            st['running'] = False
            if st['phase'] not in ('done', 'error', 'cancelled'):
                st['phase'], st['error'] = 'error', f'El asistente terminó sin acabar (código {code})'
            elif st['phase'] == 'done' and code:
                st['phase'], st['error'] = 'error', f'Calibración hecha, pero no se pudo instalar el resultado (código {code})'
            st['t'] = time.time()
            self.send(self.imucal_pub, st)

    def _subscribe_robot(self):
        for s in self.telemetry_subs:
            self.destroy_subscription(s)
        self.telemetry_subs = [self.create_subscription(
            BatteryState, self.ns('sensors/battery'), self._on_battery, 10)]
        # leak_broadcaster (ros2_control) publica std_msgs/Bool
        self.telemetry_subs.append(self.create_subscription(
            Bool, self.ns('sensors/leak'), self._on_leak, 10))
        self._ros_clients = {}

    def _on_battery(self, msg):
        pct = msg.percentage * 100.0 if msg.percentage <= 1.0 else msg.percentage
        self.battery = pct if math.isfinite(pct) else None

    def _on_leak(self, msg):
        self.leak = bool(msg.data)

    def client(self, kind, typ, name):
        key = (kind, name)
        if key not in self._ros_clients:
            self._ros_clients[key] = (ActionClient(self, typ, name) if kind == 'action'
                                 else self.create_client(typ, name))
        return self._ros_clients[key]

    # ---------- estado ----------
    def publish_state(self):
        self.send(self.state_pub, {
            'robot': self.robot, 'environment': self.environment, 'address': self.address,
            'processes': {k: v.status() for k, v in self.procs.items()},
            'sim_configured': bool(self.sim_command),
            'bt': {'name': self.bt_name, 'running': self.runner is not None,
                   'result': self.bt_result},
            'terminal_enabled': self.terminal_enabled,
            'teleop': self.teleop,
            'terminals': list(self.terms),
            'bag_dir': self.bag_dir,
            'imucal': self.imucal,
            't': time.time(),
        })

    # ---------- comandos ----------
    def on_cmd(self, msg):
        try:
            req = json.loads(msg.data)
        except json.JSONDecodeError:
            return
        rid, op, args = req.get('id'), req.get('op', ''), req.get('args') or {}
        handler = getattr(self, 'op_' + op.replace('.', '_'), None)
        try:
            if handler is None:
                raise ValueError(f'Operación desconocida: {op}')
            data = handler(args)
            self.send(self.reply_pub, {'id': rid, 'ok': True, 'data': data})
        except Exception as e:  # el error vuelve a la web tal cual, para mostrarlo
            self.send(self.reply_pub, {'id': rid, 'ok': False, 'error': str(e)})
        self.publish_state()

    def on_tf_static(self, msg):
        for tr in msg.transforms:
            t, r = tr.transform.translation, tr.transform.rotation
            self.tf_static[tr.child_frame_id] = {
                'parent': tr.header.frame_id, 'child': tr.child_frame_id,
                't': [t.x, t.y, t.z], 'q': [r.x, r.y, r.z, r.w]}

    def op_tf_static(self, args):
        return list(self.tf_static.values())

    def op_latched_string(self, args):
        """Último std_msgs/String de un topic TRANSIENT_LOCAL (p. ej. robot_description), que
        rosbridge no recibe. La primera llamada se suscribe; las siguientes ya tienen el texto."""
        topic = str(args.get('topic', ''))
        if not topic.startswith('/'):
            raise ValueError('Topic no válido')
        if topic not in self.latched:
            self.latched[topic] = None
            qos = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL,
                             reliability=ReliabilityPolicy.RELIABLE)
            self.create_subscription(String, topic, lambda m, t=topic: self.latched.__setitem__(t, m.data), qos)
        return self.latched[topic]

    def op_msg_fields(self, args):
        return msgfields.fields_for(args.get('types', []))

    def op_robots_list(self, args):
        from ament_index_python.packages import get_package_share_directory
        share = get_package_share_directory('sura_view')
        variants = profiles.load_variants(os.path.join(share, 'config', 'robot_variants.yaml'))
        return profiles.discover(self._description_packages(), variants)

    def _description_packages(self):
        """Paquetes instalados más los robots que lleva sura_view (robots/) y no están instalados."""
        from ament_index_python.packages import get_package_share_directory
        return bundle.description_packages(profiles.installed_packages(),
                                           os.path.join(get_package_share_directory('sura_view'), 'robots'))

    def op_robot_select(self, args):
        name = str(args.get('name', '')).strip('/')
        if not re.fullmatch(r'[a-z][a-z0-9_]*', name):
            raise ValueError('Nombre de robot no válido (minúsculas, números y _)')
        if self.procs['sura'].running and name != self.robot:
            raise RuntimeError('Detén SURA antes de cambiar de robot')
        self.robot = name
        self.environment = args.get('environment', self.environment)
        self.address = str(args.get('address', self.address)).strip()
        self.user = str(args.get('user', self.user)).strip() or self.user
        self._subscribe_robot()
        return {'robot': self.robot, 'environment': self.environment, 'address': self.address}

    # ---------- calibración de la IMU ----------
    def _imu_calib_values(self):
        """{robot}, {output} (el yaml del código fuente, como hace el asistente si se lanza desde
        el workspace) e {installed} (la copia que lee calibration_filter al arrancar SURA)."""
        from ament_index_python.packages import get_package_prefix
        try:
            prefix = get_package_prefix('sura_imu')
        except LookupError:
            raise RuntimeError('sura_imu no está instalado: la calibración de la IMU no está disponible') from None
        installed = os.path.join(prefix, 'share', 'sura_imu', 'config', 'sura_imu_calibration.yaml')
        src = os.path.join(os.path.dirname(os.path.dirname(prefix)), 'src', 'sura_imu', 'config')
        output = os.path.join(src, 'sura_imu_calibration.yaml') if os.path.isdir(src) else installed
        return {'robot': self.robot, 'address': self.address, 'user': self.user,
                'output': processes.quote(output), 'installed': processes.quote(installed)}

    def op_imu_calib_status(self, args):
        text = ''
        if self.environment == 'real':
            cmd = processes.render(self.real_imu_calib_status_command, robot=self.robot,
                                   address=self.address, user=self.user)
            if not cmd:
                raise RuntimeError('No hay real_imu_calib_status_command configurado')
            r = subprocess.run(['bash', '-lc', cmd], capture_output=True, text=True, timeout=15)
            text = r.stdout if r.returncode == 0 else ''
        else:
            try:
                from ament_index_python.packages import get_package_share_directory
                path = os.path.join(get_package_share_directory('sura_imu'), 'config', 'sura_imu_calibration.yaml')
                with open(path, encoding='utf-8') as f:
                    text = f.read()
            except (OSError, LookupError):
                text = ''
        out = imucal.assess(text, self.robot)
        # calibration_filter solo se lanza con el robot real; en simulación la IMU ya viene limpia
        out['applies'] = self.environment == 'real'
        out['environment'] = self.environment
        return out

    def op_imu_calib_start(self, args):
        proc = self.procs['imucal']
        if proc.running:
            raise RuntimeError('Ya hay una calibración en marcha')
        template = self.real_imu_calib_command if self.environment == 'real' else self.imu_calib_command
        self.imucal = {**imucal.new_state(), 'running': True, 'phase': 'starting'}
        proc.start(processes.render(template, **self._imu_calib_values()), stdin=True)
        self.send(self.imucal_pub, self.imucal)
        return self.imucal

    def op_imu_calib_next(self, args):
        if not self.imucal.get('awaiting'):
            raise RuntimeError('El asistente no está esperando')
        self.procs['imucal'].write('\n')
        imucal.started_capture(self.imucal)
        self.send(self.imucal_pub, self.imucal)
        return self.imucal

    def op_imu_calib_cancel(self, args):
        self.imucal = {**self.imucal, 'phase': 'cancelled', 'awaiting': False, 'capturing_since': None,
                       't': time.time()}
        self.procs['imucal'].stop(grace=2.0)
        self.imucal['running'] = False
        self.send(self.imucal_pub, self.imucal)
        return self.imucal

    def op_profile_raw(self, args):
        share = self._description_packages().get(f'{self.robot}_description')
        if not share:
            raise FileNotFoundError(f'No está instalado {self.robot}_description')
        path = os.path.join(share, profiles.PROFILE_PATH)
        with open(path, 'r', encoding='utf-8') as f:
            return {'path': path, 'text': f.read()}

    def op_sura_start(self, args):
        values = {'robot': self.robot, 'address': self.address, 'user': self.user}
        if self.environment == 'sim':
            if self.sim_command and not self.procs['sim'].running:
                self.procs['sim'].start(processes.render(self.sim_command, **values))
            self.procs['sura'].start(processes.render(self.sura_command, **values))
        else:
            self.procs['sura'].start(processes.render(self.real_sura_command, **values))
        return self.procs['sura'].status()

    def op_sura_stop(self, args):
        self.op_bt_stop({})
        self.procs['sura'].stop()
        if args.get('simulator', True):
            self.procs['sim'].stop()
        return self.procs['sura'].status()

    def op_ping(self, args):
        address = args.get('address') or self.address
        t0 = time.time()
        ms = processes.ping(address)
        return {'address': address, 'ms': ms, 'reachable': ms is not None,
                'checked_in_ms': round((time.time() - t0) * 1000)}

    def op_bag_start(self, args):
        os.makedirs(self.bag_dir, exist_ok=True)
        out = os.path.join(self.bag_dir, time.strftime(f'{self.robot}_%Y-%m-%d_%H-%M-%S'))
        topics = args.get('topics') or []
        sel = ' '.join(processes.quote(t) for t in topics) if topics else '-a'
        self.procs['bag'].start(f'ros2 bag record {sel} -o {processes.quote(out)}')
        return {'path': out}

    def op_bag_stop(self, args):
        self.procs['bag'].stop()
        return self.procs['bag'].status()

    # ---------- behaviour trees ----------
    def _bt_dirs(self):
        return [d for d in (self.bt_dir, self.bt_builtin_dir) if d and os.path.isdir(d)]

    def _bt_path(self, name):
        if not BT_NAME.match(name or ''):
            raise ValueError('Nombre de árbol no válido')
        for d in self._bt_dirs():
            path = os.path.join(d, name + '.xml')
            if os.path.isfile(path):
                return path
        raise FileNotFoundError(f'No existe el árbol «{name}»')

    def op_bt_list(self, args):
        seen = {}
        for d in self._bt_dirs():
            for f in sorted(os.listdir(d)):
                if f.endswith('.xml') and f[:-4] not in seen:
                    seen[f[:-4]] = {'name': f[:-4], 'editable': d == self.bt_dir,
                                    'description': self._bt_description(os.path.join(d, f))}
        return {'trees': list(seen.values()), 'leaves': sorted(self.leaf_kinds())}

    def _bt_description(self, path):
        with open(path, 'r', encoding='utf-8') as f:
            m = re.search(r'<!--\s*(.*?)\s*-->', f.read(), re.S)
        return m.group(1).splitlines()[0] if m else ''

    def op_bt_get(self, args):
        path = self._bt_path(args.get('name'))
        with open(path, 'r', encoding='utf-8') as f:
            text = f.read()
        tree = bt.build(text, self.leaf_kinds())
        return {'name': args['name'], 'xml': text, 'tree': tree.snapshot()}

    def op_bt_save(self, args):
        name = args.get('name', '')
        if not BT_NAME.match(name):
            raise ValueError('Nombre de árbol no válido')
        tree = bt.build(args.get('xml', ''), self.leaf_kinds())  # valida antes de guardar
        os.makedirs(self.bt_dir, exist_ok=True)
        with open(os.path.join(self.bt_dir, name + '.xml'), 'w', encoding='utf-8') as f:
            f.write(args['xml'])
        return {'name': name, 'tree': tree.snapshot()}

    def op_bt_run(self, args):
        if self.runner is not None:
            raise RuntimeError(f'Ya se está ejecutando «{self.bt_name}»')
        data = self.op_bt_get(args)
        tree = bt.build(data['xml'], self.leaf_kinds())
        self.bb = {'robot': self.robot}
        self.runner = bt.Runner(tree, self.make_leaf, self.bb)
        self.bt_name, self.bt_result = args['name'], ''
        return {'name': self.bt_name}

    def op_bt_stop(self, args):
        if self.runner is not None:
            self.runner.halt()
            self._publish_bt()
            self.bt_result = 'detenido'
            self.runner = None
        return {'stopped': True}

    def tick_bt(self):
        if self.runner is None:
            return
        try:
            st = self.runner.tick()
        except Exception as e:
            st, self.bt_result = bt.FAILURE, f'error: {e}'
            self.on_line('bt', self.bt_result)
        self._publish_bt()
        if st != bt.RUNNING:
            self.bt_result = self.bt_result or st
            self.on_line('bt', f'«{self.bt_name}» terminó: {st}')
            self.runner = None

    def _publish_bt(self):
        if self.runner is not None:
            self.send(self.bt_pub, {'name': self.bt_name, 'tree': self.runner.tree.snapshot(),
                                    'blackboard': {k: str(v) for k, v in self.bb.items()},
                                    't': time.time()})

    def leaf_kinds(self):
        return {'Wait', 'SetBlackboard', 'BatteryAbove', 'NoLeak', 'Log', 'SetMode',
                'HoldPosition', 'EmergencyStop', 'GoToDepth', 'GoToPose', 'FollowPath', 'Surface'}

    def make_leaf(self, kind, attrs, bb):
        num = lambda key, default=0.0: float(bt.resolve(attrs.get(key, default), bb))  # noqa: E731
        if kind == 'Wait':
            return bt.Wait(attrs, bb)
        if kind == 'SetBlackboard':
            return bt.SetBlackboard(attrs, bb)
        if kind == 'BatteryAbove':
            return bt.Condition(attrs, bb, lambda a, b: self.battery is not None
                                and self.battery > float(bt.resolve(a.get('percent', 30), b)))
        if kind == 'NoLeak':
            return bt.Condition(attrs, bb, lambda a, b: not self.leak)
        if kind == 'Log':
            return bt.Condition(attrs, bb, lambda a, b: self.on_line(
                'bt', str(bt.resolve(a.get('message', ''), b))) or True)
        if SetControlMode is None:
            raise bt.BtError('sura_actions no está instalado')
        if kind in ('SetMode', 'HoldPosition', 'EmergencyStop'):
            mode = {'HoldPosition': 'HOLD_POSITION', 'EmergencyStop': 'EMERGENCY_STOP'}.get(
                kind, str(attrs.get('mode', 'MANUAL')).upper())
            if mode not in MODES:
                raise bt.BtError(f'Modo desconocido «{mode}»')
            req = SetControlMode.Request(mode=MODES[mode], reason=f'sura_view bt {self.bt_name}')
            return ServiceLeaf(self.client('srv', SetControlMode, self.ns('control_manager/set_mode')), req)
        if kind == 'GoToDepth':
            goal = GoToDepth.Goal(target_depth=num('depth'), depth_tolerance=num('tolerance', 0.2),
                                  timeout=num('timeout', 120))
            return self.gated('go_to_depth', lambda: ActionLeaf(self, self.client('action', GoToDepth, self.ns('actions/go_to_depth')), goal))
        if kind == 'Surface':
            goal = Surface.Goal(target_depth=num('depth', 0.0), depth_tolerance=num('tolerance', 0.3),
                                timeout=num('timeout', 120))
            return ActionLeaf(self, self.client('action', Surface, self.ns('actions/surface')), goal)
        if kind == 'GoToPose':
            goal = GoToPose.Goal()
            goal.target_pose = self.pose(num('x'), num('y'), num('z'), math.radians(num('yaw_deg')))
            goal.target_yaw = math.radians(num('yaw_deg'))
            goal.holonomic = str(attrs.get('holonomic', 'true')).lower() == 'true'
            goal.position_tolerance = num('tolerance', 0.5)
            goal.timeout = num('timeout', 300)
            return self.gated('go_to_pose', lambda: ActionLeaf(self, self.client('action', GoToPose, self.ns('actions/go_to_pose')), goal))
        if kind == 'FollowPath':
            goal = FollowPath.Goal()
            goal.path = self.path(parse_waypoints(bt.resolve(attrs.get('waypoints', ''), bb)))
            goal.goal_tolerance = num('tolerance', 0.5)
            goal.max_forward_speed = num('speed', 0.0)
            goal.holonomic = str(attrs.get('holonomic', 'false')).lower() == 'true'
            goal.timeout = num('timeout', 0.0)
            return self.gated('follow_path', lambda: ActionLeaf(self, self.client('action', FollowPath, self.ns('actions/follow_path')), goal))
        raise bt.BtError(f'Hoja desconocida «{kind}»')

    def gated(self, rel, make):
        return GatedLeaf(LifecycleGate(self, LIFECYCLE[rel]), make)

    def pose(self, x, y, z, yaw):
        ps = PoseStamped()
        ps.header.frame_id = self.frame_id
        ps.header.stamp = self.get_clock().now().to_msg()
        ps.pose.position.x, ps.pose.position.y, ps.pose.position.z = x, y, z
        ps.pose.orientation.w, ps.pose.orientation.z = yaw_quaternion(yaw)
        return ps

    def path(self, pts):
        msg = Path()
        msg.header.frame_id = self.frame_id
        msg.header.stamp = self.get_clock().now().to_msg()
        for i, (x, y, z) in enumerate(pts):
            nx, ny = (pts[i + 1][0] - x, pts[i + 1][1] - y) if i + 1 < len(pts) else (0.0, 0.0)
            msg.poses.append(self.pose(x, y, z, math.atan2(ny, nx) if (nx or ny) else 0.0))
        return msg

    # ---------- terminal ----------
    def op_terminal_open(self, args):
        if not self.terminal_enabled:
            raise PermissionError('La terminal está desactivada. Lanza sura_view con terminal:=true.')
        sid = uuid.uuid4().hex[:8]
        cmd = 'bash -i'
        if args.get('target') == 'robot' and self.environment == 'real':
            cmd = f'ssh -t {processes.quote(self.user + "@" + self.address)}'
        self.terms[sid] = processes.PtySession(sid, self._term_out, self._term_exit, cmd,
                                               cwd=self.terminal_cwd)
        return {'sid': sid}

    def op_terminal_close(self, args):
        sess = self.terms.pop(args.get('sid'), None)
        if sess:
            sess.close()
        return {'closed': True}

    def _term_out(self, sid, data):
        self.send(self.term_pub, {'sid': sid, 'data': data})

    def _term_exit(self, sid):
        self.terms.pop(sid, None)
        self.send(self.term_pub, {'sid': sid, 'data': '\r\n[sesión terminada]\r\n', 'closed': True})

    def on_term_in(self, msg):
        try:
            req = json.loads(msg.data)
        except json.JSONDecodeError:
            return
        sess = self.terms.get(req.get('sid'))
        if sess is None:
            return
        if 'rows' in req:
            sess.resize(int(req['rows']), int(req['cols']))
        if 'data' in req:
            sess.write(req['data'])

    def shutdown(self):
        if self.runner is not None:
            self.runner.halt()
        for sess in list(self.terms.values()):
            sess.close()
        for proc in self.procs.values():
            proc.stop(grace=5.0)


def main():
    rclpy.init()
    node = SuraViewServer()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.shutdown()
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == '__main__':
    main()
