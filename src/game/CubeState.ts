import { ALL_BITS, Axis, DIRS, rotatePorts, rotateVec, vecToDirIndex } from './dir';

export const EMPTY = 0;
export const PIPE = 1;
export const SOURCE = 2;
export const SINK = 3;
export const BLOCKER = 4;

export interface CellInit {
  coord: [number, number, number];
  kind: number;
  ports: number; // bitmask
  face?: number; // direction index (0-5) the surface canal is drawn on
}

export const NO_FACE = 255;

/** Deterministic small PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LayerMove {
  axis: Axis;
  layer: number;
  turns: number; // +1 / -1 quarter turns
}

/**
 * Logical cube. Coordinates are 0..n-1 on each axis.
 * Each cell carries a kind, a world-frame port bitmask, and a stable pieceId
 * so the renderer can follow a physical piece as it moves between cells.
 */
export class CubeState {
  n: number;
  kind: Uint8Array;
  ports: Uint8Array;
  piece: Int16Array;
  face: Uint8Array; // canal face direction index, rotates with the piece
  // Per-port canal face: armFace[i*6 + dir] is the exposed face the canal arm
  // for that port is drawn on (NO_FACE = none/outlet). Assigned once from the
  // solved geometry and then rotated rigidly with the piece, so a canal never
  // re-snaps to a different face when a layer is turned.
  armFace: Uint8Array;
  terrain: Uint8Array; // 0 dirt, 1 grass, 255 none — rotates with the cubelet

  constructor(n: number) {
    this.n = n;
    const s = n * n * n;
    this.kind = new Uint8Array(s);
    this.ports = new Uint8Array(s);
    this.piece = new Int16Array(s).fill(-1);
    this.face = new Uint8Array(s).fill(NO_FACE);
    this.armFace = new Uint8Array(s * 6).fill(NO_FACE);
    this.terrain = new Uint8Array(s).fill(NO_FACE);
  }

  idx(x: number, y: number, z: number): number {
    const n = this.n;
    return x + y * n + z * n * n;
  }

  inRange(v: number): boolean {
    return v >= 0 && v < this.n;
  }

  clone(): CubeState {
    const c = new CubeState(this.n);
    c.kind.set(this.kind);
    c.ports.set(this.ports);
    c.piece.set(this.piece);
    c.face.set(this.face);
    c.armFace.set(this.armFace);
    c.terrain.set(this.terrain);
    return c;
  }

  static fromCells(n: number, cells: CellInit[]): CubeState {
    const cube = new CubeState(n);
    let pid = 0;
    for (const c of cells) {
      const i = cube.idx(c.coord[0], c.coord[1], c.coord[2]);
      cube.kind[i] = c.kind;
      cube.ports[i] = c.ports;
      cube.piece[i] = pid++;
      cube.face[i] = c.face ?? NO_FACE;
    }
    return cube;
  }

  /** All occupied cells. */
  *occupied(): Generator<number> {
    for (let i = 0; i < this.kind.length; i++) {
      if (this.kind[i] !== EMPTY) yield i;
    }
  }

  coordOf(i: number): [number, number, number] {
    const n = this.n;
    const x = i % n;
    const y = Math.floor(i / n) % n;
    const z = Math.floor(i / (n * n));
    return [x, y, z];
  }

