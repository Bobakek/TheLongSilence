// M3: folding between rooms.
//
//   node tools/jumpcheck.mjs            the rule, no server needed
//   node server/index.mjs &
//   node tools/jumpcheck.mjs --wire     ...and the room change itself
//
// The rule half checks that the cost is the same number the star map has always
// drawn, and that a refusal costs nothing. The wire half is the interesting
// one: a pilot who has attuned to a Resonator folds to another system and must
// arrive with the Canto, the discovery and the upgraded drive still theirs,
// while everything tied to the room it left — the input queue, the scanner, the
// acknowledged sequence — is gone.

import * as THREE from 'three';
import { Room } from '../server/room.js';
import { createSimWorld, createShipState, jumpCost, canJump, payJump } from '../src/sim/index.js';
import { BTN } from '../src/net/protocol.js';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

const fails = [];
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) fails.push(label);
};
const UP = new THREE.Vector3(0, 1, 0);
const NEUTRAL = { pitch: 0, yaw: 0, roll: 0, strafeX: 0, strafeY: 0, throttleDelta: 0, boost: 0 };

/* ------------------------------------------------------------------ rules */

console.log('rules (no server)\n');

const room0 = new Room({ seed: 20260725, systemId: 0 });
const galaxy = room0.galaxy;
const ship = createShipState();

// the same expression HoloMap draws on the plate
const target = 1;
const a = galaxy[0], b = galaxy[target];
const expected = Math.min(1, Math.hypot(b.x - a.x, b.y - a.y) / 80);
ok(Math.abs(jumpCost(galaxy, 0, target) - expected) < 1e-12,
  'cost matches the star map expression', jumpCost(galaxy, 0, target).toFixed(4));

ok(canJump(ship, galaxy, 0, 0) === 'sameSystem', 'folding to where you are is refused');
ok(canJump(ship, galaxy, 0, 99) === 'noSuchSystem', 'folding nowhere is refused');

ship.foldCharge = 1;
ok(canJump(ship, galaxy, 0, target) === null, 'a full charge may fold');
ship.foldCharge = jumpCost(galaxy, 0, target) - 1e-6;
ok(canJump(ship, galaxy, 0, target) === 'noCharge', 'a charge one hair short may not');
const before = ship.foldCharge;
ok(ship.foldCharge === before, 'and a refusal spends nothing');

ship.foldCharge = 1;
const paid = payJump(ship, galaxy, 0, target);
ok(Math.abs(ship.foldCharge - (1 - paid)) < 1e-12, 'paying deducts exactly the cost',
  `${paid.toFixed(4)} -> ${ship.foldCharge.toFixed(4)}`);

/* --------------------------------------------------- what survives a fold

   The wire pass below can only reach the planet it spawns beside, so it proves
   that `maxSpeed` crosses rooms without ever changing it. This does the real
   case: attune to a Resonator, then move the pilot and check what came along. */

const src = new Room({ seed: 20260725, systemId: 0 });
const dst = new Room({ seed: 20260725, systemId: 1 });
const pilot = src.add('CARRIER');
pilot._seq = 0;

const res = src.bodies.find((x) => x.anomalyType === 'resonator');
const vantage = new THREE.Vector3().copy(res.absPos)
  .add(new THREE.Vector3(0, 0, 1).multiplyScalar(res.radius * 2));
const aimAtRes = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().lookAt(vantage, res.absPos, UP));
for (let i = 0; i < 200; i++) {
  pilot.ship.absPos.copy(vantage);
  pilot.ship.vel.set(0, 0, 0);
  pilot.enqueue({ seq: ++pilot._seq, raw: NEUTRAL, buttons: BTN.SCAN, aim: aimAtRes });
  src.step();
}
ok(pilot.cantos.length === 1, 'attuned before folding', String(pilot.cantos.length));
const carriedSpeed = pilot.ship.maxSpeed;
const carriedDisc = pilot.discoveries.size;

// queue something and half-fill the scanner, so there is state that must NOT travel
pilot.enqueue({ seq: ++pilot._seq, raw: NEUTRAL, buttons: 0, aim: aimAtRes });
pilot.scan.progress = 0.5;

src.remove(pilot.id);
dst.adopt(pilot);

