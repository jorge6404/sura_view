// El robot (su URDF) haciendo el movimiento que pide cada paso de la calibración de la IMU:
// quieto (giróscopo), tres vueltas de 360° (magnetómetro) o girando hasta un rumbo visto
// desde arriba (brújula). Ejes de three: x = este, y = arriba, -z = norte.
import * as THREE from 'three';
import { UrdfRobot, fetchUrdf } from './urdf.js';
import { DIRS, DUR, captureElapsed, magMove, MAG_MOVES } from './imucal.js';

const NED = new THREE.Matrix4().set(0, 1, 0, 0, 0, 0, -1, 0, -1, 0, 0, 0, 0, 0, 0, 1);
const ZUP = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
const HEADING = { North: 0, East: 90, South: 180, West: 270 };
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const AXIS_LABEL = { yaw: '360° en horizontal', roll: '360° de lado', pitch: '360° de morro' };

export class ImuAnim {
  constructor(host, profile) {
    this.host = host;
    this.robotName = profile?.name;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.prepend(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xdfeeff, 0x223030, 1.3));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(3, 6, 4);
    this.scene.add(key);
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    this.spinner = new THREE.Group();           // gira alrededor del centro del robot
    this.scene.add(this.spinner);
    this.floor = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.6, 64), new THREE.MeshBasicMaterial({ color: 0x4fb37a, transparent: true, opacity: 0, side: THREE.DoubleSide }));
    this.floor.rotation.x = -Math.PI / 2;
    this.scene.add(this.floor);
    this.size = 0.6;
    this.mode = 'show';
    this.heading = 0;                            // rumbo dibujado (grados), para la brújula
    this.load(profile);
  }

  async load(profile) {
    if (!profile) return;
    try {
      const urdf = await fetchUrdf(profile, profile.environment);
      const robot = new UrdfRobot(urdf);
      const holder = new THREE.Group();
      holder.matrixAutoUpdate = false;
      holder.matrix.copy(profile.family === 'surface' ? ZUP : NED);
      holder.add(robot);
      const offset = new THREE.Group();          // lleva el centro del robot al origen del spinner
      offset.add(holder);
      this.spinner.add(offset);
      const center = () => {
        if (robot.pending) return;
        offset.position.set(0, 0, 0);
        offset.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(offset);
        if (box.isEmpty()) return;
        const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
        offset.position.copy(c).negate();
        this.size = Math.max(s.x, s.y, s.z);
        this.spinner.position.y = this.size * 0.55;
        this.floor.scale.setScalar(this.size * 1.1);
      };
      robot.addEventListener('loaded', center);
      center();
    } catch {
      this.host.classList.add('noanim');
    }
  }

  start() {
    if (this.raf) return;
    const loop = () => { this.raf = requestAnimationFrame(loop); this.frame(); };
    this.raf = requestAnimationFrame(loop);
  }

  stop() { cancelAnimationFrame(this.raf); this.raf = null; }

  dispose() { this.stop(); this.renderer.dispose(); this.renderer.domElement.remove(); }

  // estado de la calibración -> qué movimiento dibujar
  set(st) {
    this.st = st;
    const phase = st?.phase;
    this.mode = phase === 'gyro' ? 'still' : phase === 'mag' ? 'mag' : phase === 'compass' ? 'compass' : 'show';
    this.host.dataset.mode = this.mode;
  }

  frame() {
    const host = this.host, w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    if (this.w !== w || this.h !== h) {
      this.w = w; this.h = h;
      this.renderer.setSize(w, h, false);
      this.renderer.domElement.style.width = '100%';
      this.renderer.domElement.style.height = '100%';
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    const t = performance.now() / 1000, st = this.st || {}, sp = this.spinner;
    const label = host.querySelector('.imu-motion');
    let motion = '';
    sp.rotation.set(0, 0, 0);
    this.floor.material.opacity = 0;
    const r = this.size * 2.4;
    const target = new THREE.Vector3(0, this.size * 0.55, 0);

    if (this.mode === 'compass') {
      // vista desde arriba con el norte arriba; el robot gira hasta el rumbo pedido
      this.camera.position.set(0, r * 1.15, 0.001);
      this.camera.up.set(0, 0, -1);
      const i = DIRS.indexOf(st.step);
      const to = HEADING[st.step] ?? 0, from = i > 0 ? HEADING[DIRS[i - 1]] : to;
      let hdg = to;
      if (st.awaiting && from !== to) {
        const cyc = (t % 3.2) / 3.2;             // gira, se para, vuelve a empezar
        hdg = from + (to - from) * ease(Math.min(1, cyc / 0.55));
        motion = '↻ 90° a la derecha';
      }
      this.heading = hdg;
      sp.rotation.y = -THREE.MathUtils.degToRad(hdg);
      host.style.setProperty('--hdg', `${hdg}deg`);
    } else {
      this.camera.up.set(0, 1, 0);
      let yaw = 0.7;
      if (this.mode === 'show') yaw += t * 0.4;
      this.camera.position.set(Math.sin(yaw) * r, target.y + r * 0.45, Math.cos(yaw) * r);
      if (this.mode === 'still') {
        // quieto: un anillo que late en el suelo
        const k = (t % 1.6) / 1.6;
        this.floor.material.opacity = 0.7 * (1 - k);
        this.floor.scale.setScalar(this.size * (0.9 + k * 0.6));
      } else if (this.mode === 'mag') {
        // las tres vueltas: si captura, al ritmo de la captura; si espera, en bucle de muestra
        let axis, ang;
        if (st.capturing_since != null) {
          const f = captureElapsed(st, Date.now() / 1000) / DUR.mag;
          const seg = Math.min(2, Math.floor(f * 3));
          axis = magMove(f).axis;
          ang = ((f * 3) - seg) * Math.PI * 2;
        } else {
          const seg = Math.floor(t / 3) % 3;
          axis = MAG_MOVES[seg].axis;
          ang = ease((t % 3) / 3) * Math.PI * 2;
        }
        if (axis === 'yaw') sp.rotation.y = -ang;
        else if (axis === 'roll') sp.rotation.z = ang;
        else sp.rotation.x = ang;
        motion = `↻ ${AXIS_LABEL[axis]}`;
      }
    }
    if (label && label.textContent !== motion) { label.textContent = motion; label.hidden = !motion; }
    this.camera.lookAt(this.mode === 'compass' ? new THREE.Vector3(0, 0, 0) : target);
    this.renderer.render(this.scene, this.camera);
  }
}
