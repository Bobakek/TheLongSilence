// A/B the extracted sim against the ORIGINAL code, transcribed verbatim out of
// git (commit 4845c1d) below. `determinism.mjs` proves Node and the browser
// agree with each other; this proves the extraction did not change the game.
//
// The "old" functions are copy-pastes of Ship.update and the four Game methods
// as they were, with `this` replaced by an explicit argument and the renderer
// lines (object.quaternion, updateVisuals, hud, audio) dropped — those are the
// parts that were always presentation.
//
// THIS IS A ONE-TIME PROOF, NOT A LIVING TEST. It pins the behaviour of one
// commit, so the first *intentional* change to the flight model will make it
// fail, correctly and uselessly. When that day comes, delete it: it will have
// done the only job it has, which is to make the M0 refactor auditable rather
// than merely plausible.
//
//   node tools/ab-original.mjs      → PASS means bit-identical

import * as THREE from 'three';
import {
  createShipState, stepFlight, engageFold, dropFold,
  positionSystem, applyProximity, nearestBodyInfo, foldFloor, foldCeiling,
  canFold, scanRangeFor, createSimWorld,
} from '../src/sim/index.js';

/* ============================ ORIGINAL, verbatim ========================== */

const _v = new THREE.Vector3();
const ORBIT_TIME = 1;

