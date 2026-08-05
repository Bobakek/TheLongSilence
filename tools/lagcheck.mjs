// M7 acceptance: is a pilot judged against the world they could see?
//
//   node tools/lagcheck.mjs                 the mechanism, no server needed
//   node server/index.mjs --lag 75 &
//   node tools/lagcheck.mjs --wire          ...and two pilots shooting
//
// The measurement that matters is a *difference*: the same shot, at the same
// moving target, resolved with and without the rewind. If compensation does
// nothing the two agree, and the milestone is theatre.
//
// A note on what is being compensated. This game fires projectiles, not
// hitscan. A bolt takes a third of a second to cross two hundred units, which
// is longer than the round trip it is correcting for — so rewinding only the
// muzzle moment would compensate nothing, because a projectile does not hit at
// spawn. The bolt therefore carries its shooter's view offset for its whole
// flight: it travels through the world that shooter could see. The cost is
// real and is asserted below — the victim can be hit where they no longer are.

import * as THREE from 'three';
import { Room } from '../server/room.js';
import { History, MAX_REWIND_TICKS, rewindSeconds } from '../server/history.js';
import { BOLT_SPEED, HIT_RADIUS } from '../src/sim/index.js';
import { BTN, TICK_DT } from '../src/net/protocol.js';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

const fails = [];
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) fails.push(label);
};
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const NEUTRAL = { pitch: 0, yaw: 0, roll: 0, strafeX: 0, strafeY: 0, throttleDelta: 0, boost: 0 };

/* ------------------------------------------------------------- the buffer */

console.log('the history buffer\n');

{
  const h = new History();
  const ship = { absPos: V(0, 0, 0) };
  const c = [{ id: 'x', ship }];
  for (let t = 1; t <= 50; t++) { ship.absPos.set(t, 0, 0); h.record(t, c); }

  ok(h.posAt(50, 'x')?.x === 50, 'the latest tick is held', String(h.posAt(50, 'x')?.x));
  ok(h.posAt(50 - MAX_REWIND_TICKS, 'x')?.x === 50 - MAX_REWIND_TICKS,
    'and so is the oldest the cap allows', String(h.posAt(50 - MAX_REWIND_TICKS, 'x')?.x));
  ok(h.posAt(5, 'x') === null, 'anything older has been overwritten');
  ok(h.posAt(50, 'nobody') === null, 'an unknown id reads as nothing');

  ok(h.rewindTicks(100, 90) === 10, 'a render tick ten behind rewinds ten');
  ok(h.rewindTicks(100, 120) === 0, 'a client claiming the future is refused', String(h.rewindTicks(100, 120)));
  ok(h.rewindTicks(100, -5000) === MAX_REWIND_TICKS,
    'and one claiming the distant past is capped',
    `${h.rewindTicks(100, -5000)} ticks (${rewindSeconds(MAX_REWIND_TICKS).toFixed(2)}s)`);
  ok(h.rewindTicks(100, null) === 0, 'a client that reports nothing gets no rewind');
}

/* ------------------------------------------------- the difference it makes */

console.log('\nthe shot, with and without');

/**
 * One pilot shoots at another crossing its nose, aiming the way a pilot does.
 *
 * The shooter can only see the mark as it was `lagTicks` ago, so it aims at
 * that ghost — *with the lead its own eyes justify*, which is the flight time
 * multiplied by the drift it can observe. That distinction is the whole test:
 *
 *   lead        is physics. A bolt takes a third of a second to cross two
 *               hundred units and the pilot must allow for it, compensated or
 *               not. Removing that would be removing the skill.
 *   staleness   is the network. The pilot cannot see it, cannot correct for
 *               it, and it is worth `drift * lagSeconds` — eight units here,
 *               against a hit radius of 0.6.
 *
 * `compensate` decides only whether the shooter tells the room what it was
 * looking at. Everything else about the shot is identical, so the difference
 * between the two runs is the compensation and nothing else.
 */
