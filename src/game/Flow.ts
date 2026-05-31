import { ALL_BITS, DIRS } from './dir';
import { CubeState, EMPTY, SINK, SOURCE } from './CubeState';

export interface FlowEdge {
  a: number; // cell index
  b: number; // cell index
  dir: number; // direction index from a to b
}

export interface ExitPort {
  cell: number;
  dir: number; // direction index pointing outside the cube
  kind: 'fountain' | 'spurt' | 'leak';
}

export interface FlowResult {
  filled: Uint8Array;
  dist: Int32Array; // BFS hops from the nearest source (-1 if dry)
  edges: FlowEdge[];
  exits: ExitPort[];
  reachedSinks: number[];
  totalSinks: number;
  leaks: number;
  solved: boolean;
}

/** Deterministic BFS flood from all sources through aligned ports. */
export function computeFlow(cube: CubeState): FlowResult {
  const n = cube.n;
  const size = n * n * n;
  const filled = new Uint8Array(size);
  const dist = new Int32Array(size).fill(-1);
  const queue: number[] = [];

  const sinks: number[] = [];
  for (let i = 0; i < size; i++) {
    if (cube.kind[i] === SOURCE) {
      filled[i] = 1;
      dist[i] = 0;
      queue.push(i);
    } else if (cube.kind[i] === SINK) {
      sinks.push(i);
    }
  }

  const edges: FlowEdge[] = [];
  const seenEdge = new Set<number>();

  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const x = i % n;
    const y = Math.floor(i / n) % n;
    const z = Math.floor(i / (n * n));
    const pmask = cube.ports[i];

    for (let di = 0; di < 6; di++) {
      if (!(pmask & ALL_BITS[di])) continue;
      const d = DIRS[di];
      const nx = x + d.x;
      const ny = y + d.y;
      const nz = z + d.z;
      if (nx < 0 || nx >= n || ny < 0 || ny >= n || nz < 0 || nz >= n) continue;
      const ni = cube.idx(nx, ny, nz);
      if (cube.kind[ni] === EMPTY) continue;
      const oppBit = ALL_BITS[di ^ 1];
      if (!(cube.ports[ni] & oppBit)) continue; // neighbour does not face back

      const key = i < ni ? i * size + ni : ni * size + i;
      if (!seenEdge.has(key)) {
        seenEdge.add(key);
        edges.push({ a: i, b: ni, dir: di });
      }
      if (!filled[ni]) {
        filled[ni] = 1;
        dist[ni] = dist[i] + 1;
        queue.push(ni);
      }
    }
  }

  // Exterior ports on filled cells -> fountains / spurts / leaks.
  const exits: ExitPort[] = [];
  for (let i = 0; i < size; i++) {
    if (!filled[i]) continue;
    const x = i % n;
    const y = Math.floor(i / n) % n;
    const z = Math.floor(i / (n * n));
    const pmask = cube.ports[i];
    for (let di = 0; di < 6; di++) {
      if (!(pmask & ALL_BITS[di])) continue;
      const d = DIRS[di];
      const nx = x + d.x;
      const ny = y + d.y;
      const nz = z + d.z;
      const outside =
        nx < 0 || nx >= n || ny < 0 || ny >= n || nz < 0 || nz >= n;
      if (!outside) continue;
      let kind: ExitPort['kind'];
      if (cube.kind[i] === SOURCE) kind = 'fountain';
      else if (cube.kind[i] === SINK) kind = 'spurt';
      else kind = 'leak';
      exits.push({ cell: i, dir: di, kind });
    }
  }

  const reachedSinks = sinks.filter((s) => filled[s] === 1);
  const leaks = exits.filter((e) => e.kind === 'leak').length;
  // A clean solve reaches every outlet with no water spilling anywhere else.
  const solved =
    reachedSinks.length === sinks.length && sinks.length > 0 && leaks === 0;

  return {
    filled,
    dist,
    edges,
    exits,
    reachedSinks,
    totalSinks: sinks.length,
    leaks,
    solved,
  };
}
