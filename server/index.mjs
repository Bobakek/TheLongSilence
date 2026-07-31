// M1: the authoritative room, on a socket.
//
//   node server/index.mjs                 port 8787, one room per system
//   node server/index.mjs --port 9000
//   node server/index.mjs --seed 20260725
//
// Connect with  ws://localhost:8787/?system=0
//
// This is a *development* server: one process, one machine, no auth, no
// persistence, no TLS. It exists to prove the transport, the fixed clock and
// the snapshot shape. The plan's target is a Durable Object per system, and
// `Room` was written to move there unchanged — everything Cloudflare-specific
// would live in this file and nowhere else.

import { WebSocketServer } from 'ws';
import { Room } from './room.js';
import { C, S, TICK_HZ, TICK_DT, SNAPSHOT_EVERY, PROTOCOL_VERSION, decodeInput } from '../src/net/protocol.js';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};

const PORT = +arg('--port', 8787);
const SEED = +arg('--seed', 20260725);

/* Artificial one-way latency, for testing prediction against something other
   than a loopback. Applied to inputs on the way in and snapshots on the way
   out, so --lag 75 is a 150 ms round trip. Localhost is about 0 ms and proves
   nothing: prediction that only works at zero latency is not prediction. */
const LAG_MS = +arg('--lag', 0);

const rooms = new Map();
function roomFor(systemId) {
  if (!rooms.has(systemId)) {
    const r = new Room({ seed: SEED, systemId });
    rooms.set(systemId, r);
    console.log(`[room ${systemId}] ${r.stub.name} · ${r.bodies.length} bodies`);
  }
  return rooms.get(systemId);
}

const wss = new WebSocketServer({ port: PORT });
console.log(`THE LONG SILENCE · authoritative room server`);
console.log(`ws://localhost:${PORT}  seed ${SEED}  tick ${TICK_HZ}Hz  snapshot ${TICK_HZ / SNAPSHOT_EVERY}Hz`
  + (LAG_MS ? `  simulated lag ${LAG_MS}ms each way (${LAG_MS * 2}ms RTT)` : '') + '\n');

wss.on('connection', (sock, req) => {
  const url = new URL(req.url, 'http://x');
  const systemId = Math.max(0, Math.min(13, +(url.searchParams.get('system') || 0) | 0));
  const room = roomFor(systemId);
  const player = room.add(url.searchParams.get('name'));

  sock.playerId = player.id;
  sock.room = room;

  send(sock, {
    t: S.WELCOME, v: PROTOCOL_VERSION,
    id: player.id, seed: room.seed, system: systemId,
    // The room's clock. A late joiner has to seek its orbits to this or its
    // planets start at phase zero while everyone else's are hours along.
    tick: room.tick,
    tickHz: TICK_HZ, snapshotEvery: SNAPSHOT_EVERY,
    you: { name: player.name },
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name })),
  });
  broadcast(room, { t: S.JOIN, id: player.id, name: player.name }, player.id);
  console.log(`[room ${systemId}] + ${player.name} (${room.players.size} aboard)`);

  sock.on('message', (data) => {
    let m;
    // A client that sends rubbish gets ignored, not a crashed room.
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === C.INPUT) {
      const cmd = decodeInput(m);
      /* Stale and duplicate packets are dropped rather than queued. UDP-style
         reordering does not happen on a WebSocket, but a reconnecting client
         restarting its sequence would otherwise rewind the ship. */
      if (cmd.seq <= player.seenSeq) return;
      player.seenSeq = cmd.seq;
      if (LAG_MS) setTimeout(() => player.enqueue(cmd), LAG_MS);
      else player.enqueue(cmd);
    } else if (m.t === C.PING) {
      // Lagged like everything else, or --lag would report a 0 ms round trip
      // on a link it is deliberately delaying.
      const pong = { t: S.PONG, c: m.c, tick: room.tick };
      if (LAG_MS) setTimeout(() => send(sock, pong), LAG_MS * 2);
      else send(sock, pong);
    }
  });

  const bye = () => {
    room.remove(player.id);
    broadcast(room, { t: S.LEAVE, id: player.id });
    console.log(`[room ${systemId}] - ${player.name} (${room.players.size} aboard)`);
  };
  sock.on('close', bye);
  sock.on('error', bye);
});

function send(sock, obj) {
  if (sock.readyState === 1) sock.send(JSON.stringify(obj));
}

function broadcast(room, obj, exceptId) {
  const text = JSON.stringify(obj);
  for (const s of wss.clients) {
    if (s.room !== room || s.readyState !== 1) continue;
    if (exceptId !== undefined && s.playerId === exceptId) continue;
    s.send(text);
  }
}

/* The clock.
 *
 * setInterval drifts, so the loop catches up on accumulated real time rather
 * than assuming one tick per callback — but it steps a *fixed* dt every time,
 * because a variable one would make the same input fly differently on a loaded
 * machine. The catch-up is capped: after a long stall it is better to lose time
 * than to spend a minute simulating it and stall further. */
const MAX_CATCHUP = 5;
let last = process.hrtime.bigint();
let acc = 0;
let sinceSnapshot = 0;

setInterval(() => {
  const now = process.hrtime.bigint();
  acc += Number(now - last) / 1e9;
  last = now;

  let steps = 0;
  while (acc >= TICK_DT && steps < MAX_CATCHUP) { acc -= TICK_DT; steps++; }
  if (steps === MAX_CATCHUP) acc = 0;
  if (!steps) return;

  /* Count the ticks since the last broadcast rather than testing `tick` for
     parity. Windows timers land around 15 ms, so a 33 ms interval routinely
     fires late and the catch-up runs two ticks in one callback — which leaves
     the parity of `tick` unchanged, so a `tick % 2` test either fires every
     callback or never fires again depending on which side it started. Measured
     11.5 snapshots a second against an advertised 15. */
  sinceSnapshot += steps;
  const due = sinceSnapshot >= SNAPSHOT_EVERY;
  if (due) sinceSnapshot = 0;

  for (const room of rooms.values()) {
    for (let i = 0; i < steps; i++) room.step(TICK_DT);
    if (!due) continue;
    for (const s of wss.clients) {
      if (s.room !== room || s.readyState !== 1) continue;
      const text = JSON.stringify({ t: S.SNAPSHOT, ...room.snapshot(s.playerId) });
      if (LAG_MS) setTimeout(() => { if (s.readyState === 1) s.send(text); }, LAG_MS);
      else s.send(text);
    }
  }
}, 1000 / TICK_HZ);

process.on('SIGINT', () => { console.log('\nshutting down'); wss.close(); process.exit(0); });
