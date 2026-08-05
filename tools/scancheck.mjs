// M3 acceptance: does the room decide what has been surveyed?
//
//   node tools/scancheck.mjs                 rules only, no server needed
//   node server/index.mjs &
//   node tools/scancheck.mjs --wire          ...and the round trip as well
//
// Split deliberately. The interesting rules are about *authority* — who may
// decide that a Resonator has been attuned — and those are tested against
// `Room` directly, with the ship placed by the room itself. Driving them over a
// socket would mean flying six hundred thousand units to the instrument first,
// or shoving the client's ship somewhere the server does not agree it is, which
// tests the harness rather than the game.
//
// The wire pass then does one honest end-to-end scan: from the spawn point, the
// first planet is already inside scanner range, so a pilot can survey it
// without moving and the whole path is exercised — aim on the wire, decision in
// the room, event back, client mirrors it.

import * as THREE from 'three';
import { Room } from '../server/room.js';
import { BTN } from '../src/net/protocol.js';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

const UP = new THREE.Vector3(0, 1, 0);
const fails = [];
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) fails.push(label);
};

const NEUTRAL = { pitch: 0, yaw: 0, roll: 0, strafeX: 0, strafeY: 0, throttleDelta: 0, boost: 0 };

function aimFrom(pos, target) {
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(pos, target, UP));
}

/**
 * Park `p` at `mult` radii off `body`, aim at `aimAt`, hold SCAN for `ticks`.
 * The ship is placed once and the room is stepped; nothing fights the server
 * for position because nothing else is driving it.
 */
function survey(room, p, body, mult, { aimAt = body, ticks = 200, scanning = true } = {}) {
  const pos = new THREE.Vector3().copy(body.absPos)
    .add(new THREE.Vector3(0, 0, 1).multiplyScalar(body.radius * mult));
  p.ship.absPos.copy(pos);
  p.ship.vel.set(0, 0, 0);
  const aim = aimFrom(pos, aimAt.absPos);
  p.events.length = 0;

  for (let i = 0; i < ticks; i++) {
    p.enqueue({ seq: ++p._seq, raw: NEUTRAL, buttons: scanning ? BTN.SCAN : 0, aim });
    // keep it parked: the envelope and the orbits would otherwise carry it off
    p.ship.absPos.copy(pos);
    p.ship.vel.set(0, 0, 0);
    room.step();
  }
  return p.events.filter((e) => e && e.type === 'scanned');
}

/* ------------------------------------------------------------------ rules */

console.log('rules (no server)\n');

const room = new Room({ seed: 20260725, systemId: 0 });
const res = room.bodies.find((b) => b.anomalyType === 'resonator');
const planet = room.bodies.find((b) => b.kind === 'planet');
const other = room.bodies.find((b) => b.kind === 'planet' && b !== planet);
console.log(`  target ${res.id} "${res.name}" radius ${res.radius}\n`);

const A = room.add('A'); A._seq = 0;
const B = room.add('B'); B._seq = 0;

let ev = survey(room, A, res, 2.0);
ok(ev.length === 1, 'aimed and in range: one scan completes', `${ev.length}`);
ok(ev[0]?.id === res.id, 'it was the Resonator', ev[0]?.id || '-');
ok(ev[0]?.canto === 'canto1', 'the server awarded the Canto', String(ev[0]?.canto));
ok(Math.abs(A.ship.maxSpeed - 60 * 1.09) < 1e-9, 'maxSpeed raised server-side',
  A.ship.maxSpeed.toFixed(4));
ok(A.cantos.length === 1, 'the room holds the Canto, not the client', String(A.cantos.length));

ev = survey(room, A, res, 2.0);
ok(ev.length === 0, 'scanning it twice awards nothing', `${ev.length}`);

ev = survey(room, B, res, 2.0);
ok(ev.length === 1 && ev[0].canto === 'canto1',
  'a second pilot attunes to the same Resonator (discoveries are personal)', `${ev.length}`);

ev = survey(room, A, res, 2.0, { aimAt: other, ticks: 120 });
ok(ev.length === 0, 'aiming elsewhere scans nothing', `${ev.length}`);

ev = survey(room, A, res, 400, { ticks: 120 });
ok(ev.length === 0, 'out of range scans nothing', `${ev.length}`);
ok(A.scan.progress === 0, 'and the bar never moved', String(A.scan.progress));

ev = survey(room, A, planet, 2.0, { ticks: 200, scanning: false });
ok(ev.length === 0, 'not holding the key scans nothing', `${ev.length}`);

// shared mode, for whoever wants to argue the other way
const shared = new Room({ seed: 20260725, systemId: 0, sharedDiscoveries: true });
const S1 = shared.add('S1'); S1._seq = 0;
const S2 = shared.add('S2'); S2._seq = 0;
const sres = shared.bodies.find((b) => b.anomalyType === 'resonator');
survey(shared, S1, sres, 2.0);
ev = survey(shared, S2, sres, 2.0);
ok(ev.length === 0, 'sharedDiscoveries: the second pilot finds it already surveyed', `${ev.length}`);

/* ------------------------------------------------------------------- wire */

if (argv.includes('--wire')) {
  console.log('\nwire (needs a running room)\n');
  const { NetClient } = await import('../src/net/Client.js');
  const { createSimWorld, createShipState } = await import('../src/sim/index.js');
  const URL_ = arg('--url', 'ws://localhost:8787');

  const net = new NetClient(URL_, { system: 0, name: 'SCAN-WIRE' });
  const w = await net.connect();
  const { bodies } = createSimWorld(w.seed, w.system);
  const ship = createShipState();
  net.attach(bodies, ship);

  // Wait for the first snapshot so we know where the room put us, then aim at
  // the planet we spawned beside — it is inside scanner range from there.
  await new Promise((r) => setTimeout(r, 600));
  const target = bodies.find((b) => b.kind === 'planet');
  const aim = aimFrom(ship.absPos, target.absPos);
  const sample = () => ({ raw: NEUTRAL, buttons: BTN.SCAN, aim });

  const t0 = Date.now();
  let prev = t0;
  await new Promise((done) => {
    const iv = setInterval(() => {
      const now = Date.now();
      net.update((now - prev) / 1000, sample);
      prev = now;
      if (now - t0 >= 8000) { clearInterval(iv); done(); }
    }, 1000 / 60);
  });
  await new Promise((r) => setTimeout(r, 400));

  const scanned = net.events.filter((e) => e && e.type === 'scanned');
  ok(net.stats.snapshots > 0, 'snapshots arrived', String(net.stats.snapshots));
  ok(net.scan.targetId !== null, 'the room resolved a target from our aim', String(net.scan.targetId));
  ok(scanned.length >= 1, 'a scan completed over the wire', `${scanned.length}`);
  ok(scanned.length === 0 || scanned[0].name === target.name,
    'and it was the body we aimed at', scanned[0]?.name || '-');
  net.close();
}

console.log(fails.length ? `\nFAIL — ${fails.length} check(s)\n` : '\nPASS — the room decides what was surveyed\n');
process.exit(fails.length ? 1 : 0);
