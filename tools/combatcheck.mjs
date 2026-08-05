// M6 acceptance: does shooting work, and does the room decide it?
//
//   node tools/combatcheck.mjs              rules, no server needed
//   node server/index.mjs &
//   node tools/combatcheck.mjs --wire       ...and bolts over the wire
//
// The first check is the one that matters most and is easiest to get wrong: a
// bolt covers twenty units in a tick and a ship is a tenth of a unit long, so
// hit detection has to test the segment the bolt swept, not the point it
// landed on. A point test misses essentially always, and the weapon would look
// like it fired blanks.

import * as THREE from 'three';
import { Room } from '../server/room.js';
import {
  segmentHitsSphere, createShipState, applyDamage, stepCombatState, canFire, fire,
  aimForward, stepProjectiles,
  BOLT_SPEED, BOLT_DAMAGE, FIRE_COOLDOWN, HIT_RADIUS, SHIELD_HOLDOFF, SHIELD_MAX,
} from '../src/sim/index.js';
import { BTN } from '../src/net/protocol.js';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

const fails = [];
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) fails.push(label);
};
const DT = 1 / 30;
const NEUTRAL = { pitch: 0, yaw: 0, roll: 0, strafeX: 0, strafeY: 0, throttleDelta: 0, boost: 0 };
const V = (x, y, z) => new THREE.Vector3(x, y, z);

/* ------------------------------------------------------ the swept segment */

console.log('hit detection\n');

{
  const step = BOLT_SPEED * DT;                 // ~20 units in one tick
  const p0 = V(0, 0, 0), p1 = V(step, 0, 0);
  const dead = V(step * 0.5, 0, 0);             // dead centre of the stride

  ok(segmentHitsSphere(p0, p1, dead, HIT_RADIUS) >= 0,
    'a target mid-stride is hit', `stride ${step.toFixed(1)} units`);
  // the same target against a point test — what this replaces
  ok(p0.distanceTo(dead) > HIT_RADIUS && p1.distanceTo(dead) > HIT_RADIUS,
    'and a point test at either end would have missed it',
    `${p0.distanceTo(dead).toFixed(1)} and ${p1.distanceTo(dead).toFixed(1)} from a radius of ${HIT_RADIUS}`);

  ok(segmentHitsSphere(p0, p1, V(step * 0.5, HIT_RADIUS * 3, 0), HIT_RADIUS) < 0,
    'a target off to one side is missed');
  ok(segmentHitsSphere(p0, p1, V(step * 3, 0, 0), HIT_RADIUS) < 0,
    'a target beyond the stride is not hit early');
  ok(segmentHitsSphere(p0, p1, V(-step, 0, 0), HIT_RADIUS) < 0,
    'nor one behind it');

  const near = segmentHitsSphere(p0, p1, V(step * 0.25, 0, 0), HIT_RADIUS);
  const far = segmentHitsSphere(p0, p1, V(step * 0.75, 0, 0), HIT_RADIUS);
  ok(near >= 0 && far >= 0 && near < far,
    'two in line report their order along the flight path', `${near.toFixed(2)} < ${far.toFixed(2)}`);
}

/* ------------------------------------------------------------- the damage */

console.log('\ndamage');

{
  const s = createShipState();
  const d1 = applyDamage(s, 0.3, 10);
  ok(d1.shield === 0.3 && d1.hull === 0, 'the shield takes it first',
    `shield ${d1.shield}, hull ${d1.hull}`);
  ok(Math.abs(s.shield - 0.7) < 1e-9, 'and is drawn down', s.shield.toFixed(3));

  applyDamage(s, 0.7, 11);                       // exactly empties the shield
  const d3 = applyDamage(s, 0.25, 12);
  ok(d3.shield === 0 && Math.abs(d3.hull - 0.25) < 1e-9,
    'with the shield gone the hull takes it', `hull ${d3.hull}`);

  // holdoff, then recovery
  const before = s.shield;
  stepCombatState(s, 1.0, 12.5);
  ok(s.shield === before, 'the shield does not recover while it is being shot at',
    `${s.shield.toFixed(3)}`);
  stepCombatState(s, 1.0, 12 + SHIELD_HOLDOFF + 1);
  ok(s.shield > before, 'and does once it is left alone', s.shield.toFixed(3));

  const kill = createShipState();
  kill.shield = 0;
  const d4 = applyDamage(kill, 5, 20);
  ok(d4.destroyed && kill.hull === 0, 'enough damage destroys', `hull ${kill.hull}`);
}

