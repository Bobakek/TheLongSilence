// M1 acceptance: does the room actually hold several pilots on one clock?
//
//   node server/index.mjs &
//   node tools/netcheck.mjs [--clients 3] [--seconds 6] [--url ws://localhost:8787]
//
// Headless clients on Node's built-in WebSocket. They fly scripted input and
// then check the things M1 is supposed to establish:
//
//   · everyone gets a distinct id and sees everyone else
//   · snapshots arrive at the advertised rate
//   · the position a client is told about itself is the same position the
//     other clients are told about it — one authority, one answer
//   · the ship actually moves, and the fold is refused where it should be
//
// It deliberately does NOT check that a client can predict the server. There is
// no prediction in M1; that is the whole of M2.

import { C, S, BTN, encodeInput, TICK_HZ, SNAPSHOT_EVERY } from '../src/net/protocol.js';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

const URL_ = arg('--url', 'ws://localhost:8787');
const N = +arg('--clients', 3);
const SECONDS = +arg('--seconds', 6);
const SEND_HZ = 30;

class Probe {
  constructor(i) {
    this.i = i;
    this.name = `PROBE-${i}`;
    this.seq = 0;
    this.id = null;
    this.welcome = null;
    this.snaps = 0;
    this.events = [];
    this.seen = new Map();        // id -> last position we were told
    this.mine = null;             // our own last position, per the server
    this.firstMine = null;
    this.ready = new Promise((r) => { this._ready = r; });
  }

  connect() {
    const ws = this.ws = new WebSocket(`${URL_}/?system=0&name=${this.name}`);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === S.WELCOME) { this.id = m.id; this.welcome = m; this._ready(); }
      else if (m.t === S.SNAPSHOT) {
        this.snaps++;
        if (m.you) {
          this.mine = m.you.p;
          if (!this.firstMine) this.firstMine = m.you.p;
        }
        for (const o of m.others) this.seen.set(o.id, o.p);
        if (m.ev) this.events.push(...m.ev);
      }
    };
    ws.onerror = () => {};
    return this.ready;
  }

  /* Scripted flight, different per client so they do not overlap. Client 0
     asks for the fold on a fixed count — a time-window test ("the first frame
     of every odd second") sounds equivalent and is not: with timer jitter the
     window is missed more often than it is hit, and the check passed or failed
     depending on the machine. */
  tickInput(t) {
    const raw = {
      pitch: this.i === 0 ? 0 : Math.sin(t * 0.7 + this.i) * 0.6,
      yaw: this.i === 0 ? 0 : Math.cos(t * 0.5 + this.i * 2) * 0.5,
      roll: 0, strafeX: 0, strafeY: 0,
      throttleDelta: 1,
    };
    let btn = 0;
    // one press, held a single packet, every 45 sends — and the button is
    // edge-triggered server-side, so holding it would do nothing anyway
    if (this.i === 0 && this.seq % 45 === 44) btn |= BTN.FOLD;
    this.ws.send(encodeInput(++this.seq, raw, btn));
  }
}

const probes = Array.from({ length: N }, (_, i) => new Probe(i));
await Promise.all(probes.map((p) => p.connect()));
console.log(`connected ${N} probes to ${URL_}`);
console.log(`server: seed ${probes[0].welcome.seed} · system ${probes[0].welcome.system} `
  + `· ${probes[0].welcome.tickHz}Hz tick\n`);

const t0 = Date.now();
await new Promise((done) => {
  const iv = setInterval(() => {
    const t = (Date.now() - t0) / 1000;
    for (const p of probes) p.tickInput(t);
    if (t >= SECONDS) { clearInterval(iv); done(); }
  }, 1000 / SEND_HZ);
});

// let the last snapshots land
await new Promise((r) => setTimeout(r, 300));

/* ------------------------------------------------------------------ checks */

const fails = [];
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) fails.push(label);
};

console.log('checks');

const ids = probes.map((p) => p.id);
ok(new Set(ids).size === N, 'every probe got a distinct id', `[${ids}]`);

const expected = SECONDS * (TICK_HZ / SNAPSHOT_EVERY);
for (const p of probes) {
  const ratio = p.snaps / expected;
  ok(ratio > 0.8 && ratio < 1.25, `probe ${p.i} snapshot rate`,
    `${p.snaps} in ${SECONDS}s (expected ~${expected})`);
}

/* "Sees at least the other probes", not "sees exactly N-1". The room is a
   shared place and a browser can join it while this is running — which it did,
   and the strict form failed on a server that was working perfectly. A check
   that assumes it is alone in a multiplayer room is testing the wrong thing. */
const probeIds = new Set(ids);
for (const p of probes) {
  const sawProbes = [...p.seen.keys()].filter((id) => probeIds.has(id));
  const extra = p.seen.size - sawProbes.length;
  ok(sawProbes.length === N - 1, `probe ${p.i} sees the other ${N - 1} probes`,
    `saw ${[...p.seen.keys()]}${extra ? ` (${extra} other occupant(s))` : ''}`);
}

// One authority: what A is told about itself must be what B is told about A.
let worst = 0;
for (const p of probes) {
  for (const q of probes) {
    if (p === q) continue;
    const theirView = q.seen.get(p.id);
    if (!theirView || !p.mine) continue;
    const d = Math.hypot(theirView[0] - p.mine[0], theirView[1] - p.mine[1], theirView[2] - p.mine[2]);
    if (d > worst) worst = d;
  }
}
/* Not zero: snapshots for different sockets are built from the same tick, but
   a client's own view and its neighbour's arrive in different frames, so this
   is bounded by one tick of travel, not by disagreement. At 60 km/s that is
   two kilometres. */
ok(worst < 5000, 'all clients agree on where each ship is', `max ${worst.toFixed(1)} units apart`);

for (const p of probes) {
  const moved = p.firstMine && p.mine
    ? Math.hypot(p.mine[0] - p.firstMine[0], p.mine[1] - p.firstMine[1], p.mine[2] - p.firstMine[2])
    : 0;
  ok(moved > 1, `probe ${p.i} actually flew`, `${moved.toFixed(1)} units`);
}

const refusals = probes[0].events.filter((e) => e.startsWith('foldRefused')).length;
const folds = probes[0].events.filter((e) => e === 'foldOn' || e === 'foldOff').length;
ok(refusals + folds > 0, 'the fold was exercised on the server',
  `${refusals} refused, ${folds} state changes`);

for (const p of probes) p.ws.close();
console.log(fails.length ? `\nFAIL — ${fails.length} check(s)\n` : '\nPASS — M1 transport holds\n');
process.exit(fails.length ? 1 : 0);
