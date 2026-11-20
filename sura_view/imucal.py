"""Calibración de la IMU desde la web, con el calibration_wizard de sura_imu.

Sin ROS: lee la salida del asistente línea a línea y la convierte en un estado que la web
dibuja (fase, si espera al operario, octantes, calidad), y valora un sura_imu_calibration.yaml.
El asistente pide Enter antes de cada captura; el servidor se lo manda cuando el operario
pulsa «Empezar» en la web.
"""
import re
import time

import yaml

# Lo que dura cada captura en el asistente (sus valores por defecto: --gyro-duration,
# --mag-duration y --compass-duration por dirección)
DURATIONS = {'gyro': 8.0, 'mag': 35.0, 'compass': 4.0}
DIRECTIONS = ['North', 'East', 'South', 'West']
PARTS = {'gyro': 'Giróscopo', 'magnetometer': 'Magnetómetro', 'compass': 'Brújula'}
LABELS = {'excellent': 'excelente', 'good': 'buena', 'fair': 'regular', 'poor': 'mala'}

PROMPT = '> press Enter to continue'


def new_state():
    return {
        'running': False, 'phase': 'idle', 'step': '', 'target_deg': None,
        'awaiting': False, 'capturing_since': None, 'duration': 0.0,
        'samples': 0, 'octants': 0, 'results': {}, 'directions': [],
        'error': '', 'output': '', 't': time.time(),
    }


def parse_line(state, line, now=None):
    """Actualiza state con una línea de calibration_wizard. Devuelve True si cambió algo."""
    now = time.time() if now is None else now
    text = line.strip()
    # el aviso «> press Enter» no acaba en salto de línea: llega pegado a la siguiente
    before = dict(state)
    if text.startswith(PROMPT):
        state['awaiting'] = False    # si llega algo detrás del aviso, el Enter ya se dio
    while text.startswith(PROMPT):
        text = text[len(PROMPT):].strip()
    if not text:
        return state != before
    if text.startswith('Waiting for ROS 2 calibration data'):
        state['phase'] = 'waiting_data'
    elif text == '=== Gyroscope calibration ===':
        _enter_phase(state, 'gyro')
    elif text == '=== Magnetometer calibration ===':
        _enter_phase(state, 'mag')
    elif m := re.match(r'Point the robot toward (\w+) \(([-\d.]+) deg\)', text):
        _enter_phase(state, 'compass')
        state['step'] = m.group(1)
        state['target_deg'] = float(m.group(2))
    elif text in ('When it is motionless, capture will start',
                  'When ready, magnetometer capture will start',
                  'Keep it still and capture will start'):
        state['awaiting'] = True
        state['capturing_since'] = None
    elif m := re.match(r'\[mag\] samples=(\d+) octants=(\d)/8', text):
        state['samples'] = int(m.group(1))
        state['octants'] = int(m.group(2))
    elif m := re.match(r'Quality: (\w+) \(([-\d.]+)/100\)', text):
        key = {'gyro': 'gyro', 'mag': 'magnetometer', 'compass': 'compass'}.get(state['phase'])
        if key:
            state['results'] = {**state['results'], key: {'label': m.group(1), 'score': float(m.group(2))}}
            state['capturing_since'] = None
    elif m := re.match(r'(North|East|South|West): measured heading=([-\d.]+) deg.*spread=([-\d.]+) deg', text):
        state['directions'] = state['directions'] + [
            {'name': m.group(1), 'heading': float(m.group(2)), 'spread': float(m.group(3))}]
        state['capturing_since'] = None
    elif m := re.match(r'Results saved to: (.+)', text):
        state['output'] = m.group(1)
    elif text == 'Calibration complete.':
        state['phase'] = 'done'
        state['awaiting'] = False
        state['capturing_since'] = None
    elif m := re.match(r'Error: (.+)', text):
        state['phase'] = 'error'
        state['error'] = m.group(1)
        state['awaiting'] = False
        state['capturing_since'] = None
    if state != before:
        state['t'] = now
        return True
    return False


def _enter_phase(state, phase):
    state['phase'] = phase
    state['step'] = ''
    state['target_deg'] = None
    state['awaiting'] = False
    state['capturing_since'] = None
    state['duration'] = DURATIONS[phase]


def started_capture(state, now=None):
    """El operario pulsó «Empezar»: el asistente captura durante state['duration']."""
    state['awaiting'] = False
    state['capturing_since'] = time.time() if now is None else now
    state['t'] = state['capturing_since']


def assess(text, robot):
    """Valora un sura_imu_calibration.yaml para un robot: {calibrated, reasons, parts, ...}.

    No calibrada si falta, si es de otro robot, si le falta una parte o si alguna sale mala.
    """
    if not text:
        return {'calibrated': False, 'exists': False, 'reasons': ['No hay ninguna calibración guardada'],
                'parts': {}, 'generated_at': None}
    try:
        data = (yaml.safe_load(text) or {}).get('sura_imu_calibration', {}) or {}
    except yaml.YAMLError as e:
        return {'calibrated': False, 'exists': True, 'reasons': [f'El fichero de calibración no se puede leer: {e}'],
                'parts': {}, 'generated_at': None}
    meta = data.get('metadata', {}) or {}
    reasons, parts = [], {}
    topic = str(meta.get('imu_topic', ''))
    if robot and topic and not topic.startswith(f'/{robot}/'):
        reasons.append(f'Es de otro robot ({topic.split("/")[1] or topic})')
    for key, name in PARTS.items():
        part = data.get(key, {}) or {}
        label = str(part.get('quality_label', ''))
        score = part.get('quality_score')
        parts[key] = {'available': bool(part.get('available', False)), 'label': label,
                      'score': float(score) if score is not None else None}
        if not parts[key]['available']:
            reasons.append(f'{name}: sin calibrar')
        elif label == 'poor':
            reasons.append(f'{name}: calidad {LABELS[label]} ({score:.0f}/100)')
    generated = meta.get('generated_at_unix')
    return {'calibrated': not reasons, 'exists': True, 'reasons': reasons, 'parts': parts,
            'generated_at': float(generated) if generated is not None else None}
