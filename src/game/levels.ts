import {
  ALL_BITS,
  DIRS,
  dirIndexToBit,
  vecToDirIndex,
} from './dir';
import { CellInit, CubeState, PIPE, rng, SINK, SOURCE } from './CubeState';

export interface SinkDef {
  x: number;
  y: number;
  z: number;
  exit: number; // direction index of the outward spurt
  color: number; // hex colour for the outlet ring + spurt
}

export interface LevelDef {
  id: number;
  name: string;
  n: number;
  scramble: number; // number of quarter-turn shuffles
  source: { x: number; y: number; z: number };
  sinks: SinkDef[];
  seed: number;
}

const isShell = (n: number, x: number, y: number, z: number) =>
  x === 0 || x === n - 1 || y === 0 || y === n - 1 || z === 0 || z === n - 1;

/** Most camera-facing exterior face for a solved-state cell (dir index). */
function faceDirIndex(x: number, y: number, z: number, n: number): number {
  if (y === n - 1) return 2; // +y
  if (x === n - 1) return 0; // +x
  if (z === n - 1) return 4; // +z
  if (x === 0) return 1; // -x
  if (z === 0) return 5; // -z
  if (y === 0) return 3; // -y
  return 2;
}

/**
 * Build a connected, solved network over the cube shell linking the source to
 * every sink via shortest surface paths, then return the logical cube.
 * Solvability is guaranteed because the unscrambled state is, by construction,
 * already a winning configuration.
 */
export function buildSolved(def: LevelDef): {
  cube: CubeState;
  colors: Map<number, number>;
} {
  const n = def.n;
  const key = (x: number, y: number, z: number) => x + y * n + z * n * n;

  // BFS over shell cells from the source.
  const start = key(def.source.x, def.source.y, def.source.z);
  const parent = new Map<number, number>();
  const visited = new Set<number>([start]);
  const q = [start];
  let h = 0;
  while (h < q.length) {
    const c = q[h++];
    const x = c % n;
    const y = Math.floor(c / n) % n;
    const z = Math.floor(c / (n * n));
    for (let di = 0; di < 6; di++) {
      const d = DIRS[di];
      const nx = x + d.x;
      const ny = y + d.y;
      const nz = z + d.z;
      if (nx < 0 || nx >= n || ny < 0 || ny >= n || nz < 0 || nz >= n) continue;
      if (!isShell(n, nx, ny, nz)) continue;
      const nk = key(nx, ny, nz);
      if (visited.has(nk)) continue;
      visited.add(nk);
      parent.set(nk, c);
      q.push(nk);
    }
  }

  const portmask = new Map<number, number>();
  const add = (c: number, di: number) =>
    portmask.set(c, (portmask.get(c) || 0) | dirIndexToBit(di));

  const network = new Set<number>([start]);
  const dirBetween = (a: number, b: number) => {
    const ax = a % n,
      ay = Math.floor(a / n) % n,
      az = Math.floor(a / (n * n));
    const bx = b % n,
      by = Math.floor(b / n) % n,
      bz = Math.floor(b / (n * n));
    return vecToDirIndex({ x: bx - ax, y: by - ay, z: bz - az });
  };

  for (const s of def.sinks) {
    let cur = key(s.x, s.y, s.z);
    network.add(cur);
    while (cur !== start) {
      const p = parent.get(cur);
      if (p === undefined) break; // unreachable; should not happen on shell
      const di = dirBetween(p, cur);
      add(p, di);
      add(cur, di ^ 1);
      network.add(p);
      cur = p;
    }
  }

  // Source fountain port: straight up out of the cube.
  add(start, vecToDirIndex({ x: 0, y: 1, z: 0 }));
  // Sink spurt ports.
  const colors = new Map<number, number>();
  for (const s of def.sinks) {
    const c = key(s.x, s.y, s.z);
    add(c, s.exit);
    colors.set(c, s.color);
  }

  // ---- decoy filler canals -------------------------------------------------
  // Cover most of the shell with extra pipe pieces that are NOT connected to
  // the source in the solved state (so they stay dry — no leaks when solved),
  // but once layers are scrambled they get mixed in with the real path. The
  // player must align things so water reaches every outlet without spilling out
  // of any decoy. This is what makes most faces show canals.
  const rand = rng((def.seed ^ 0x9e3779b1) >>> 0);
  const fillerSet = new Set<number>();
  for (let x = 0; x < n; x++)
    for (let y = 0; y < n; y++)
      for (let z = 0; z < n; z++) {
        const c = key(x, y, z);
        if (network.has(c)) continue;
        if (!isShell(n, x, y, z)) continue;
        if (rand() < 0.8) fillerSet.add(c);
      }

  const fillerPorts = new Map<number, number>();
  const fAdd = (c: number, di: number) =>
    fillerPorts.set(c, (fillerPorts.get(c) || 0) | dirIndexToBit(di));
  const coordOf = (c: number): [number, number, number] => [
    c % n,
    Math.floor(c / n) % n,
    Math.floor(c / (n * n)),
  ];
  for (const c of fillerSet) {
    const [x, y, z] = coordOf(c);
    for (let di = 0; di < 6; di++) {
      const d = DIRS[di];
      const nx = x + d.x,
        ny = y + d.y,
        nz = z + d.z;
      if (nx < 0 || nx >= n || ny < 0 || ny >= n || nz < 0 || nz >= n) continue;
      const nc = key(nx, ny, nz);
      if (nc <= c) continue; // handle each pair once
      if (!fillerSet.has(nc)) continue;
      if (rand() < 0.78) {
        fAdd(c, di);
        fAdd(nc, di ^ 1);
      }
    }
  }

  // Occasional decoy opening to the outside: dry in the solved state, but a
  // leak if the player misroutes water into it.
  for (const c of fillerSet) {
    if (!fillerPorts.has(c)) continue;
    const [x, y, z] = coordOf(c);
    let added = false;
    for (let di = 0; di < 6 && !added; di++) {
      const d = DIRS[di];
      const nx = x + d.x,
        ny = y + d.y,
        nz = z + d.z;
      const outside =
        nx < 0 || nx >= n || ny < 0 || ny >= n || nz < 0 || nz >= n;
      if (!outside) continue;
      if (fillerPorts.get(c)! & dirIndexToBit(di)) continue;
      if (rand() < 0.06) {
        fAdd(c, di);
        added = true;
      }
    }
  }

  const cells: CellInit[] = [];
  const pushCell = (c: number, kind: number, ports: number) => {
    const [x, y, z] = coordOf(c);
    cells.push({ coord: [x, y, z], kind, ports, face: faceDirIndex(x, y, z, n) });
  };
  for (const c of network) {
    let kind = PIPE;
    if (c === start) kind = SOURCE;
    else if (colors.has(c)) kind = SINK;
    pushCell(c, kind, portmask.get(c) || 0);
  }
  for (const c of fillerSet) {
    const p = fillerPorts.get(c) || 0;
    if (p === 0) continue; // no canal -> leave as a plain block
    pushCell(c, PIPE, p);
  }

  const cube = CubeState.fromCells(n, cells);

  // Assign grass/dirt to every shell cubelet in clustered patches. Stored on
  // the cube so it rotates with the pieces.
  for (let x = 0; x < n; x++)
    for (let y = 0; y < n; y++)
      for (let z = 0; z < n; z++) {
        if (!isShell(n, x, y, z)) continue;
        cube.terrain[cube.idx(x, y, z)] = isGrassBlock(x, y, z, n) ? 1 : 0;
      }

  return { cube, colors };
}

