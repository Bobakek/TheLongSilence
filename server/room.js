import {
  createSimWorld, createShipState, engageFold, dropFold,
  positionSystem, stepShip,
} from '../src/sim/index.js';
import { TICK_DT, encodeShip } from '../src/net/protocol.js';

/* ============================================================================
   One system, one room, one clock.

   The room owns every ship in it and steps them all on the same fixed tick.
   Nothing here renders, and nothing here knows what a socket is — it takes
   inputs and produces snapshots, which is what makes it testable without a
   network and portable to a Durable Object without a rewrite.

   ---------------------------------------------------------- what is shared

   The bodies are generated, not replicated. The room and every client run
   `createSimWorld(seed, systemId)` and get byte-identical stars, orbits and
   radii — that is what M0 measured — so the only thing that ever crosses the
   wire is the ships. A hundred-body system costs zero bandwidth.

   Orbits advance here as well as on each client. They have to: the envelope
   and the fold ceiling are decided against body positions, and a room whose
   planets sat still would push ships out of thin air.

   ------------------------------------------------------------ what is fixed

   The tick is fixed at 30 Hz and never varies with wall-clock drift. A
   variable dt would make the same input produce different flight depending on
   how loaded the server was, which is exactly the property M0 spent its time
   removing.
   ========================================================================== */

/* The envelope wants a host with four members. On a client that host is the
   `Game`; here each player gets one of these. The autopilot does not exist
   server-side yet — M1 has no autopilot — but the fold drop absolutely does,
   because it bleeds off velocity and therefore decides where the ship ends up. */
class PlayerHost {
  constructor(player) {
    this.player = player;
    this.shake = 0;              // written by the envelope, thrown away here
    this.proximityWarn = null;
    this.events = player.events;
  }

  cancelAutopilot() { this.events.push('autopilotOff'); }

  setFold(on) {
    const s = this.player.ship;
    if (on) engageFold(s); else dropFold(s);
    this.events.push(on ? 'foldOn' : 'foldOff');
  }
}

let nextPlayerId = 1;

/* How many un-consumed inputs a player may bank.
 *
 * A jitter cushion, not a buffer for its own sake: packets arrive in clumps and
 * a queue that empties makes the server repeat an input the client never sent
 * twice, which the client cannot reproduce and therefore cannot predict. Two
 * deep absorbs ordinary jitter; past the cap the player is running ahead of the
 * room and the extras are consumed two-a-tick rather than piling into latency
 * the pilot can feel. */
const QUEUE_TARGET = 2;
const QUEUE_MAX = 8;

export class Player {
  constructor(name) {
    this.id = nextPlayerId++;
    this.name = name || `PILOT-${this.id}`;
    this.ship = createShipState();
    this.queue = [];
    this.lastCmd = {
      seq: 0,
      raw: { pitch: 0, yaw: 0, roll: 0, strafeX: 0, strafeY: 0, throttleDelta: 0, boost: 0 },
      buttons: 0,
    };
    this.prevButtons = 0;
    this.lastSeq = 0;         // last input actually consumed by a tick
    this.seenSeq = 0;         // last input accepted off the wire
    this.events = [];
    this.primed = false;      // has the jitter cushion filled at least once?
    this.starved = 0;         // ticks with nothing to consume, since last snapshot
    this.dropped = 0;         // inputs discarded because the player ran too far ahead
    this.host = new PlayerHost(this);
  }

  enqueue(cmd) {
    this.queue.push(cmd);
    while (this.queue.length > QUEUE_MAX) { this.queue.shift(); this.dropped++; }
  }

