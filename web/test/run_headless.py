#!/usr/bin/env python3
"""Pasa los tests de la web (run.html) en un Firefox sin ventana y sale con 0 si pasan todos.

El host no tiene Node: run.html importa los *.test.mjs con shims de node:test. Aquí se sirve
web/ en un puerto libre, se abre run.html?report en Firefox headless con un perfil temporal y
la página manda su salida por POST /report.
"""
import http.server
import os
import shutil
import subprocess
import sys
import tempfile
import threading

WEB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
result = {}
done = threading.Event()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=WEB, **k)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
        result['text'] = body
        self.send_response(204)
        self.end_headers()
        done.set()

    def log_message(self, *a):
        pass


def main():
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    # Firefox de Ubuntu es un snap: solo ve perfiles dentro de ~/snap/firefox
    snap = os.path.expanduser('~/snap/firefox/common')
    profile = tempfile.mkdtemp(prefix='sura_view_tests_', dir=snap if os.path.isdir(snap) else None)
    url = f'http://127.0.0.1:{srv.server_address[1]}/test/run.html?report'
    ff = subprocess.Popen(['firefox', '--headless', '--no-remote', '--profile', profile, url],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ok = done.wait(90)
    finally:
        ff.terminate()
        try:
            ff.wait(10)
        except subprocess.TimeoutExpired:
            ff.kill()
        srv.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
    if not ok:
        print('Sin respuesta de run.html en 90 s (¿error al importar un módulo?)')
        return 1
    text = result['text']
    print(text)
    return 0 if text.rstrip().endswith(', 0 fallan') else 1


if __name__ == '__main__':
    sys.exit(main())