/* -------------------------------------------------------------- the rules */

console.log('\nfiring');

{
  const s = createShipState();
  ok(canFire(s) === null, 'a fresh ship may fire');
  const b = fire(s, 'me', aimForward(s, V(0, 0, 0)), 0);
  ok(canFire(s) === 'cooling', 'and then has to wait', String(canFire(s)));
  stepCombatState(s, FIRE_COOLDOWN + 1e-6, 0.3);
  ok(canFire(s) === null, 'until the cooldown expires');

  ok(b.vel.length() > BOLT_SPEED * 0.99, 'the bolt leaves at speed',
    b.vel.length().toFixed(0));

  const dead = createShipState();
  dead.hull = 0;
  ok(canFire(dead) === 'dead', 'a dead ship does not fire', String(canFire(dead)));

  // a bolt must never hit the ship that fired it
  const me = { id: 'me', ship: s };
  const r = stepProjectiles([fire(s, 'me', V(0, 0, -1), 1)], [me], DT, 1);
  ok(r.hits.length === 0, 'a bolt does not hit its own shooter', `${r.hits.length} hits`);
}

/* ------------------------------------------------------- in a real room */

console.log('\nin the room');

{
  const room = new Room({ seed: 20260725, systemId: 0 });
  const raider = room.npcs.find((n) => n.hostile);
  const patrol = room.npcs.find((n) => !n.hostile);
  ok(!!raider && !!patrol, 'a system holds both patrols and something hostile',
    room.npcs.map((n) => n.kind).join(', '));

  // put a pilot behind the raider, pointed at it, and hold the trigger
  const p = room.add('GUNNER'); p._seq = 0;
  const stand = () => {
    const from = raider.ship.absPos.clone().add(V(0, 0, 260));
    p.ship.absPos.copy(from);
    p.ship.vel.set(0, 0, 0);
    p.ship.quat.setFromRotationMatrix(
      new THREE.Matrix4().lookAt(from, raider.ship.absPos, V(0, 1, 0)));
  };

  let hitsOnRaider = 0, fired = 0;
  const startHull = raider.ship.hull + raider.ship.shield;
  for (let i = 1; i <= 400; i++) {
    stand();                                     // hold station on the target
    p.enqueue({ seq: ++p._seq, raw: NEUTRAL, buttons: BTN.FIRE, aim: null });
    room.step();
    fired += p.events.filter((e) => e.type === 'fired').length;
    hitsOnRaider += p.events.filter((e) => e.type === 'hit' && e.target === raider.id).length;
    p.events.length = 0;
    if (raider.ship.hull <= 0) break;
  }

  ok(fired > 0, 'holding the trigger fires', `${fired} bolts`);
  ok(fired < 400, 'but not every tick — the cooldown gates it', `${fired} in 400 ticks`);
  ok(hitsOnRaider > 0, 'and the bolts connect', `${hitsOnRaider} hits`);
  ok(raider.ship.hull + raider.ship.shield < startHull, 'the raider took damage',
    `${startHull.toFixed(2)} -> ${(raider.ship.hull + raider.ship.shield).toFixed(2)}`);

  // patrols are not targets of opportunity and do not open fire
  ok(patrol.ai.wantsFire !== true, 'a patrol does not shoot', String(patrol.ai.wantsFire));
}

