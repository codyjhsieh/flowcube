/**
 * Six axis-aligned directions. Ports are stored as a bitmask of these.
 * Index order is fixed and used everywhere for determinism.
 */
export type Axis = 'x' | 'y' | 'z';

export interface Vec3i {
  x: number;
  y: number;
  z: number;
}

export const DIRS: Vec3i[] = [
  { x: 1, y: 0, z: 0 }, // 0  +x
  { x: -1, y: 0, z: 0 }, // 1  -x
  { x: 0, y: 1, z: 0 }, // 2  +y
  { x: 0, y: -1, z: 0 }, // 3  -y
  { x: 0, y: 0, z: 1 }, // 4  +z
  { x: 0, y: 0, z: -1 }, // 5  -z
];

export const PX = 1 << 0;
export const NX = 1 << 1;
export const PY = 1 << 2;
export const NY = 1 << 3;
export const PZ = 1 << 4;
export const NZ = 1 << 5;

export const ALL_BITS = [PX, NX, PY, NY, PZ, NZ];

/** opposite direction index */
export function oppositeIndex(i: number): number {
  return i ^ 1; // pairs (0,1)(2,3)(4,5)
}

export function oppositeBit(bit: number): number {
  return ALL_BITS[oppositeIndex(ALL_BITS.indexOf(bit))];
}

export function dirIndexToBit(i: number): number {
  return ALL_BITS[i];
}

export function vecToDirIndex(v: Vec3i): number {
  for (let i = 0; i < 6; i++) {
    if (DIRS[i].x === v.x && DIRS[i].y === v.y && DIRS[i].z === v.z) return i;
  }
  return -1;
}

/**
 * Rotate a direction vector by a quarter turn (or multiple) about an axis.
 * `turns` is signed; positive = right-handed about the +axis.
 */
export function rotateVec(v: Vec3i, axis: Axis, turns: number): Vec3i {
  let { x, y, z } = v;
  const t = ((turns % 4) + 4) % 4;
  for (let k = 0; k < t; k++) {
    if (axis === 'x') {
      // y -> z, z -> -y
      const ny = -z;
      const nz = y;
      y = ny;
      z = nz;
    } else if (axis === 'y') {
      // z -> x, x -> -z
      const nx = z;
      const nz = -x;
      x = nx;
      z = nz;
    } else {
      // x -> y, y -> -x
      const nx = -y;
      const ny = x;
      x = nx;
      y = ny;
    }
  }
  return { x, y, z };
}

/** Rotate an entire port bitmask about an axis by `turns` quarter-turns. */
export function rotatePorts(mask: number, axis: Axis, turns: number): number {
  let out = 0;
  for (let i = 0; i < 6; i++) {
    if (mask & ALL_BITS[i]) {
      const nv = rotateVec(DIRS[i], axis, turns);
      out |= dirIndexToBit(vecToDirIndex(nv));
    }
  }
  return out;
}

export function portsToBits(dirs: string[]): number {
  let m = 0;
  for (const d of dirs) {
    switch (d) {
      case '+x':
        m |= PX;
        break;
      case '-x':
        m |= NX;
        break;
      case '+y':
        m |= PY;
        break;
      case '-y':
        m |= NY;
        break;
      case '+z':
        m |= PZ;
        break;
      case '-z':
        m |= NZ;
        break;
    }
  }
  return m;
}
