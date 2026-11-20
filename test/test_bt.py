import pytest

from sura_view import bt

LEAVES = {'Ok', 'Fail', 'Slow', 'Wait', 'SetBlackboard', 'Check'}


class Scripted:
    """Hoja que devuelve una secuencia de estados y recuerda si la pararon."""
    log = []

    def __init__(self, kind, attrs):
        self.kind, self.name = kind, attrs.get('name', kind)
        self.seq = {'Ok': [bt.SUCCESS], 'Fail': [bt.FAILURE],
                    'Slow': [bt.RUNNING, bt.RUNNING, bt.SUCCESS]}[kind]
        self.i = 0

    def tick(self):
        Scripted.log.append(self.name)
        st = self.seq[min(self.i, len(self.seq) - 1)]
        self.i += 1
        return st

    def halt(self):
        Scripted.log.append('halt:' + self.name)


def make_leaf(kind, attrs, bb):
    if kind == 'SetBlackboard':
        return bt.SetBlackboard(attrs, bb)
    if kind == 'Check':
        return bt.Condition(attrs, bb, lambda a, b: b.get(a['key']) == a['value'])
    return Scripted(kind, attrs)


def run(xml, max_ticks=20):
    Scripted.log = []
    runner = bt.Runner(bt.build(xml, LEAVES), make_leaf)
    for _ in range(max_ticks):
        st = runner.tick()
        if st != bt.RUNNING:
            return st, runner
    return bt.RUNNING, runner


def tree(body, extra=''):
    return f'<root main_tree_to_execute="T"><BehaviorTree ID="T">{body}</BehaviorTree>{extra}</root>'


def test_sequence_runs_children_in_order_and_remembers_progress():
    st, _ = run(tree('<Sequence><Ok name="a"/><Slow name="b"/><Ok name="c"/></Sequence>'))
    assert st == bt.SUCCESS
    # «a» no se repite mientras «b» está en curso (Sequence con memoria)
    assert Scripted.log == ['a', 'b', 'b', 'b', 'c']


def test_sequence_fails_on_first_failure():
    st, _ = run(tree('<Sequence><Ok name="a"/><Fail name="b"/><Ok name="c"/></Sequence>'))
    assert st == bt.FAILURE
    assert 'c' not in Scripted.log


def test_fallback_stops_at_first_success():
    st, _ = run(tree('<Fallback><Fail name="a"/><Ok name="b"/><Ok name="c"/></Fallback>'))
    assert st == bt.SUCCESS
    assert Scripted.log == ['a', 'b']


def test_reactive_sequence_rechecks_conditions_every_tick():
    st, _ = run(tree('<ReactiveSequence><Ok name="cond"/><Slow name="act"/></ReactiveSequence>'))
    assert st == bt.SUCCESS
    assert Scripted.log == ['cond', 'act', 'cond', 'act', 'cond', 'act']


def test_inverter_and_retry():
    assert run(tree('<Inverter><Fail/></Inverter>'))[0] == bt.SUCCESS
    st, _ = run(tree('<RetryUntilSuccessful num_attempts="3"><Fail name="x"/></RetryUntilSuccessful>'))
    assert st == bt.FAILURE
    assert Scripted.log.count('x') == 3


def test_subtree_and_blackboard_ports():
    xml = tree('<Sequence><SetBlackboard output_key="k" value="v"/><SubTree ID="S"/></Sequence>',
               '<BehaviorTree ID="S"><Check key="k" value="v"/></BehaviorTree>')
    assert run(xml)[0] == bt.SUCCESS


def test_halt_stops_running_leaf_and_resets_status():
    Scripted.log = []
    runner = bt.Runner(bt.build(tree('<Sequence><Slow name="s"/></Sequence>'), LEAVES), make_leaf)
    assert runner.tick() == bt.RUNNING
    runner.halt()
    assert Scripted.log[-1] == 'halt:s'
    snap = runner.tree.snapshot()
    assert snap['children'][0]['children'][0]['status'] == bt.IDLE


def test_snapshot_shape():
    _, runner = run(tree('<Sequence name="raíz"><Ok name="a"/></Sequence>'))
    snap = runner.tree.snapshot()
    seq = snap['children'][0]
    assert seq['name'] == 'raíz' and seq['role'] == 'control' and seq['status'] == bt.SUCCESS
    assert seq['children'][0]['id'] == '0.0.0'


@pytest.mark.parametrize('xml, msg', [
    ('<root', 'XML no válido'),
    ('<root/>', 'No hay ningún'),
    (tree('<Sequence/>'), 'sin hijos'),
    (tree('<Inverter><Ok/><Ok/></Inverter>'), 'exactamente un hijo'),
    (tree('<Teleport/>'), 'desconocido'),
    (tree('<SubTree ID="X"/>'), 'no existe'),
])
def test_invalid_trees_are_rejected_with_a_clear_message(xml, msg):
    with pytest.raises(bt.BtError, match=msg):
        bt.build(xml, LEAVES)


def test_wait_uses_clock():
    t = [0.0]
    w = bt.Wait({'seconds': '2'}, {}, clock=lambda: t[0])
    assert w.tick() == bt.RUNNING
    t[0] = 2.5
    assert w.tick() == bt.SUCCESS
