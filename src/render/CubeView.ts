import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { CubeState, NO_FACE, SINK, SOURCE } from '../game/CubeState';
import { FlowResult } from '../game/Flow';
import { ALL_BITS, Axis, DIRS } from '../game/dir';
import { PALETTE } from './colors';

const SPACING = 1.14;

interface Droplet {
  mesh: THREE.Mesh;
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  phase: number;
  speed: number;
  kind: 'fountain' | 'spurt';
  delay: number;
}

interface PickResult {
  cell: number;
  coord: [number, number, number];
  normal: THREE.Vector3;
}

// ---- shared, cached resources (never disposed; cheap to reuse) -------------
const sphereGeo = new THREE.SphereGeometry(1, 14, 12);
const dropGeo = new THREE.IcosahedronGeometry(1, 0);
const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
const unitBox = new THREE.BoxGeometry(1, 1, 1);
// Subdivided plane used as the sloshing water surface (segments along length).
const waterSurfaceGeo = new THREE.PlaneGeometry(1, 1, 4, 20);
const ringGeo = new THREE.TorusGeometry(0.27, 0.07, 8, 20);
const holeGeo = new THREE.CircleGeometry(0.22, 18);
const holeMat = new THREE.MeshBasicMaterial({
  color: 0x223038,
  side: THREE.DoubleSide,
});

const boxCache = new Map<number, THREE.BufferGeometry>();
function boxGeo(size: number): THREE.BufferGeometry {
  let g = boxCache.get(size);
  if (!g) {
    g = new RoundedBoxGeometry(size, size, size, 3, size * 0.12);
    boxCache.set(size, g);
  }
  return g;
}
// Terrain blocks. Each cubelet is either a grass block or a dirt block; the
// type is chosen by low-frequency noise so neighbouring cubelets cluster into
// multi-cube grass/dirt patches across the surface. A clone of the rounded box
// gets per-vertex jitter so it reads as minimalist texture.
const terrainCache = new Map<string, THREE.BufferGeometry>();
function terrainGeo(size: number, grassy: boolean): THREE.BufferGeometry {
  const key = `${size}:${grassy ? 'g' : 'd'}`;
  let g = terrainCache.get(key);
  if (g) return g;
  g = (boxGeo(size) as THREE.BufferGeometry).clone();
  const pos = g.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const light = new THREE.Color(grassy ? PALETTE.grass : PALETTE.dirt);
  const dark = new THREE.Color(grassy ? PALETTE.grassDark : PALETTE.dirtDark);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const h = Math.sin(
      (pos.getX(i) * 12.9 + pos.getY(i) * 78.2 + pos.getZ(i) * 37.7) * 43.0
    );
    const j = h - Math.floor(h); // 0..1 deterministic
    c.copy(j > 0.5 ? light : dark);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  terrainCache.set(key, g);
  return g;
}
const grassDirtMat = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.95,
  metalness: 0,
});


const edgeCache = new Map<number, THREE.BufferGeometry>();
function edgeGeo(size: number): THREE.BufferGeometry {
  let g = edgeCache.get(size);
  if (!g) {
    g = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(size * 1.001, size * 1.001, size * 1.001),
      30
    );
    edgeCache.set(size, g);
  }
  return g;
}

const edgeMat = new THREE.LineBasicMaterial({
  color: PALETTE.edge,
  transparent: true,
  opacity: 0.85,
});
const highlightEdgeMat = new THREE.LineBasicMaterial({
  color: PALETTE.waterBright,
  transparent: true,
  opacity: 0.95,
});
const highlightFaceMat = new THREE.MeshBasicMaterial({
  color: PALETTE.water,
  transparent: true,
  opacity: 0.16,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});
