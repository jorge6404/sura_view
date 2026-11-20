from sura_view import imucal

TRANSCRIPT = """
Waiting for ROS 2 calibration data...
IMU: /bluerov/controller/imu_broadcaster/imu
Mag: /bluerov/controller/magnetometer_broadcaster/mag

=== Gyroscope calibration ===
Place the robot completely still and avoid vibrations.
When it is motionless, capture will start
> press Enter to continue Samples used: 156
Estimated bias [rad/s]: (-0.053407, -0.000888, 0.050129)
Quality: good (81.0569/100)

=== Magnetometer calibration ===
Move the robot slowly through many orientations, away from metal.
When ready, magnetometer capture will start
> press Enter to continue [mag] samples=20 octants=1/8
[mag] samples=400 octants=5/8
Samples used: 677
3D coverage: 5/8 octants
Quality: poor (39.0661/100)

Point the robot toward North (0 deg).
Keep it still and capture will start
> press Enter to continue North: measured heading=3.2 deg, partial offset=-3.2 deg, spread=1.1 deg
"""


def feed(state, text, now=100.0):
    for line in text.splitlines():
        imucal.parse_line(state, line, now)


def test_phases_prompts_and_results():
    s = imucal.new_state()
    feed(s, TRANSCRIPT)
    assert s['phase'] == 'compass' and s['step'] == 'North' and s['target_deg'] == 0.0
    assert s['results']['gyro'] == {'label': 'good', 'score': 81.0569}
    assert s['results']['magnetometer']['label'] == 'poor'
    assert s['octants'] == 5 and s['samples'] == 400
    assert s['directions'] == [{'name': 'North', 'heading': 3.2, 'spread': 1.1}]
    assert s['awaiting'] is False


def test_waits_for_operator_before_each_capture_and_times_it():
    s = imucal.new_state()
    feed(s, 'Waiting for ROS 2 calibration data...\n=== Gyroscope calibration ===\nWhen it is motionless, capture will start')
    assert s['phase'] == 'gyro' and s['awaiting'] and s['duration'] == 8.0
    imucal.started_capture(s, now=50.0)
    assert not s['awaiting'] and s['capturing_since'] == 50.0


def test_done_and_error():
    s = imucal.new_state()
    feed(s, 'Results saved to: /ws/src/sura_imu/config/sura_imu_calibration.yaml\nCalibration complete.')
    assert s['phase'] == 'done' and s['output'].endswith('sura_imu_calibration.yaml')
    e = imucal.new_state()
    feed(e, 'Error: No IMU or magnetometer data received. Check topics and broadcasters.')
    assert e['phase'] == 'error' and e['error'].startswith('No IMU')


GOOD = """
sura_imu_calibration:
  metadata: {generated_at_unix: 1781000000, imu_topic: '/bluerov/controller/imu_broadcaster/imu'}
  gyro: {available: true, quality_score: 81.0, quality_label: 'good'}
  magnetometer: {available: true, quality_score: 80.0, quality_label: 'good'}
  compass: {available: true, quality_score: 77.0, quality_label: 'good'}
"""


def test_assess():
    assert imucal.assess(GOOD, 'bluerov')['calibrated'] is True
    other = imucal.assess(GOOD, 'cirtesub')
    assert not other['calibrated'] and other['reasons'] == ['Es de otro robot (bluerov)']
    poor = imucal.assess(GOOD.replace("quality_score: 80.0, quality_label: 'good'", "quality_score: 39.0, quality_label: 'poor'"), 'bluerov')
    assert poor['reasons'] == ['Magnetómetro: calidad mala (39/100)']
    missing = imucal.assess('', 'bluerov')
    assert not missing['calibrated'] and not missing['exists']