{
  // destruction removes a hunter and tells the shooter
  const room = new Room({ seed: 20260725, systemId: 0 });
  const raider = room.npcs.find((n) => n.hostile);
  const p = room.add('KILLER'); p._seq = 0;
  const before = room.npcs.length;
  let killed = null;
  for (let i = 1; i <= 2000 && room.npcs.includes(raider); i++) {
    const from = raider.ship.absPos.clone().add(V(0, 0, 260));
    p.ship.absPos.copy(from);
    p.ship.vel.set(0, 0, 0);
    p.ship.quat.setFromRotationMatrix(
      new THREE.Matrix4().lookAt(from, raider.ship.absPos, V(0, 1, 0)));
    p.ship.hull = 1; p.ship.shield = SHIELD_MAX;   // not the fight under test
    p.enqueue({ seq: ++p._seq, raw: NEUTRAL, buttons: BTN.FIRE, aim: null });
    room.step();
    const k = p.events.find((e) => e.type === 'killed');
    if (k) killed = k;
    p.events.length = 0;
  }
  ok(!!killed, 'sustained fire destroys a raider', killed ? killed.id : 'survived');
  ok(room.npcs.length === before - 1, 'and it leaves the room',
    `${before} -> ${room.npcs.length}`);
}

{
  // a pilot that loses its hull is put back, not left at zero
  const room = new Room({ seed: 20260725, systemId: 0 });
  const p = room.add('VICTIM'); p._seq = 0;
  p.ship.shield = 0;
  p.ship.hull = 0.01;
  const where = p.ship.absPos.clone();
  const raider = room.npcs.find((n) => n.hostile);
  p.ship.absPos.copy(raider.ship.absPos).add(V(0, 0, 120));
  let destroyed = null;
  for (let i = 1; i <= 900 && !destroyed; i++) {
    p.enqueue({ seq: ++p._seq, raw: NEUTRAL, buttons: 0, aim: null });
    room.step();
    destroyed = p.events.find((e) => e.type === 'destroyed');
    p.events.length = 0;
  }
  ok(!!destroyed, 'a raider can destroy a pilot', destroyed ? 'yes' : 'no');
  ok(p.ship.hull === p.ship.hullMax, 'who is put back with a whole hull',
    p.ship.hull.toFixed(2));
  ok(p.ship.absPos.distanceTo(where) > 0, 'and somewhere else');
}

/* ------------------------------------------------------------------ wire */

if (argv.includes('--wire')) {
  console.log('\nwire (needs a running room)');
  const { NetClient } = await import('../src/net/Client.js');
  const { createSimWorld } = await import('../src/sim/index.js');
  const URL_ = arg('--url', 'ws://localhost:8787');

  const net = new NetClient(URL_, { system: 0, name: 'GUNNER', key: null });
  const w = await net.connect();
  const { bodies } = createSimWorld(w.seed, w.system);
  const ship = createShipState();
  net.attach(bodies, ship);
  await new Promise((r) => setTimeout(r, 600));

  let sawBolts = 0;
  const t0 = Date.now(); let prev = t0;
  await new Promise((done) => {
    const iv = setInterval(() => {
      const now = Date.now();
      net.update((now - prev) / 1000, () => ({ raw: NEUTRAL, buttons: BTN.FIRE, aim: null }));
      prev = now;
      if (net.bolts.length) sawBolts = Math.max(sawBolts, net.bolts.length);
      if (now - t0 >= 5000) { clearInterval(iv); done(); }
    }, 1000 / 60);
  });

  ok(net.stats.snapshots > 0, 'snapshots arrived', String(net.stats.snapshots));
  ok(sawBolts > 0, 'bolts reach the client', `${sawBolts} in flight at once`);
  ok(net.events.some((e) => e && e.type === 'fired'), 'and the room confirms the shots');
  net.close();
}

console.log(fails.length ? `\nFAIL — ${fails.length} check(s)\n` : '\nPASS — the room decides who was hit\n');
process.exit(fails.length ? 1 : 0);