const grooveMat = new THREE.MeshStandardMaterial({
  color: PALETTE.groove,
  roughness: 0.9,
  metalness: 0,
});
const trenchMat = new THREE.MeshStandardMaterial({
  color: PALETTE.grooveDark,
  roughness: 0.98,
  metalness: 0,
});
// GPU-cheap flowing water: one shared shader, animated by a single uTime
// uniform. Scrolling bright bands give directional flow; a fresnel rim makes
// the liquid read as glassy without any texture fetches or post-processing.
const waterMat = new THREE.ShaderMaterial({
  transparent: true,
  uniforms: {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(PALETTE.water) },
    uBright: { value: new THREE.Color(PALETTE.waterBright) },
    uDeep: { value: new THREE.Color(PALETTE.waterDeep) },
    uSpeed: { value: 1.6 },
    uOpacity: { value: 0.97 },
    uAmp: { value: 0.04 },
  },
  side: THREE.DoubleSide,
  vertexShader: /* glsl */ `
    uniform float uTime; uniform float uAmp; uniform float uSpeed;
    varying vec2 vUv;
    varying vec3 vN;
    varying vec3 vView;
    varying float vWave;
    // Sum-of-sines (Gerstner-ish) surface so the water physically sloshes in 3D.
    float waveH(vec2 p, float tt) {
      float w = 0.55 * sin(p.y * 13.0 - tt * 5.0 * uSpeed);
      w += 0.30 * sin(p.y * 27.0 + tt * 3.3 + p.x * 9.0);
      w += 0.18 * sin(p.y * 8.0 - tt * 2.0 + p.x * 4.0);
      w += 0.12 * sin((p.x + p.y) * 19.0 - tt * 6.5);
      return w;
    }
    void main() {
      vUv = uv;
      float tt = uTime;
      float h = waveH(uv, tt);
      vWave = h;
      // finite-difference normal of the displaced surface for lighting/fresnel
      float e = 0.02;
      float hx = waveH(uv + vec2(e, 0.0), tt) - h;
      float hy = waveH(uv + vec2(0.0, e), tt) - h;
      vec3 disp = position + normal * (h * uAmp);
      // perturb normal by the slope so crests catch light
      vec3 n = normalize(normal - vec3(hx, hy, 0.0) * (uAmp * 6.0));
      vec4 mv = modelViewMatrix * vec4(disp, 1.0);
      vN = normalize(normalMatrix * n);
      vView = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uTime; uniform vec3 uColor; uniform vec3 uBright;
    uniform vec3 uDeep; uniform float uSpeed; uniform float uOpacity;
    varying vec2 vUv; varying vec3 vN; varying vec3 vView; varying float vWave;
    void main() {
      float y = vUv.y;       // along the channel
      float x = vUv.x;       // across the channel
      float tt = uTime;

      // The flow centreline meanders like a river (domain warp on y).
      float meander = 0.10 * sin(y * 9.0 + tt * 2.0)
                    + 0.05 * sin(y * 19.0 - tt * 3.3);
      float flow = y * 2.6 - tt * uSpeed + meander;
      float t = fract(flow);
      float band = smoothstep(0.26, 0.5, t) - smoothstep(0.5, 0.76, t);

      // Layered turbulence -> churning surface + foam crests.
      float turb = 0.50 * sin(y * 23.0 - tt * 7.0 + x * 6.0);
      turb += 0.30 * sin(y * 39.0 + tt * 5.0 - x * 11.0);
      turb += 0.20 * sin(y * 63.0 - tt * 9.5 + x * 3.0 + meander * 8.0);
      turb = 0.5 + 0.5 * turb;                 // -> 0..1
      float foam = smoothstep(0.72, 0.96, turb * (0.55 + 0.7 * band));
      float crest = smoothstep(0.35, 0.9, vWave * 0.5 + 0.5); // wave-top foam

      float fres = pow(1.0 - max(dot(vN, vView), 0.0), 2.0);

      vec3 col = mix(uDeep, uColor, 0.45 + 0.55 * turb);
      col = mix(col, uBright, band * 0.8);
      col += uBright * foam * 0.6;             // churning crests
      col += uBright * crest * 0.35;           // foam on wave tops
      col += uBright * fres * 0.5;             // glassy rim
      gl_FragColor = vec4(col, uOpacity);
    }
  `,
});
// Same water look but no vertex displacement — used for the round joints and
// outlet nubs, which would otherwise bulge sideways instead of bobbing with the
// surface of their cell.
const waterMatStill = waterMat.clone();
waterMatStill.uniforms.uAmp.value = 0;

