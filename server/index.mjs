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
import { ProfileStore, captureProfile } from './profiles.js';
import { C, S, TICK_HZ, TICK_DT, SNAPSHOT_EVERY, PROTOCOL_VERSION, decodeInput } from '../src/net/protocol.js';
import { canJump, payJump } from '../src/sim/index.js';

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

const profiles = new ProfileStore(arg('--profiles', '.data/pilots.json'));

/* ------------------------------------------------------------- abuse limits

   Not security — there is no authentication here and a determined client can
   still fly a modified game. These are the cheap floors that stop one socket
   from costing the room everything: an oversized frame, a flood of packets, or
   a name long enough to be a payload in its own right. Input *values* are
   already clamped in `decodeInput`, which is the other half of the same idea. */
const MAX_MESSAGE_BYTES = 4096;
const MAX_MSG_PER_SEC = 120;          // the client sends 30 inputs/s plus a ping
const MAX_NAME = 24;
const MAX_KEY = 128;

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
  // Length-capped and stripped of control characters — the latter because a
  // name is echoed to every other client and printed in the room log, and a
  // carriage return in a log line is how one pilot forges another arrival.
  const CTRL = /[\u0000-\u001f\u007f]/g;
  const clean = (s, max) => (typeof s === 'string'
    ? (s.slice(0, max).replace(CTRL, '') || null)
    : null);

  /* The pilot key identifies a profile. It does NOT authenticate one: whoever
     holds it is that pilot. Written down here as well as in profiles.js
     because it is exactly the sort of thing that gets mistaken for a login
     later. It is also a client-supplied string, so it is length-capped before
     it is used as a map key and never touches a filesystem path. */
  const pilotKey = clean(url.searchParams.get('key'), MAX_KEY);
  const name = clean(url.searchParams.get('name'), MAX_NAME);

  const profile = pilotKey ? profiles.get(pilotKey, name, Date.now()) : null;
  // Resume where they left off, unless the URL asks for somewhere specific.
  const asked = url.searchParams.get('system');
  const wanted = asked !== null ? +asked | 0 : (profile ? profile.system | 0 : 0);
  const systemId = Math.max(0, Math.min(13, wanted));

  const room = roomFor(systemId);
  const player = room.add(name, profile);

  sock.playerId = player.id;
  sock.room = room;
  sock.pilotKey = pilotKey;
  sock.msgWindow = { at: 0, n: 0 };

  send(sock, {
    t: S.WELCOME, v: PROTOCOL_VERSION,
    id: player.id, seed: room.seed, system: systemId,
    // The room's clock. A late joiner has to seek its orbits to this or its
    // planets start at phase zero while everyone else's are hours along.
    tick: room.tick,
    tickHz: TICK_HZ, snapshotEvery: SNAPSHOT_EVERY,
    you: {
      name: player.name,
      // What the archive should already show. A returning pilot's codex is
      // theirs, and rebuilding it from scratch every session would quietly
      // undo the whole point of the store.
      discoveries: [...player.discoveries],
      cantos: [...player.cantos],
      logsFound: [...player.logsFound],
      returning: !!(profile && profile.discoveries?.length),
    },
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name })),
  });
  broadcast(room, { t: S.JOIN, id: player.id, name: player.name }, player.id);
  console.log(`[room ${systemId}] + ${player.name} (${room.players.size} aboard)`);

  sock.on('message', (data) => {
    /* An oversized frame is refused before it is parsed: JSON.parse on a
       megabyte of nesting is the cheapest denial of service there is, and the
       largest thing a legitimate client sends is a couple of hundred bytes. */
    if (data.length > MAX_MESSAGE_BYTES) { sock.close(1009, 'message too large'); return; }

    /* A packet flood is dropped rather than queued. The client sends thirty
       inputs a second and a ping every second; the ceiling is four times that,
       so ordinary jitter never trips it and a runaway loop always does. The
       window is deliberately coarse — this is a floor, not a shaper. */
    const now = Date.now();
    const w = sock.msgWindow;
    if (now - w.at >= 1000) { w.at = now; w.n = 0; }
    if (++w.n > MAX_MSG_PER_SEC) return;

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
    } else if (m.t === C.JUMP) {
      jump(sock, m.system | 0);
    } else if (m.t === C.PING) {
      // Lagged like everything else, or --lag would report a 0 ms round trip
      // on a link it is deliberately delaying.
      const pong = { t: S.PONG, c: m.c, tick: room.tick };
      if (LAG_MS) setTimeout(() => send(sock, pong), LAG_MS * 2);
      else send(sock, pong);
    }
  });

  /* `sock.room`, not the `room` this connection opened in.
     A pilot who folds is moved to another room, and a `bye` closed over the
     original would delete them from the system they left — which they are
     already gone from — and leave them standing in the one they are in, for
     ever. Every disconnect after a jump left a ghost the next arrival could
     see and nobody could remove. */
  const bye = () => {
    const here = sock.room || room;
    // Save before the pilot leaves the room, while the Player still holds
    // everything they earned and we still know which system they were in.
    saveProfile(sock, here, player);
    here.remove(player.id);
    broadcast(here, { t: S.LEAVE, id: player.id });
    console.log(`[room ${here.systemId}] - ${player.name} (${here.players.size} aboard)`);
  };
  sock.on('close', bye);
  sock.on('error', bye);
});

