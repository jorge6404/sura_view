import math

import pytest

from sura_view.server_node import parse_waypoints, yaw_quaternion


def test_parse_waypoints_accepts_commas_spaces_and_missing_z():
    assert parse_waypoints('0,0,3; 1 2 3 ;4,5') == [(0, 0, 3), (1, 2, 3), (4, 5, 0)]


@pytest.mark.parametrize('text', ['', ';;', '1'])
def test_parse_waypoints_rejects_empty_or_incomplete(text):
    with pytest.raises(ValueError):
        parse_waypoints(text)


def test_yaw_quaternion():
    w, z = yaw_quaternion(math.pi / 2)
    assert w == pytest.approx(math.sqrt(0.5)) and z == pytest.approx(math.sqrt(0.5))