function duel({ lagTicks, drift, compensate = true }) {
  const room = new Room({ seed: 20260725, systemId: 0 });
  room.npcs.length = 0;                       // just the two pilots

  const a = room.add('SHOOTER'); a._seq = 0;
  const b = room.add('MARK'); b._seq = 0;

  const base = V(0, 0, 0).copy(room.bodies[0].absPos).add(V(0, 0, 400000));
  const range = 150;
  a.ship.absPos.copy(base);
  b.ship.absPos.copy(base).add(V(0, 0, -range));

  // let the buffer fill while the mark slides sideways at a steady rate
  const seenAt = new THREE.Vector3();
  for (let i = 0; i < MAX_REWIND_TICKS + 4; i++) {
    if (i === 4) seenAt.copy(b.ship.absPos);    // remembered below
    a.ship.vel.set(0, 0, 0);
    b.ship.vel.set(drift, 0, 0);
    a.enqueue({ seq: ++a._seq, raw: NEUTRAL, buttons: 0, aim: null, renderTick: null });
    b.enqueue({ seq: ++b._seq, raw: NEUTRAL, buttons: 0, aim: null, renderTick: null });
    room.step();
  }

  // where the shooter can see the mark: `lagTicks` in the past
  const ghost = room.history.posAt(room.tick - lagTicks, `p:${b.id}`).clone();

  /* Aim ahead of the ghost by the flight time — the lead any pilot has to
     take, and all this pilot has the information to take.

     The lead uses the ghost's *observed* velocity, taken from two consecutive
     recorded positions, rather than the drift the test asked for. They are not
     the same: the flight model pulls an unthrottled ship's velocity toward
     zero every tick, so a mark told to move at 40 actually crosses at about
     39.3. A pilot can only see the former, and using the latter would be the
     test cheating with information the game does not give anyone. */
  const gPrev = room.history.posAt(room.tick - lagTicks - 1, `p:${b.id}`);
  const ghostVel = gPrev ? ghost.clone().sub(gPrev).divideScalar(TICK_DT) : V(drift, 0, 0);

  let flight = a.ship.absPos.distanceTo(ghost) / BOLT_SPEED;
  let aimPoint = ghost.clone().addScaledVector(ghostVel, flight);
  // one refinement: the lead point is further away than the ghost was
  flight = a.ship.absPos.distanceTo(aimPoint) / BOLT_SPEED;
  aimPoint = ghost.clone().addScaledVector(ghostVel, flight);

  a.ship.quat.setFromRotationMatrix(new THREE.Matrix4().lookAt(a.ship.absPos, aimPoint, V(0, 1, 0)));
  a.ship.vel.set(0, 0, 0);
  a.enqueue({
    seq: ++a._seq, raw: NEUTRAL, buttons: BTN.FIRE, aim: null,
    // The only difference between the two runs.
    renderTick: compensate ? room.tick - lagTicks : null,
  });
  b.enqueue({ seq: ++b._seq, raw: NEUTRAL, buttons: 0, aim: null, renderTick: null });
  a.events.length = 0;
  room.step();

  // fly the bolt out, keeping the mark drifting, and watch how close it comes
  let hit = null;
  let closest = Infinity;
  for (let i = 0; i < 90 && !hit; i++) {
    b.ship.vel.set(drift, 0, 0);
    a.ship.vel.set(0, 0, 0);
    a.enqueue({ seq: ++a._seq, raw: NEUTRAL, buttons: 0, aim: null, renderTick: null });
    b.enqueue({ seq: ++b._seq, raw: NEUTRAL, buttons: 0, aim: null, renderTick: null });
    room.step();
    /* Closest approach to the ghost, measured against the swept segment the
       room actually tests — not against the bolt's position at the tick
       boundary. A bolt covers twenty units a tick, so sampling it at those
       boundaries reports misses of several units for shots that were dead on;
       the first version of this diagnostic did exactly that and sent me
       looking for a bug in the compensation. */
    for (const bolt of room.bolts) {
      if (bolt.owner !== `p:${a.id}`) continue;
      const g = room.history.posAt(room.tick - bolt.rewind, `p:${b.id}`);
      if (!g) continue;
      if (bolt._was) {
        const seg = bolt.pos.clone().sub(bolt._was);
        const toG = g.clone().sub(bolt._was);
        const t = Math.max(0, Math.min(1, toG.dot(seg) / Math.max(seg.lengthSq(), 1e-12)));
        closest = Math.min(closest, toG.sub(seg.multiplyScalar(t)).length());
      }
      bolt._was = bolt.pos.clone();
    }
    hit = a.events.find((e) => e.type === 'hit') || null;
  }
  return { hit: !!hit, ghost, closest, room, a, b };
}

