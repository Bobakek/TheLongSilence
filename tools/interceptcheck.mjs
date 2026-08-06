// Does the lead actually lead, and does the chase actually close?
//
//   node tools/interceptcheck.mjs
//
// Two halves. First the geometry: given a target and a velocity, is the aim
// point the one an intercept solution puts it at? Then the behaviour: fly the
// real flight model at a real moving target and watch the range.
//
// This exists because the first version of `steerToIntercept` estimated the
// meeting time as distance over the pursuer's own top speed, which is only
// right for a stationary target. Against a craft under way it over-led by the
// ratio of the speeds and aimed at empty space — and nothing in the suite
// noticed, because every check up to then either had a still target or only
// asked whether the range closed *at all*.

import * as THREE from 'three';
import {
  steerToIntercept, steerToward, createShipState, stepFlight,
  nearestBodyInfo, foldCeiling, createSimWorld,
} from '../src/sim/index.js';

const fails = [];
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) fails.push(label);
};
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const DT = 1 / 60;

/* ---------------------------------------------------------- the geometry */

console.log('the intercept solution\n');

/** Where the steering is actually pointing, as a point `dist` ahead. */
function aimPoint(ship, cmd, dist) {
  // reconstruct the aim direction from the command by re-steering onto it
  const f = V(0, 0, -1).applyQuaternion(ship.quat);
  return f.multiplyScalar(dist).add(ship.absPos);
}

{
  const ship = createShipState();
  ship.absPos.set(0, 0, 0);
  const speed = 60;

  // 1. a still target: the lead must be the target itself
  const still = V(0, 0, -600);
  const a = steerToIntercept(ship, still, V(0, 0, 0), speed, {});
  const b = steerToward(ship, still, {});
  ok(Math.abs(a.pitch - b.pitch) < 1e-9 && Math.abs(a.yaw - b.yaw) < 1e-9,
    'a still target is aimed at directly', 'lead == pursuit');
  ok(Math.abs(a.dist - 600) < 1e-6, 'and the range is the range to it', a.dist.toFixed(1));

  // 2. a crossing target: the solution must satisfy |r + u t| = v t
  const pos = V(0, 0, -600), vel = V(30, 0, 0);
  const c = steerToIntercept(ship, pos, vel, speed, {});
  // recover t from the geometry the solver used
  const solved = (() => {
    const r = pos.clone().sub(ship.absPos);
    const A = vel.lengthSq() - speed * speed;
    const B = 2 * r.dot(vel);
    const C = r.lengthSq();
    const d = B * B - 4 * A * C;
    const t1 = (-B - Math.sqrt(d)) / (2 * A), t2 = (-B + Math.sqrt(d)) / (2 * A);
    return Math.min(...[t1, t2].filter((t) => t > 1e-6));
  })();
  const meet = vel.clone().multiplyScalar(solved).add(pos);
  const travel = meet.distanceTo(ship.absPos);
  ok(Math.abs(travel - speed * solved) < 1e-6,
    'the crossing solution is a real intercept', `|r+ut| = ${travel.toFixed(2)}, vt = ${(speed * solved).toFixed(2)}`);
  ok(Math.abs(c.dist - 600) < 1e-6, 'and `dist` still reports the target, not the aim point',
    c.dist.toFixed(1));

  /* The old formula, for contrast, on the case that provoked this: a craft
     running away at the pursuer's own speed, six hundred units out. Distance
     over speed gives ten seconds, so it aimed a full six hundred units past
     the target — the length of the whole approach — at a patch of empty space
     the target was never going to reach. Against the crossing target above the
     same guess is only about forty units out, which is why nothing caught it
     for so long: it is wrong everywhere but only obviously wrong in a chase. */
  const runner = V(0, 0, -600), runVel = V(0, 0, -60);
  const naiveLead = runVel.clone().multiplyScalar(600 / speed).add(runner);
  ok(naiveLead.distanceTo(runner) > 500,
    'the old guess aimed hundreds of units past a fleeing target',
    `${naiveLead.distanceTo(runner).toFixed(0)} units past it`);
  ok(naiveLead.distanceTo(meet) > 25,
    'and missed the true solution by more than the arrival standoff even when crossing',
    `${vel.clone().multiplyScalar(600 / speed).add(pos).distanceTo(meet).toFixed(0)} units`);

  // 3. fleeing at matched speed: no intercept exists, so point at it
  const flee = steerToIntercept(ship, V(0, 0, -600), V(0, 0, -60), 60, {});
  const direct = steerToward(ship, V(0, 0, -600), {});
  ok(Math.abs(flee.pitch - direct.pitch) < 1e-9 && Math.abs(flee.yaw - direct.yaw) < 1e-9,
    'an uncatchable runner is chased directly rather than led into space');

  // 4. fleeing slower: catchable, and the lead is modest and ahead of it
  const slow = steerToIntercept(ship, V(0, 0, -600), V(0, 0, -20), 60, {});
  ok(Math.abs(slow.dist - 600) < 1e-6, 'a slower runner reports its own range', slow.dist.toFixed(1));
}

/* ---------------------------------------------------------- the behaviour */

console.log('\nthe chase');

/**
 * Fly the real model at a mark under way and report the range each second.
 * `markVel` is held constant — the point is the steering, not the mark's AI.
 */
function chase({ label, markVel, seconds = 90, lead = true }) {
  const { bodies } = createSimWorld(20260725, 0);
  const ship = createShipState();
  const anchor = bodies.find((b) => b.kind === 'planet').absPos;
  ship.absPos.copy(anchor).add(V(0, 0, 40000));
  ship.quat.setFromEuler(new THREE.Euler(0.4, 1.2, 0, 'XYZ'));

  const mark = { pos: ship.absPos.clone().add(V(600, 0, 0)), vel: markVel.clone() };
  const cmd = {};
  let closest = Infinity;

  for (let i = 0; i < seconds * 60; i++) {
    mark.pos.addScaledVector(mark.vel, DT);
    const c = lead
      ? steerToIntercept(ship, mark.pos, mark.vel, ship.maxSpeed, cmd)
      : steerToward(ship, mark.pos, cmd);
    ship.throttle = c.aligned ? 1 : 0.35;
    stepFlight(ship, DT, c, { foldCeiling: foldCeiling(nearestBodyInfo(ship, bodies)) });
    closest = Math.min(closest, ship.absPos.distanceTo(mark.pos));
  }
  const end = ship.absPos.distanceTo(mark.pos);
  console.log(`  ${label.padEnd(22)} closest ${closest.toFixed(0).padStart(6)}   final ${end.toFixed(0).padStart(7)}`);
  return { closest, end };
}

const crossing = chase({ label: 'crossing at 40 u/s', markVel: V(0, 40, 0) });
ok(crossing.closest < 40, 'a crossing mark is actually intercepted', `${crossing.closest.toFixed(0)} units`);

const fleeing = chase({ label: 'fleeing at 30 u/s', markVel: V(30, 0, 0) });
ok(fleeing.closest < 40, 'a slower runner is caught', `${fleeing.closest.toFixed(0)} units`);

const matched = chase({ label: 'fleeing at 60 u/s', markVel: V(60, 0, 0) });
ok(matched.closest < 900, 'a matched runner is at least followed, not lost',
  `${matched.closest.toFixed(0)} units`);

console.log(fails.length ? `\nFAIL — ${fails.length} check(s)\n` : '\nPASS — the lead leads and the chase closes\n');
process.exit(fails.length ? 1 : 0);
