import * as THREE from 'three';
import { createShipState, stepFlight, engageFold, dropFold } from './flight.js';
import { positionSystem } from './orbits.js';
import { applyProximity } from './proximity.js';
import { nearestBodyInfo, foldCeiling, foldFloor, canFold } from './targeting.js';
import { createSimWorld, createHostStub } from './world.js';

/* ============================================================================
   The determinism trace.

   M0 asks one question: does `src/sim` produce the same flight in Node as it
   does in a browser tab? That is only answerable if both run *literally the
   same procedure*, so the procedure lives here and both sides call it —
   `tools/determinism.mjs` on one end, `window.__simTrace` on the other.

   The run is in three phases, because the branches worth testing are not all
   reachable from the same flight:

     A · approach   Straight in at the planet from 1.3 radii, no steering and
                    no drive. This is the only way to reach the envelope, the
                    hard floor, the repulsion and the velocity bleed — the
                    first version of this trace flew a pretty curve through
                    open space, entered the envelope zero times, and would have
                    passed while testing none of it.
     B · loiter     Full steering and thrust while still deep in the planet's
                    well, which is where `canFold` must *refuse*.
     C · departure  Turned outward and boosted clear, so the fold is finally
                    granted, held and dropped.

   The input is a function of the tick index and nothing else. No clock, no RNG
   — those would make the trace unrepeatable, which is the one thing it may not
   be. Phase C turns the ship by hand at the boundary rather than steering it
   round: a scripted rotation that happens to end up pointing outward would be
   luck, and luck does not survive a change to the model.

   Bit-identical results are NOT the acceptance criterion. `Math.sin` and
   friends are not specified to the last bit across engines, so the comparison
   is a divergence measurement with a tolerance, and the architecture assumes
   the server corrects the client rather than that they never disagree. What a
   large divergence would mean is a *rule* that differs — a branch taken on one
   side and not the other — and that is what this catches.
   ========================================================================== */

export const TRACE_DEFAULTS = {
  seed: 20260725,      // the galaxy seed Game.boot uses
  system: 0,
  ticks: 10000,
  dt: 1 / 60,
  sampleEvery: 100,
};

const _look = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _off = new THREE.Vector3();

/** Which phase tick `i` is in, given the total. */
function phaseOf(i, ticks) {
  if (i < ticks * 0.25) return 'approach';
  if (i < ticks * 0.60) return 'loiter';
  return 'departure';
}

/**
 * Scripted input for tick `i`. Pure arithmetic — same answer everywhere.
 *
 * The periods are deliberately coprime-ish so the axes do not all peak
 * together and cancel into a straight line.
 */
