import os
from glob import glob

from setuptools import setup

package_name = 'sura_view'


def tree(src):
    """Instala un directorio completo (p. ej. web/) conservando su estructura."""
    out = {}
    for path in glob(os.path.join(src, '**', '*'), recursive=True):
        if os.path.isfile(path) and '/test/' not in path:
            dest = os.path.join('share', package_name, os.path.dirname(path))
            out.setdefault(dest, []).append(path)
    return list(out.items())


setup(
    name=package_name,
    version='0.1.0',
    packages=[package_name],
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        ('share/' + package_name + '/launch', glob('launch/*.py')),
        ('share/' + package_name + '/config', glob('config/*.yaml')),
        ('share/' + package_name + '/bt', glob('bt/*.xml')),
    ] + tree('web') + tree('robots'),
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='jorge',
    maintainer_email='jorgee6404@gmail.com',
    description='Estación de tierra web de SURA',
    license='TODO',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            'sura_view_server = sura_view.server_node:main',
            'sura_view_web = sura_view.web_server:main',
        ],
    },
)
