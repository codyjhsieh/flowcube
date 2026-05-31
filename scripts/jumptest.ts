/**
 * Reproduction harness for the "canals jump faces" bug.
 *
 * It replicates the EXACT face-assignment logic used by CubeView.build() and,
 * for every mutually-connected pair of cells, checks that both cells assign
 * their shared channel to the SAME exposed face. If they pick different faces
 * the two arms can't meet on the surface — that is a face-jump. It also flags
 * "water with no visible canal" (a port whose arm would not be drawn).
 *
 * Run: npx tsx scripts/jumptest.ts
 */
import { CubeState, PIPE, SINK, SOURCE } from '../src/game/CubeState';
import { computeFlow } from '../src/game/Flow';
import { buildSolved, LEVELS } from '../src/game/levels';
import { DIRS, ALL_BITS, oppositeIndex, rotatePorts } from '../src/game/dir';
import type { Axis } from '../src/game/dir';

const N = 3;
const inb = (v: number) => v >= 0 && v < N;
const shell = (x: number, y: number, z: number) =>
  x === 0 || x === N - 1 || y === 0 || y === N - 1 || z === 0 || z === N - 1;

function exposedOf(x: number, y: number, z: number): number[] {
  const out: number[] = [];
  for (let f = 0; f < 6; f++) {
    const d = DIRS[f];
    if (!inb(x + d.x) || !inb(y + d.y) || !inb(z + d.z)) out.push(f);
  }
  return out;
}
const perp = (a: number, b: number) =>
  DIRS[a].x * DIRS[b].x + DIRS[a].y * DIRS[b].y + DIRS[a].z * DIRS[b].z === 0;

/** EXACT copy of the renderer's per-port face choice. Returns the face index
 *  the arm is drawn on, or -1 if it is an outward outlet (no internal arm). */
function chosenFace(cube: CubeState, x: number, y: number, z: number, di: number): number {
  const d = DIRS[di];
  const nx = x + d.x,
    ny = y + d.y,
    nz = z + d.z;
  if (!inb(nx) || !inb(ny) || !inb(nz)) return -1; // outlet/leak
  const myFaces = exposedOf(x, y, z);
  const nbFaces = exposedOf(nx, ny, nz);
  let chosen = -1;
  for (const f of myFaces) {
    if (!perp(f, di)) continue;
    if (nbFaces.includes(f)) {
      chosen = f;
      break;
    }
    if (chosen < 0) chosen = f;
  }
  if (chosen < 0) chosen = myFaces[0] ?? di;
  return chosen;
}

interface Anomaly {
  level: number;
  kind: string;
  detail: string;
}
const anomalies: Anomaly[] = [];

function audit(cube: CubeState, levelId: number, tag: string) {
  const flow = computeFlow(cube);
  for (let x = 0; x < N; x++)
    for (let y = 0; y < N; y++)
      for (let z = 0; z < N; z++) {
        if (!shell(x, y, z)) continue;
        const i = cube.idx(x, y, z);
        const ports = cube.ports[i];
        if (!ports) continue;
        for (let di = 0; di < 6; di++) {
          if (!(ports & ALL_BITS[di])) continue;
          const d = DIRS[di];
          const nx = x + d.x,
            ny = y + d.y,
            nz = z + d.z;
          if (!inb(nx) || !inb(ny) || !inb(nz)) continue; // outlet, fine
          const ni = cube.idx(nx, ny, nz);
          const odi = oppositeIndex(di);
          const mutual = (cube.ports[ni] & ALL_BITS[odi]) !== 0;

          const fa = chosenFace(cube, x, y, z, di);
          // arm invisible? (assigned face not perpendicular to the port dir)
          if (!perp(fa, di)) {
            anomalies.push({
              level: levelId,
              kind: 'INVISIBLE_ARM',
              detail: `${tag} cell(${x},${y},${z}) port ${di} face ${fa} not perp (water=${flow.filled[i]})`,
            });
          }
          if (!mutual) continue; // dangling end (a normal unaligned pipe), skip
          const fb = chosenFace(cube, nx, ny, nz, odi);
          if (fa !== fb) {
            anomalies.push({
              level: levelId,
              kind: 'FACE_JUMP',
              detail: `${tag} (${x},${y},${z})->(${nx},${ny},${nz}) A.face=${fa} B.face=${fb} filled=${flow.filled[i]}/${flow.filled[ni]}`,
            });
          }
        }
      }
}

// Deterministic PRNG so runs are reproducible.
let seed = 0x12345;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0xffffffff;
};

let states = 0;
for (const def of LEVELS) {
  const { cube: solved } = buildSolved(def);
  audit(solved, def.id, 'solved');
  states++;
  // scramble + many random walks to exercise rotated states
  for (let trial = 0; trial < 400; trial++) {
    const c = solved.clone();
    const steps = 1 + Math.floor(rand() * 8);
    for (let s = 0; s < steps; s++) {
      const axis = (['x', 'y', 'z'] as Axis[])[Math.floor(rand() * 3)];
      const layer = Math.floor(rand() * N);
      const turns = (Math.floor(rand() * 3) + 1) as number;
      c.rotateLayer(axis, layer, turns);
    }
    audit(c, def.id, `walk#${trial}`);
    states++;
  }
}

const jumps = anomalies.filter((a) => a.kind === 'FACE_JUMP');
const invis = anomalies.filter((a) => a.kind === 'INVISIBLE_ARM');
console.log(`audited ${states} cube states across ${LEVELS.length} levels`);
console.log(`FACE_JUMP anomalies: ${jumps.length}`);
console.log(`INVISIBLE_ARM anomalies: ${invis.length}`);
for (const a of [...jumps.slice(0, 12), ...invis.slice(0, 12)]) {
  console.log(`  [L${a.level}] ${a.kind}: ${a.detail}`);
}
// keep rotatePorts referenced (sanity import) so unused-import lint stays quiet
void rotatePorts;
void PIPE;
void SINK;
void SOURCE;
