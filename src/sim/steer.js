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
 * A pursuer that steers at the present position of something crossing its bow
 * flies a tail chase for ever. `speed` is how fast the pursuer expects to
 * close; at these scales the estimate does not need to be good, only present.
 */
const _lead = new THREE.Vector3();
export function steerToIntercept(ship, targetPos, targetVel, speed, out = {}) {
  _lead.copy(targetPos).sub(ship.absPos);
  const dist = _lead.length();
  const t = Math.min(dist / Math.max(speed, 1e-3), 30);   // capped: no fantasy leads
  _lead.copy(targetVel).multiplyScalar(t).add(targetPos);
  return steerToward(ship, _lead, out);
}
