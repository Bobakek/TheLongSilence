import * as THREE from 'three';

/* Distances and the rules that fall out of them: what is nearest, how fast the
   drive may fold here, and how close a scan needs you to be.

   These are rules, not presentation. Every one of them decides something the
   server has to agree with — a fold that engages on the client and not on the
   server is a desync you can feel — so none of them may live in `Game.js`. */

/**
 * Bodies with enough mass to matter to flight: stars, planets, moons.
 *
 * `Game.updateProximity` used to spell this as `!b.planet && b.kind !== 'star'`
 * — a test on the *render* object hanging off the body record. Only planets and
 * moons ever carry one, so the set is identical, but the server's body records
 * have no meshes and the old form would have quietly matched nothing there.
 * Stated as a kind test, it means the same thing in both processes.
 */
export function isMassive(b) {
  return b.kind === 'planet' || b.kind === 'moon' || b.kind === 'star';
}

/** Nearest massive body, and the gap to its *surface* rather than its centre. */
export function nearestBodyInfo(ship, bodies) {
  let best = bodies[0], bd = Infinity;
  for (const b of bodies) {
    if (!isMassive(b)) continue;
    const d = b.absPos.distanceTo(ship.absPos) - b.radius;
    if (d < bd) { bd = d; best = b; }
  }
  return { body: best, surfaceDist: Math.max(bd, 1) };
}

/* How far from a surface the drive will hold a fold, in world units.
 *
 * One number, deliberately: engagement and the mid-flight drop-out have to
 * read the same threshold or the drive engages and cancels on alternate frames
 * and the ship simply shudders in place. */
export function foldFloor(near) {
  return (near.body ? near.body.radius * 0.9 : 0) + 40;
}

/* Fold speed is proportional to how far you are from the nearest mass, so an
   approach decelerates itself. Capped below c because the drive folds space
   rather than moving through it, and because a whole system crossed in two
   seconds is not a journey. */
export function foldCeiling(near) {
  return THREE.MathUtils.clamp(near.surfaceDist * 1.15, 900, 240000);
}

/** Whether the drive would engage here, without saying anything about it. */
export function canFold(ship, near) {
  if (near.surfaceDist < foldFloor(near)) return 'tooDeep';
  if (ship.foldCharge < 0.12) return 'noCharge';
  return null;
}

const _fwd = new THREE.Vector3();
const _to = new THREE.Vector3();

/**
 * The body closest to the reticle, weighted by angular size.
 *
 * Lifted out of `Game.aimTarget`, which read the *camera's* orientation — and
 * the server has no camera. So the aim arrives on the wire as a quaternion and
 * is resolved here, by the same scoring, on both sides. The server cannot
 * verify where a pilot is really looking; what it can do is refuse to scan
 * anything that quaternion does not actually point at, which is the difference
 * between a client that reports a discovery and a client that requests one.
 */
export function aimTargetFrom(ship, bodies, aimQuat) {
  _fwd.set(0, 0, -1).applyQuaternion(aimQuat);
  let best = null, bestScore = 0;
  for (const b of bodies) {
    _to.copy(b.absPos).sub(ship.absPos);
    const d = _to.length();
    if (d < 1e-6) continue;
    _to.multiplyScalar(1 / d);
    const dot = _to.dot(_fwd);
    if (dot < 0.955) continue;
    const ang = Math.atan2(b.radius, d);
    const score = (dot - 0.955) * 40 + Math.min(ang * 6, 3);
    if (score > bestScore) { bestScore = score; best = b; }
  }
  return best;
}

export function scanRangeFor(b, mul = 1) {
  if (b.kind === 'anomaly') return 40 * mul;
  if (b.kind === 'star') return b.radius * 26 * mul;
  return Math.max(b.radius * 11, 500) * mul;
}

export function inScanRange(ship, b, mul = 1) {
  return b.absPos.distanceTo(ship.absPos) < scanRangeFor(b, mul) + (b.radius || 0);
}
