// Does the autopilot actually fly at the thing?
//
// Runs Game.applyAutopilot against the real flight model, headless, with a
// stubbed `this`. Reports the angle between the nose and the target each
// second. If the autopilot steers, that angle goes to zero and stays there.

import * as THREE from 'three';
import { Game } from '../src/game/Game.js';
import {
  createSimWorld, createShipState, stepFlight, nearestBodyInfo,
  foldCeiling, engageFold, dropFold,
} from '../src/sim/index.js';

const DT = 1 / 60;
const { bodies } = createSimWorld(20260725, 0);

function run({ label, targetKind = 'planet', startOffset, seconds = 120, allowFold = true, pitchSign = 1, quiet = false }) {
  const ship = createShipState();
  // `Ship` has this getter; the bare sim state does not, and applyAutopilot's
  // arrival test reads it. Worth knowing: if the autopilot ever moves to the
  // server, that is a silent `undefined < 4`.
  Object.defineProperty(ship, 'speed', { get() { return ship.vel.length(); } });
  const target = bodies.filter((b) => b.kind === targetKind)[1] || bodies.find((b) => b.kind === targetKind);

  ship.absPos.copy(target.absPos).add(startOffset);
  // start pointed somewhere unhelpful, which is the whole point of an autopilot
  ship.quat.setFromEuler(new THREE.Euler(0.6, 2.1, 0.3, 'XYZ'));

  const g = Object.create(Game.prototype);
  Object.assign(g, {
    ship, bodies, autopilot: { body: target, phase: 'align' },
    hud: { log() {}, setFold() {} },
    audio: { ping() {} },
    toggleFold(on) {
      const want = on !== undefined ? on : !ship.foldMode;
      if (want === ship.foldMode) return;
      if (!allowFold && want) return;
      if (want) { engageFold(ship); g._folds++; } else { dropFold(ship); g._folds++; }
    },
    cancelAutopilot() { g.autopilot = null; },
    _folds: 0,
  });

  const fwd = new THREE.Vector3();
  const to = new THREE.Vector3();
  const samples = [];
  let cancelled = -1;

  for (let i = 0; i < seconds * 60; i++) {
    if (!g.autopilot) { cancelled = i / 60; break; }
    const raw = { pitch: 0, yaw: 0, roll: 0, strafeX: 0, strafeY: 0, throttleDelta: 0, boost: 0 };
    const flight = g.applyAutopilot(DT, raw);
    // pitchSign -1 re-inverts the axis, reproducing the pre-fix behaviour
    if (pitchSign < 0) flight.pitch = -flight.pitch;  // -1 now reproduces the OLD bug
    const near = nearestBodyInfo(ship, bodies);
    stepFlight(ship, DT, flight, { foldCeiling: foldCeiling(near) });

    if (i % 60 === 0) {
      fwd.set(0, 0, -1).applyQuaternion(ship.quat);
      to.copy(target.absPos).sub(ship.absPos);
      const dist = to.length();
      to.multiplyScalar(1 / Math.max(dist, 1e-9));
      const ang = Math.acos(THREE.MathUtils.clamp(fwd.dot(to), -1, 1)) * 180 / Math.PI;
      samples.push({ t: i / 60, ang, dist, speed: ship.speed, fold: ship.foldMode });
    }
  }

  const first = samples[0], last = samples[samples.length - 1];
  if (!quiet) {
    console.log(`\n${label}  target ${target.name} (radius ${Math.round(target.radius)})`);
    console.log('   t      angle°     distance      speed   fold');
    for (const s of samples.filter((_, i) => i % 5 === 0 || i === samples.length - 1)) {
      console.log(`  ${String(s.t.toFixed(0)).padStart(3)}   ${s.ang.toFixed(2).padStart(8)}   `
        + `${Math.round(s.dist).toString().padStart(10)}   ${s.speed.toFixed(1).padStart(8)}   ${s.fold ? 'yes' : ''}`);
    }
    console.log(`  angle ${first.ang.toFixed(1)}° -> ${last.ang.toFixed(1)}°   `
      + `distance ${Math.round(first.dist)} -> ${Math.round(last.dist)}   fold toggles ${g._folds}`
      + (cancelled >= 0 ? `   (autopilot released at ${cancelled.toFixed(1)}s)` : ''));
  }
  return { first, last, folds: g._folds, samples };
}

/* Current code against the old sign, on the same flight.
 *
 * `pitchSign: -1` re-inverts the pitch axis, which is what the shipped code
 * did before the fix — the comparison is the evidence, not the argument. */
function sweep(label, offset) {
  const now = run({ startOffset: offset, allowFold: false, seconds: 120, quiet: true });
  const old = run({ startOffset: offset, allowFold: false, seconds: 120, pitchSign: -1, quiet: true });
  console.log(`\n${label}`);
  const line = (n, r) => console.log(`  ${n.padEnd(9)} angle ${r.first.ang.toFixed(1).padStart(6)}° -> `
    + `${r.last.ang.toFixed(1).padStart(6)}°   closed ${String(Math.round(r.first.dist - r.last.dist)).padStart(5)} units`);
  line('fixed', now);
  line('old', old);
}

console.log('=== steering: does the angle to target close? ===');
sweep('A · far target', new THREE.Vector3(0, 0, 60000));
sweep('B · target above', new THREE.Vector3(0, -40000, 0));
sweep('C · target to starboard', new THREE.Vector3(-40000, 0, 0));

console.log('\n=== a real approach, fold allowed, run to arrival ===');
run({ label: 'D · fold approach', startOffset: new THREE.Vector3(0, -40000, 60000), allowFold: true, seconds: 300 });
