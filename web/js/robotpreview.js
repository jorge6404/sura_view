// Vista previa 3D del robot en la pantalla de inicio: su URDF girando despacio.
// Arrastra para girarlo y la rueda acerca. Comparte la caché de mallas con la vista 3D.
import * as THREE from 'three';
import { UrdfRobot, fetchUrdf } from './urdf.js';

// cuerpo de los submarinos en FRD (z abajo): se dibuja como NED; los de superficie, z arriba
const NED = new THREE.Matrix4().set(0, 1, 0, 0, 0, 0, -1, 0, -1, 0, 0, 0, 0, 0, 0, 1);
const ZUP = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);

export class RobotPreview {
  constructor(host, msg) {
    this.host = host;
    this.msg = msg;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.prepend(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xdfeeff, 0x223030, 1.3));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(3, 5, 4);
    this.scene.add(key);
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.MeshBasicMaterial({ color: 0x3a434c, transparent: true, opacity: 0.35 }));
    floor.rotation.x = -Math.PI / 2;
    this.floor = floor;
    this.scene.add(floor);
    this.yaw = 0.6; this.pitch = 0.35; this.dist = 2; this.spin = true;
    let drag = null;
    const c = this.renderer.domElement;
    c.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; this.spin = false; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.yaw -= (e.clientX - drag.x) * 0.01;
      this.pitch = Math.max(-0.3, Math.min(1.4, this.pitch + (e.clientY - drag.y) * 0.01));
      drag = { x: e.clientX, y: e.clientY };
    });
    c.addEventListener('pointerup', () => { drag = null; });
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom = Math.max(0.4, Math.min(3, (this.zoom || 1) * (e.deltaY > 0 ? 1.1 : 0.9))); }, { passive: false });
    c.addEventListener('dblclick', () => { this.spin = true; this.zoom = 1; });
    requestAnimationFrame(() => this.frame());
  }

  async show(profile) {
    const gen = this.gen = (this.gen || 0) + 1;
    this.pivot.clear();
    this.robot = null;
    if (!profile) { this.say('Elige un robot'); return; }
    this.say('Generando el modelo…');
    try {
      const urdf = await fetchUrdf(profile, profile.environment);
      if (gen !== this.gen) return;
      const robot = new UrdfRobot(urdf, { onError: (e) => { this.err = e; } });
      const holder = new THREE.Group();
      holder.matrixAutoUpdate = false;
      holder.matrix.copy(profile.family === 'surface' ? ZUP : NED);
      holder.add(robot);
      this.pivot.add(holder);
      this.robot = robot;
      const done = () => {
        if (gen !== this.gen) return;
        if (robot.pending) { this.say(`Cargando mallas (${robot.pending})…`); return; }
        this.say(this.err ? `Algunas mallas no cargan: ${this.err}` : '');
        this.frameRobot(holder);
      };
      robot.addEventListener('loaded', done);
      done();
    } catch (e) {
      if (gen === this.gen) this.say(`Sin modelo 3D: ${e.message}`);
    }
  }

  // centra el robot y ajusta la distancia a su tamaño
  frameRobot(holder) {
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(holder);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    this.pivot.position.set(-center.x, -box.min.y, -center.z);
    this.radius = Math.max(size.x, size.y, size.z);
    this.height = size.y;
    this.floor.scale.setScalar(this.radius * 0.9);
  }

  say(text) { this.msg.textContent = text; this.msg.hidden = !text; }

  frame() {
    requestAnimationFrame(() => this.frame());
    if (!this.host.offsetParent) return;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (w && h && (this.w !== w || this.h !== h)) {
      this.w = w; this.h = h;
      this.renderer.setSize(w, h, false);
      this.renderer.domElement.style.width = '100%';
      this.renderer.domElement.style.height = '100%';
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    if (this.spin) this.yaw += 0.004;
    const r = (this.radius || 0.6) * 2.1 * (this.zoom || 1), target = new THREE.Vector3(0, (this.height || 0.3) * 0.45, 0);
    this.camera.position.set(Math.cos(this.yaw) * Math.cos(this.pitch) * r, target.y + Math.sin(this.pitch) * r, Math.sin(this.yaw) * Math.cos(this.pitch) * r);
    this.camera.lookAt(target);
    this.renderer.render(this.scene, this.camera);
  }
}
