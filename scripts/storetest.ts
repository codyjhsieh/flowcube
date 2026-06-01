/**
 * Validates the equivariant per-port canal-face storage (CubeState.armFace).
 *
 *  - VALID:    every internal port's stored face is exposed and perpendicular
 *              to the port in the CURRENT geometry (so the arm is drawable).
 *  - MISMATCH: a mutually-connected pair stores DIFFERENT faces (arms would not
 *              meet) — the one risk of rigid storage at newly-formed adjacencies.
 *
 * Run: npx tsx scripts/storetest.ts
 */
import { CubeState, NO_FACE } from '../src/game/CubeState';
import { buildSolved, LEVELS } from '../src/game/levels';
import { DIRS, ALL_BITS, oppositeIndex } from '../src/game/dir';
import type { Axis } from '../src/game/dir';

const N = 3;
const inb = (v: number) => v >= 0 && v < N;
const exposed = (x: number, y: number, z: number): number[] => {
  const out: number[] = [];
  for (let f = 0; f < 6; f++) {
    const d = DIRS[f];
    if (!inb(x + d.x) || !inb(y + d.y) || !inb(z + d.z)) out.push(f);
  }
  return out;
};
const perp = (a: number, b: number) =>
  DIRS[a].x * DIRS[b].x + DIRS[a].y * DIRS[b].y + DIRS[a].z * DIRS[b].z === 0;

let seed = 0x55aa33;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0xffffffff;
};

let invalid = 0;
let mismatch = 0;
let checked = 0;
let states = 0;

// The EXACT face the renderer draws an arm on, including the owner rule.
const renderedFace = (c: CubeState, x: number, y: number, z: number, di: number): number => {
  const d = DIRS[di];
  const nx = x + d.x,
    ny = y + d.y,
    nz = z + d.z;
  if (!inb(nx) || !inb(ny) || !inb(nz)) return -1;
  const i = c.idx(x, y, z);
  const my = exposed(x, y, z);
  const stored = c.armFace[i * 6 + di];
  let chosen = stored !== NO_FACE ? stored : (my[0] ?? di);
  const ni = c.idx(nx, ny, nz);
  const opp = oppositeIndex(di);
  if (
    c.ports[ni] & ALL_BITS[opp] &&
    c.piece[ni] >= 0 &&
    c.piece[ni] < c.piece[i] &&
    c.armFace[ni * 6 + opp] !== NO_FACE
  ) {
    chosen = c.armFace[ni * 6 + opp];
  }
  return chosen;
};

const audit = (c: CubeState) => {
  states++;
  for (let x = 0; x < N; x++)
    for (let y = 0; y < N; y++)
      for (let z = 0; z < N; z++) {
        const i = c.idx(x, y, z);
        const ports = c.ports[i];
        if (!ports) continue;
        const my = exposed(x, y, z);
        for (let di = 0; di < 6; di++) {
          if (!(ports & ALL_BITS[di])) continue;
          const d = DIRS[di];
          const nx = x + d.x,
            ny = y + d.y,
            nz = z + d.z;
          if (!inb(nx) || !inb(ny) || !inb(nz)) continue; // outlet
          const f = renderedFace(c, x, y, z, di);
          // validity: must be a real exposed face perpendicular to the port
          if (f < 0 || !my.includes(f) || !perp(f, di)) invalid++;
          // mutual-connection agreement (with the owner rule applied)
          const ni = c.idx(nx, ny, nz);
          if (c.ports[ni] & ALL_BITS[oppositeIndex(di)]) {
            checked++;
            if (renderedFace(c, nx, ny, nz, oppositeIndex(di)) !== f) mismatch++;
          }
        }
      }
};

for (const def of LEVELS) {
  const { cube: solved } = buildSolved(def);
  audit(solved);
  for (let trial = 0; trial < 400; trial++) {
    const c = solved.clone();
    const steps = 1 + Math.floor(rand() * 8);
    for (let s = 0; s < steps; s++) {
      const axis = (['x', 'y', 'z'] as Axis[])[Math.floor(rand() * 3)];
      const layer = Math.floor(rand() * N);
      const turns = Math.floor(rand() * 3) + 1;
      c.rotateLayer(axis, layer, turns);
    }
    audit(c);
  }
}

console.log(`states=${states}`);
console.log(`INVALID stored faces (not exposed/perp): ${invalid}`);
console.log(`MUTUAL connections checked: ${checked}`);
console.log(`A<->B face MISMATCH (boundary jumps): ${mismatch} (${((100 * mismatch) / checked).toFixed(2)}%)`);
