from sura_view.msgfields import fields_for, fields_of


def test_imu_anidado_y_array_fijo():
    f = fields_of('sensor_msgs/msg/Imu')
    assert f['fields'][:3] == ['header/stamp/sec', 'header/stamp/nanosec', 'orientation/x']
    assert 'orientation_covariance[8]' in f['fields']
    assert f['dynamic'] == []


def test_arrays_variables_sin_bytes():
    assert fields_of('sensor_msgs/msg/JointState')['dynamic'] == ['position', 'velocity', 'effort']
    assert fields_of('sensor_msgs/msg/Image')['dynamic'] == []


def test_tipo_desconocido_se_omite():
    assert list(fields_for(['std_msgs/msg/Int32', 'no_existe/msg/X'])) == ['std_msgs/msg/Int32']
