import * as THREE from 'three';
import { PALETTE } from './colors';

/**
 * Owns the renderer, orthographic isometric camera, lighting and the soft blob
 * shadow under the cube. Background is painted by CSS, so the renderer clears
 * transparent.
 */
export class Scene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  root: THREE.Group;

  private frustum = 6.4;
  private baseDir = new THREE.Vector3(1, 0.82, 1).normalize();
  private orbit = { az: 0, el: 0 }; // small peek offsets (radians)

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = false;

    this.scene = new THREE.Scene();
    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    this.updateCamera();

    // Lighting: soft ambient + one key directional, toon-friendly.
    const amb = new THREE.AmbientLight(0xffffff, 0.92);
    this.scene.add(amb);
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(2.5, 4, 1.8);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfe0ff, 0.25);
    fill.position.set(-2, 1, -2.5);
    this.scene.add(fill);

    // Fake blob shadow on the ground.
    const shadowTex = makeBlobTexture();
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(5.4, 5.4),
      new THREE.MeshBasicMaterial({
        map: shadowTex,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        color: PALETTE.shadow,
      })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -2.15;
    this.scene.add(shadow);
  }

  setOrbit(az: number, el: number) {
    // Azimuth spins freely all the way around; elevation is clamped just shy
    // of the poles so the cube never flips upside-down.
    this.orbit.az = az;
    this.orbit.el = THREE.MathUtils.clamp(el, -1.25, 1.25);
    this.updateCamera();
  }

  addOrbit(daz: number, del: number) {
    this.setOrbit(this.orbit.az + daz, this.orbit.el + del);
  }

  get orbitState() {
    return { ...this.orbit };
  }

  private updateCamera() {
    const dir = this.baseDir.clone();
    const e = new THREE.Euler(this.orbit.el, this.orbit.az, 0, 'YXZ');
    dir.applyEuler(e);
    const dist = 14;
    this.camera.position.copy(dir.multiplyScalar(dist));
    this.camera.lookAt(0, 0, 0);
    this.camera.up.set(0, 1, 0);
  }

  resize(w: number, h: number) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    const f = this.frustum;
    this.camera.left = -f * aspect;
    this.camera.right = f * aspect;
    this.camera.top = f;
    this.camera.bottom = -f;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

function makeBlobTexture(): THREE.Texture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 4, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.6)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}