ok(dst.players.has(pilot.id) && !src.players.has(pilot.id), 'the pilot changed rooms');
ok(pilot.cantos.length === 1, 'the Canto came along', String(pilot.cantos.length));
ok(pilot.discoveries.size === carriedDisc, 'and the discoveries', String(pilot.discoveries.size));
ok(pilot.ship.maxSpeed === carriedSpeed, 'and the upgraded drive',
  `${carriedSpeed.toFixed(3)}`);
ok(pilot.queue.length === 0, 'the old room\'s input queue did not', String(pilot.queue.length));
ok(pilot.scan.progress === 0 && pilot.scan.targetId === null, 'nor the half-filled scanner');
ok(pilot.lastSeq === 0 && pilot.seenSeq === 0, 'nor its acknowledged sequence');
ok(pilot.ship.foldMode === false && pilot.ship.foldSpeed === 0, 'and the drive arrives shut down');

/* ------------------------------------------------------------------- wire */

if (argv.includes('--wire')) {
  console.log('\nwire (needs a running room)\n');
  const { NetClient } = await import('../src/net/Client.js');
  const URL_ = arg('--url', 'ws://localhost:8787');

  const net = new NetClient(URL_, { system: 0, name: 'JUMPER' });
  const w = await net.connect();
  let world = createSimWorld(w.seed, w.system);
  const myShip = createShipState();
  net.attach(world.bodies, myShip);

  let jumped = null;
  net.onJumped = (m) => { jumped = m; };
  let denied = null;
  net.onJumpDenied = (m) => { denied = m; };

  const drive = (ms, sample) => new Promise((done) => {
    const t0 = Date.now(); let prev = t0;
    const iv = setInterval(() => {
      const now = Date.now();
      net.update((now - prev) / 1000, sample);
      prev = now;
      if (now - t0 >= ms) { clearInterval(iv); done(); }
    }, 1000 / 60);
  });

  // 1. survey the planet we spawned beside, so there is something to carry
  await new Promise((r) => setTimeout(r, 600));
  const planet = world.bodies.find((x) => x.kind === 'planet');
  const aim = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(myShip.absPos, planet.absPos, UP));
  await drive(8000, () => ({ raw: NEUTRAL, buttons: BTN.SCAN, aim }));
  const surveyed = net.events.filter((e) => e && e.type === 'scanned');
  ok(surveyed.length >= 1, 'surveyed something before folding', `${surveyed.length}`);
  const chargeBefore = net.authoritative.fc;
  const speedBefore = net.authoritative.ms;

  // 2. fold
  const to = 1;
  const cost = jumpCost(galaxy, w.system, to);
  net.requestJump(to);
  await drive(2500, () => ({ raw: NEUTRAL, buttons: 0, aim }));

  ok(!!jumped, 'the room granted the fold', denied ? `denied: ${denied.reason}` : '');
  ok(jumped?.system === to, 'and put us in the system we asked for', String(jumped?.system));
  ok(net.pending.length === 0, 'inputs from the old room were dropped', String(net.pending.length));
  ok(net.remotes.size === 0, 'and so were its neighbours', String(net.remotes.size));

  // 3. re-attach the new system, as Game.onJumped does, and keep flying
  world = createSimWorld(w.seed, to);
  net.attach(world.bodies, myShip);
  await drive(3000, () => ({ raw: NEUTRAL, buttons: 0, aim }));

  ok(net.stats.snapshots > 0 && net.authoritative, 'snapshots resume in the new room');
  /* Read the charge the room reported at the moment of the fold, not one from
     a later snapshot: it regenerates at 4.5% a second, so measuring five
     seconds downstream measures the recovery and not the price. */
  ok(Math.abs((jumped?.charge ?? 1) - (chargeBefore - cost)) < 1e-9,
    'the server charged us exactly the cost',
    `${chargeBefore?.toFixed(4)} - ${cost.toFixed(4)} -> ${jumped?.charge?.toFixed(4)}`);
  ok((net.authoritative.fc ?? 0) > (jumped?.charge ?? 0),
    'and the drive has been recharging since', `${net.authoritative.fc?.toFixed(3)}`);
  ok(Math.abs((net.authoritative.ms ?? 0) - speedBefore) < 1e-9,
    'the upgraded drive came with us', `${net.authoritative.ms}`);
  ok(net.stats.maxPredictionError < 1e-3,
    'and prediction is still exact after the room change',
    net.stats.maxPredictionError.toExponential(2));

  net.close();
}

console.log(fails.length ? `\nFAIL — ${fails.length} check(s)\n` : '\nPASS — folding between rooms holds\n');
process.exit(fails.length ? 1 : 0);