/**
 * Fold a pilot into another system's room.
 *
 * The rule is `canJump` in src/sim, the same one the star map draws on its
 * plate, and the charge is spent here rather than on the client — a client
 * that could spend its own fold charge could also decline to.
 *
 * The Player object moves rooms intact: discoveries, Cantos and the upgrades
 * already on its ship belong to the pilot. Everything keyed to the old room's
 * clock is dropped by `adopt`.
 */
function jump(sock, targetId) {
  const from = sock.room;
  const player = from?.players.get(sock.playerId);
  if (!from || !player) return;

  const refused = canJump(player.ship, from.galaxy, from.systemId, targetId);
  if (refused) {
    send(sock, { t: S.JUMP_DENIED, reason: refused, system: targetId });
    return;
  }

  const cost = payJump(player.ship, from.galaxy, from.systemId, targetId);
  const to = roomFor(targetId);
  // Arriving somewhere new is worth recording: a pilot who drops mid-fold
  // should come back where they landed, not where they set off from.
  saveProfile(sock, to, player);

  from.remove(player.id);
  broadcast(from, { t: S.LEAVE, id: player.id });
  to.adopt(player);
  sock.room = to;
  broadcast(to, { t: S.JOIN, id: player.id, name: player.name }, player.id);

  send(sock, {
    t: S.JUMPED,
    system: targetId,
    systemName: to.stub.name,
    tick: to.tick,
    cost,
    // What the fold actually left in the tank. The charge regenerates every
    // tick, so a client that tried to work this out from a later snapshot
    // would measure the recovery rather than the price.
    charge: player.ship.foldCharge,
    players: [...to.players.values()].map((p) => ({ id: p.id, name: p.name })),
  });
  console.log(`[room ${from.systemId} -> ${targetId}] ${player.name} folded (cost ${(cost * 100) | 0}%)`);
}

/** Write a pilot's progression back to the store. No-op without a key. */
function saveProfile(sock, room, player) {
  if (!sock.pilotKey || !player) return;
  profiles.put(sock.pilotKey, captureProfile(player, room.systemId, Date.now()));
}

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

    // A survey is progress, and progress that only exists in memory is lost to
    // the first crash. The store coalesces its own writes, so flagging here
    // costs nothing per scan.
    for (const s of wss.clients) {
      if (s.room !== room) continue;
      const p = room.players.get(s.playerId);
      if (p?.progressDirty) { p.progressDirty = false; saveProfile(s, room, p); }
    }

    if (!due) continue;
    for (const s of wss.clients) {
      if (s.room !== room || s.readyState !== 1) continue;
      const text = JSON.stringify({ t: S.SNAPSHOT, ...room.snapshot(s.playerId) });
      if (LAG_MS) setTimeout(() => { if (s.readyState === 1) s.send(text); }, LAG_MS);
      else s.send(text);
    }
  }
}, 1000 / TICK_HZ);

process.on('SIGINT', () => {
  console.log('\nshutting down');
  // Every connected pilot, not just the dirty ones: a clean stop should not
  // cost anybody the session they were in the middle of.
  for (const s of wss.clients) {
    const p = s.room?.players.get(s.playerId);
    if (p) saveProfile(s, s.room, p);
  }
  profiles.flush();
  console.log(`[profiles] ${profiles.size} saved`);
  wss.close();
  process.exit(0);
});
