import * as THREE from 'three';
import { Scene } from '../render/Scene';
import { CubeView } from '../render/CubeView';
import { Axis } from '../game/dir';

const DRAG_THRESHOLD = 9; // px before a gesture commits to slice vs orbit
const PX_PER_RADIAN = 70; // ~110px === one quarter turn
const SNAP_MS = 150;

type Mode = 'idle' | 'decide' | 'slice' | 'orbit' | 'anim';

export interface CommitMove {
  axis: Axis;
  layer: number;
  turns: number;
}

export class Controls {
  private mode: Mode = 'idle';
  private locked = false;

  private pointers = new Map<number, { x: number; y: number }>();
  private startX = 0;
  private startY = 0;
  private lastX = 0;
  private lastY = 0;

  // slice state
  private rotAxis = new THREE.Vector3();
  private screenDir = new THREE.Vector2();
  private axisLetter: Axis = 'y';
  private axisSign = 1;
  private layer = 0;
  private curAngle = 0;

  // snap tween
  private animFrom = 0;
  private animTo = 0;
  private animT = 0;
  private animTurns = 0;

  private ray = new THREE.Raycaster();

  constructor(
    private canvas: HTMLCanvasElement,
    private scene: Scene,
    private view: CubeView,
    private onCommit: (m: CommitMove) => void,
    private onFirstMove: () => void
  ) {
    canvas.addEventListener('pointerdown', this.onDown, { passive: false });
    canvas.addEventListener('pointermove', this.onMove, { passive: false });
    canvas.addEventListener('pointerup', this.onUp, { passive: false });
    canvas.addEventListener('pointercancel', this.onUp, { passive: false });
  }

  setLocked(v: boolean) {
    this.locked = v;
  }

  private ndc(x: number, y: number): THREE.Vector2 {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((x - r.left) / r.width) * 2 - 1,
      -((y - r.top) / r.height) * 2 + 1
    );
  }

  private onDown = (e: PointerEvent) => {
    if (this.locked || this.mode === 'anim') return;
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.startX = this.lastX = e.clientX;
      this.startY = this.lastY = e.clientY;
      this.mode = 'decide';
    } else {
      // second finger -> camera orbit, abandon any slice attempt
      if (this.mode === 'slice') this.view.endLayer();
      this.mode = 'orbit';
    }
  };

  private onMove = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    e.preventDefault();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.mode === 'orbit') {
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      // drag should carry the cube with the finger (grab-and-spin feel)
      this.scene.addOrbit(-dx * 0.006, -dy * 0.006);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      return;
    }

    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;

    if (this.mode === 'decide') {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      this.beginSlice(dx, dy);
      return;
    }

    if (this.mode === 'slice') {
      const s = dx * this.screenDir.x + dy * this.screenDir.y;
      this.curAngle = s / PX_PER_RADIAN;
      const q = new THREE.Quaternion().setFromAxisAngle(this.rotAxis, this.curAngle);
      this.view.setLayerQuat(q);
    }
  };

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.canvas.hasPointerCapture(e.pointerId))
      this.canvas.releasePointerCapture(e.pointerId);

    if (this.mode === 'slice') {
      this.startSnap();
    } else if (this.mode === 'orbit' || this.mode === 'decide') {
      if (this.pointers.size === 0) this.mode = 'idle';
    }
    if (this.pointers.size === 0 && this.mode === 'orbit') this.mode = 'idle';
  };

  private beginSlice(dx: number, dy: number) {
    // Raycast the touch point against the cube.
    this.ray.setFromCamera(this.ndc(this.startX, this.startY), this.scene.camera);
    const hit = this.view.pick(this.ray);
    if (!hit) {
      // empty space -> orbit instead
      this.mode = 'orbit';
      this.lastX = this.startX + dx;
      this.lastY = this.startY + dy;
      return;
    }

    // World-space drag direction projected onto the touched face.
    const cam = this.scene.camera;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const worldDrag = right
      .multiplyScalar(dx)
      .add(up.multiplyScalar(-dy));
    const n = hit.normal.clone().normalize();
    worldDrag.addScaledVector(n, -worldDrag.dot(n)); // project onto face
    if (worldDrag.lengthSq() < 1e-6) {
      this.mode = 'orbit';
      return;
    }
    worldDrag.normalize();

    // Rotation axis = normal x drag, snapped to the nearest cube axis.
    const rawAxis = new THREE.Vector3().crossVectors(n, worldDrag);
    const snapped = snapAxis(rawAxis);
    this.rotAxis.copy(snapped.vec);
    this.axisLetter = snapped.letter;
    this.axisSign = snapped.sign;
    this.layer = hit.coord[axisIndex(snapped.letter)];

    this.screenDir.set(dx, dy).normalize();
    this.curAngle = 0;

    this.view.beginLayer(this.axisLetter, this.layer);
    this.mode = 'slice';
    this.onFirstMove();
  }

  private startSnap() {
    const quarter = Math.PI / 2;
    let turns = Math.round(this.curAngle / quarter);
    // require a reasonable commitment, else snap back
    if (Math.abs(this.curAngle - turns * quarter) > 0.0 && Math.abs(this.curAngle) < quarter * 0.35) {
      turns = 0;
    }
    turns = Math.max(-2, Math.min(2, turns));
    this.animFrom = this.curAngle;
    this.animTo = turns * quarter;
    this.animTurns = turns;
    this.animT = 0;
    this.mode = 'anim';
  }

  update(dt: number) {
    if (this.mode !== 'anim') return;
    this.animT += (dt * 1000) / SNAP_MS;
    if (this.animT >= 1) {
      const q = new THREE.Quaternion().setFromAxisAngle(this.rotAxis, this.animTo);
      this.view.setLayerQuat(q);
      this.view.endLayer();
      const logicalTurns = this.axisSign * this.animTurns;
      this.mode = 'idle';
      if (logicalTurns !== 0) {
        this.onCommit({ axis: this.axisLetter, layer: this.layer, turns: logicalTurns });
      }
      return;
    }
    const e = easeOutCubic(this.animT);
    const a = this.animFrom + (this.animTo - this.animFrom) * e;
    const q = new THREE.Quaternion().setFromAxisAngle(this.rotAxis, a);
    this.view.setLayerQuat(q);
  }

  get busy() {
    return this.mode === 'slice' || this.mode === 'anim';
  }
}

function axisIndex(a: Axis): 0 | 1 | 2 {
  return a === 'x' ? 0 : a === 'y' ? 1 : 2;
}

function snapAxis(v: THREE.Vector3): { vec: THREE.Vector3; letter: Axis; sign: number } {
  const ax = Math.abs(v.x),
    ay = Math.abs(v.y),
    az = Math.abs(v.z);
  let letter: Axis = 'x';
  let sign = Math.sign(v.x) || 1;
  if (ay >= ax && ay >= az) {
    letter = 'y';
    sign = Math.sign(v.y) || 1;
  } else if (az >= ax && az >= ay) {
    letter = 'z';
    sign = Math.sign(v.z) || 1;
  }
  const vec = new THREE.Vector3(
    letter === 'x' ? sign : 0,
    letter === 'y' ? sign : 0,
    letter === 'z' ? sign : 0
  );
  return { vec, letter, sign };
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