export function scriptedInput(i, phase, out) {
  if (phase === 'approach') {
    // Hands off the stick. Anything else curves away from the planet and the
    // envelope is never reached.
    out.pitch = out.yaw = out.roll = out.strafeX = out.strafeY = 0;
    return out;
  }
  if (phase === 'departure') {
    /* Rotation off, thrusters on. Turning the ship outward at the phase
       boundary and then handing it back to the oscillating stick is what the
       first version did, and it simply tumbled: the fold was refused every
       single time because the ship never actually went anywhere. */
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

/** Throttle and boost for tick `i`, written straight onto the ship state. */
function scriptedDrive(s, i, phase) {
  if (s.foldMode) return;        // the drive is not yours in a fold
  if (phase === 'approach') { s.throttle = 1; s.boost = 0; return; }
  if (phase === 'departure') { s.throttle = 1; s.boost = 1; return; }
  s.throttle = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(i * 0.0021));
  s.boost = (i % 1700 < 300) ? 1 : 0;
}

/**
 * Run the trace. Returns samples plus a final state, ready to be compared with
 * a run from the other process.
 */
export function runTrace(opts = {}) {
  const o = { ...TRACE_DEFAULTS, ...opts };
  const { bodies, stub } = createSimWorld(o.seed, o.system);

  const ship = createShipState();

  /* Start just outside the envelope of the first planet, pointed straight at
     it. `soft` is 1.16 radii, so 1.3 is close enough that a quarter of the run
     reaches it and far enough that the first tick is still in open space. */
  const planet = bodies.find((b) => b.kind === 'planet') || bodies[0];
  _off.set(1, 0.2, 0.35).normalize().multiplyScalar(planet.radius * 1.3);
  ship.absPos.copy(planet.absPos).add(_off);
  _look.lookAt(ship.absPos, planet.absPos, _up);
  ship.quat.setFromRotationMatrix(_look);

  /* Arrive fast — faster than the ship can actually fly.

     The envelope bleeds off a large fraction of the inward velocity every
     single tick, so it is extremely stiff: measured against this planet, an
     entry at 500 units/s only ever reaches t = 0.13 and 1500 reaches 0.21,
     both short of the 0.25 where the autopilot is cancelled and the drive is
     cut. 4000 reaches 0.32 and fires them. Boost cruise is 252 units/s, so
     this is not a flight anyone can fly — it is branch coverage, and the
     server has to agree with the client about the edges too. */
  ship.vel.copy(planet.absPos).sub(ship.absPos).normalize().multiplyScalar(4000);

  // The trace is its own host: it records what the envelope asked for and
  // applies the fold drop itself, exactly as Game.toggleFold would.
  let foldEvents = 0;
  let autopilotCancels = 0;
  const host = createHostStub();
  host.cancelAutopilot = () => { autopilotCancels++; };
  host.setFold = (on) => {
    foldEvents++;
    if (on) engageFold(ship); else dropFold(ship);
  };

  const input = { pitch: 0, yaw: 0, roll: 0, strafeX: 0, strafeY: 0 };
  const samples = [];
  let foldAttempts = 0, foldRefusals = 0, foldEngaged = 0, envelopeTicks = 0;
  let turned = false;

  for (let i = 0; i < o.ticks; i++) {
    const phase = phaseOf(i, o.ticks);
    positionSystem(bodies, o.dt);

    // Departure begins by turning the ship outward, once. See the header.
    if (phase === 'departure' && !turned) {
      turned = true;
      _off.copy(ship.absPos).sub(planet.absPos).normalize().multiplyScalar(1e6).add(ship.absPos);
      _look.lookAt(ship.absPos, _off, _up);
      ship.quat.setFromRotationMatrix(_look);
      ship.angVel.set(0, 0, 0);
    }

    scriptedInput(i, phase, input);
    scriptedDrive(ship, i, phase);

    // Ask for the drive every so often. Deep in the well this is refused, and
    // out in the open it is granted — `canFold` has to reach the same verdict
    // on both sides or the two ships end up in different places entirely.
    if (phase !== 'approach' && i % 600 === 0) {
      foldAttempts++;
      const near = nearestBodyInfo(ship, bodies);
      const refused = canFold(ship, near);
      if (refused) foldRefusals++;
      else if (!ship.foldMode) { engageFold(ship); foldEngaged++; }
    }
    if (i % 600 === 350 && ship.foldMode) dropFold(ship);

    const near = nearestBodyInfo(ship, bodies);
    if (ship.foldMode && near.surfaceDist < foldFloor(near)) dropFold(ship);

    stepFlight(ship, o.dt, input, { foldCeiling: foldCeiling(near), time: i * o.dt });
    applyProximity(ship, bodies, o.dt, host);
    if (host.proximityWarn) envelopeTicks++;

    if (i % o.sampleEvery === 0) {
      samples.push([
        i,
        ship.absPos.x, ship.absPos.y, ship.absPos.z,
        ship.vel.x, ship.vel.y, ship.vel.z,
        ship.quat.x, ship.quat.y, ship.quat.z, ship.quat.w,
        ship.hull, ship.foldCharge, ship.heat,
      ]);
    }
  }

  return {
    meta: {
      seed: o.seed, system: o.system, systemName: stub.name,
      ticks: o.ticks, dt: o.dt, sampleEvery: o.sampleEvery,
      bodies: bodies.length, planet: planet.name,
    },
    counters: {
      foldAttempts, foldRefusals, foldEngaged, foldEvents, autopilotCancels, envelopeTicks,
    },
    samples,
    final: {
      absPos: ship.absPos.toArray(),
      vel: ship.vel.toArray(),
      quat: ship.quat.toArray(),
      hull: ship.hull, foldCharge: ship.foldCharge, heat: ship.heat,
      foldMode: ship.foldMode,
    },
  };
}

/**
 * Compare two traces. Returns the worst divergence found, in world units for
 * position and in native units for everything else.
 */
export function compareTraces(a, b) {
  const problems = [];
  if (a.samples.length !== b.samples.length) {
    problems.push(`sample count differs: ${a.samples.length} vs ${b.samples.length}`);
  }
  for (const k of Object.keys(a.counters)) {
    if (a.counters[k] !== b.counters[k]) {
      problems.push(`counter ${k} differs: ${a.counters[k]} vs ${b.counters[k]}`);
    }
  }

  let maxPos = 0, maxVel = 0, maxQuat = 0, maxScalar = 0, atTick = -1;
  const n = Math.min(a.samples.length, b.samples.length);
  for (let i = 0; i < n; i++) {
    const x = a.samples[i], y = b.samples[i];
    const dp = Math.hypot(x[1] - y[1], x[2] - y[2], x[3] - y[3]);
    const dv = Math.hypot(x[4] - y[4], x[5] - y[5], x[6] - y[6]);
    const dq = Math.max(
      Math.abs(x[7] - y[7]), Math.abs(x[8] - y[8]),
      Math.abs(x[9] - y[9]), Math.abs(x[10] - y[10]));
    const ds = Math.max(
      Math.abs(x[11] - y[11]), Math.abs(x[12] - y[12]), Math.abs(x[13] - y[13]));
    if (dp > maxPos) { maxPos = dp; atTick = x[0]; }
    if (dv > maxVel) maxVel = dv;
    if (dq > maxQuat) maxQuat = dq;
    if (ds > maxScalar) maxScalar = ds;
  }

  return { problems, maxPos, maxVel, maxQuat, maxScalar, atTick, compared: n };
}
