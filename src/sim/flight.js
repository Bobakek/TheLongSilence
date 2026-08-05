import * as THREE from 'three';
import { createCombatState } from './weapons.js';

/* ============================================================================
   The flight model, with nothing attached to it.

   This is the half of `Ship.update` that decides where the ship *is*: rotation,
   thrust, fold, heat, charge. It touches no scene graph, no material and no
   DOM, so the same code runs in the browser for client-side prediction and in
   Node for the authoritative server. `Ship.updateVisuals` — the drive glow, the
   radiators, the dish, the strobe — stays on the client and is not this file's
   business.

   Two rules for everything in `src/sim`:

   **The state is plain data.** `createShipState()` returns exactly the numbers
   the model reads and writes. The browser's `Ship` mixes them into itself and
   hangs geometry off the same object; the server keeps them on their own. Both
   step through this function, so both agree.

   **No allocation in the step.** Every scratch value is module scope. This is
   not only for the frame budget: a server running thirty ticks a second for
   dozens of ships would otherwise spend its life in the collector.
   ========================================================================== */

const _fwd = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tq = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'XYZ');

/** Everything the flight model reads or writes, and nothing else. */
export function createShipState() {
  return {
    absPos: new THREE.Vector3(0, 0, 0),
    vel: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    angVel: new THREE.Vector3(),

    throttle: 0,
    boost: 0,
    assist: true,

    maxSpeed: 60,          // km/s cruise
    boostMul: 4.2,
    accel: 22,
    turnAccel: new THREE.Vector3(2.6, 2.2, 3.4),   // pitch, yaw, roll
    turnDamp: 3.1,
    maxTurn: new THREE.Vector3(1.15, 0.95, 1.7),

    foldMode: false,
    foldSpeed: 0,
    foldCharge: 1,
    foldRegen: 1,
    hull: 1,
    hullMax: 1,
    heat: 0.12,
    scanRate: 1,
    // Weapon and damage state. Mixed in rather than kept beside the ship so
    // that everything the room has to replicate about a hull lives in one
    // object — a second bag would be a second thing to forget on the wire.
    ...createCombatState(),
  };
}

/** Forward axis of `s`, into `out`. Nose is −Z, as everywhere else. */
export function forwardOf(s, out) {
  return out.set(0, 0, -1).applyQuaternion(s.quat);
}

/**
 * Throttle and boost, integrated from the raw stick.
 *
 * Lifted out of `Game.update` for M1: the server owns the throttle, so it has
 * to move it the same way the client always did. The client decides *whether*
 * to feed input through (a menu is open, the ship is landed, a transition is
 * playing); this only knows how to apply what it is given.
 */
export function applyDriveInput(s, dt, raw) {
  s.throttle = THREE.MathUtils.clamp(s.throttle + raw.throttleDelta * dt * 0.9, 0, 1);
  s.boost += ((raw.boost && !s.foldMode ? 1 : 0) - s.boost) * Math.min(1, dt * 5);
}

/* Engaging and dropping the fold, as state rather than as an announcement.
   Whether the drive *may* engage is `canFold` in targeting.js; the banner, the
   denial sound and the HUD flash are the client's business. The velocity bleed
   on the way out is not decoration — it decides where the ship ends up — so it
   has to be here, where both processes can run it. */
export function engageFold(s) {
  s.foldMode = true;
  s.throttle = 1;
}

export function dropFold(s) {
  s.foldMode = false;
  s.vel.multiplyScalar(0.0006);
  s.throttle = 0.15;
}

/**
 * One step of the flight model.
 *
 *   input  pitch, yaw, roll, strafeX, strafeY  — already through the autopilot
 *   env    foldCeiling — how fast the drive may fold here, from `foldCeiling()`
 */
export function stepFlight(s, dt, input, env) {
  const q = s.quat;

  // ---------------------------------------------------------- rotation
  const ta = s.turnAccel;
  const damp = s.foldMode ? s.turnDamp * 2.4 : s.turnDamp;
  const authority = s.foldMode ? 0.20 : 1.0;
  s.angVel.x += (input.pitch * ta.x * authority - s.angVel.x * damp) * dt;
  s.angVel.y += (input.yaw * ta.y * authority - s.angVel.y * damp) * dt;
  s.angVel.z += (input.roll * ta.z * authority - s.angVel.z * damp) * dt;
  s.angVel.x = THREE.MathUtils.clamp(s.angVel.x, -s.maxTurn.x, s.maxTurn.x);
  s.angVel.y = THREE.MathUtils.clamp(s.angVel.y, -s.maxTurn.y, s.maxTurn.y);
  s.angVel.z = THREE.MathUtils.clamp(s.angVel.z, -s.maxTurn.z, s.maxTurn.z);

  _euler.set(s.angVel.x * dt, s.angVel.y * dt, s.angVel.z * dt, 'XYZ');
  _tq.setFromEuler(_euler);
  q.multiply(_tq).normalize();

  // ------------------------------------------------------------ thrust
  const fwd = forwardOf(s, _fwd);
  if (s.foldMode) {
    // fold speed scales with distance to the nearest mass — you accelerate
    // out of a gravity well and decelerate into one
    const targetFold = env.foldCeiling;
    s.foldSpeed += (targetFold - s.foldSpeed) * Math.min(1, dt * 0.55);
    s.vel.copy(fwd).multiplyScalar(s.foldSpeed);
    s.heat = Math.min(1, s.heat + dt * 0.02);
    s.foldCharge = Math.max(0, s.foldCharge - dt * 0.012);
  } else {
    s.foldSpeed = 0;
    const boostF = 1 + s.boost * (s.boostMul - 1);
    const target = _tmp.copy(fwd).multiplyScalar(s.throttle * s.maxSpeed * boostF);

    // lateral / vertical translation thrusters
    if (input.strafeX || input.strafeY) {
      _right.set(1, 0, 0).applyQuaternion(q);
      _up.set(0, 1, 0).applyQuaternion(q);
      target.addScaledVector(_right, input.strafeX * s.maxSpeed * 0.35);
      target.addScaledVector(_up, input.strafeY * s.maxSpeed * 0.35);
    }

    const rate = s.assist ? s.accel * (1 + s.boost * 1.8) : s.accel * 0.35;
    const dv = target.sub(s.vel);
    const dvLen = dv.length();
    if (dvLen > 1e-6) {
      dv.multiplyScalar(Math.min(1, (rate * dt) / dvLen));
      s.vel.add(dv);
    }
    s.heat += ((0.10 + s.throttle * 0.30 + s.boost * 0.5) - s.heat) * dt * 0.4;
    s.foldCharge = Math.min(1, s.foldCharge + dt * 0.045 * s.foldRegen);
  }

  s.absPos.addScaledVector(s.vel, dt);
}
