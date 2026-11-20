import os

from sura_view import bundle


def write(path, text=''):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)


def make_bundle(root):
    write(os.path.join(root, 'bluerov_description', 'config', 'bringup_description.yaml'), 'robot: {name: bluerov}\n')
    write(os.path.join(root, 'bluerov_description', 'urdf', 'bigblue.urdf.xacro.sim.urdf'),
          '<robot name="__sura_robot__"><link name="__sura_robot__/base_link"/></robot>')
    write(os.path.join(root, 'bluerov_description', 'urdf', 'meshes', 'rov.glb'), 'glTF')
    write(os.path.join(root, 'alpha_description', 'meshes', 'M2.stl'), 'solid')


def test_paquetes_instalados_ganan_a_los_de_sura_view(tmp_path):
    root = str(tmp_path / 'robots')
    make_bundle(root)
    pkgs = bundle.description_packages({'bluerov_description': '/opt/x/share/bluerov_description', 'rclpy': '/r'}, root)
    assert pkgs['bluerov_description'] == '/opt/x/share/bluerov_description'
    assert pkgs['alpha_description'] == os.path.join(root, 'alpha_description')
    assert 'rclpy' in pkgs        # el resto de paquetes no se toca


def test_sin_paquete_instalado_se_usa_la_copia(tmp_path):
    root = str(tmp_path / 'robots')
    make_bundle(root)
    assert bundle.description_packages({}, root)['bluerov_description'] == os.path.join(root, 'bluerov_description')


def test_urdf_de_la_copia_con_el_nombre_del_robot(tmp_path):
    root = str(tmp_path / 'robots')
    make_bundle(root)
    urdf = bundle.urdf(root, 'bluerov_description', 'urdf/bigblue.urdf.xacro', 'sim', 'rov2')
    assert urdf == b'<robot name="rov2"><link name="rov2/base_link"/></robot>'


def test_urdf_que_no_esta_en_la_copia(tmp_path):
    root = str(tmp_path / 'robots')
    make_bundle(root)
    assert bundle.urdf(root, 'bluerov_description', 'urdf/otro.urdf.xacro', 'sim', 'rov') is None
    assert bundle.urdf(root, 'bluerov_description', '../../etc/passwd', 'sim', 'rov') is None
    assert bundle.urdf(root, 'bluerov_description', 'urdf/bigblue.urdf.xacro', 'sim', 'x"/><evil') is None


def test_malla_dae_se_sirve_con_su_glb(tmp_path):
    root = str(tmp_path / 'robots')
    make_bundle(root)
    assert bundle.mesh(root, 'bluerov_description', 'urdf/meshes/rov.dae') == os.path.join(root, 'bluerov_description', 'urdf', 'meshes', 'rov.glb')
    assert bundle.mesh(root, 'alpha_description', 'meshes/M2.stl') == os.path.join(root, 'alpha_description', 'meshes', 'M2.stl')
    assert bundle.mesh(root, 'bluerov_description', 'urdf/meshes/nada.dae') is None


def test_malla_fuera_de_la_copia(tmp_path):
    root = str(tmp_path / 'robots')
    make_bundle(root)
    write(str(tmp_path / 'secreto.glb'), 'glTF')
    assert bundle.mesh(root, 'bluerov_description', '../../secreto.glb') is None
    assert bundle.mesh(root, '..', 'secreto.glb') is None
