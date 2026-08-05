/* ============================================================================
   src/sim — the part of the game that decides what happened.

   Everything in here runs unchanged in a browser tab and in a Node process.
   No DOM, no WebGL, no renderer, no audio, no `Game`. three is imported, but
   only for `Vector3`, `Quaternion` and `MathUtils` — its math classes are
   plain arithmetic over JS doubles and work headless.

   The client runs this to *predict*; the server runs it to *decide*. When they
   disagree the server wins and the client is corrected, so nothing here is
   required to be bit-identical across engines — only to be the same rules.

   What is deliberately NOT here: the camera, the HUD, the audio, the post
   chain, the landing sequence, the terrain, the cabin. Those are how the
   result is presented, and the server has no opinion about them.
   ========================================================================== */

export {
  createShipState, forwardOf, stepFlight, applyDriveInput, engageFold, dropFold,
} from './flight.js';
export { runTrace, compareTraces, scriptedInput, TRACE_DEFAULTS } from './trace.js';
export { positionSystem, seekSystem, ORBIT_TIME } from './orbits.js';
export { stepShip, createQuietHost, CMD } from './step.js';
export { applyProximity } from './proximity.js';
export {
  isMassive, nearestBodyInfo, foldFloor, foldCeiling, canFold,
  scanRangeFor, inScanRange, aimTargetFrom,
} from './targeting.js';
export { createScanState, stepScan, SCAN_RATE, SCAN_DECAY } from './scan.js';
export { jumpCost, canJump, payJump } from './jump.js';
export { steerToward, steerToIntercept, ALIGNED_RAD } from './steer.js';
export {
  createCombatState, canFire, fire, aimForward, applyDamage,
  stepCombatState, stepProjectiles, segmentHitsSphere, resetBoltIds,
  BOLT_SPEED, BOLT_TTL, BOLT_DAMAGE, FIRE_COOLDOWN, HIT_RADIUS,
  SHIELD_MAX, SHIELD_REGEN, SHIELD_HOLDOFF, MUZZLE,
} from './weapons.js';
export {
  createNpc, stepNpc, spawnPatrols, resetNpcIds,
  AGGRO_RANGE, LOSE_RANGE, STANDOFF, FIRE_RANGE,
} from './npc.js';
export {
  buildSimBodies, createSimWorld, createHostStub,
  resonatorSystemsFor, resonatorIndexFor, placeAnomalies,
  ANOMALY_RADIUS, RESONATOR_COUNT,
} from './world.js';
