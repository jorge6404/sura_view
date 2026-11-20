"""Descubre los robots instalados (paquetes *_description con bringup_description.yaml).

Sin ROS: solo lee ficheros. El nodo lo usa para la pantalla «¿Con qué robot trabajas hoy?».
"""
import os

import yaml

PROFILE_PATH = os.path.join('config', 'bringup_description.yaml')


def family_from_name(name, xacro=''):
    """surface/underwater. Sin renderizar el xacro, se deduce del nombre."""
    text = f'{name} {xacro}'.lower()
    return 'surface' if any(k in text for k in ('boat', 'usv', 'surface')) else 'underwater'


def load_variants(path):
    """{paquete: [{xacro, label}]} de config/robot_variants.yaml; vacío si no existe."""
    if not path or not os.path.isfile(path):
        return {}
    with open(path, 'r', encoding='utf-8') as f:
        data = yaml.safe_load(f) or {}
    return {pkg: [{'xacro': str(v['xacro']), 'label': str(v.get('label', v['xacro']))}
                  for v in (items or []) if isinstance(v, dict) and v.get('xacro')]
            for pkg, items in data.items()}


def _has_xacro(share_dir, xacro):
    """El xacro, o su URDF ya generado si es la copia que lleva sura_view (bundle.py)."""
    path = os.path.join(share_dir, xacro)
    return os.path.isfile(path) or os.path.isfile(f'{path}.sim.urdf')


def with_variants(summary, share_dir, variants):
    """Añade las versiones que existen en el paquete. La de bringup_description.yaml va
    siempre (marcada default) y es la elegida al empezar."""
    default = summary['xacro']
    out = [dict(v) for v in variants.get(summary['package'], [])
           if share_dir is None or _has_xacro(share_dir, v['xacro'])]
    if default and not any(v['xacro'] == default for v in out):
        out.insert(0, {'xacro': default, 'label': os.path.basename(default).split('.')[0]})
    for v in out:
        v['default'] = v['xacro'] == default
    summary['variants'] = out
    return summary


def summarize_profile(profile, package):
    """Resumen de bringup_description.yaml que necesita la web (sin rutas internas)."""
    profile = profile or {}
    robot = profile.get('robot', {}) or {}
    desc = profile.get('description', {}) or {}
    name = str(robot.get('name', '') or package[:-len('_description')]).strip('/')
    cameras = {}
    for cam, cfg in (profile.get('cameras', {}) or {}).items():
        cfg = cfg or {}
        cameras[cam] = {'enabled': bool(cfg.get('enabled', False)), 'aruco': bool(cfg.get('aruco', False))}
    loc = profile.get('localization', {}) or {}
    datum = loc.get('datum', {}) or {}
    modem = profile.get('modem', {}) or {}
    return {
        'name': name,
        'package': package,
        'environment': str(robot.get('environment', 'sim')),
        'xacro': str(desc.get('xacro', '')),
        'family': family_from_name(name, str(desc.get('xacro', ''))),
        'cameras': cameras,
        'localization': bool(loc.get('enabled', False)),
        'modem': bool(modem.get('enabled', False)),
        'datum': {k: float(datum[k]) for k in ('latitude', 'longitude', 'heading') if k in datum},
    }


def read_profile(share_dir):
    path = os.path.join(share_dir, PROFILE_PATH)
    if not os.path.isfile(path):
        return None
    with open(path, 'r', encoding='utf-8') as f:
        return yaml.safe_load(f) or {}


def discover(packages, variants=None):
    """packages: {nombre_paquete: share_dir}. Devuelve los perfiles ordenados por nombre,
    cada uno con sus versiones (variants: lo de load_variants)."""
    out = []
    for pkg, share in sorted(packages.items()):
        if not pkg.endswith('_description'):
            continue
        profile = read_profile(share)
        if profile is not None:
            out.append(with_variants(summarize_profile(profile, pkg), share, variants or {}))
    return out


def installed_packages():
    from ament_index_python.packages import get_packages_with_prefixes
    return {pkg: os.path.join(prefix, 'share', pkg)
            for pkg, prefix in get_packages_with_prefixes().items()}
