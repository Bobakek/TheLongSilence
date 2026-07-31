// M2 acceptance: does the client predict the room, or only guess at it?
//
//   node server/index.mjs --lag 75 &
//   node tools/predictcheck.mjs [--seconds 12] [--url ws://localhost:8787]
//
// The measurement is the *correction*: how far the predicted ship has to move
// when the server's answer arrives and the unacknowledged inputs are replayed.
// If both sides run the same rules on the same inputs, that number is zero —
// not "small for the latency", zero — because latency changes *when* the answer
// arrives, not what it is. So this test is latency-independent by construction,
// and that is exactly why it is a good test: a non-zero correction means the two
// step paths differ, and the size of it says how badly.
//
// What it therefore catches: a client stepping on render dt instead of the
// server's tick, a missing fold drop in the envelope host, boost read from the
// wrong field, an input applied twice, orbits running on the client's own clock.
// Every one of those was a real possibility in this design.

import { NetClient } from '../src/net/Client.js';
import { createSimWorld, createShipState } from '../src/sim/index.js';
import { TICK_HZ } from '../src/net/protocol.js';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

const URL_ = arg('--url', 'ws://localhost:8787');
const SECONDS = +arg('--seconds', 12);
const SEED = +arg('--seed', 20260725);

/* A unit is a kilometre. A tenth of one is the length of the ship, so anything
   under a millimetre is float noise and anything over it is a rule that
   differs. The bar is deliberately far below "looks fine". */
const TOLERANCE = 1e-3;

const net = new NetClient(URL_, { system: 0, name: 'PREDICT' });
const welcome = await net.connect();
if (welcome.seed !== SEED) {
  console.error(`server seed ${welcome.seed} != ${SEED}; start it with --seed ${SEED}`);
  process.exit(2);
}

const { bodies } = createSimWorld(welcome.seed, welcome.system);
const ship = createShipState();
net.attach(bodies, ship);

console.log(`connected as pilot ${welcome.id} · room tick ${welcome.tick} · ${TICK_HZ}Hz`);
console.log(`flying ${SECONDS}s\n`);

/* Scripted, and varied on purpose: a ship droning in a straight line exercises
   almost none of the model. This turns, boosts, presses the fold and gets
   refused, and spends time inside the approach envelope. */
let t = 0;
let folds = 0;
const sample = () => {
  const raw = {
    pitch: Math.sin(t * 0.9) * 0.8,
    yaw: Math.cos(t * 0.6 + 1) * 0.7,
    roll: Math.sin(t * 1.7) * 0.4,
    strafeX: (Math.floor(t) % 5 === 0) ? 0.8 : 0,
    strafeY: (Math.floor(t) % 7 === 0) ? -0.6 : 0,
    throttleDelta: 1,
    boost: (Math.floor(t) % 4 === 3) ? 1 : 0,
  };
  // a fold press roughly every two seconds, one step wide
  let buttons = net.takeButtons() | (raw.boost ? 2 : 0);
  if (Math.floor(t * 2) % 4 === 3 && folds !== Math.floor(t * 2)) {
    folds = Math.floor(t * 2);
    buttons |= 1;
  }
  return { raw, buttons };
};

const corrections = [];
let lastCorrCount = 0;

const trace = [];
if (argv.includes('--trace')) {
  net.onCorrection = (c) => { if (trace.length < 40) trace.push(c); };
}

const t0 = Date.now();
let prev = Date.now();
await new Promise((done) => {
  const iv = setInterval(() => {
    const now = Date.now();
    const dt = (now - prev) / 1000;
    prev = now;
    t = (now - t0) / 1000;
    net.update(dt, sample);
    if (net.stats.errorSamples > lastCorrCount) {
      lastCorrCount = net.stats.errorSamples;
      corrections.push(net.stats.predictionError);
    }
    if (t >= SECONDS) { clearInterval(iv); done(); }
  }, 1000 / 60);
});

await new Promise((r) => setTimeout(r, 300));
net.close();

/* ------------------------------------------------------------------ report */

const s = net.stats;
const settled = corrections.slice(2);          // the first snapshots place the ship
const mean = settled.length ? settled.reduce((a, b) => a + b, 0) / settled.length : 0;
const max = settled.length ? Math.max(...settled) : 0;
const over = settled.filter((c) => c > TOLERANCE).length;

console.log(`steps predicted     ${s.steps}`);
console.log(`inputs sent         ${s.sent}`);
console.log(`snapshots           ${s.snapshots}`);
console.log(`ticks replayed      ${s.replays}  (${(s.replays / Math.max(1, s.snapshots)).toFixed(1)} per snapshot)`);
console.log(`unacked inputs      ${s.pending}   server queue ${s.serverQueue}`);
console.log(`server starved      ${s.starved}   dropped ${s.dropped}`);
console.log(`measured RTT        ${s.rttMs} ms`);
console.log('');
console.log(`prediction error mean  ${fmt(mean)} units`);
console.log(`prediction error max   ${fmt(max)} units`);
console.log(`errors > ${TOLERANCE}       ${over} of ${settled.length}`);
console.log(`re-seat jump (max)     ${fmt(s.maxCorrection)} units  ` +
  `— the ship catching up over ${(s.replays / Math.max(1, s.snapshots)).toFixed(1)} unacked ticks, not an error`);
console.log(`first 12            ${settled.slice(0, 12).map(fmt).join('  ')}`);
console.log(`last 6              ${settled.slice(-6).map(fmt).join('  ')}`);

function fmt(n) {
  if (!Number.isFinite(n)) return String(n);
  return n === 0 ? '0' : (Math.abs(n) < 1e-4 ? n.toExponential(2) : n.toFixed(6));
}

if (trace.length) {
  console.log('\n  err        ack   srvTick  cTick->  acked  replay  starv  q   speed');
  for (const c of trace.slice(0, 30)) {
    console.log(`  ${fmt(c.err).padEnd(10)} ${String(c.ack).padStart(4)} `
      + `${String(c.serverTick).padStart(8)} ${String(c.clientTickWas).padStart(5)}->${String(c.clientTickNow).padEnd(5)} `
      + `${String(c.droppedFromBuffer).padStart(5)} ${String(c.replayed).padStart(6)} `
      + `${String(c.starved).padStart(5)} ${String(c.queue).padStart(2)}  ${c.speed.toFixed(2)}`);
  }
}

const fails = [];
if (!s.snapshots) fails.push('no snapshots arrived');
if (!s.steps) fails.push('nothing was predicted');
if (s.replays === 0) fails.push('nothing was ever replayed — the input buffer is not filling, so prediction is not being tested');
/* NaN first, and explicitly. `NaN > tolerance` is false, so a comparison-only
   check reports PASS on a simulation that has come apart entirely — which is
   what this test did on its first run, while printing "64 of 152" corrections
   over tolerance three lines above the word PASS. */
if (!Number.isFinite(max)) fails.push('correction is not a finite number — the prediction produced NaN');
else if (max > TOLERANCE) fails.push(`correction ${fmt(max)} exceeds ${TOLERANCE} — client and server are not running the same rules`);
if (over > 0) fails.push(`${over} of ${settled.length} corrections exceeded ${TOLERANCE}`);
if (s.starved > s.snapshots * 0.5) fails.push(`server starved ${s.starved} times — the client is not keeping the queue fed`);

console.log(fails.length ? `\nFAIL\n  ${fails.join('\n  ')}\n` : '\nPASS — the client predicts the room exactly\n');
process.exit(fails.length ? 1 : 0);