  /** Rotate one layer by a number of quarter turns (signed). Mutates in place. */
  rotateLayer(axis: Axis, layer: number, turns: number): void {
    const n = this.n;
    const center = (n - 1) / 2;
    const t = ((turns % 4) + 4) % 4;
    if (t === 0) return;

    const newKind = new Uint8Array(this.kind);
    const newPorts = new Uint8Array(this.ports);
    const newPiece = new Int16Array(this.piece);
    const newFace = new Uint8Array(this.face);
    const newArmFace = new Uint8Array(this.armFace);
    const newTerrain = new Uint8Array(this.terrain);

    // Clear the layer in the target buffers first.
    for (let i = 0; i < this.kind.length; i++) {
      const [x, y, z] = this.coordOf(i);
      const onLayer =
        (axis === 'x' && x === layer) ||
        (axis === 'y' && y === layer) ||
        (axis === 'z' && z === layer);
      if (onLayer) {
        newKind[i] = EMPTY;
        newPorts[i] = 0;
        newPiece[i] = -1;
        newFace[i] = NO_FACE;
        for (let d = 0; d < 6; d++) newArmFace[i * 6 + d] = NO_FACE;
        newTerrain[i] = NO_FACE;
      }
    }

    // Terrain (grass/dirt) belongs to every cubelet on the layer, decorative
    // ones included, so it must rotate with the cube.
    for (let i = 0; i < this.kind.length; i++) {
      const [x, y, z] = this.coordOf(i);
      const onLayer =
        (axis === 'x' && x === layer) ||
        (axis === 'y' && y === layer) ||
        (axis === 'z' && z === layer);
      if (!onLayer) continue;
      const rel = { x: x - center, y: y - center, z: z - center };
      const nrel = rotateVec(rel, axis, t);
      const ni = this.idx(
        Math.round(nrel.x + center),
        Math.round(nrel.y + center),
        Math.round(nrel.z + center)
      );
      newTerrain[ni] = this.terrain[i];
    }

    for (let i = 0; i < this.kind.length; i++) {
      const [x, y, z] = this.coordOf(i);
      const onLayer =
        (axis === 'x' && x === layer) ||
        (axis === 'y' && y === layer) ||
        (axis === 'z' && z === layer);
      if (!onLayer || this.kind[i] === EMPTY) continue;

      const rel = { x: x - center, y: y - center, z: z - center };
      const nrel = rotateVec(rel, axis, t);
      const nx = Math.round(nrel.x + center);
      const ny = Math.round(nrel.y + center);
      const nz = Math.round(nrel.z + center);
      const ni = this.idx(nx, ny, nz);

      newKind[ni] = this.kind[i];
      newPorts[ni] = rotatePorts(this.ports[i], axis, t);
      newPiece[ni] = this.piece[i];
      const f = this.face[i];
      if (f === NO_FACE) {
        newFace[ni] = NO_FACE;
      } else {
        const nv = rotateVec(DIRS[f], axis, t);
        newFace[ni] = vecToDirIndex(nv);
      }
      // Rotate each port's stored canal face: the port direction and the face
      // it lives on both turn rigidly with the piece.
      for (let d = 0; d < 6; d++) {
        const af = this.armFace[i * 6 + d];
        if (af === NO_FACE) continue;
        const nd = vecToDirIndex(rotateVec(DIRS[d], axis, t));
        newArmFace[ni * 6 + nd] = vecToDirIndex(rotateVec(DIRS[af], axis, t));
      }
    }

    this.kind = newKind;
    this.ports = newPorts;
    this.piece = newPiece;
    this.face = newFace;
    this.armFace = newArmFace;
    this.terrain = newTerrain;
  }

  /**
   * Assign every internal port a surface face for its canal arm, from the
   * current geometry. Called once on the solved cube; rotateLayer then keeps the
   * values rigid with each piece. A connection is put on the lowest-index
   * exposed face perpendicular to it that BOTH cells share, which both endpoints
   * compute identically — so connected arms meet, and the result rotates with
   * the cube instead of being recomputed (and popping) on every turn.
   */
  assignArmFaces(): void {
    const n = this.n;
    const inb = (v: number) => v >= 0 && v < n;
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

    this.armFace.fill(NO_FACE);
    for (let i = 0; i < this.kind.length; i++) {
      const ports = this.ports[i];
      if (!ports) continue;
      const [x, y, z] = this.coordOf(i);
      const my = exposed(x, y, z);
      for (let di = 0; di < 6; di++) {
        if (!(ports & ALL_BITS[di])) continue;
        const d = DIRS[di];
        const nx = x + d.x,
          ny = y + d.y,
          nz = z + d.z;
        if (!inb(nx) || !inb(ny) || !inb(nz)) continue; // outlet: no arm face
        const nb = exposed(nx, ny, nz);
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
        this.armFace[i * 6 + di] = chosen;
      }
    }
  }

  /** Apply a sequence of moves. */
  apply(moves: LayerMove[]): void {
    for (const m of moves) this.rotateLayer(m.axis, m.layer, m.turns);
  }

  /**
   * Produce a scrambled copy plus the move list applied. Avoids immediately
   * undoing the previous move so the scramble stays meaningful.
   */
  scramble(seed: number, count: number): { cube: CubeState; moves: LayerMove[] } {
    const cube = this.clone();
    const rand = rng(seed);
    const axes: Axis[] = ['x', 'y', 'z'];
    const moves: LayerMove[] = [];
    let last: LayerMove | null = null;
    let guard = 0;
    while (moves.length < count && guard++ < count * 20) {
      const axis = axes[Math.floor(rand() * 3)];
      const layer = Math.floor(rand() * cube.n);
      const turns = rand() < 0.5 ? 1 : -1;
      // skip an exact inverse of the previous move
      if (
        last &&
        last.axis === axis &&
        last.layer === layer &&
        last.turns === -turns
      ) {
        continue;
      }
      const m: LayerMove = { axis, layer, turns };
      cube.rotateLayer(axis, layer, turns);
      moves.push(m);
      last = m;
    }
    return { cube, moves };
  }
}