/** Patchy grass/dirt assignment: smooth noise + a bias toward grass up top. */
export function isGrassBlock(x: number, y: number, z: number, n: number): boolean {
  const t = n > 1 ? y / (n - 1) : 1; // 0 bottom .. 1 top
  const v =
    (Math.sin(x * 1.3 + 0.6) +
      Math.sin(z * 1.3 + 1.9) +
      Math.sin((x + z) * 0.7 + 0.3)) *
      0.5 +
    t * 1.7 -
    0.5;
  return v > 0;
}

// Outlet colours pulled from the reference art.
const C_GREEN = 0x8fbf63;
const C_BLUE = 0x4a90c2;
const C_ORANGE = 0xe09a4a;
const C_TEAL = 0x4fae8c;
const C_YELLOW = 0xe6c34a;

// Direction indices: 0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z
// Five short, friendly levels. All 3x3x3 with small scrambles.
export const LEVELS: LevelDef[] = [
  {
    id: 1,
    name: 'First Drop',
    n: 3,
    scramble: 2,
    seed: 101,
    source: { x: 1, y: 2, z: 1 },
    sinks: [{ x: 2, y: 1, z: 1, exit: 0, color: C_ORANGE }],
  },
  {
    id: 2,
    name: 'Two Taps',
    n: 3,
    scramble: 3,
    seed: 202,
    source: { x: 1, y: 2, z: 1 },
    sinks: [
      { x: 2, y: 1, z: 1, exit: 0, color: C_ORANGE },
      { x: 0, y: 1, z: 1, exit: 1, color: C_BLUE },
    ],
  },
  {
    id: 3,
    name: 'Around the Bend',
    n: 3,
    scramble: 3,
    seed: 303,
    source: { x: 1, y: 2, z: 1 },
    sinks: [
      { x: 2, y: 1, z: 1, exit: 0, color: C_ORANGE },
      { x: 1, y: 1, z: 2, exit: 4, color: C_TEAL },
    ],
  },
  {
    id: 4,
    name: 'Three Ways',
    n: 3,
    scramble: 4,
    seed: 404,
    source: { x: 1, y: 2, z: 1 },
    sinks: [
      { x: 2, y: 1, z: 1, exit: 0, color: C_ORANGE },
      { x: 0, y: 1, z: 1, exit: 1, color: C_BLUE },
      { x: 1, y: 1, z: 2, exit: 4, color: C_GREEN },
    ],
  },
  {
    id: 5,
    name: 'Perfect Flow',
    n: 3,
    scramble: 4,
    seed: 505,
    source: { x: 1, y: 2, z: 1 },
    sinks: [
      { x: 2, y: 1, z: 1, exit: 0, color: C_ORANGE },
      { x: 0, y: 1, z: 1, exit: 1, color: C_BLUE },
      { x: 1, y: 1, z: 0, exit: 5, color: C_YELLOW },
    ],
  },
];

export function levelByIndex(i: number): LevelDef {
  return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, i))];
}
