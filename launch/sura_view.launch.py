# sura_view: rosbridge + rosapi + la web + sura_view_server (+ teleop para el mando).
# Abrir http://<host>:8095/ (la web usa ws://<host>:9090 salvo ?ws=).
#
#   ros2 launch sura_view sura_view.launch.py robot_namespace:=bluerov
#   ros2 launch sura_view sura_view.launch.py teleop:=joystick terminal:=true
#
# teleop: browser  -> el mando conectado al navegador publica /joy y aquí se lanza
#                     solo el nodo sura_teleop (sin joy_node)
#         joystick -> teleop.launch.py de sura_teleop tal cual (joy_node + sura_teleop)
#         none     -> nada (si ya tienes sura_gcs.launch.py abierto)

import importlib.util
import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import (DeclareLaunchArgument, IncludeLaunchDescription, LogInfo,
                            OpaqueFunction)
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def teleop_actions(robot, mode):
    if mode == 'none':
        return []
    try:
        teleop_launch = os.path.join(get_package_share_directory('sura_teleop'), 'launch',
                                     'teleop.launch.py')
    except LookupError:   # sura_teleop es opcional: sin él no hay mando, el resto funciona
        return [LogInfo(msg='[sura_view] sura_teleop no está instalado: sin mando (teleop:=none para no ver este aviso)')]
    if mode == 'joystick':
        return [IncludeLaunchDescription(PythonLaunchDescriptionSource(teleop_launch),
                                         launch_arguments={'robot_namespace': robot}.items())]
    # browser: se reutilizan las funciones de teleop.launch.py para no duplicar su lógica
    spec = importlib.util.spec_from_file_location('sura_teleop_launch', teleop_launch)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    try:
        env, desc_pkg, xacro = mod.robot_profile_for_namespace(robot)
        family = mod.robot_family_for_namespace(robot, env, desc_pkg, xacro)
        params = mod.namespaced_config(
            mod.config_for_robot(get_package_share_directory('sura_teleop'), robot, env), robot)
    except Exception as e:  # p. ej. robot sin teleop_params_<robot>_<env>.yaml
        return [LogInfo(msg=f'[sura_view] Sin teleop para «{robot}»: {e}')]
    return [Node(package='sura_teleop', executable='cirtesub_teleop', name='sura_teleop',
                 namespace=robot, output='screen',
                 parameters=[params, {'robot_family': family}])]


def setup(context):
    cfg = lambda name: LaunchConfiguration(name).perform(context)  # noqa: E731
    robot = cfg('robot_namespace').strip('/')
    share = get_package_share_directory('sura_view')
    overrides = {'robot_namespace': robot,
                 'terminal_enabled': cfg('terminal').lower() == 'true',
                 'teleop': cfg('teleop'),
                 'bt_builtin_dir': os.path.join(share, 'bt')}
    for key in ('environment', 'robot_address', 'sim_command'):
        if cfg(key):
            overrides[key] = cfg(key)
    return [
        Node(package='rosbridge_server', executable='rosbridge_websocket',
             name='rosbridge_websocket', output='screen',
             # una meta de acción o un servicio lento no deben bloquear el resto del puente
             parameters=[{'port': int(cfg('ws_port')),
                          'call_services_in_new_thread': True,
                          'send_action_goals_in_new_thread': True,
                          'default_call_service_timeout': 5.0}]),
        Node(package='rosapi', executable='rosapi_node', name='rosapi', output='screen'),
        Node(package='sura_view', executable='sura_view_server', name='sura_view_server',
             namespace='sura_view', output='screen',
             parameters=[os.path.join(share, 'config', 'sura_view.yaml'), overrides]),
        # Web estática: sin dependencias externas, funciona sin internet
        Node(package='sura_view', executable='sura_view_web', name='sura_view_web', output='log',
             arguments=[cfg('http_port'), '--directory', os.path.join(share, 'web')]),
        LogInfo(msg=f'[sura_view] Abre http://localhost:{cfg("http_port")}/'),
    ] + teleop_actions(robot, cfg('teleop'))


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument('robot_namespace', default_value='bluerov'),
        DeclareLaunchArgument('environment', default_value='',
                              description='sim | real. Vacío = valor del config'),
        DeclareLaunchArgument('robot_address', default_value=''),
        DeclareLaunchArgument('sim_command', default_value=''),
        DeclareLaunchArgument('http_port', default_value='8095'),
        DeclareLaunchArgument('ws_port', default_value='9090'),
        DeclareLaunchArgument('teleop', default_value='joystick',
                              description='browser | joystick | none'),
        DeclareLaunchArgument('terminal', default_value='false',
                              description='true activa la terminal en la web'),
        OpaqueFunction(function=setup),
    ])