const waterDropMat = new THREE.MeshBasicMaterial({
  color: PALETTE.waterBright,
  transparent: true,
  opacity: 0.95,
});
const sourceRingMat = new THREE.MeshStandardMaterial({
  color: PALETTE.sourceRing,
  roughness: 0.5,
});

const cubeletMatCache = new Map<number, THREE.MeshStandardMaterial>();
function cubeletMat(color: number): THREE.MeshStandardMaterial {
  let m = cubeletMatCache.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.82,
      metalness: 0,
      flatShading: false,
    });
    cubeletMatCache.set(color, m);
  }
  return m;
}
const ringMatCache = new Map<number, THREE.MeshStandardMaterial>();
function ringMat(color: number): THREE.MeshStandardMaterial {
  let m = ringMatCache.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0 });
    ringMatCache.set(color, m);
  }
  return m;
}

/** Builds and animates the visual cube from logical state + flow result. */
export class CubeView {
  root: THREE.Group;
  private n = 3;
  private center = 1;
  private cellGroups = new Map<number, THREE.Group>();
  private pickList: THREE.Mesh[] = [];
  private pivot: THREE.Group | null = null;
  private highlights: THREE.Object3D[] = [];
  private droplets: Droplet[] = [];
  private fillItems: { obj: THREE.Object3D; base: THREE.Vector3; delay: number }[] =
    [];
  private fillClock = 0;
  private size = SPACING * 0.9;

  constructor(root: THREE.Group) {
    this.root = root;
  }

  private worldPos(x: number, y: number, z: number, out = new THREE.Vector3()) {
    return out.set(
      (x - this.center) * SPACING,
      (y - this.center) * SPACING,
      (z - this.center) * SPACING
    );
  }

  clear() {
    if (this.pivot) {
      this.root.remove(this.pivot);
      this.pivot = null;
    }
    for (const g of this.cellGroups.values()) {
      g.parent?.remove(g);
    }
    this.cellGroups.clear();
    this.pickList.length = 0;
    this.droplets.length = 0;
    this.fillItems.length = 0;
  }

