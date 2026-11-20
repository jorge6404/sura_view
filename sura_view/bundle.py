"""Robots que lleva sura_view dentro (robots/), para no depender de sus *_description.

Cada robots/<paquete>/ imita el share del paquete con lo que usa la web: el
config/bringup_description.yaml, el URDF de cada xacro ya generado (<xacro>.<entorno>.urdf,
con __sura_robot__ en lugar del nombre del robot) y las mallas visuales reducidas a .glb.
Lo genera tools/bundle_robots.py. Un paquete instalado siempre gana a su copia.

Sin ROS: solo lee ficheros.
"""
import os
import re

ROBOT_TOKEN = '__sura_robot__'
_NAME = re.compile(r'[A-Za-z0-9_/]+')


def _inside(root, *parts):
    """Ruta dentro de root, o None si se sale (.., enlaces)."""
    root = os.path.realpath(root)
    path = os.path.realpath(os.path.join(root, *parts))
    return path if path.startswith(root + os.sep) else None


def bundled(root):
    """{paquete: dir} de las copias que hay en root."""
    if not root or not os.path.isdir(root):
        return {}
    return {d: os.path.join(root, d) for d in sorted(os.listdir(root))
            if d.endswith('_description') and os.path.isdir(os.path.join(root, d))}


def description_packages(installed, root):
    """installed ({paquete: share}) más las copias de los paquetes que no están instalados."""
    return {**bundled(root), **installed}


def urdf(root, package, xacro, environment, robot_name):
    """URDF de la copia para ese xacro y entorno, con el nombre del robot; None si no está."""
    if not _NAME.fullmatch(robot_name or '') or not _NAME.fullmatch(environment or ''):
        return None
    pkg = _inside(root, package)
    path = pkg and _inside(pkg, f'{xacro}.{environment}.urdf')
    if not path or not os.path.isfile(path):
        return None
    with open(path, 'r', encoding='utf-8') as f:
        return f.read().replace(ROBOT_TOKEN, robot_name).encode('utf-8')


def mesh(root, package, rel):
    """Fichero de la copia para package://<package>/<rel>: el mismo, o su .glb si era otra malla."""
    pkg = _inside(root, package)
    if not pkg:
        return None
    for candidate in (rel, os.path.splitext(rel)[0] + '.glb'):
        path = _inside(pkg, candidate)
        if path and os.path.isfile(path):
            return path
    return None