// --- Ship.update, lines 57..108 of the original src/ship/Ship.js
function oldStepFlight(s, dt, input, env) {
  const q = s.quat;
  const ta = s.turnAccel;
  const damp = s.foldMode ? s.turnDamp * 2.4 : s.turnDamp;
  const authority = s.foldMode ? 0.20 : 1.0;
  s.angVel.x += (input.pitch * ta.x * authority - s.angVel.x * damp) * dt;
  s.angVel.y += (input.yaw * ta.y * authority - s.angVel.y * damp) * dt;
  s.angVel.z += (input.roll * ta.z * authority - s.angVel.z * damp) * dt;
  s.angVel.x = THREE.MathUtils.clamp(s.angVel.x, -s.maxTurn.x, s.maxTurn.x);
  s.angVel.y = THREE.MathUtils.clamp(s.angVel.y, -s.maxTurn.y, s.maxTurn.y);
  s.angVel.z = THREE.MathUtils.clamp(s.angVel.z, -s.maxTurn.z, s.maxTurn.z);

  s._tq.setFromEuler(new THREE.Euler(s.angVel.x * dt, s.angVel.y * dt, s.angVel.z * dt, 'XYZ'));
  q.multiply(s._tq).normalize();

  const fwd = s._fwd.set(0, 0, -1).applyQuaternion(s.quat).clone();
  if (s.foldMode) {
    const targetFold = env.foldCeiling;
    s.foldSpeed += (targetFold - s.foldSpeed) * Math.min(1, dt * 0.55);
    s.vel.copy(fwd).multiplyScalar(s.foldSpeed);
    s.heat = Math.min(1, s.heat + dt * 0.02);
    s.foldCharge = Math.max(0, s.foldCharge - dt * 0.012);
  } else {
    s.foldSpeed = 0;
    const boostF = 1 + s.boost * (s.boostMul - 1);
    const target = s._tmp.copy(fwd).multiplyScalar(s.throttle * s.maxSpeed * boostF);
    if (input.strafeX || input.strafeY) {
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      const upv = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      target.addScaledVector(right, input.strafeX * s.maxSpeed * 0.35);
      target.addScaledVector(upv, input.strafeY * s.maxSpeed * 0.35);
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

// --- Game._positionSystem
function oldPositionSystem(bodies, dt) {
  for (const b of bodies) {
    if (b.kind === 'planet') {
      b.phase += b.spec.orbitSpeed * dt * ORBIT_TIME;
      const a = b.spec.orbitR;
      b.absPos.set(Math.cos(b.phase) * a, Math.sin(b.phase * 1.3) * a * b.spec.orbitInc, Math.sin(b.phase) * a);
    } else if (b.kind === 'moon') {
      b.phase += b.spec.orbitSpeed * dt * ORBIT_TIME;
      const a = b.spec.orbitR;
      b.absPos.copy(b.parent.absPos).add(
        _v.set(Math.cos(b.phase) * a, Math.sin(b.phase * 1.7) * a * b.spec.orbitInc, Math.sin(b.phase) * a)
      );
    }
  }
}

// --- Game.updateProximity. NOTE the original filter was `!b.planet && kind!=='star'`;
// these headless bodies have no `.planet`, so it is spelled as the kind test the
// refactor uses. That equivalence is the one thing this file cannot prove — it
// is argued in src/sim/targeting.js and checked by eye against loadSystem.
function oldUpdateProximity(ship, bodies, dt, host) {
  host.proximityWarn = null;
  for (const b of bodies) {
    if (!(b.kind === 'planet' || b.kind === 'moon') && b.kind !== 'star') continue;
    const isStar = b.kind === 'star';
    const floor = b.radius * (isStar ? 2.2 : 1.02);
    const soft = b.radius * (isStar ? 4.0 : 1.16);
    _v.copy(ship.absPos).sub(b.absPos);
    const d = _v.length();
    if (d > soft) continue;
    _v.multiplyScalar(1 / Math.max(d, 1e-6));
    const t = THREE.MathUtils.clamp((soft - d) / (soft - floor), 0, 1);
    host.proximityWarn = isStar ? 'STELLAR PROXIMITY' : 'TERRAIN PROXIMITY';
    if (t > 0.25) { host.cancelAutopilot(true); if (ship.foldMode) host.setFold(false); }
    if (t > 0.5) ship.throttle = Math.min(ship.throttle, 1 - t);
    const push = t * t * 120 + (d < floor ? 900 : 0);
    ship.vel.addScaledVector(_v, push * dt);
    const vn = ship.vel.dot(_v);
    if (vn < 0) ship.vel.addScaledVector(_v, -vn * Math.min(1, t * 2.4));
    if (d < floor) {
      ship.absPos.copy(b.absPos).addScaledVector(_v, floor);
      ship.hull = Math.max(0, ship.hull - 0.00035 * Math.min(200, Math.abs(vn)));
      host.shake = Math.min(1, host.shake + 0.25);
    }
    host.shake = Math.min(1, host.shake + t * dt * 1.6);
    if (isStar && t > 0.35) ship.hull = Math.max(0, ship.hull - dt * 0.05 * t);
  }
}

// --- Game.nearestBodyInfo
function oldNearestBodyInfo(ship, bodies) {
  let best = bodies[0], bd = Infinity;
  for (const b of bodies) {
    if (b.kind === 'anomaly' || b.kind === 'craft' || b.kind === 'station') continue;
    const d = b.absPos.distanceTo(ship.absPos) - b.radius;
    if (d < bd) { bd = d; best = b; }
  }
  return { body: best, surfaceDist: Math.max(bd, 1) };
}

// --- Game.foldFloor / the inline fold ceiling / Game.scanRangeFor / Game.toggleFold
const oldFoldFloor = (near) => (near.body ? near.body.radius * 0.9 : 0) + 40;
const oldFoldCeiling = (near) => THREE.MathUtils.clamp(near.surfaceDist * 1.15, 900, 240000);
function oldScanRangeFor(b, m) {
  if (b.kind === 'anomaly') return 40 * m;
  if (b.kind === 'star') return b.radius * 26 * m;
  return Math.max(b.radius * 11, 500) * m;
}
function oldCanFold(ship, near) {
  if (near.surfaceDist < oldFoldFloor(near)) return 'tooDeep';
  if (ship.foldCharge < 0.12) return 'noCharge';
  return null;
}
const oldEngageFold = (s) => { s.foldMode = true; s.throttle = 1; };
const oldDropFold = (s) => { s.foldMode = false; s.vel.multiplyScalar(0.0006); s.throttle = 0.15; };

/* ================================ the run ================================= */

const TICKS = 10000, DT = 1 / 60;
const _look = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _off = new THREE.Vector3();

function phaseOf(i) {
  if (i < TICKS * 0.25) return 'approach';
  if (i < TICKS * 0.60) return 'loiter';
  return 'departure';
}
function inputFor(i, phase, out) {
  if (phase === 'approach') { out.pitch = out.yaw = out.roll = out.strafeX = out.strafeY = 0; return out; }
  if (phase === 'departure') {
    out.pitch = out.yaw = out.roll = 0;
    out.strafeX = (i % 900 < 120) ? 0.8 : 0;
    out.strafeY = (i % 1300 < 90) ? -0.6 : 0;
    return out;
  }
  out.pitch = Math.sin(i * 0.00700) * 0.85;
  out.yaw = Math.sin(i * 0.00310 + 1.1) * 0.70;
  out.roll = Math.sin(i * 0.01300 + 2.3) * 0.50;
  out.strafeX = (i % 900 < 120) ? 0.8 : 0;
  out.strafeY = (i % 1300 < 90) ? -0.6 : 0;
  return out;
}
function driveFor(s, i, phase) {
  if (s.foldMode) return;
  if (phase === 'approach') { s.throttle = 1; s.boost = 0; return; }
  if (phase === 'departure') { s.throttle = 1; s.boost = 1; return; }
  s.throttle = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(i * 0.0021));
  s.boost = (i % 1700 < 300) ? 1 : 0;
}

function run(old) {
  const { bodies } = createSimWorld(20260725, 0);
  const ship = createShipState();
  if (old) { ship._tq = new THREE.Quaternion(); ship._tmp = new THREE.Vector3(); ship._fwd = new THREE.Vector3(); }

  const planet = bodies.find((b) => b.kind === 'planet');
  _off.set(1, 0.2, 0.35).normalize().multiplyScalar(planet.radius * 1.3);
  ship.absPos.copy(planet.absPos).add(_off);
  _look.lookAt(ship.absPos, planet.absPos, _up);
  ship.quat.setFromRotationMatrix(_look);
  ship.vel.copy(planet.absPos).sub(ship.absPos).normalize().multiplyScalar(4000);

  const step = old ? oldStepFlight : stepFlight;
  const prox = old ? oldUpdateProximity : applyProximity;
  const posSys = old ? oldPositionSystem : positionSystem;
  const nearest = old ? oldNearestBodyInfo : nearestBodyInfo;
  const ffloor = old ? oldFoldFloor : foldFloor;
  const fceil = old ? oldFoldCeiling : foldCeiling;
  const cfold = old ? oldCanFold : canFold;
  const eng = old ? oldEngageFold : engageFold;
  const drop = old ? oldDropFold : dropFold;
  const srange = old ? oldScanRangeFor : scanRangeFor;

  const host = {
    shake: 0, proximityWarn: null,
    cancelAutopilot() { host.cancels++; },
    setFold(on) { host.folds++; if (on) eng(ship); else drop(ship); },
    cancels: 0, folds: 0,
  };
  const input = { pitch: 0, yaw: 0, roll: 0, strafeX: 0, strafeY: 0 };
  const samples = [];
  let turned = false, refusals = 0, engaged = 0, scanAcc = 0;

  for (let i = 0; i < TICKS; i++) {
    const phase = phaseOf(i);
    posSys(bodies, DT);
    if (phase === 'departure' && !turned) {
      turned = true;
      _off.copy(ship.absPos).sub(planet.absPos).normalize().multiplyScalar(1e6).add(ship.absPos);
      _look.lookAt(ship.absPos, _off, _up);
      ship.quat.setFromRotationMatrix(_look);
      ship.angVel.set(0, 0, 0);
    }
    inputFor(i, phase, input);
    driveFor(ship, i, phase);
    if (phase !== 'approach' && i % 600 === 0) {
      const near = nearest(ship, bodies);
      const refused = cfold(ship, near);
      if (refused) refusals++;
      else if (!ship.foldMode) { eng(ship); engaged++; }
    }
    if (i % 600 === 350 && ship.foldMode) drop(ship);
    const near = nearest(ship, bodies);
    if (ship.foldMode && near.surfaceDist < ffloor(near)) drop(ship);
    step(ship, DT, input, { foldCeiling: fceil(near), time: i * DT });
    prox(ship, bodies, DT, host);

    // scan range is not part of the trajectory, so fold it into a checksum
    if (i % 500 === 0) for (const b of bodies) scanAcc += srange(b, 1.4);

    if (i % 100 === 0) {
      samples.push([ship.absPos.x, ship.absPos.y, ship.absPos.z,
        ship.vel.x, ship.vel.y, ship.vel.z,
        ship.quat.x, ship.quat.y, ship.quat.z, ship.quat.w,
        ship.hull, ship.foldCharge, ship.heat]);
    }
  }
  return { samples, refusals, engaged, scanAcc, cancels: host.cancels, folds: host.folds, shake: host.shake };
}

const A = run(true);
const B = run(false);

let maxAbs = 0, worst = -1;
for (let i = 0; i < A.samples.length; i++) {
  for (let k = 0; k < A.samples[i].length; k++) {
    const d = Math.abs(A.samples[i][k] - B.samples[i][k]);
    if (d > maxAbs) { maxAbs = d; worst = i * 100; }
  }
}

const same = (k) => A[k] === B[k];
const rules = ['refusals', 'engaged', 'cancels', 'folds', 'scanAcc', 'shake'];
console.log('ORIGINAL vs src/sim, 10000 ticks\n');
for (const k of rules) {
  console.log(`  ${k.padEnd(9)} old=${String(A[k]).padEnd(22)} new=${String(B[k]).padEnd(22)} ${same(k) ? 'same' : 'DIFFERENT'}`);
}
console.log(`\n  max component divergence ${maxAbs === 0 ? '0 (bit-identical)' : maxAbs.toExponential(3)} (worst near tick ${worst})`);
const ok = rules.every(same) && maxAbs === 0;
console.log(ok ? '\nPASS — the extraction is byte-for-byte the original behaviour\n'
  : '\nFAIL — the refactor changed something\n');
process.exit(ok ? 0 : 1);