  build(cube: CubeState, flow: FlowResult, colors: Map<number, number>) {
    this.clear();
    this.n = cube.n;
    this.center = (cube.n - 1) / 2;
    this.size = SPACING * 0.9;
    this.fillClock = 0;
    const n = cube.n;
    const PER_HOP = 0.05; // seconds of travel per canal hop

    // Render every cubelet so the puzzle reads as one solid object; water
    // channels are then carved on top of the network cells.
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        for (let z = 0; z < n; z++) {
          const i = cube.idx(x, y, z);
          const shell =
            x === 0 || x === n - 1 || y === 0 || y === n - 1 || z === 0 || z === n - 1;
          if (!shell) continue; // hollow interior — never seen, saves draw calls

          const group = new THREE.Group();
          this.worldPos(x, y, z, group.position);
          this.root.add(group);
          this.cellGroups.set(i, group);

          const kind = cube.kind[i];
          const ports = cube.ports[i];
          const filled = flow.filled[i] === 1;
          const isSink = kind === SINK;
          const isSource = kind === SOURCE;
          const accent = colors.get(i) ?? PALETTE.cubelet;
          // how long until the flow front reaches this cell
          const fillDelay = filled && flow.dist[i] >= 0 ? flow.dist[i] * PER_HOP : 0;
          const regFill = (obj: THREE.Object3D) =>
            this.fillItems.push({ obj, base: obj.scale.clone(), delay: fillDelay });

          // ---- cubelet body: grass/dirt terrain block; sinks are colour-blocked
          // Terrain type is carried on the cube so it rotates with the piece.
          const grassy = cube.terrain[i] !== 0; // 1 grass / 255 default -> grass
          const body = isSink
            ? new THREE.Mesh(boxGeo(this.size), cubeletMat(accent))
            : new THREE.Mesh(terrainGeo(this.size, grassy), grassDirtMat);
          body.userData.cell = i;
          group.add(body);
          this.pickList.push(body);

          const edges = new THREE.LineSegments(edgeGeo(this.size), edgeMat);
          group.add(edges);

          if (ports === 0) continue;

          // The face this cell's channel lives on. We prefer the per-piece
          // stored face (so canals rotate rigidly with the cube), but only if
          // that face is still EXPOSED on the surface. If a rotation has turned
          // it inward, we re-project to an exposed face so a canal is always
          // visible — water never appears to flow without a channel.
          const fd = cube.face[i];
          const nrm =
            fd !== NO_FACE && isExposedFace(x, y, z, fd, n)
              ? dirVec(DIRS[fd])
              : outerNormal(x, y, z, n);
          // R = cubelet face. Canals are walled channels carved on the face.
          const R = this.size * 0.5;
          const half = SPACING * 0.5;
          const floorH = nrm.clone().multiplyScalar(R - 0.01); // channel floor
          const waterH = nrm.clone().multiplyScalar(R + 0.05); // water surface
          const wallH = nrm.clone().multiplyScalar(R + 0.04); // raised wall centre
          const UP = new THREE.Vector3(0, 1, 0);
          const FWD = new THREE.Vector3(0, 0, 1);

          // A walled canal arm running from the cell centre toward `dir`.
          const drawArm = (dir: THREE.Vector3, len: number, isFilled: boolean) => {
            const wb = new THREE.Vector3().crossVectors(nrm, dir);
            if (wb.lengthSq() < 1e-4) {
              // port runs along the normal (into the cube) -> short tube
              const tube = new THREE.Mesh(
                cylGeo,
                isFilled ? waterMatStill : grooveMat
              );
              tube.scale.set(isFilled ? 0.14 : 0.12, len, isFilled ? 0.14 : 0.12);
              tube.quaternion.setFromUnitVectors(UP, dir);
              tube.position.copy(waterH).addScaledVector(dir, len * 0.5);
              group.add(tube);
              if (isFilled) regFill(tube);
              return;
            }
            wb.normalize();
            const boxB = new THREE.Matrix4().makeBasis(wb, nrm, dir); // right-handed
            // channel floor
            const floor = new THREE.Mesh(unitBox, trenchMat);
            floor.quaternion.setFromRotationMatrix(boxB);
            floor.scale.set(0.3, 0.06, len);
            floor.position.copy(floorH).addScaledVector(dir, len * 0.5);
            group.add(floor);
            // two raised walls framing the channel
            for (const s of [1, -1]) {
              const wall = new THREE.Mesh(unitBox, trenchMat);
              wall.quaternion.setFromRotationMatrix(boxB);
              wall.scale.set(0.06, 0.2, len);
              wall.position
                .copy(wallH)
                .addScaledVector(dir, len * 0.5)
                .addScaledVector(wb, 0.15 * s);
              group.add(wall);
            }
            // water surface (displaced plane) or empty groove
            if (isFilled) {
              const surf = new THREE.Mesh(waterSurfaceGeo, waterMat);
              // RIGHT-handed basis (col0 x col1 == col2): (dir x nrm) x dir == nrm
              const planeB = new THREE.Matrix4().makeBasis(
                wb.clone().negate(),
                dir,
                nrm
              );
              surf.quaternion.setFromRotationMatrix(planeB);
              surf.scale.set(0.22, len, 1);
              surf.position.copy(waterH).addScaledVector(dir, len * 0.5);
              group.add(surf);
              regFill(surf);
            } else {
              const ribbon = new THREE.Mesh(unitBox, grooveMat);
              ribbon.quaternion.setFromRotationMatrix(boxB);
              ribbon.scale.set(0.2, 0.05, len);
              ribbon.position.copy(floorH).addScaledVector(dir, len * 0.5);
              group.add(ribbon);
            }
          };

          // An outlet/leak hole seated on the cell's `dir` face.
          const drawHole = (dir: THREE.Vector3, isFilled: boolean) => {
            const isOutlet = isSource || isSink;
            const rmat = isSource
              ? sourceRingMat
              : isSink
                ? ringMat(accent)
                : trenchMat;
            const hole = new THREE.Mesh(holeGeo, holeMat);
            hole.quaternion.setFromUnitVectors(FWD, dir);
            hole.position.copy(dir).multiplyScalar(R + 0.012);
            hole.scale.setScalar(isOutlet ? 1.0 : 0.6);
            hole.renderOrder = 2;
            group.add(hole);
            const ring = new THREE.Mesh(ringGeo, rmat);
            ring.quaternion.setFromUnitVectors(FWD, dir);
            ring.position.copy(dir).multiplyScalar(R + 0.03);
            ring.scale.setScalar(isSource ? 1.0 : isSink ? 1.12 : 0.58);
            ring.renderOrder = 3;
            group.add(ring);
            if (isFilled) {
              const plug = new THREE.Mesh(cylGeo, waterMatStill);
              const pr = isOutlet ? 0.16 : 0.1;
              plug.scale.set(pr, 0.3, pr);
              plug.quaternion.setFromUnitVectors(UP, dir);
              plug.position.copy(dir).multiplyScalar(R + 0.1);
              plug.renderOrder = 2;
              group.add(plug);
              regFill(plug);
              this.addEmitter(
                group,
                dir,
                isSource ? 'fountain' : 'spurt',
                dir.clone().multiplyScalar(R + 0.14),
                fillDelay
              );
            }
          };

          for (let di = 0; di < 6; di++) {
            if (!(ports & ALL_BITS[di])) continue;
            const d = DIRS[di];
            const dir = new THREE.Vector3(d.x, d.y, d.z);
            const nx = x + d.x,
              ny = y + d.y,
              nz = z + d.z;
            const outside =
              nx < 0 || nx >= n || ny < 0 || ny >= n || nz < 0 || nz >= n;
            const along = dir.dot(nrm);

            // Draw a canal toward every port that lies in the face plane — this
            // includes outlet ports, so a hole always has a channel leading to
            // it. Ports along the normal are either the vertical spout (outward,
            // no arm) or a hidden inward link (short tube).
            if (Math.abs(along) < 0.5) drawArm(dir, outside ? half : half + 0.04, filled);
            else if (along <= -0.5) drawArm(dir, half * 0.7, filled);

            if (outside) drawHole(dir, filled);
          }

          // joint hub where canals cross
          const bedHub = new THREE.Mesh(cylGeo, trenchMat);
          bedHub.scale.set(0.2, 0.1, 0.2);
          bedHub.quaternion.setFromUnitVectors(UP, nrm);
          bedHub.position.copy(floorH);
          group.add(bedHub);
          const joint = new THREE.Mesh(cylGeo, filled ? waterMatStill : grooveMat);
          joint.scale.set(filled ? 0.15 : 0.13, 0.05, filled ? 0.15 : 0.13);
          joint.quaternion.setFromUnitVectors(UP, nrm);
          joint.position.copy(waterH);
          group.add(joint);
          if (filled) regFill(joint);
        }
      }
    }
  }

  private addEmitter(
    group: THREE.Group,
    dir: THREE.Vector3,
    kind: 'fountain' | 'spurt',
    base: THREE.Vector3,
    delay = 0
  ) {
    const count = kind === 'fountain' ? 8 : 6;
    for (let k = 0; k < count; k++) {
      const mesh = new THREE.Mesh(dropGeo, waterDropMat);
      mesh.scale.setScalar(0.085 + (k % 3) * 0.02);
      group.add(mesh);
      this.droplets.push({
        mesh,
        origin: base.clone(),
        dir: dir.clone(),
        phase: k / count,
        speed: kind === 'fountain' ? 0.9 : 1.2,
        kind,
        delay,
      });
    }
  }

  // ---- animation ----------------------------------------------------------
  update(dt: number, time: number) {
    waterMat.uniforms.uTime.value = time;
    waterMatStill.uniforms.uTime.value = time;

    // Flow propagation: reveal water cell-by-cell from the source outward so it
    // visibly rushes through newly connected canals rather than popping in.
    this.fillClock += dt;
    for (const it of this.fillItems) {
      const tt = (this.fillClock - it.delay) / 0.1;
      if (tt <= 0) {
        it.obj.visible = false;
      } else {
        it.obj.visible = true;
        const s = Math.min(1, tt);
        const e = 1 - Math.pow(1 - s, 2);
        it.obj.scale.copy(it.base).multiplyScalar(e);
      }
    }

    const g = new THREE.Vector3(0, -1, 0);
    for (const d of this.droplets) {
      if (this.fillClock < d.delay) {
        d.mesh.visible = false;
        continue;
      }
      d.mesh.visible = true;
      d.phase += dt * d.speed;
      if (d.phase > 1) d.phase -= 1;
      const t = d.phase;
      const m = d.mesh;
      if (d.kind === 'fountain') {
        // rise then fall along an arc around the up direction
        const h = Math.sin(t * Math.PI) * 0.9;
        const spread = 0.12 * t;
        m.position
          .copy(d.origin)
          .addScaledVector(d.dir, 0.15 + h)
          .addScaledVector(
            new THREE.Vector3(Math.cos(t * 7), 0, Math.sin(t * 7)),
            spread
          );
        const s = 0.11 - t * 0.05;
        m.scale.setScalar(Math.max(0.03, s));
      } else {
        // spurt: out along dir + gravity droop
        const out = 0.2 + t * 1.0;
        const drop = t * t * 0.9;
        m.position
          .copy(d.origin)
          .addScaledVector(d.dir, out)
          .addScaledVector(g, drop);
        const s = 0.1 - t * 0.04;
        m.scale.setScalar(Math.max(0.03, s));
      }
    }
  }

  /**
   * Compute a screen-space swipe (start/end px) that, fed through the normal
   * gesture pipeline, produces the given logical layer move. Used by automated
   * tests to solve levels with real pointer events. Returns null if no visible
   * face can drive that move.
   */
  screenGestureFor(
    move: { axis: Axis; layer: number; turns: number },
    camera: THREE.Camera,
    w: number,
    h: number
  ): { x0: number; y0: number; x1: number; y1: number } | null {
    const n = this.n;
    const camN = camera.position.clone().normalize();
    const axes: Axis[] = ['x', 'y', 'z'];
    const axisVec = (a: Axis, s: number) =>
      new THREE.Vector3(a === 'x' ? s : 0, a === 'y' ? s : 0, a === 'z' ? s : 0);
    const comp = (v: THREE.Vector3, a: Axis) =>
      a === 'x' ? v.x : a === 'y' ? v.y : v.z;

    for (const fa of axes) {
      if (fa === move.axis) continue;
      for (const s of [1, -1]) {
        const nf = axisVec(fa, s);
        if (nf.dot(camN) < 0.3) continue; // face not visible
        const Ba = axes.find((a) => a !== fa && a !== move.axis)!;
        const coord = { x: 0, y: 0, z: 0 } as Record<Axis, number>;
        coord[fa] = s > 0 ? n - 1 : 0;
        coord[move.axis] = move.layer;
        coord[Ba] = Math.floor(n / 2);

        const center = this.worldPos(coord.x, coord.y, coord.z).addScaledVector(
          nf,
          this.size * 0.5
        );
        const p0 = this.project(center, camera, w, h);
        const Bunit = axisVec(Ba, 1);
        const rax = new THREE.Vector3().crossVectors(nf, Bunit);
        const moveSign = Math.sign(comp(rax, move.axis)) || 1;
        const dragSign = Math.sign(move.turns) === moveSign ? 1 : -1;
        const end = center.clone().addScaledVector(Bunit, 0.7 * dragSign);
        const p1 = this.project(end, camera, w, h);
        let dx = p1.x - p0.x;
        let dy = p1.y - p0.y;
        const L = Math.hypot(dx, dy) || 1;
        const px = 130 * Math.abs(move.turns) + 24;
        return { x0: p0.x, y0: p0.y, x1: p0.x + (dx / L) * px, y1: p0.y + (dy / L) * px };
      }
    }
    return null;
  }

  private project(
    v: THREE.Vector3,
    camera: THREE.Camera,
    w: number,
    h: number
  ): { x: number; y: number } {
    const p = v.clone().project(camera);
    return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h };
  }

  // ---- picking ------------------------------------------------------------
  pick(raycaster: THREE.Raycaster): PickResult | null {
    const hits = raycaster.intersectObjects(this.pickList, false);
    if (!hits.length) return null;
    const h = hits[0];
    const mesh = h.object as THREE.Mesh;
    const cell = mesh.userData.cell as number;
    let normal = new THREE.Vector3(0, 0, 1);
    if (h.face) {
      normal = h.face.normal.clone();
      const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
      normal.applyMatrix3(nm).normalize();
    }
    return { cell, coord: this.coordOf(cell), normal };
  }

  private coordOf(i: number): [number, number, number] {
    const n = this.n;
    return [i % n, Math.floor(i / n) % n, Math.floor(i / (n * n))];
  }

  // ---- live layer rotation ------------------------------------------------
  /** Move all cell groups on the given layer into a fresh pivot for animation. */
  beginLayer(axis: Axis, layer: number) {
    if (this.pivot) this.endLayerCancel();
    const pivot = new THREE.Group();
    this.root.add(pivot);
    const sz = this.size;
    for (const [i, group] of this.cellGroups) {
      const [x, y, z] = this.coordOf(i);
      const on =
        (axis === 'x' && x === layer) ||
        (axis === 'y' && y === layer) ||
        (axis === 'z' && z === layer);
      if (on) {
        this.root.remove(group);
        pivot.add(group);
        // glowing outline + faint shell so the active layer reads clearly
        const outline = new THREE.LineSegments(edgeGeo(sz), highlightEdgeMat);
        outline.position.copy(group.position);
        pivot.add(outline);
        this.highlights.push(outline);
        const shell = new THREE.Mesh(boxGeo(sz * 1.04), highlightFaceMat);
        shell.position.copy(group.position);
        pivot.add(shell);
        this.highlights.push(shell);
      }
    }
    this.pivot = pivot;
  }

  setLayerQuat(q: THREE.Quaternion) {
    if (this.pivot) this.pivot.quaternion.copy(q);
  }

  /** Reparent the layer's groups back onto root (at their original local
   *  transforms) before discarding the pivot, so cubelets are never lost even
   *  when a move snaps back to zero and no rebuild follows. */
  private endLayerCancel() {
    if (!this.pivot) return;
    // drop the transient highlight meshes
    for (const h of this.highlights) h.parent?.remove(h);
    const hset = new Set(this.highlights);
    this.highlights.length = 0;
    // reparent the real cubelet groups back to root (keeps local transform)
    const kids = [...this.pivot.children];
    for (const k of kids) if (!hset.has(k)) this.root.add(k);
    this.root.remove(this.pivot);
    this.pivot = null;
  }

  endLayer() {
    this.endLayerCancel();
  }
}

/**
 * Pick the most camera-facing exterior face for a shell cell, so its channel is
 * drawn on a visible surface. Priority: top, then the two front faces, then the
 * back/bottom faces.
 */
function dirVec(d: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(d.x, d.y, d.z);
}

/** True if the face direction `fd` points out of the cube at this cell. */
function isExposedFace(
  x: number,
  y: number,
  z: number,
  fd: number,
  n: number
): boolean {
  const d = DIRS[fd];
  const nx = x + d.x,
    ny = y + d.y,
    nz = z + d.z;
  return nx < 0 || nx >= n || ny < 0 || ny >= n || nz < 0 || nz >= n;
}

function outerNormal(x: number, y: number, z: number, n: number): THREE.Vector3 {
  if (y === n - 1) return new THREE.Vector3(0, 1, 0);
  if (x === n - 1) return new THREE.Vector3(1, 0, 0);
  if (z === n - 1) return new THREE.Vector3(0, 0, 1);
  if (x === 0) return new THREE.Vector3(-1, 0, 0);
  if (z === 0) return new THREE.Vector3(0, 0, -1);
  if (y === 0) return new THREE.Vector3(0, -1, 0);
  return new THREE.Vector3(0, 1, 0);
}
