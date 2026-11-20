"""Procesos lanzados desde la web (SURA, simulador, rosbag) y la terminal con pty."""
import codecs
import os
import pty
import select
import shlex
import signal
import struct
import subprocess
import threading
import time


def render(template, **values):
    """Rellena {robot}, {address}, {user}… Las claves que falten quedan vacías."""
    class Missing(dict):
        def __missing__(self, key):
            return ''
    return template.format_map(Missing(**values)).strip()


class ManagedProcess:
    """Un comando en su propio grupo de procesos, con su salida línea a línea.

    stop() manda SIGINT al grupo (como Ctrl+C a ros2 launch) y, si no acaba en
    `grace` segundos, SIGTERM y luego SIGKILL.
    """

    def __init__(self, name, on_line=None, on_exit=None):
        self.name = name
        self.on_line = on_line or (lambda name, line: None)
        self.on_exit = on_exit or (lambda name, code: None)
        self.proc = None
        self.command = ''
        self.started_at = None
        self.exit_code = None

    @property
    def running(self):
        return self.proc is not None and self.proc.poll() is None

    def status(self):
        return {
            'running': self.running,
            'command': self.command,
            'pid': self.proc.pid if self.running else None,
            'uptime': round(time.time() - self.started_at, 1) if self.running else 0.0,
            'exit_code': self.exit_code,
        }

    def start(self, command, env=None, stdin=False):
        """stdin=True deja la entrada abierta para write() (asistentes que piden Enter)."""
        if self.running:
            raise RuntimeError(f'{self.name} ya está en marcha')
        if not command:
            raise RuntimeError(f'No hay comando configurado para {self.name}')
        self.command = command
        self.exit_code = None
        self.proc = subprocess.Popen(
            ['bash', '-lc', command], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            stdin=subprocess.PIPE if stdin else subprocess.DEVNULL, env={**os.environ, **(env or {})},
            start_new_session=True, text=True, bufsize=1)
        self.started_at = time.time()
        threading.Thread(target=self._pump, args=(self.proc,), daemon=True).start()

    def write(self, text):
        if not self.running or self.proc.stdin is None:
            raise RuntimeError(f'{self.name} no está esperando entrada')
        self.proc.stdin.write(text)
        self.proc.stdin.flush()

    def _pump(self, proc):
        for line in proc.stdout:
            self.on_line(self.name, line.rstrip('\n'))
        self.exit_code = proc.wait()
        self.on_exit(self.name, self.exit_code)

    def stop(self, grace=8.0):
        if not self.running:
            return
        pgid = os.getpgid(self.proc.pid)
        for sig, wait in ((signal.SIGINT, grace), (signal.SIGTERM, 3.0), (signal.SIGKILL, 1.0)):
            try:
                os.killpg(pgid, sig)
            except ProcessLookupError:
                return
            try:
                self.proc.wait(timeout=wait)
                return
            except subprocess.TimeoutExpired:
                continue


class PtySession:
    """bash interactivo en un pseudo-terminal. La salida llega en trozos a on_output."""

    def __init__(self, sid, on_output, on_exit, command='bash -i', cwd=None):
        self.sid = sid
        self.on_output = on_output
        self.on_exit = on_exit
        pid, fd = pty.fork()
        if pid == 0:
            if cwd:
                os.chdir(cwd)
            os.environ['TERM'] = 'xterm-256color'
            os.environ['COLORTERM'] = 'truecolor'     # la web es xterm.js: color de 24 bits
            os.execvp('bash', ['bash', '-c', command])
        self.pid, self.fd = pid, fd
        self.alive = True
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        # incremental: una lectura de 4096 bytes puede partir un carácter UTF-8 por la mitad
        dec = codecs.getincrementaldecoder('utf-8')('replace')
        while self.alive:
            try:
                ready, _, _ = select.select([self.fd], [], [], 0.2)
                if ready:
                    data = os.read(self.fd, 4096)
                    if not data:
                        break
                    text = dec.decode(data)
                    if text:
                        self.on_output(self.sid, text)
            except OSError:
                break
        if self.alive:      # la shell terminó sola (exit): recogerla para que no quede zombi
            self.alive = False
            try:
                os.waitpid(self.pid, 0)
            except ChildProcessError:
                pass
            os.close(self.fd)
        self.on_exit(self.sid)

    def write(self, data):
        if self.alive:
            os.write(self.fd, data.encode('utf-8'))

    def resize(self, rows, cols):
        import fcntl
        import termios
        if self.alive:
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

    def close(self):
        if not self.alive:
            return
        self.alive = False
        try:
            os.kill(self.pid, signal.SIGHUP)
            os.waitpid(self.pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
        os.close(self.fd)


def ping(address, timeout_s=1.0):
    """Ping ICMP. Devuelve milisegundos o None. Una dirección «host:puerto» usa solo el host."""
    host = address.split('://')[-1].split('/')[0].rsplit(':', 1)[0] if address else ''
    if not host:
        return None
    try:
        out = subprocess.run(
            ['ping', '-c', '1', '-W', str(max(1, int(timeout_s))), host],
            capture_output=True, text=True, timeout=timeout_s + 2)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None
    if out.returncode != 0:
        return None
    for token in out.stdout.split():
        if token.startswith('time='):
            return float(token[5:])
    return None


def quote(text):
    return shlex.quote(text)
