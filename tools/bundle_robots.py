#!/usr/bin/env python3
"""Copia en robots/ lo que la web usa de cada *_description, para que sura_view funcione sin ellos.

Solo hace falta al cambiar un robot (o añadir uno a config/robot_variants.yaml), no para usar
sura_view. Necesita el workspace con los *_description compilado y Blender (las mallas COLLADA se
reducen y se pasan a .glb):

    source install/setup.bash
    python3 src/sura_view/tools/bundle_robots.py                # los de robot_variants.yaml
    python3 src/sura_view/tools/bundle_robots.py otro_description

Por cada paquete deja en robots/<paquete>/: config/bringup_description.yaml, el URDF de cada
versión y entorno (<xacro>.<sim|real>.urdf, con __sura_robot__ como nombre del robot) y las mallas
de los <visual> en la misma ruta que en el paquete (.dae -> .glb; .stl/.obj/.glb tal cual).
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET



HERE = os.path.dirname(os.path.abspath(__file__))
PKG_ROOT = os.path.dirname(HERE)
sys.path.insert(0, PKG_ROOT)
from sura_view import bundle, profiles  # noqa: E402

ENVIRONMENTS = ('sim', 'real')
MAX_TRIANGLES = 120000     # por malla: el BlueROV tiene millones y en la web no se notan

BLENDER_SCRIPT = r'''
import bpy, sys
src, dst, max_tris = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.collada_import(filepath=src, import_units=True)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
tris = sum(len(p.vertices) - 2 for o in meshes for p in o.data.polygons)
ratio = min(1.0, int(max_tris) / max(tris, 1))
for o in meshes:
    if ratio < 1.0:
        o.modifiers.new('reducir', 'DECIMATE').ratio = ratio
    o.data.use_auto_smooth = True
    o.data.auto_smooth_angle = 0.6
    for p in o.data.polygons:
        p.use_smooth = True
# Z arriba como en ROS: la web no gira los .glb
bpy.ops.export_scene.gltf(filepath=dst, export_format='GLB', export_apply=True, export_yup=False,
                          export_cameras=False, export_lights=False, export_texcoords=True)
print('TRIS', tris, 'RATIO', ratio)
'''


def share(pkg):
    from ament_index_python.packages import get_package_share_directory
    return get_package_share_directory(pkg)


def render(pkg, xacro_rel, env):
    path = os.path.join(share(pkg), xacro_rel)
    cmd = ['xacro', path, f'robot_name:={bundle.ROBOT_TOKEN}', f'environment:={env}']
    return subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=60).stdout


def visual_meshes(urdf_text):
    """package://pkg/ruta de las mallas de los <visual>."""
    out = set()
    for vis in ET.fromstring(urdf_text).iter('visual'):
        for m in vis.iter('mesh'):
            name = m.get('filename', '')
            if name.startswith('package://'):
                out.add(name[len('package://'):])
    return out


def strip_collisions(urdf_text):
    """La web no dibuja las colisiones (sus mallas no se copian), y los comentarios de xacro
    llevan la ruta del ordenador donde se generó."""
    text = re.sub(r'\s*<collision\b.*?</collision>', '', urdf_text, flags=re.S)
    return re.sub(r'<!--.*?-->\s*', '', text, flags=re.S)


def convert_dae(src, dst, blender):
    with open(os.path.join(os.path.dirname(dst), '.bundle_blender.py'), 'w') as f:
        f.write(BLENDER_SCRIPT)
        script = f.name
    try:
        r = subprocess.run([blender, '-b', '--factory-startup', '-P', script, '--', src, dst, str(MAX_TRIANGLES)],
                           capture_output=True, text=True, timeout=900)
    finally:
        os.remove(script)
    if r.returncode != 0 or not os.path.isfile(dst):
        raise RuntimeError(f'Blender no pudo convertir {src}:\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}')
    print('   ', [ln for ln in r.stdout.splitlines() if ln.startswith('TRIS')][-1:])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('packages', nargs='*', help='paquetes *_description (por defecto, los de config/robot_variants.yaml)')
    ap.add_argument('--out', default=os.path.join(PKG_ROOT, 'robots'))
    ap.add_argument('--blender', default=shutil.which('blender') or 'blender')
    args = ap.parse_args()

    variants = profiles.load_variants(os.path.join(PKG_ROOT, 'config', 'robot_variants.yaml'))
    packages = args.packages or sorted(variants)
    meshes = set()
    for pkg in packages:
        src = share(pkg)
        dst = os.path.join(args.out, pkg)
        shutil.rmtree(dst, ignore_errors=True)
        os.makedirs(os.path.join(dst, 'config'))
        shutil.copy(os.path.join(src, profiles.PROFILE_PATH), os.path.join(dst, profiles.PROFILE_PATH))
        summary = profiles.with_variants(profiles.summarize_profile(profiles.read_profile(src), pkg), src, variants)
        for v in summary['variants']:
            for env in ENVIRONMENTS:
                text = strip_collisions(render(pkg, v['xacro'], env))
                out = os.path.join(dst, f"{v['xacro']}.{env}.urdf")
                os.makedirs(os.path.dirname(out), exist_ok=True)
                with open(out, 'w', encoding='utf-8') as f:
                    f.write(text)
                meshes |= visual_meshes(text)
                print(f'{pkg}: {v["xacro"]} ({env})')

    for ref in sorted(meshes):
        pkg, _, rel = ref.partition('/')
        src = os.path.join(share(pkg), rel)
        ext = os.path.splitext(rel)[1].lower()
        dst = os.path.join(args.out, pkg, os.path.splitext(rel)[0] + '.glb' if ext == '.dae' else rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        print(f'malla {ref}')
        if ext == '.dae':
            convert_dae(src, dst, args.blender)
        else:
            shutil.copy(src, dst)

    total = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(args.out) for f in fs)
    print(f'robots/: {total / 1e6:.1f} MB')
    with open(os.path.join(args.out, 'README.md'), 'w', encoding='utf-8') as f:
        f.write('Generado por tools/bundle_robots.py: no editar a mano. '
                'Copia ligera de los *_description para usar sura_view sin ellos.\n')


if __name__ == '__main__':
    main()
