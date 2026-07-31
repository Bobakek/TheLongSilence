// Headless pilots that just fly, so there is somebody else in the room.
//
//   node tools/netbot.mjs [--n 1] [--url ws://localhost:8787] [--system 0]
//
// Used two ways: as the other player while testing the browser client by hand,
// and — with a large --n — as the load generator M1's interest management has
// to be measured against. It prints a line a second so it is obvious it is
// still alive; Ctrl-C to stop.

import { BTN, encodeInput, TICK_HZ } from '../src/net/protocol.js';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

const URL_ = arg('--url', 'ws://localhost:8787');
const SYSTEM = +arg('--system', 0);
const N = +arg('--n', 1);

const bots = [];

for (let i = 0; i < N; i++) {
  const name = `BOT-${i}`;
  const ws = new WebSocket(`${URL_}/?system=${SYSTEM}&name=${name}`);
  const bot = { i, name, ws, seq: 0, id: null, snaps: 0, pos: null, others: 0 };
  bots.push(bot);

  ws.onopen = () => console.log(`${name} connected`);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'welcome') { bot.id = m.id; console.log(`${name} is pilot ${m.id}`); }
    else if (m.t === 'snap') {
      bot.snaps++;
      if (m.you) bot.pos = m.you.p;
      bot.others = m.others.length;
    }
  };
  ws.onerror = (e) => console.error(`${name} error`, e.message || e);
  ws.onclose = () => console.log(`${name} disconnected`);
}

const t0 = Date.now();
setInterval(() => {
  const t = (Date.now() - t0) / 1000;
  for (const b of bots) {
    if (b.ws.readyState !== 1) continue;
    // A slow figure of its own per bot, so they do not fly in formation and
    // the beacons on screen are visibly separate objects.
    const raw = {
      pitch: Math.sin(t * 0.31 + b.i * 1.7) * 0.55,
      yaw: Math.cos(t * 0.23 + b.i * 2.3) * 0.45,
      roll: 0, strafeX: 0, strafeY: 0,
      throttleDelta: 1,
    };
    b.ws.send(encodeInput(++b.seq, raw, 0));
  }
}, 1000 / TICK_HZ);

setInterval(() => {
  const b = bots[0];
  if (!b || !b.pos) return;
  console.log(`t=${((Date.now() - t0) / 1000).toFixed(0)}s  pilot ${b.id}  `
    + `pos ${b.pos.map((n) => Math.round(n)).join(',')}  snaps ${b.snaps}  sees ${b.others}`);
}, 5000);

process.on('SIGINT', () => { for (const b of bots) b.ws.close(); process.exit(0); });
