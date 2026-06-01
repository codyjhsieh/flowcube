import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
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
// Toon gradient ramp gives the cube a hand-shaded, illustrated look.
function makeToonGradient(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 5;
  c.height = 1;
  const ctx = c.getContext('2d')!;
  const stops = ['#9a9a9a', '#bcbcbc', '#dadada', '#f0f0f0', '#ffffff'];
  for (let i = 0; i < stops.length; i++) {
    ctx.fillStyle = stops[i];
    ctx.fillRect(i, 0, 1, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
}
const toonGrad = makeToonGradient();

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
const grassDirtMat = new THREE.MeshToonMaterial({
  vertexColors: true,
  gradientMap: toonGrad,
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

// Bold, slightly-wobbled "ink" outline (fat lines in world units) for the
// hand-drawn look. World units keep the stroke weight consistent under the
// orthographic camera without needing per-resize resolution updates.
const inkMat = new LineMaterial({
  color: PALETTE.edge,
  linewidth: 0.03,
  worldUnits: true,
  transparent: true,
  opacity: 0.92,
});
inkMat.resolution.set(window.innerWidth, window.innerHeight);

const inkCache = new Map<number, LineSegmentsGeometry>();
function inkOutlineGeo(size: number): LineSegmentsGeometry {
  let g = inkCache.get(size);
  if (g) return g;
  const eg = new THREE.EdgesGeometry(
    new THREE.BoxGeometry(size, size, size),
    30
  );
  const pos = eg.getAttribute('position');
  const arr: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i),
      y = pos.getY(i),
      z = pos.getZ(i);
    // deterministic hand-wobble so the same cube always draws the same line
    const h = Math.sin((x * 91.7 + y * 47.3 + z * 13.1) * 51.0);
    const j = (h - Math.floor(h) - 0.5) * 0.02;
    arr.push(x + j, y + j * 0.6, z - j * 0.5);
  }
  g = new LineSegmentsGeometry().setPositions(arr);
  inkCache.set(size, g);
  return g;
}
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
const grooveMat = new THREE.MeshToonMaterial({
  color: PALETTE.groove,
  gradientMap: toonGrad,
});
const trenchMat = new THREE.MeshToonMaterial({
  color: PALETTE.grooveDark,
  gradientMap: toonGrad,
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
    uSpeed: { value: 1.05 },
    uOpacity: { value: 0.93 },
    uAmp: { value: 0.025 },
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

      // Gentle drifting flow highlight (subtle, not a strobe).
      float meander = 0.05 * sin(y * 8.0 + tt * 1.3);
      float flow = fract(y * 2.0 - tt * uSpeed + meander);
      float band = smoothstep(0.30, 0.5, flow) - smoothstep(0.5, 0.72, flow);

      // Calm turbulence for life.
      float turb = 0.5 * sin(y * 16.0 - tt * 3.5 + x * 5.0)
                 + 0.3 * sin(y * 28.0 + tt * 2.6 - x * 8.0);
      turb = 0.5 + 0.5 * turb;

      // Depth: deeper teal toward the centre of the channel, lighter near banks.
      float centre = 1.0 - clamp(abs(x - 0.5) * 2.0, 0.0, 1.0);
      vec3 col = mix(uColor, uDeep, centre * 0.65);
      col = mix(col, uBright, band * 0.45);

      // Soft white foam: along the banks and on the moving wave crests.
      float bankFoam = smoothstep(0.80, 1.0, abs(x - 0.5) * 2.0);
      float crestFoam = smoothstep(0.55, 0.95, turb * (0.4 + 0.7 * band));
      float foam = clamp(bankFoam + crestFoam * 0.5, 0.0, 0.7);
      col = mix(col, vec3(0.93, 0.98, 1.0), foam);

      // Subtle glassy rim, much gentler than before.
      float fres = pow(1.0 - max(dot(vN, vView), 0.0), 2.0);
      col += uBright * fres * 0.22;

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
const sourceRingMat = new THREE.MeshToonMaterial({
  color: PALETTE.sourceRing,
  gradientMap: toonGrad,
});

const cubeletMatCache = new Map<number, THREE.MeshToonMaterial>();
function cubeletMat(color: number): THREE.MeshToonMaterial {
  let m = cubeletMatCache.get(color);
  if (!m) {
    m = new THREE.MeshToonMaterial({ color, gradientMap: toonGrad });
    cubeletMatCache.set(color, m);
  }
  return m;
}
const ringMatCache = new Map<number, THREE.MeshToonMaterial>();
function ringMat(color: number): THREE.MeshToonMaterial {
  let m = ringMatCache.get(color);
  if (!m) {
    m = new THREE.MeshToonMaterial({ color, gradientMap: toonGrad });
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
  private introT = 1; // 0..1 level-entrance animation
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

          const ink = new LineSegments2(inkOutlineGeo(this.size), inkMat);
          ink.computeLineDistances();
          group.add(ink);

          if (ports === 0) continue;

          // Canals live on the cube SURFACE only. Every groove is drawn on an
          // exposed face, and a connection between two cells is always shown as
          // a continuous channel: either two coplanar arms meeting in the gap,
          // or — when the path turns a corner of the cube — a groove that wraps
          // around the shared cube edge. Water never disappears into the solid.
          const R = this.size * 0.5;
          const half = SPACING * 0.5;
          const UP = new THREE.Vector3(0, 1, 0);
          const FWD = new THREE.Vector3(0, 0, 1);

          // Which of a cell's six faces are exposed (neighbour is off the cube).
          const exposedOf = (cx: number, cy: number, cz: number): number[] => {
            const out: number[] = [];
            for (let f = 0; f < 6; f++) {
              const d = DIRS[f];
              const ax = cx + d.x,
                ay = cy + d.y,
                az = cz + d.z;
              if (ax < 0 || ax >= n || ay < 0 || ay >= n || az < 0 || az >= n)
                out.push(f);
            }
            return out;
          };
          const myFaces = exposedOf(x, y, z);
          const vec = (di: number) =>
            new THREE.Vector3(DIRS[di].x, DIRS[di].y, DIRS[di].z);

          // A walled trough arm on `faceNrm`, running from the cell centre toward
          // in-plane direction `dir` for length `len`.
          const drawArm = (
            faceNrm: THREE.Vector3,
            dir: THREE.Vector3,
            len: number,
            isFilled: boolean,
            lift = 0,
            bankInset = 0,
            near = 0
          ) => {
            const wb = new THREE.Vector3().crossVectors(faceNrm, dir);
            if (wb.lengthSq() < 1e-4) return; // dir not in this face plane
            wb.normalize();
            // Each arm is lifted a hair more than the last so overlapping
            // arms at a junction layer cleanly instead of z-fighting.
            const floorH = faceNrm.clone().multiplyScalar(R - 0.01 + lift);
            const waterH = faceNrm.clone().multiplyScalar(R + 0.045 + lift);
            const wallH = faceNrm.clone().multiplyScalar(R + 0.01 + lift);
            const boxB = new THREE.Matrix4().makeBasis(wb, faceNrm, dir);
            // The arm runs from `near` (out from centre) to `len`.
            const span = Math.max(0.02, len - near);
            const mid = (near + len) / 2;
            const floor = new THREE.Mesh(unitBox, grooveMat);
            floor.quaternion.setFromRotationMatrix(boxB);
            floor.scale.set(0.34, 0.06, span);
            floor.position.copy(floorH).addScaledVector(dir, mid);
            group.add(floor);
            // Banks start `bankInset` further out so that at a basin junction
            // they frame each arm without crossing through the middle.
            const bStart = near + bankInset;
            const bLen = Math.max(0.02, len - bStart);
            const bMid = (bStart + len) / 2;
            for (const s of [1, -1]) {
              const wall = new THREE.Mesh(unitBox, trenchMat);
              wall.quaternion.setFromRotationMatrix(boxB);
              wall.scale.set(0.05, 0.12, bLen);
              wall.position
                .copy(wallH)
                .addScaledVector(dir, bMid)
                .addScaledVector(wb, 0.155 * s);
              group.add(wall);
            }
            if (isFilled) {
              const surf = new THREE.Mesh(waterSurfaceGeo, waterMat);
              // RIGHT-handed basis (col0 x col1 == col2): (dir x faceNrm) x dir
              const planeB = new THREE.Matrix4().makeBasis(
                wb.clone().negate(),
                dir,
                faceNrm
              );
              surf.quaternion.setFromRotationMatrix(planeB);
              surf.scale.set(0.27, span, 1);
              surf.position.copy(waterH).addScaledVector(dir, mid);
              group.add(surf);
              regFill(surf);
            } else {
              const hollow = new THREE.Mesh(unitBox, trenchMat);
              hollow.quaternion.setFromRotationMatrix(boxB);
              hollow.scale.set(0.22, 0.04, span);
              hollow.position
                .copy(floorH)
                .addScaledVector(faceNrm, 0.028)
                .addScaledVector(dir, mid);
              group.add(hollow);
            }
          };

          // Build a triangle-strip ribbon from cross-section rows (each row is a
          // left point, a right point, and a normal). Used for curved channel
          // pieces that a box can't represent.
          const strip = (
            rows: { l: THREE.Vector3; r: THREE.Vector3; n: THREE.Vector3 }[],
            mat: THREE.Material,
            track: boolean
          ) => {
            const pos: number[] = [];
            const nrm: number[] = [];
            const uv: number[] = [];
            const idx: number[] = [];
            for (let i = 0; i < rows.length; i++) {
              const { l, r, n } = rows[i];
              pos.push(l.x, l.y, l.z, r.x, r.y, r.z);
              nrm.push(n.x, n.y, n.z, n.x, n.y, n.z);
              const tv = i / (rows.length - 1);
              uv.push(0, tv, 1, tv);
            }
            for (let i = 0; i < rows.length - 1; i++) {
              const a = i * 2;
              idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
            }
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
            g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
            g.setIndex(idx);
            const m = new THREE.Mesh(g, mat);
            group.add(m);
            if (track) regFill(m);
          };

          // A smooth in-plane elbow joining two perpendicular arms (a and b) on
          // one face with a quarter-arc, so a bend reads as a curved channel
          // rather than two boxes butting at a right angle.
          const ELBOW_R = 0.22;
          const drawElbow = (
            faceNrm: THREE.Vector3,
            a: THREE.Vector3,
            b: THREE.Vector3,
            isFilled: boolean
          ) => {
            const SEG = 8;
            const samples = [];
            for (let i = 0; i <= SEG; i++) {
              const t = i / SEG;
              const th = -(Math.PI / 2) * (1 + t); // -90° → -180°
              const u = ELBOW_R + ELBOW_R * Math.cos(th);
              const v = ELBOW_R + ELBOW_R * Math.sin(th);
              const du = -ELBOW_R * Math.sin(th);
              const dv = ELBOW_R * Math.cos(th);
              const tang = a
                .clone()
                .multiplyScalar(du)
                .addScaledVector(b, dv)
                .normalize();
              const perp = new THREE.Vector3().crossVectors(faceNrm, tang).normalize();
              const planar = a.clone().multiplyScalar(u).addScaledVector(b, v);
              samples.push({ perp, planar });
            }
            const at = (h: number, s: { perp: THREE.Vector3; planar: THREE.Vector3 }) =>
              faceNrm.clone().multiplyScalar(h).add(s.planar);
            // floor bed
            strip(
              samples.map((s) => ({
                l: at(R - 0.01, s).addScaledVector(s.perp, 0.17),
                r: at(R - 0.01, s).addScaledVector(s.perp, -0.17),
                n: faceNrm,
              })),
              grooveMat,
              false
            );
            if (isFilled) {
              strip(
                samples.map((s) => ({
                  l: at(R + 0.045, s).addScaledVector(s.perp, 0.135),
                  r: at(R + 0.045, s).addScaledVector(s.perp, -0.135),
                  n: faceNrm,
                })),
                waterMat,
                true
              );
            } else {
              strip(
                samples.map((s) => ({
                  l: at(R + 0.018, s).addScaledVector(s.perp, 0.11),
                  r: at(R + 0.018, s).addScaledVector(s.perp, -0.11),
                  n: faceNrm,
                })),
                trenchMat,
                false
              );
            }
            // two curved banks
            for (const sgn of [1, -1]) {
              strip(
                samples.map((s) => {
                  const base = at(R + 0.01, s).addScaledVector(s.perp, 0.155 * sgn);
                  return {
                    l: base.clone().addScaledVector(faceNrm, -0.06),
                    r: base.clone().addScaledVector(faceNrm, 0.06),
                    n: s.perp.clone().multiplyScalar(sgn),
                  };
                }),
                trenchMat,
                false
              );
            }
          };

          // A short bank closing one side of a junction basin (a side with no
          // arm) so the central pool stays contained and reads as a clean
          // intersection rather than open, criss-crossing strips.
          const drawEndCap = (faceNrm: THREE.Vector3, d4: THREE.Vector3) => {
            const along = new THREE.Vector3()
              .crossVectors(faceNrm, d4)
              .normalize();
            const basis = new THREE.Matrix4().makeBasis(along, faceNrm, d4);
            const wall = new THREE.Mesh(unitBox, trenchMat);
            wall.quaternion.setFromRotationMatrix(basis);
            wall.scale.set(0.36, 0.12, 0.05);
            wall.position
              .copy(faceNrm)
              .multiplyScalar(R + 0.01)
              .addScaledVector(d4, 0.19);
            group.add(wall);
          };

          // A ribbon swept along the cube's ROUNDED edge — the channel literally
          // curves from one face to the next, so nothing is bolted on. Returns a
          // mesh built from a quarter-arc of the edge fillet.
          const edgeR = this.size * 0.12; // matches RoundedBoxGeometry radius
          const cornerRibbon = (
            nA: THREE.Vector3,
            nB: THREE.Vector3,
            width: number,
            proud: number,
            mat: THREE.Material,
            track: boolean
          ) => {
            const u = new THREE.Vector3().crossVectors(nA, nB).normalize(); // edge
            const inner = nA.clone().add(nB).multiplyScalar(R - edgeR); // fillet axis
            const SEG = 10;
            const pos: number[] = [];
            const nrm: number[] = [];
            const uv: number[] = [];
            const idx: number[] = [];
            for (let i = 0; i <= SEG; i++) {
              const ph = (i / SEG) * (Math.PI / 2);
              const radial = nA
                .clone()
                .multiplyScalar(Math.cos(ph))
                .addScaledVector(nB, Math.sin(ph)); // unit surface normal
              const c = inner.clone().addScaledVector(radial, edgeR + proud);
              const l = c.clone().addScaledVector(u, width / 2);
              const r = c.clone().addScaledVector(u, -width / 2);
              pos.push(l.x, l.y, l.z, r.x, r.y, r.z);
              nrm.push(radial.x, radial.y, radial.z, radial.x, radial.y, radial.z);
              uv.push(0, i / SEG, 1, i / SEG);
            }
            for (let i = 0; i < SEG; i++) {
              const a = i * 2;
              idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
            }
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
            g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
            g.setIndex(idx);
            const m = new THREE.Mesh(g, mat);
            group.add(m);
            if (track) regFill(m);
          };

          // Wrap a connection around the edge shared by faces `fa` and `fb`:
          // straight arms up to (just shy of) the edge, then a curved ribbon that
          // rides the rounded fillet across to the other face.
          const drawWrap = (fa: number, fb: number, isFilled: boolean) => {
            const nA = vec(fa);
            const nB = vec(fb);
            drawArm(nA, nB, R - 0.03, isFilled, 0.006); // up face A toward edge
            drawArm(nB, nA, R - 0.03, isFilled, 0.006); // up face B toward edge
            if (isFilled) {
              cornerRibbon(nA, nB, 0.34, 0.0, grooveMat, false); // bed
              cornerRibbon(nA, nB, 0.27, 0.05, waterMat, true); // water
            } else {
              cornerRibbon(nA, nB, 0.34, 0.0, grooveMat, false); // bed
              cornerRibbon(nA, nB, 0.22, 0.03, trenchMat, false); // dark line
            }
          };

          // An outlet/leak hole pointing straight out of face `dir`.
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
            ring.scale.setScalar(isSource ? 0.92 : isSink ? 0.95 : 0.52);
            ring.renderOrder = 3;
            group.add(ring);
            if (isFilled) {
              const plug = new THREE.Mesh(cylGeo, waterMatStill);
              const pr = isOutlet ? 0.13 : 0.08;
              plug.scale.set(pr, 0.22, pr);
              plug.quaternion.setFromUnitVectors(UP, dir);
              plug.position.copy(dir).multiplyScalar(R + 0.07);
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

          // ---- assign each port to a surface face -------------------------
          // The face each internal port's arm lives on is read straight from the
          // cube's equivariant store (CubeState.armFace), which was pinned in the
          // solved state and rotates rigidly with the piece — so a canal never
          // re-snaps to a different face when a layer is turned. Outward ports
          // become an outlet/leak hole on that exposed face.
          const armsOnFace = new Map<number, number[]>(); // face -> port dirs
          const activeFaces = new Set<number>();
          const outletDirs: number[] = [];
          for (let di = 0; di < 6; di++) {
            if (!(ports & ALL_BITS[di])) continue;
            const d = DIRS[di];
            const nx = x + d.x,
              ny = y + d.y,
              nz = z + d.z;
            const outside =
              nx < 0 || nx >= n || ny < 0 || ny >= n || nz < 0 || nz >= n;
            if (outside) {
              outletDirs.push(di);
              activeFaces.add(di); // the hole + its hub live on face di
              continue;
            }
            const stored = cube.armFace[i * 6 + di];
            let chosen = stored !== NO_FACE ? stored : (myFaces[0] ?? di);
            // On a mutual connection both cells defer to the lower-id piece's
            // stored face. A face perpendicular to the connection is exposed on
            // both cells, so the owner's choice is always valid on this cell too
            // — guaranteeing the two arms meet even at a freshly-formed edge.
            const ni = cube.idx(nx, ny, nz);
            const opp = di ^ 1;
            if (
              cube.ports[ni] & ALL_BITS[opp] &&
              cube.piece[ni] >= 0 &&
              cube.piece[ni] < cube.piece[i]
            ) {
              const nbFace = cube.armFace[ni * 6 + opp];
              if (nbFace !== NO_FACE) chosen = nbFace;
            }
            if (!armsOnFace.has(chosen)) armsOnFace.set(chosen, []);
            armsOnFace.get(chosen)!.push(di);
            activeFaces.add(chosen);
          }

          // ---- draw it ----------------------------------------------------
          // Arms run from the cell centre, so the centre is already covered by
          // the arms overlapping there — no hub disc needed. Where two or more
          // arms meet on one face (a bend / T / cross) we inset their banks and
          // cap the open sides, so the intersection reads as one smooth basin
          // instead of criss-crossing strips. Each arm is lifted a hair so the
          // overlapping water layers without z-fighting.
          for (const [f, dirs] of armsOnFace) {
            const fn = vec(f);
            const axes = new Set(dirs.map((di) => di >> 1));
            if (dirs.length === 2 && axes.size === 2) {
              // L-bend: stop the arms short and join them with a curved elbow.
              dirs.forEach((di, k) =>
                drawArm(fn, vec(di), half + 0.07, filled, k * 0.012, 0, ELBOW_R)
              );
              drawElbow(fn, vec(dirs[0]), vec(dirs[1]), filled);
            } else if (axes.size >= 2) {
              // T / cross: inset banks and cap the open sides to form a basin.
              dirs.forEach((di, k) =>
                drawArm(fn, vec(di), half + 0.07, filled, k * 0.012, 0.17)
              );
              for (let dd = 0; dd < 6; dd++) {
                const inPlane =
                  DIRS[f].x * DIRS[dd].x +
                    DIRS[f].y * DIRS[dd].y +
                    DIRS[f].z * DIRS[dd].z ===
                  0;
                if (inPlane && !dirs.includes(dd)) drawEndCap(fn, vec(dd));
              }
            } else {
              // straight pass-through or single dead-end arm
              dirs.forEach((di, k) =>
                drawArm(fn, vec(di), half + 0.07, filled, k * 0.012)
              );
            }
          }
          for (const di of outletDirs) drawHole(vec(di), filled);
          const af = [...activeFaces];
          // Stitch all of this cell's active faces into one network. They are
          // mutually perpendicular (a shell cell never exposes opposite faces),
          // so a star of edge-wraps from the first face reaches them all.
          for (let k = 1; k < af.length; k++) drawWrap(af[0], af[k], filled);
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
    const count = kind === 'fountain' ? 6 : 4;
    for (let k = 0; k < count; k++) {
      const mesh = new THREE.Mesh(dropGeo, waterDropMat);
      mesh.scale.setScalar(0.07 + (k % 3) * 0.018);
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
  /** Trigger the level-entrance pop (call on load, not on every rebuild). */
  playIntro() {
    this.introT = 0;
  }

  /** Keep the fat-line outline stroke crisp across viewport sizes. */
  setResolution(w: number, h: number) {
    inkMat.resolution.set(w, h);
  }

  update(dt: number, time: number) {
    waterMat.uniforms.uTime.value = time;
    waterMatStill.uniforms.uTime.value = time;

    // Level entrance: spring the cube up into place.
    if (this.introT < 1) {
      this.introT = Math.min(1, this.introT + dt / 0.45);
      const e = 1 - Math.pow(1 - this.introT, 3);
      const s = 0.72 + 0.28 * e;
      this.root.scale.setScalar(s);
      this.root.position.y = (1 - e) * -0.6;
      this.root.rotation.y = (1 - e) * -0.25;
    }

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
