import threading

from sura_view.processes import PtySession


def test_pty_no_rompe_caracteres_utf8_entre_lecturas():
    # 1 byte + 5000 «ñ» (2 bytes): las lecturas de 4096 bytes parten alguna «ñ» por la mitad
    out, done = [], threading.Event()
    PtySession('t', lambda sid, d: out.append(d), lambda sid: done.set(),
               command="python3 -c \"import sys; sys.stdout.write('a' + 'ñ' * 5000)\"")
    assert done.wait(10)
    text = ''.join(out)
    assert '�' not in text
    assert text.count('ñ') == 5000


def test_pty_anuncia_color_verdadero():
    out, done = [], threading.Event()
    PtySession('t', lambda sid, d: out.append(d), lambda sid: done.set(), command='echo $TERM $COLORTERM')
    assert done.wait(10)
    assert 'xterm-256color truecolor' in ''.join(out)


def test_pty_recoge_la_shell_que_termina_sola():
    import os
    import pytest
    done = threading.Event()
    s = PtySession('t', lambda sid, d: None, lambda sid: done.set(), command='exit 0')
    assert done.wait(10)
    with pytest.raises(ChildProcessError):     # ya recogida: no queda zombi
        os.waitpid(s.pid, os.WNOHANG)
