/**
 * Reproduces the "canal jumps to a different face when swiping" bug.
 *
 * A piece is tracked by its stable pieceId. For a rendering to be correct, a
 * piece's canal for a given port must stay on the SAME face in the piece's own
 * local frame as the cube is rotated — i.e. the choice must be rotation-
 * equivariant. We accumulate each piece's net rotation as moves are applied and
 * express every assigned face in the piece's local frame; if that local face
 * changes from one move to the next, the canal visibly popped.
 *
 * Run: npx tsx scripts/poptest.ts
 */
import { CubeState } from '../src/game/CubeState';
import { buildSolved, LEVELS } from '../src/game/levels';
import { DIRS, ALL_BITS, rotateVec, vecToDirIndex } from '../src/game/dir';
import type { Axis, Vec3i } from '../src/game/dir';

const N = 3;
const inb = (v: number) => v >= 0 && v < N;
const exposedOf = (x: number, y: number, z: number): number[] => {
  const out: number[] = [];
  for (let f = 0; f < 6; f++) {
    const d = DIRS[f];
    if (!inb(x + d.x) || !inb(y + d.y) || !inb(z + d.z)) out.push(f);
  }
  return out;
};
const perp = (a: number, b: number) =>
  DIRS[a].x * DIRS[b].x + DIRS[a].y * DIRS[b].y + DIRS[a].z * DIRS[b].z === 0;

// CURRENT renderer logic: min shared exposed perpendicular face.
function chosenFace(cube: CubeState, x: number, y: number, z: number, di: number): number {
  const d = DIRS[di];
  const nx = x + d.x,
    ny = y + d.y,
    nz = z + d.z;
  if (!inb(nx) || !inb(ny) || !inb(nz)) return -1;
  const my = exposedOf(x, y, z);
  const nb = exposedOf(nx, ny, nz);
  let chosen = -1;
  for (const f of my) {
    if (!perp(f, di)) continue;
    if (nb.includes(f)) {
      chosen = f;
      break;
    }
    if (chosen < 0) chosen = f;
  }
  if (chosen < 0) chosen = my[0] ?? di;
  return chosen;
}

// Compose a rotation about `axis` by `t` quarter-turns into a function on dirs.
const rot = (v: Vec3i, axis: Axis, t: number) => rotateVec(v, axis, t);

let seed = 0xabc123;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0xffffffff;
};

let pops = 0;
let samples = 0;

for (const def of LEVELS) {
  for (let trial = 0; trial < 200; trial++) {
    const { cube: solved } = buildSolved(def);
    const c = solved.clone();
    // Track each piece's net orientation (as a rotation applied to local dirs).
    // localFace(piece) = orientation^-1 applied to worldFace. We store, per
    // pieceId, a function via cumulative (axis,t) list — simpler: store the
    // current world->local by tracking the inverse rotation as a dir remap.
    // We represent orientation as a 3x3 by tracking images of +x,+y,+z.
    const basis = new Map<number, [Vec3i, Vec3i, Vec3i]>();
    for (let i = 0; i < c.kind.length; i++) {
      if (c.piece[i] >= 0)
        basis.set(c.piece[i], [
          { x: 1, y: 0, z: 0 },
          { x: 0, y: 1, z: 0 },
          { x: 0, y: 0, z: 1 },
        ]);
    }
    // localFace map: pieceId -> (worldPortDirIndex in local) -> localFaceIndex
    const lastLocal = new Map<number, Map<number, number>>();

    const worldToLocal = (pid: number, dirIdx: number): number => {
      const [bx, by, bz] = basis.get(pid)!;
      // local vector = B^T * world dir (B columns are images of local axes)
      const w = DIRS[dirIdx];
      const lv = {
        x: bx.x * w.x + bx.y * w.y + bx.z * w.z,
        y: by.x * w.x + by.y * w.y + by.z * w.z,
        z: bz.x * w.x + bz.y * w.y + bz.z * w.z,
      };
      return vecToDirIndex(lv);
    };

    const record = () => {
      for (let x = 0; x < N; x++)
        for (let y = 0; y < N; y++)
          for (let z = 0; z < N; z++) {
            const i = c.idx(x, y, z);
            const pid = c.piece[i];
            if (pid < 0) continue;
            const ports = c.ports[i];
            if (!ports) continue;
            for (let di = 0; di < 6; di++) {
              if (!(ports & ALL_BITS[di])) continue;
              const f = chosenFace(c, x, y, z, di);
              if (f < 0) continue; // outlet
              const localPort = worldToLocal(pid, di);
              const localFace = worldToLocal(pid, f);
              let m = lastLocal.get(pid);
              if (!m) {
                m = new Map();
                lastLocal.set(pid, m);
              }
              if (m.has(localPort)) {
                samples++;
                if (m.get(localPort) !== localFace) pops++;
              }
              m.set(localPort, localFace);
            }
          }
    };

    record();
    const steps = 1 + Math.floor(rand() * 6);
    for (let s = 0; s < steps; s++) {
      const axis = (['x', 'y', 'z'] as Axis[])[Math.floor(rand() * 3)];
      const layer = Math.floor(rand() * N);
      const turns = Math.floor(rand() * 3) + 1;
      c.rotateLayer(axis, layer, turns);
      // update tracked orientation for pieces on that layer
      for (let i = 0; i < c.kind.length; i++) {
        const pid = c.piece[i];
        if (pid < 0) continue;
        // a piece is "on layer" if it currently sits there (post-rotate) —
        // recompute orientation lazily: apply rotation to every piece that the
        // move touched. Simpler: recompute basis for all by re-deriving below.
      }
      // Re-derive orientation by applying the move's rotation to the basis of
      // every piece that was on the rotated layer BEFORE the move. We detect
      // that via position change is hard post-hoc, so instead rotate the basis
      // of pieces now located off their pre-move spot. Easiest correct way:
      // rotate basis of pieces whose cell lies on the layer now (they were the
      // ones moved into/within it). For a single full layer this set is exactly
      // the layer's pieces.
      for (let x = 0; x < N; x++)
        for (let y = 0; y < N; y++)
          for (let z = 0; z < N; z++) {
            const onLayer =
              (axis === 'x' && x === layer) ||
              (axis === 'y' && y === layer) ||
              (axis === 'z' && z === layer);
            if (!onLayer) continue;
            const pid = c.piece[c.idx(x, y, z)];
            if (pid < 0) continue;
            const b = basis.get(pid)!;
            basis.set(pid, [
              rot(b[0], axis, turns),
              rot(b[1], axis, turns),
              rot(b[2], axis, turns),
            ]);
          }
      record();
    }
  }
}

console.log(`samples=${samples}  face-pops=${pops}  (${((100 * pops) / samples).toFixed(2)}%)`);
