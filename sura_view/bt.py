"""Behaviour trees en XML de BehaviorTree.CPP v3, ejecutados sin ROS.

Controles: Sequence, Fallback, ReactiveSequence, ReactiveFallback, Parallel (success_threshold),
Inverter, ForceSuccess, ForceFailure, RetryUntilSuccessful (num_attempts), Repeat (num_cycles),
Timeout (msec). Las hojas (acciones y condiciones) las pone quien ejecuta: el nodo servidor
registra las acciones de SURA (GoToDepth, FollowPath, Surface…).
"""
import time
import xml.etree.ElementTree as ET

SUCCESS, FAILURE, RUNNING, IDLE = 'success', 'failure', 'running', 'idle'

CONTROLS = {'Sequence', 'Fallback', 'ReactiveSequence', 'ReactiveFallback', 'Parallel',
            'SequenceStar'}
DECORATORS = {'Inverter', 'ForceSuccess', 'ForceFailure', 'RetryUntilSuccessful', 'Repeat',
              'Timeout'}


class BtError(Exception):
    pass


class Node:
    def __init__(self, kind, name, attrs, children=()):
        self.kind = kind
        self.name = name or kind
        self.attrs = dict(attrs)
        self.children = list(children)
        self.status = IDLE
        self.idx = 0
        self.count = 0
        self.t0 = None
        self.leaf = None

    def snapshot(self, path='0'):
        return {'id': path, 'kind': self.kind, 'name': self.name, 'status': self.status,
                'attrs': {k: v for k, v in self.attrs.items() if k != 'name'},
                'role': role(self.kind),
                'children': [c.snapshot(f'{path}.{i}') for i, c in enumerate(self.children)]}


def role(kind):
    if kind in CONTROLS:
        return 'control'
    if kind in DECORATORS:
        return 'decorator'
    if kind == 'SubTree':
        return 'subtree'
    return 'leaf'


