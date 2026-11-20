"""Servidor HTTP de la web. Como `python3 -m http.server`, pero con Cache-Control: no-store
para que el navegador revalide los módulos JS tras actualizar el paquete.

El URDF y las mallas salen del *_description instalado o, si no está, de la copia que lleva
sura_view en robots/ (bundle.py)."""
import argparse
import functools
import http.server
import os
import subprocess
import urllib.parse

from sura_view import bundle

# Ficheros de paquetes que la vista 3D puede pedir (mallas y texturas del URDF)
PKG_FILES = {'.dae': 'model/vnd.collada+xml', '.stl': 'model/stl', '.obj': 'text/plain', '.mtl': 'text/plain',
             '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.png': 'image/png',
             '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.tga': 'image/x-tga'}
_urdf_cache = {}
ROBOTS = None       # robots/ de sura_view (--robots)


def share_dir(package):
    from ament_index_python.packages import get_package_share_directory
    return get_package_share_directory(package)


def package_file(package, rel):
    """Malla o textura de package://<package>/<rel>: la del paquete instalado o, si no está, la
    de robots/. None si no existe, se sale del paquete o no es una malla."""
    if not package.replace('_', '').isalnum() or os.path.splitext(rel)[1].lower() not in PKG_FILES:
        return None
    try:
        path = installed_file(package, rel)
    except LookupError:          # PackageNotFoundError: el paquete no está instalado
        path = None
    return path or bundle.mesh(ROBOTS, package, rel)


def installed_file(package, rel):
    root = os.path.realpath(share_dir(package))
    path = os.path.realpath(os.path.join(root, rel))
    if not path.startswith(root + os.sep) or os.path.splitext(path)[1].lower() not in PKG_FILES:
        return None
    return path if os.path.isfile(path) else None


def urdf(package, xacro_file, args):
    """El URDF del paquete instalado o, si no está, el ya generado de robots/."""
    try:
        return render_urdf(package, xacro_file, args)
    except LookupError:
        text = bundle.urdf(ROBOTS, package, xacro_file, args.get('environment', 'sim'),
                           args.get('robot_name', package[:-len('_description')]))
        if text is None:
            raise FileNotFoundError(f'{package} no está instalado ni en robots/ de sura_view')
        return text


def render_urdf(package, xacro_file, args):
    """URDF de un *_description, como lo genera sura_bringup (xacro con robot_name y environment)."""
    key = (package, xacro_file, tuple(sorted(args.items())))
    if key not in _urdf_cache:
        root = os.path.realpath(share_dir(package))
        path = os.path.realpath(os.path.join(root, xacro_file))
        if not path.startswith(root + os.sep) or not os.path.isfile(path):
            raise FileNotFoundError(xacro_file)
        cmd = ['xacro', path] + [f'{k}:={v}' for k, v in args.items()]
        _urdf_cache[key] = subprocess.run(cmd, check=True, capture_output=True, timeout=30).stdout
    return _urdf_cache[key]


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript',
                      '.woff2': 'font/woff2', '.glb': 'model/gltf-binary'}

    # no-store: con no-cache, Chrome y Firefox siguen ejecutando módulos JS guardados tras
    # recompilar; la web es pequeña y local, así que se baja entera cada vez
    cache = 'no-store'

    def end_headers(self):
        self.send_header('Cache-Control', self.cache)
        super().end_headers()

    def log_message(self, *args):
        pass

    # /pkg/<paquete>/<ruta>: ficheros de un paquete (las package:// del URDF)
    # /urdf?package=&xacro=&robot_name=&environment=: el URDF ya procesado
    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        try:
            if url.path.startswith('/pkg/'):
                pkg, _, rel = urllib.parse.unquote(url.path[5:]).partition('/')
                path = package_file(pkg, rel)
                if not path:
                    return self.send_error(404)
                self.cache = 'max-age=3600'   # las mallas pesan (la del BlueROV, 50 MB)
                with open(path, 'rb') as f:
                    return self.reply(f.read(), PKG_FILES[os.path.splitext(path)[1].lower()])
            if url.path == '/urdf':
                q = dict(urllib.parse.parse_qsl(url.query))
                args = {k: q[k] for k in ('robot_name', 'environment') if q.get(k)}
                return self.reply(urdf(q.get('package', ''), q.get('xacro', ''), args), 'application/xml')
        except Exception as e:  # paquete que no existe, xacro que falla...
            return self.send_error(404, str(e).splitlines()[0][:200] if str(e) else type(e).__name__)
        return super().do_GET()

    def reply(self, body, ctype):
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('port', type=int)
    ap.add_argument('--directory', required=True)
    ap.add_argument('--bind', default='0.0.0.0')
    ap.add_argument('--robots', help='robots/ de sura_view (por defecto, junto a --directory)')
    args, _ = ap.parse_known_args()
    global ROBOTS
    ROBOTS = args.robots or os.path.join(os.path.dirname(os.path.abspath(args.directory)), 'robots')
    handler = functools.partial(NoCacheHandler, directory=args.directory)
    with http.server.ThreadingHTTPServer((args.bind, args.port), handler) as srv:
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