{
  const drift = 40;                            // units per second across the nose
  const lag = 6;                               // ticks — 200 ms, a real link
  const offset = drift * rewindSeconds(lag);
  console.log(`  mark drifting ${drift} u/s, shooter ${lag} ticks behind `
    + `(${rewindSeconds(lag).toFixed(2)}s, ${offset.toFixed(1)} units of error)\n`);

  /* Swept rather than asserted on one shot.
     An input spends a tick or two in the room's jitter buffer before it is
     consumed, so the rewind a bolt ends up with can differ from the one the
     test intended by a tick — which at these speeds is more than a hit radius.
     That is a real property of the system, not a flaw in it, and the way to
     measure through it is to fire a spread and compare the totals. */
  /* Measured as an error, not as a hit count.
     Whether a given shot lands depends on the last fraction of a unit of the
     test's own aim, and a hit count therefore measures my arithmetic as much
     as the room's. How far the bolt passed from what it was aimed at is the
     direct reading of what compensation does, and it does not care whether the
     lead was perfect. */
  let hitsOn = 0, hitsOff = 0, shots = 0;
  let errOn = 0, errOff = 0;
  for (let l = 4; l <= 8; l++) {
    for (const d of [25, 40, 55]) {
      shots++;
      const on = duel({ lagTicks: l, drift: d, compensate: true });
      const off = duel({ lagTicks: l, drift: d, compensate: false });
      if (on.hit) hitsOn++;
      if (off.hit) hitsOff++;
      errOn += on.hit ? 0 : on.closest;
      errOff += off.hit ? 0 : off.closest;
    }
  }
  const meanOn = errOn / shots, meanOff = errOff / shots;
  console.log(`  ${shots} aimed shots, lags 4..8 ticks, drifts 25/40/55 u/s`);
  console.log(`    with the rewind    ${hitsOn}/${shots} hit, mean miss ${meanOn.toFixed(2)}u`);
  console.log(`    without it         ${hitsOff}/${shots} hit, mean miss ${meanOff.toFixed(2)}u\n`);

  ok(hitsOn > hitsOff, 'the rewind materially changes the outcome',
    `${hitsOn} vs ${hitsOff} hits`);
  ok(meanOn < meanOff / 4, 'and shrinks the aiming error by the bulk of it',
    `${meanOn.toFixed(2)}u vs ${meanOff.toFixed(2)}u`);
  ok(meanOn < HIT_RADIUS * 2.5,
    'leaving a residual within a couple of hit radii — the test\'s own lead, not the room\'s',
    `${meanOn.toFixed(2)}u vs a hit radius of ${HIT_RADIUS}`);
  ok(meanOff > offset * 0.5, 'while the uncompensated error is the staleness itself',
    `${meanOff.toFixed(1)}u against ${offset.toFixed(1)}u of drift in ${rewindSeconds(lag).toFixed(2)}s`);
}

{
  // The cost, stated plainly: the mark is judged where it was.
  const drift = 60, lag = 8;
  const r = duel({ lagTicks: lag, drift, compensate: true });
  if (r.hit) {
    const nowPos = r.b.ship.absPos;
    const apart = r.ghost.distanceTo(nowPos);
    ok(apart > HIT_RADIUS,
      'the victim was hit where they no longer are — the accepted cost',
      `${apart.toFixed(1)} units from the position that was shot at`);
  } else {
    ok(false, 'the compensated shot should have connected');
  }
}

{
  // A client that lies about the past gets the cap, not the moon.
  const room = new Room({ seed: 20260725, systemId: 0 });
  ok(room.history.rewindTicks(1000, -1e9) === MAX_REWIND_TICKS,
    'a hostile render tick is clamped, not honoured',
    `${MAX_REWIND_TICKS} ticks max`);
}

/* ------------------------------------------------------------------ wire */

if (argv.includes('--wire')) {
  console.log('\nwire (needs a running room)');
  const { NetClient } = await import('../src/net/Client.js');
  const { createSimWorld, createShipState } = await import('../src/sim/index.js');
  const URL_ = arg('--url', 'ws://localhost:8787');

  const mk = async (name) => {
    const net = new NetClient(URL_, { system: 0, name, key: null });
    const w = await net.connect();
    const { bodies } = createSimWorld(w.seed, w.system);
    const ship = createShipState();
    net.attach(bodies, ship);
    return net;
  };

  const one = await mk('DUEL-A');
  const two = await mk('DUEL-B');
  await new Promise((r) => setTimeout(r, 800));

  const t0 = Date.now(); let prev = t0;
  await new Promise((done) => {
    const iv = setInterval(() => {
      const now = Date.now();
      const dt = (now - prev) / 1000; prev = now;
      one.update(dt, () => ({ raw: NEUTRAL, buttons: BTN.FIRE, aim: null }));
      two.update(dt, () => ({ raw: { ...NEUTRAL, throttleDelta: 1 }, buttons: 0, aim: null }));
      one.interpolate(); two.interpolate();
      if (now - t0 >= 5000) { clearInterval(iv); done(); }
    }, 1000 / 60);
  });

  ok(one.remotes.size >= 1, 'each pilot sees the other', `${one.remotes.size}`);
  ok(Number.isFinite(one.renderTick), 'the client works out what tick it is looking at',
    one.renderTick !== null ? one.renderTick.toFixed(1) : 'null');
  ok(one.renderTick < one.tick, 'and it is behind its own prediction',
    `${one.renderTick?.toFixed(1)} < ${one.tick}`);
  const behind = one.tick - one.renderTick;
  ok(behind > 0 && behind < MAX_REWIND_TICKS,
    'by a sane amount', `${behind.toFixed(1)} ticks (${(behind * TICK_DT).toFixed(2)}s)`);
  one.close(); two.close();
}

console.log(fails.length ? `\nFAIL — ${fails.length} check(s)\n` : '\nPASS — shots are judged against the world the shooter saw\n');
process.exit(fails.length ? 1 : 0);
