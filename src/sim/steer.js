import * as THREE from 'three';

/* ============================================================================
   Point the nose at a place.

   Lifted out of `Game.applyAutopilot`, which is where it was written and where
   it had an inverted pitch axis for the whole life of the project. Combat NPCs
   need exactly this — an AI that pursues is an autopilot with a different
   opinion about where to go — and two copies of a control law is two places for
   that sign to be wrong again.

   ------------------------------------------------------------------ the signs

   The two axes do NOT take the same sign, and this is the part worth reading
   before touching anything here.

   The stick is fed straight into angular acceleration and the result is applied
   as a rotation in the ship's own frame. Work either axis through:

     a positive rotation about local X takes the nose (0,0,-1) to (0, sin,-cos)
        — the nose goes UP
     a positive rotation about local Y takes it to (-sin, 0, -cos)
        — the nose goes LEFT

   So a target above (local.y > 0) wants a POSITIVE pitch input, and a target to
   starboard (local.x > 0) wants a NEGATIVE yaw one. Negating both — which is
   what the autopilot did — pushes the nose away from the target vertically, and
   the loop never converges: measured over two hundred seconds against a planet
   sixty thousand units out, the angle to target swung between 19° and 142°
   while the ship closed 574 units, flying in circles at cruise.
   ========================================================================== */

const _to = new THREE.Vector3();
const _local = new THREE.Vector3();
const _inv = new THREE.Quaternion();

/** How tight the nose has to be on the mark before a hunter commits. */
export const ALIGNED_RAD = 0.06;

/**
 * Flight input that turns `ship` toward `targetPos`.
 *
 *   out   reused between calls; the same object is returned
 *
 * Also reports the distance and whether the nose is on the mark, because every
 * caller wants those and re-deriving them means re-deriving the sign too.
 */
export function steerToward(ship, targetPos, out = {}) {
  _to.copy(targetPos).sub(ship.absPos);
  const dist = _to.length();
  _to.multiplyScalar(1 / Math.max(dist, 1e-6));

  // the target direction expressed in the ship's own frame
  _local.copy(_to).applyQuaternion(_inv.copy(ship.quat).invert());

  const yaw = THREE.MathUtils.clamp(Math.atan2(_local.x, -_local.z) * 1.6, -1, 1);
  const pitch = THREE.MathUtils.clamp(
    Math.asin(THREE.MathUtils.clamp(_local.y, -1, 1)) * 1.9, -1, 1);

  out.pitch = pitch;            // positive input pitches up; see the header
  out.yaw = -yaw;               // positive input yaws left, so this is negated
  out.roll = 0;
  out.strafeX = 0;
  out.strafeY = 0;
  out.dist = dist;
  out.ahead = _local.z < 0;
  out.aligned = out.ahead && Math.abs(yaw) < ALIGNED_RAD && Math.abs(pitch) < ALIGNED_RAD;
  return out;
}

/**
 * Lead a moving target: aim where it will be, not where it is.
 *
 * ----------------------------------------------------------------- the maths
 *
 * This solves for the intercept rather than guessing at it. With `r` the
 * offset to the target, `u` its velocity and `v` our speed, the meeting time
 * is where the target's path and a sphere of our own reach touch:
 *
 *     |r + u t| = v t
 *     (|u|² − v²) t² + 2 (r·u) t + |r|² = 0
 *
 * and the answer is the smallest positive root.
 *
 * The first version of this divided the distance by our own top speed and used
 * that as the time — which is only correct for a stationary target. Against
 * anything under way it over-leads by the ratio of the two speeds: chasing a
 * craft doing sixty at six hundred units gave a ten-second solution and put
 * the aim point six hundred units past it, in empty space. The ship then flew
 * at the empty space. It looked exactly like an autopilot that could not make
 * up its mind about what it was chasing.
 *
 * -------------------------------------------------------------- no solution
 *
 * When the target is as fast as the pursuer and running, there is no intercept
 * — the quadratic has no positive root — and the honest answer is to point
 * straight at it and close only if it turns. That is what a stern chase is,
 * and pretending otherwise by aiming somewhere hopeful is how the old version
 * lost the target completely.
 */
const _lead = new THREE.Vector3();
const _rel = new THREE.Vector3();

export function steerToIntercept(ship, targetPos, targetVel, speed, out = {}) {
  _rel.copy(targetPos).sub(ship.absPos);

  const v = Math.max(speed, 1e-3);
  const a = targetVel.lengthSq() - v * v;
  const b = 2 * _rel.dot(targetVel);
  const c = _rel.lengthSq();

  let t = -1;
  if (Math.abs(a) < 1e-9) {
    // exactly matched speeds: the quadratic degenerates to a line
    if (b < -1e-9) t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const root = Math.sqrt(disc);
      const t1 = (-b - root) / (2 * a);
      const t2 = (-b + root) / (2 * a);
      // smallest positive
      const lo = Math.min(t1, t2), hi = Math.max(t1, t2);
      t = lo > 1e-6 ? lo : (hi > 1e-6 ? hi : -1);
    }
  }

  // No intercept, or one so far out it is a fantasy: chase it directly.
  if (!(t > 0) || t > 120) return steerToward(ship, targetPos, out);

  _lead.copy(targetVel).multiplyScalar(t).add(targetPos);
  const cmd = steerToward(ship, _lead, out);
  /* Report the range to the *target*, not to the aim point. Every caller uses
     `dist` to decide whether it has arrived or may shoot, and the distance to
     a point in front of a fleeing ship is not the distance to the ship. */
  cmd.dist = _rel.length();
  return cmd;
}
