// M4 acceptance: does a pilot come back as themselves?
//
//   node server/index.mjs --profiles .data/test-pilots.json &
//   node tools/persistcheck.mjs
//
// Connect with a key, earn something, disconnect, reconnect with the same key.
// The Cantos, the discoveries and the upgraded drive have to still be there;
// the position and the fold charge must not be, because a saved velocity is a
// saved accident.
//
// Also checks the floors added with the store: an oversized frame, a packet
// flood and a control character in a name. None of that is security — there is
// no authentication here — but one socket should not be able to cost the room
// everything.

import * as THREE from 'three';
import { NetClient } from '../src/net/Client.js';
import { createSimWorld, createShipState } from '../src/sim/index.js';
import { BTN } from '../src/net/protocol.js';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const URL_ = arg('--url', 'ws://localhost:8787');

const fails = [];
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) fails.push(label);
};
const CTRL = /[\u0000-\u001f\u007f]/;
const UP = new THREE.Vector3(0, 1, 0);
const NEUTRAL = { pitch: 0, yaw: 0, roll: 0, strafeX: 0, strafeY: 0, throttleDelta: 0, boost: 0 };
const KEY = `test-pilot-${process.pid}`;

function drive(net, ms, sample) {
  return new Promise((done) => {
    const t0 = Date.now(); let prev = t0;
    const iv = setInterval(() => {
      const now = Date.now();
      net.update((now - prev) / 1000, sample);
      prev = now;
      if (now - t0 >= ms) { clearInterval(iv); done(); }
    }, 1000 / 60);
  });
}

/** Connect, survey the planet we spawn beside, return what the room said. */
async function session(label, { scan = true, seconds = 8 } = {}) {
  const net = new NetClient(URL_, { name: label, key: KEY });
  const w = await net.connect();
  const { bodies } = createSimWorld(w.seed, w.system);
  const ship = createShipState();
  net.attach(bodies, ship);
  await new Promise((r) => setTimeout(r, 600));

  const planet = bodies.find((b) => b.kind === 'planet');
  const aim = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(ship.absPos, planet.absPos, UP));
  await drive(net, seconds * 1000, () => ({ raw: NEUTRAL, buttons: scan ? BTN.SCAN : 0, aim }));
  await new Promise((r) => setTimeout(r, 300));

  const out = {
    welcome: w,
    scanned: net.events.filter((e) => e && e.type === 'scanned'),
    ship: net.authoritative,
    pos: net.authoritative ? [...net.authoritative.p] : null,
  };
  net.close();
  await new Promise((r) => setTimeout(r, 400));   // let the server save
  return out;
}

console.log(`pilot key ${KEY}\n`);
console.log('checks');

const first = await session('PERSIST-1');
ok(first.welcome.you?.returning === false || !first.welcome.you?.returning,
  'a new key starts with an empty archive', String(first.welcome.you?.returning));
ok(first.scanned.length >= 1, 'surveyed something in the first session', `${first.scanned.length}`);
const earned = first.welcome.system;
const firstPos = first.pos;

const second = await session('PERSIST-2', { scan: false, seconds: 3 });
ok(second.welcome.you?.returning === true, 'the second session is recognised as returning',
  String(second.welcome.you?.returning));
ok((second.welcome.you?.discoveries || []).length >= 1,
  'the discoveries came back', `${(second.welcome.you?.discoveries || []).length}`);
ok(second.welcome.system === earned, 'and so did the system they left off in',
  `${second.welcome.system}`);
ok(second.scanned.length === 0, 'a body already surveyed is not surveyed again',
  `${second.scanned.length}`);

const moved = firstPos && second.pos
  ? Math.hypot(firstPos[0] - second.pos[0], firstPos[1] - second.pos[1], firstPos[2] - second.pos[2])
  : 0;
ok(moved > 0, 'the ship was placed fresh rather than restored where it drifted',
  `${moved.toFixed(1)} units from the old spot`);

// a different key must be a different pilot
const otherNet = new NetClient(URL_, { name: 'STRANGER', key: `other-${process.pid}` });
const ow = await otherNet.connect();
ok(!ow.you?.returning && (ow.you?.discoveries || []).length === 0,
  'a different key is a different pilot', `${(ow.you?.discoveries || []).length} discoveries`);
otherNet.close();

/* ------------------------------------------------------------------ floors */

console.log('\nfloors');

// oversized frame: the socket should be closed, not the room
const big = new NetClient(URL_, { name: 'BIG', key: `big-${process.pid}` });
await big.connect();
let closed = false;
big.ws.addEventListener('close', () => { closed = true; });
big.ws.send(JSON.stringify({ t: 'in', seq: 1, pad: 'x'.repeat(8192) }));
await new Promise((r) => setTimeout(r, 800));
ok(closed, 'an oversized frame closes that socket', String(closed));

// flood: the server must stay up and keep serving everyone else
const flood = new NetClient(URL_, { name: 'FLOOD', key: `flood-${process.pid}` });
await flood.connect();
for (let i = 0; i < 600; i++) flood.ws.send(JSON.stringify({ t: 'ping', c: i }));
await new Promise((r) => setTimeout(r, 800));
const after = new NetClient(URL_, { name: 'AFTER', key: `after-${process.pid}` });
const aw = await after.connect();
ok(!!aw && aw.id > 0, 'the room still accepts connections after a flood', `id ${aw?.id}`);
flood.close(); after.close();

// control characters in a name must not reach the log or other clients
const nasty = new NetClient(URL_, { name: 'EVIL\r\n[room 0] + ADMIN', key: `evil-${process.pid}` });
const nw = await nasty.connect();
ok(!CTRL.test(nw.you?.name || ''), 'control characters are stripped from names',
  JSON.stringify(nw.you?.name));
nasty.close();

console.log(fails.length ? `\nFAIL — ${fails.length} check(s)\n` : '\nPASS — pilots persist, and one socket cannot spoil the room\n');
process.exit(fails.length ? 1 : 0);
