import os

import pytest

from sura_view import processes, profiles

YAML = """
robot:
  name: bluerov
  environment: sim
description:
  package: bluerov_description
  xacro: urdf/bigblue.urdf.xacro
cameras:
  down_camera: {enabled: true, aruco: true}
  front_camera: {enabled: false}
localization:
  enabled: true
  datum: {latitude: 39.9944, longitude: -0.0741, heading: 0.0}
modem:
  enabled: true
"""


def make_pkg(root, name, text):
    share = os.path.join(root, name)
    os.makedirs(os.path.join(share, 'config'))
    with open(os.path.join(share, profiles.PROFILE_PATH), 'w') as f:
        f.write(text)
    return share


def test_discover_reads_only_description_packages_with_profile(tmp_path):
    pkgs = {
        'bluerov_description': make_pkg(tmp_path, 'bluerov_description', YAML),
        'blueboat_description': make_pkg(tmp_path, 'blueboat_description',
                                         'robot: {name: blueboat, environment: real}'),
        'other_description': str(tmp_path / 'missing'),
        'sura_bringup': str(tmp_path),
    }
    robots = profiles.discover(pkgs)
    assert [r['name'] for r in robots] == ['blueboat', 'bluerov']
    rov = robots[1]
    assert rov['environment'] == 'sim'
    assert rov['family'] == 'underwater'
    assert rov['cameras']['down_camera'] == {'enabled': True, 'aruco': True}
    assert rov['datum']['latitude'] == pytest.approx(39.9944)
    assert rov['modem'] is True
    assert robots[0]['family'] == 'surface'


def test_empty_profile_falls_back_to_package_name():
    s = profiles.summarize_profile({}, 'cirtesub_description')
    assert s['name'] == 'cirtesub' and s['environment'] == 'sim' and s['cameras'] == {}


def test_render_fills_known_and_blanks_unknown():
    assert processes.render('ssh {user}@{address} {robot} {nope}', user='pi', address='1.2.3.4',
                            robot='bluerov') == 'ssh pi@1.2.3.4 bluerov'


def test_managed_process_streams_lines_and_stops(tmp_path):
    lines = []
    p = processes.ManagedProcess('t', on_line=lambda n, l: lines.append(l))
    p.start('echo hola; sleep 30')
    import time
    for _ in range(50):
        if lines:
            break
        time.sleep(0.05)
    assert lines == ['hola'] and p.running
    p.stop(grace=1.0)
    assert not p.running


def test_ping_ignores_port_and_scheme():
    # localhost siempre responde; el puerto y el esquema no deben romperlo
    assert processes.ping('ws://127.0.0.1:9090') is not None
    assert processes.ping('') is None


def test_variants_keep_existing_xacros_and_mark_the_default(tmp_path):
    share = tmp_path / 'share' / 'cirtesub_description'
    (share / 'urdf').mkdir(parents=True)
    (share / 'urdf' / 'cirtesub.urdf.xacro').write_text('<robot/>')
    (share / 'urdf' / 'cirtesub_dual_alpha.urdf.xacro').write_text('<robot/>')
    vfile = tmp_path / 'robot_variants.yaml'
    vfile.write_text(
        'cirtesub_description:\n'
        '  - {xacro: urdf/cirtesub.urdf.xacro, label: Sin brazos}\n'
        '  - {xacro: urdf/cirtesub_dual_alpha.urdf.xacro, label: Dos brazos Alpha}\n'
        '  - {xacro: urdf/no_existe.urdf.xacro, label: Fantasma}\n')
    summary = profiles.summarize_profile({'description': {'xacro': 'urdf/cirtesub_dual_alpha.urdf.xacro'}}, 'cirtesub_description')
    out = profiles.with_variants(summary, str(share), profiles.load_variants(str(vfile)))
    assert [(v['label'], v['default']) for v in out['variants']] == [('Sin brazos', False), ('Dos brazos Alpha', True)]


def test_without_variants_the_profile_xacro_is_the_only_version():
    summary = profiles.summarize_profile({'description': {'xacro': 'urdf/boat.urdf.xacro'}}, 'blueboat_description')
    out = profiles.with_variants(summary, None, {})
    assert out['variants'] == [{'xacro': 'urdf/boat.urdf.xacro', 'label': 'boat', 'default': True}]


def test_variants_of_a_bundled_copy_count_its_generated_urdf(tmp_path):
    # robots/<paquete>/ de sura_view no tiene los .xacro, sino <xacro>.sim.urdf
    share = tmp_path / 'bluerov_description'
    (share / 'urdf').mkdir(parents=True)
    (share / 'urdf' / 'bluerov_reach.urdf.xacro.sim.urdf').write_text('<robot/>')
    summary = profiles.summarize_profile({'description': {'xacro': 'urdf/bigblue.urdf.xacro'}}, 'bluerov_description')
    variants = {'bluerov_description': [{'xacro': 'urdf/bluerov_reach.urdf.xacro', 'label': 'Con brazo Reach'}]}
    out = profiles.with_variants(summary, str(share), variants)
    assert [v['label'] for v in out['variants']] == ['bigblue', 'Con brazo Reach']