  /**
   * The command for this tick.
   *
   * Exactly one input per tick is what makes reconciliation possible at all:
   * the client replays the same packets in the same order and must land on the
   * same state, which it cannot do if the server applied one of them twice.
   * When the queue runs dry the last command is held — the honest thing for a
   * pilot whose stick has not changed — and counted, because a client that is
   * being starved is a client whose prediction will be corrected and which
   * deserves to know why.
   */
  take() {
    /* Wait for a cushion before consuming anything, and go back to waiting if
       it ever runs out.
       Without this the queue sits at zero or one and ordinary network jitter
       empties it, at which point the room repeats a command the client sent
       once — a tick of motion the client never predicted and cannot replay.
       Measured at six starvations in eight seconds on a loopback with no loss.
       The cushion costs a fixed ~66 ms of input latency, which prediction hides
       completely, and buys an input stream the client can actually reproduce. */
    if (!this.primed) {
      if (this.queue.length < QUEUE_TARGET) { this.starved++; return this.lastCmd; }
      this.primed = true;
    }
    if (this.queue.length > QUEUE_TARGET + 2) this.queue.shift();   // running ahead
    const cmd = this.queue.shift();
    if (!cmd) { this.starved++; this.primed = false; return this.lastCmd; }
    this.lastCmd = cmd;
    this.lastSeq = cmd.seq;
    return cmd;
  }
}

export class Room {
  constructor({ seed, systemId = 0 }) {
    this.seed = seed;
    this.systemId = systemId;
    const world = createSimWorld(seed, systemId);
    this.bodies = world.bodies;
    this.stub = world.stub;
    this.sys = world.sys;
    this.players = new Map();
    this.tick = 0;
  }

  add(name) {
    const p = new Player(name);
    this.spawn(p);
    this.players.set(p.id, p);
    return p;
  }

  remove(id) { this.players.delete(id); }

  /**
   * Put a new arrival somewhere legal.
   *
   * Deliberately not the single-player spawn: `Game.pose()` frames a body for
   * the camera, and dropping every pilot on the same mark would stack them
   * inside one another. Fanning them round a ring by id is enough for M1 and
   * keeps everyone outside the approach envelope.
   */
  spawn(p) {
    const planet = this.bodies.find((b) => b.kind === 'planet') || this.bodies[0];
    const a = p.id * 2.399963;                      // golden angle, so ids spread
    const r = planet.radius * 4.0;
    p.ship.absPos.set(
      planet.absPos.x + Math.cos(a) * r,
      planet.absPos.y + Math.sin(a * 0.7) * r * 0.25,
      planet.absPos.z + Math.sin(a) * r,
    );
    p.ship.vel.set(0, 0, 0);
  }

  /** One authoritative step for everybody, through the shared stepper. */
  step(dt = TICK_DT) {
    this.tick++;
    positionSystem(this.bodies, dt);

    for (const p of this.players.values()) {
      const cmd = p.take();
      stepShip(p.ship, this.bodies, dt,
        { raw: cmd.raw, buttons: cmd.buttons, prevButtons: p.prevButtons }, p.host);
      p.prevButtons = cmd.buttons;
    }
  }

  /** What a given player is told. `you` is separated so M2 can reconcile it. */
  snapshot(forId) {
    const me = this.players.get(forId);
    const others = [];
    for (const p of this.players.values()) {
      if (p.id === forId) continue;
      others.push(encodeShip(p.id, p.ship));
    }
    const out = {
      tick: this.tick,
      you: me
        ? {
          ...encodeShip(me.id, me.ship),
          ack: me.lastSeq,
          /* Diagnostics the client cannot work out for itself. Starvation is
             the one thing that makes a correct prediction wrong, so it is
             reported rather than hidden.

             These names are prefixed and must stay clear of `encodeShip`'s.
             The queue depth was called `q` here, which is also the quaternion,
             and being second in the literal it won: every client read its
             orientation out of an integer, got undefined, and filled its ship
             with NaN. One letter, and the whole simulation. */
          st: me.starved, qd: me.queue.length, dr: me.dropped,
        }
        : null,
      others,
    };
    if (me) { me.starved = 0; me.dropped = 0; }
    if (me && me.events.length) { out.ev = me.events.slice(); me.events.length = 0; }
    return out;
  }

  get info() {
    return {
      seed: this.seed, system: this.systemId, systemName: this.stub.name,
      bodies: this.bodies.length, players: this.players.size, tick: this.tick,
    };
  }
}