def parse(xml_text):
    """Devuelve (nombre del árbol principal, {id: elemento <BehaviorTree>})."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        raise BtError(f'XML no válido: {e}') from e
    trees = {t.get('ID'): t for t in root.iter('BehaviorTree')}
    if not trees:
        raise BtError('No hay ningún <BehaviorTree>')
    main = root.get('main_tree_to_execute') or next(iter(trees))
    if main not in trees:
        raise BtError(f'main_tree_to_execute «{main}» no existe')
    return main, trees


def build(xml_text, known_leaves):
    """Construye el árbol. known_leaves: nombres de hojas que el ejecutor sabe hacer."""
    main, trees = parse(xml_text)

    def make(el, depth=0):
        if depth > 40:
            raise BtError('Árbol demasiado profundo (¿SubTree recursivo?)')
        tag = el.tag
        if tag == 'SubTree':
            sub = trees.get(el.get('ID'))
            if sub is None:
                raise BtError(f'SubTree «{el.get("ID")}» no existe')
            return Node('SubTree', el.get('ID'), el.attrib, [make(c, depth + 1) for c in sub])
        children = [make(c, depth + 1) for c in el]
        if tag in CONTROLS:
            if not children:
                raise BtError(f'{tag} sin hijos')
        elif tag in DECORATORS:
            if len(children) != 1:
                raise BtError(f'{tag} necesita exactamente un hijo')
        elif tag not in known_leaves:
            raise BtError(f'Nodo desconocido «{tag}»')
        return Node(tag, el.get('name'), el.attrib, children)

    body = list(trees[main])
    if len(body) != 1:
        raise BtError('<BehaviorTree> debe tener un único nodo raíz')
    return Node('BehaviorTree', main, {}, [make(body[0])])


class Runner:
    """Ejecuta un árbol con tick(). make_leaf(kind, attrs, blackboard) devuelve un objeto con
    tick() -> SUCCESS|FAILURE|RUNNING y halt()."""

    def __init__(self, tree, make_leaf, blackboard=None, clock=time.monotonic):
        self.tree = tree
        self.make_leaf = make_leaf
        self.bb = blackboard if blackboard is not None else {}
        self.clock = clock

    def tick(self):
        return self._tick(self.tree)

    def halt(self, node=None):
        node = node or self.tree
        for c in node.children:
            self.halt(c)
        if node.leaf is not None and node.status == RUNNING:
            node.leaf.halt()
        node.leaf = None
        if node.status == RUNNING:
            node.status = IDLE
        node.idx = node.count = 0
        node.t0 = None

    def _set(self, node, status):
        node.status = status
        if status != RUNNING:
            node.idx = node.count = 0
            node.t0 = None
            node.leaf = None
        return status

    def _tick(self, n):
        k = n.kind
        if k in ('BehaviorTree', 'SubTree'):
            return self._set(n, self._tick(n.children[0]))
        if k in ('Sequence', 'SequenceStar', 'ReactiveSequence', 'Fallback', 'ReactiveFallback'):
            stop_on = FAILURE if 'Sequence' in k else SUCCESS
            start = 0 if k.startswith('Reactive') else n.idx
            if start == 0 and n.status != RUNNING:
                for c in n.children:
                    c.status = IDLE
            for i in range(start, len(n.children)):
                st = self._tick(n.children[i])
                if st == RUNNING:
                    if k.startswith('Reactive'):
                        for c in n.children[i + 1:]:
                            self.halt(c)
                    n.idx = i
                    return self._set(n, RUNNING)
                if st == stop_on:
                    for c in n.children[i + 1:]:
                        self.halt(c)
                    return self._set(n, stop_on)
            return self._set(n, SUCCESS if stop_on == FAILURE else FAILURE)
        if k == 'Parallel':
            need = int(n.attrs.get('success_threshold', len(n.children)))
            sts = [c.status if c.status in (SUCCESS, FAILURE) and n.status == RUNNING
                   else self._tick(c) for c in n.children]
            ok, bad = sts.count(SUCCESS), sts.count(FAILURE)
            if ok >= need or bad > len(n.children) - need:
                for c in n.children:
                    self.halt(c)
                return self._set(n, SUCCESS if ok >= need else FAILURE)
            return self._set(n, RUNNING)
        if k in DECORATORS:
            child = n.children[0]
            if k == 'Timeout':
                if n.t0 is None:
                    n.t0 = self.clock()
                if (self.clock() - n.t0) * 1000 > float(n.attrs.get('msec', 1000)):
                    self.halt(child)
                    return self._set(n, FAILURE)
            st = self._tick(child)
            if st == RUNNING:
                return self._set(n, RUNNING)
            if k == 'Inverter':
                return self._set(n, FAILURE if st == SUCCESS else SUCCESS)
            if k == 'ForceSuccess':
                return self._set(n, SUCCESS)
            if k == 'ForceFailure':
                return self._set(n, FAILURE)
            if k == 'Timeout':
                return self._set(n, st)
            limit = int(n.attrs.get('num_attempts' if k == 'RetryUntilSuccessful' else 'num_cycles', 1))
            again = st == FAILURE if k == 'RetryUntilSuccessful' else st == SUCCESS
            if not again:
                return self._set(n, st)
            n.count += 1
            if limit >= 0 and n.count >= limit:
                return self._set(n, st)
            child.status = IDLE
            n.status = RUNNING
            return RUNNING
        # hoja
        if n.leaf is None:
            n.leaf = self.make_leaf(k, n.attrs, self.bb)
        st = n.leaf.tick()
        if st not in (SUCCESS, FAILURE, RUNNING):
            raise BtError(f'{k} devolvió un estado no válido: {st!r}')
        return self._set(n, st)


# --- hojas que no necesitan ROS --------------------------------------------------

def resolve(value, bb):
    """«{clave}» lee la pizarra (puerto de BehaviorTree.CPP); lo demás se deja igual."""
    if isinstance(value, str) and value.startswith('{') and value.endswith('}'):
        return bb.get(value[1:-1], '')
    return value


class Wait:
    def __init__(self, attrs, bb, clock=time.monotonic):
        self.secs = float(resolve(attrs.get('seconds', attrs.get('msec', 0)), bb))
        if 'msec' in attrs and 'seconds' not in attrs:
            self.secs /= 1000.0
        self.clock = clock
        self.t0 = None

    def tick(self):
        if self.t0 is None:
            self.t0 = self.clock()
        return SUCCESS if self.clock() - self.t0 >= self.secs else RUNNING

    def halt(self):
        self.t0 = None


class SetBlackboard:
    def __init__(self, attrs, bb):
        self.attrs, self.bb = attrs, bb

    def tick(self):
        key = self.attrs.get('output_key') or self.attrs.get('key')
        if not key:
            return FAILURE
        self.bb[key] = resolve(self.attrs.get('value', ''), self.bb)
        return SUCCESS

    def halt(self):
        pass


class Condition:
    """Condición evaluada con una función f(attrs, bb) -> bool."""

    def __init__(self, attrs, bb, fn):
        self.attrs, self.bb, self.fn = attrs, bb, fn

    def tick(self):
        try:
            return SUCCESS if self.fn(self.attrs, self.bb) else FAILURE
        except (KeyError, ValueError, TypeError):
            return FAILURE

    def halt(self):
        pass
