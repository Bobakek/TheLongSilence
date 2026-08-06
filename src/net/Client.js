import * as THREE from 'three';
import { createShipState, stepShip, createQuietHost, seekSystem } from '../sim/index.js';
import {
  C, S, BTN, TICK_DT, TICK_HZ, SNAPSHOT_EVERY, PROTOCOL_VERSION,
  encodeInput, quantizeInput, emptyInput,
} from './protocol.js';

/* ============================================================================
   Predict, and be corrected.

   M1 snapped the local ship to whatever the server last said, so your own ship
   lagged your hand by a round trip. M2 removes that lag without giving up
   authority: the client runs the *same* `stepShip` on the *same* inputs and
   shows the result immediately, then checks itself against the server and
   replays the difference.

   ------------------------------------------------------------- the fixed step

   Prediction only works if both sides integrate identically, and that means
   the client cannot step on its render dt — a 144 Hz machine and a 30 Hz room
   would disagree on every frame, permanently, and reconciliation would spend
   its life papering over the difference. So the client accumulates real time
   and steps in whole `TICK_DT` units, exactly as the server does, sending one
   packet per step. Frames in between reuse the last predicted state.

   -------------------------------------------------------------- reconciling

   Every input is kept until the server admits to having consumed it. When a
   snapshot arrives carrying `ack`:

     1. drop everything up to and including `ack` — that is settled history
     2. overwrite the predicted ship with the authoritative one
     3. replay what is left, advancing the world one tick per input

   If the client is right, step 3 lands exactly where it already was and the
   correction is zero. The correction is therefore not just a fix, it is the
   *measurement*: `stats.correction` is how wrong the prediction was, in world
   units, and if it is not near zero something in the two step paths differs.

   ----------------------------------------------------------------- the world

   Bodies are seeked, never free-run. The envelope is decided against planet
   positions, so a client whose orbits were a few ticks ahead would be pushed
   by a planet the server has somewhere else. `seekSystem` puts them at an
   absolute time, which also means a client joining an hour-old room starts
   with everything where the room has it rather than at phase zero.
   ========================================================================== */

/** How far behind the newest snapshot remote ships are drawn. */
const INTERP_DELAY = (SNAPSHOT_EVERY / TICK_HZ) * 2;   // two snapshot intervals

export class NetClient {
  constructor(url, { system = 0, name = null, key = undefined } = {}) {
    this.url = url;
    this.system = system;
    this.name = name;
    this.key = key === undefined ? NetClient.pilotKey() : key;
    this.id = null;
    this.connected = false;
    this.welcome = null;

    /* The predicted ship. This is what the game renders; `authoritative` is the
       last thing the server said, kept only so a correction can be measured. */
    this.ship = createShipState();
    this.authoritative = null;
    this.host = createQuietHost(this.ship);

    this.bodies = null;          // set by attachWorld
    this.tick = 0;               // server tick our prediction is standing on
    this.pending = [];           // inputs the server has not acknowledged
    this.lastAckButtons = 0;

    this.remotes = new Map();
    this.events = [];
    this.scan = { progress: 0, targetId: null, scanning: false };
    this.resonance = 0;
    this.bolts = [];
    // The room tick our remotes are drawn at; see interpolate(). Sent with
    // every input so the server can judge our shots against what we could see.
    this.renderTick = null;

    this.seq = 0;
    this._acc = 0;
    this._buttons = 0;
    this._joinedAt = 0;

    this.stats = {
      snapshots: 0, sent: 0, steps: 0, replays: 0,
      // How wrong the prediction was, at the same point in the input stream.
      // This is the number that says whether M2 works.
      predictionError: 0, maxPredictionError: 0, errorSamples: 0,
      // How far the ship moves when it is re-seated on the server's answer and
      // the unacked inputs are replayed. Bounded by the round trip, not a fault.
      correction: 0, maxCorrection: 0,
      pending: 0, starved: 0, dropped: 0, serverQueue: 0,
      rttMs: 0, lastTick: 0,
    };
    this._pingAt = 0;
  }

  /**
   * Hand the client the world and the ship it is to predict.
   *
   * Both are the renderer's own objects, not copies. `createShipState()` and
   * `Ship` carry the same fields by construction — that is what M0's
   * `Object.assign(this, createShipState())` was for — so prediction writes
   * straight into the hull the game is drawing, and there is no copy step to
   * forget. Two body arrays or two ships would be two answers.
   */
  attach(bodies, ship) {
    this.bodies = bodies;
    if (ship) {
      this.ship = ship;
      this.host = createQuietHost(ship);
    }
    if (this.welcome) seekSystem(this.bodies, this.tick * TICK_DT);
  }

  /**
   * The key that says which profile is ours.
   *
   * Generated once and kept in localStorage. This identifies a pilot; it does
   * not authenticate one — anyone holding the string is that pilot. That is
   * the honest shape of a development server with no accounts, and saying so
   * here is cheaper than someone later assuming otherwise. When there are real
   * accounts, this is the one line that changes.
   */
  static pilotKey() {
    try {
      const KEY = 'ls.pilotKey';
      let k = localStorage.getItem(KEY);
      if (!k) {
        k = (globalThis.crypto?.randomUUID?.()
          || Array.from({ length: 4 }, () => Math.random().toString(36).slice(2)).join(''));
        localStorage.setItem(KEY, k);
      }
      return k;
    } catch {
      // private mode, a sandboxed frame, or Node: play without a profile
      return null;
    }
  }

  connect() {
    const q = new URLSearchParams({ system: String(this.system) });
    if (this.name) q.set('name', this.name);
    if (this.key) q.set('key', this.key);
    const ws = this.ws = new WebSocket(`${this.url}/?${q}`);

    ws.onopen = () => { this.connected = true; };
    ws.onclose = () => { this.connected = false; };
    ws.onerror = () => { this.connected = false; };
    ws.onmessage = (e) => this._onMessage(JSON.parse(e.data));

    return new Promise((resolve, reject) => {
      this._resolve = resolve;
      ws.addEventListener('error', () => reject(new Error(`cannot reach ${this.url}`)), { once: true });
    });
  }

  _onMessage(m) {
    switch (m.t) {
      case S.WELCOME:
        if (m.v !== PROTOCOL_VERSION) {
          console.warn(`[net] protocol ${m.v} from the server, ${PROTOCOL_VERSION} here`);
        }
        this.id = m.id;
        this.welcome = m;
        this.tick = m.tick || 0;
        for (const p of m.players) if (p.id !== m.id) this._ensure(p.id).name = p.name;
        this._resolve?.(m);
        break;

      case S.SNAPSHOT: {
        this.stats.snapshots++;
        this.stats.lastTick = m.tick;
        if (m.you) this._reconcile(m.you, m.tick);
        this._readRemotes(m);
        this._readNpcs(m);
        /* Bolts are replaced wholesale rather than tracked by id. They live
           two seconds, they are never interacted with, and the only thing the
           renderer wants is where each streak is right now — matching them up
           frame to frame would be bookkeeping in exchange for nothing. */
        this.bolts = m.bolts || [];
        if (m.ev) this.events.push(...m.ev);
        break;
      }

      case S.JOIN: this._ensure(m.id).name = m.name; break;
      case S.LEAVE: this.remotes.delete(m.id); break;

      case S.JUMPED: {
        /* A new room, a new clock, and a new set of bodies.
           Everything the client had in flight belonged to the system it just
           left: unacknowledged inputs would be replayed against planets that
           are no longer there, and remembered neighbours are somewhere the
           camera can no longer see. Both are dropped rather than migrated. */
        this.system = m.system;
        this.tick = m.tick || 0;
        this.pending.length = 0;
        this.seq = 0;
        this.lastAckButtons = 0;
        this.remotes.clear();
        this.scan = { progress: 0, targetId: null, scanning: false };
        this._acc = 0;
        this.bodies = null;          // Game re-attaches once the system is built
        for (const p of m.players || []) if (p.id !== this.id) this._ensure(p.id).name = p.name;
        this.onJumped?.(m);
        break;
      }

      case S.JUMP_DENIED: this.onJumpDenied?.(m); break;
      case S.PONG: this.stats.rttMs = Math.round(performance.now() - this._pingAt); break;
      default: break;
    }
  }

  /* ------------------------------------------------------------ prediction */

  /**
   * Advance the local simulation and send what it was told to do.
   *
   *   dt      real time since the last frame
   *   sample  () => ({ raw, buttons }) — read once per fixed step, not per
   *           frame, so a 144 Hz client does not send five packets a tick
   */
  update(dt, sample) {
    if (!this.connected || !this.bodies) return;

    this._acc += Math.min(dt, 0.25);      // a long stall is lost, not simulated
    let steps = 0;
    while (this._acc >= TICK_DT && steps < 5) {
      this._acc -= TICK_DT;
      steps++;

      const sampled = sample();
      const buttons = sampled.buttons;
      // Predict from what the server will read, not from what the stick said.
      // See quantizeInput — this one line is the difference between a
      // correction of zero and a correction of half a kilometre.
      const raw = quantizeInput(sampled.raw, buttons);
      const seq = ++this.seq;
      const prevButtons = this.pending.length
        ? this.pending[this.pending.length - 1].buttons
        : this.lastAckButtons;

      this.tick++;
      seekSystem(this.bodies, this.tick * TICK_DT);
      this.host.events = this.events;
      stepShip(this.ship, this.bodies, TICK_DT, { raw, buttons, prevButtons }, this.host);
      this.stats.steps++;

      /* Keep the predicted position for each input, not just the input.
         Without it there is no way to ask the only question that matters —
         "where did I think I would be when the server consumed *this* packet?"
         The distance the ship moves during a reconcile is NOT that number: the
         client is a few inputs ahead of the server, so it compares two
         different points in the same stream and reports a difference that is
         mostly just those few ticks of travel. Measured as a steady 0.37 units
         and chased as if it were a desync; it was the ruler that was wrong. */
      this.pending.push({ seq, raw: { ...raw }, buttons, pos: this.ship.absPos.clone() });
      if (this.pending.length > 120) this.pending.shift();   // ~4s; the link is gone

      this.ws.send(encodeInput(seq, raw, buttons, sampled.aim, this.renderTick));
      this.stats.sent++;
      this._buttons = 0;      // taps are consumed by the send

      if (seq % 30 === 0) {
        this._pingAt = performance.now();
        this.ws.send(JSON.stringify({ t: C.PING, c: seq }));
      }
    }
    this.stats.pending = this.pending.length;
  }

  /** Roll back to the server's answer and replay everything it has not seen. */
  _reconcile(you, serverTick) {
    this.stats.starved += you.st || 0;
    this.stats.dropped += you.dr || 0;
    this.stats.serverQueue = you.qd || 0;

    // 1. settled history, keeping the last predicted position for the metric
    _tickWas = this.tick;
    _dropped = 0;
    let ackedPrediction = null;
    while (this.pending.length && this.pending[0].seq <= you.ack) {
      const done = this.pending.shift();
      this.lastAckButtons = done.buttons;
      if (done.seq === you.ack) ackedPrediction = done.pos;
      _dropped++;
    }

    /* The prediction error, measured where it is meaningful: the client's own
       predicted position for the very input the server has just told us it
       consumed, against the server's answer for that same input. Same point in
       the stream, so a non-zero result is a real disagreement about the rules
       and nothing else. */
    if (ackedPrediction) {
      _auth.set(you.p[0], you.p[1], you.p[2]);
      const e = ackedPrediction.distanceTo(_auth);
      this.stats.predictionError = e;
      if (e > this.stats.maxPredictionError) this.stats.maxPredictionError = e;
      this.stats.errorSamples++;
    }

    // and separately, how far the ship visibly jumps when we re-seat it
    _before.copy(this.ship.absPos);

    // 2. the server's answer is the truth
    this.ship.absPos.set(you.p[0], you.p[1], you.p[2]);
    this.ship.vel.set(you.v[0], you.v[1], you.v[2]);
    this.ship.quat.set(you.q[0], you.q[1], you.q[2], you.q[3]);
    // The integrator state too — see encodeShip. Re-seating position without
    // these leaves the ship half server, half client.
    if (you.av) this.ship.angVel.set(you.av[0], you.av[1], you.av[2]);
    if (you.fs !== undefined) this.ship.foldSpeed = you.fs;
    if (you.ht !== undefined) this.ship.heat = you.ht;
    // The upgrade-mutable parameters. An attuned Resonator raises maxSpeed on
    // the server; without this the client keeps predicting the old ship.
    if (you.ms !== undefined) this.ship.maxSpeed = you.ms;
    if (you.sr !== undefined) this.ship.scanRate = you.sr;
    if (you.fr !== undefined) this.ship.foldRegen = you.fr;
    // The scanner is not predicted — it changes nothing about where the ship
    // goes — so it is simply reported, and the HUD draws what the room says.
    this.scan.progress = you.sp || 0;
    this.scan.targetId = you.sg || null;
    this.scan.scanning = !!you.sc;
    this.resonance = you.res || 0;
    this.ship.throttle = you.th; this.ship.boost = you.bo;
    this.ship.foldMode = !!you.f; this.ship.hull = you.hl; this.ship.foldCharge = you.fc;
    this.authoritative = you;

    /* No world to replay against.
       Between a fold being granted and the new system finishing its cubemap
       bakes there is a second or more in which snapshots keep arriving and
       `bodies` is null — the client has left one system and not yet built the
       next. `update` already guarded on this; `_reconcile` did not, so every
       snapshot in that window threw inside seekSystem and took the socket down
       with it. Take the state, drop the backlog, and wait to be re-attached:
       those inputs were for a system this pilot is no longer in. */
    if (!this.bodies) {
      this.pending.length = 0;
      this.tick = serverTick;
      return;
    }

    /* 3. replay. The server consumed `ack` on the tick this snapshot was built,
       so the first unacknowledged input belongs to the tick after it, and the
       world has to be wound to each of those ticks in turn — the envelope reads
       planet positions and would otherwise judge every replayed tick against
       the newest ones. */
    let t = serverTick;
    let prevButtons = this.lastAckButtons;
    for (const p of this.pending) {
      t++;
      seekSystem(this.bodies, t * TICK_DT);
      // Replay is history being re-run, not lived: no HUD, no audio, no shake.
      this.host.events = _sink;
      stepShip(this.ship, this.bodies, TICK_DT, { raw: p.raw, buttons: p.buttons, prevButtons }, this.host);
      /* Update the stored prediction for this input.
         It is the client's *current* estimate of where that packet lands, and
         it is what the server's answer will be compared against next time. Left
         at the value from the first, uncorrected pass, the comparison measures
         the correction that has already been applied since — which is not the
         prediction error, and reads as a permanent disagreement that no fix
         ever removes. */
      p.pos.copy(this.ship.absPos);
      prevButtons = p.buttons;
      this.stats.replays++;
    }
    _sink.length = 0;
    this.tick = t;
    // leave the world where prediction now stands
    seekSystem(this.bodies, this.tick * TICK_DT);

    const err = _before.distanceTo(this.ship.absPos);
    this.stats.correction = err;
    if (err > this.stats.maxCorrection) this.stats.maxCorrection = err;

    if (!Number.isFinite(this.ship.absPos.x) || !Number.isFinite(this.ship.vel.x)) {
      // Say it once, loudly, with the state that produced it. A silent NaN
      // propagates into every later number and the cause is long gone.
      if (!this._blewUp) {
        this._blewUp = true;
        console.error('[net] prediction produced a non-finite ship', {
          ack: you.ack, serverTick, replayed: this.pending.length,
          serverPos: you.p, serverVel: you.v, serverQuat: you.q,
          pos: this.ship.absPos.toArray(), vel: this.ship.vel.toArray(),
          quat: this.ship.quat.toArray(), foldSpeed: this.ship.foldSpeed,
        });
      }
    }

    if (this.onCorrection) {
      this.onCorrection({
        err, predictionError: this.stats.predictionError,
        ack: you.ack, serverTick, clientTickWas: _tickWas, clientTickNow: this.tick,
        droppedFromBuffer: _dropped, replayed: this.pending.length,
        starved: you.st || 0, queue: you.qd || 0,
        speed: this.ship.vel.length(),
      });
    }
  }

  /* --------------------------------------------------------------- remotes */

  _readRemotes(m) {
    const now = performance.now() / 1000;
    const live = new Set();
    for (const o of m.others) {
      live.add(o.id);
      const r = this._ensure(o.id);
      // Keep two samples and draw between them: a snapshot every 66 ms drawn
      // raw is a ship that teleports fifteen times a second.
      r.prev.pos.copy(r.next.pos); r.prev.quat.copy(r.next.quat);
      r.prev.at = r.next.at; r.prev.tick = r.next.tick;
      r.next.pos.set(o.p[0], o.p[1], o.p[2]);
      r.next.quat.set(o.q[0], o.q[1], o.q[2], o.q[3]);
      r.next.at = now; r.next.tick = m.tick;
      if (!r.seen) {
        r.prev.pos.copy(r.next.pos); r.prev.quat.copy(r.next.quat);
        r.prev.at = now - TICK_DT; r.prev.tick = m.tick - 1;
      }
      r.throttle = o.th; r.boost = o.bo; r.foldMode = !!o.f;
      r.seen = true;
    }
    /* Only pilots. Hunters arrive in their own list a few lines later, and
       clearing them here would set `seen` false and then true again every
       snapshot — which re-seeds the interpolator's previous sample from its
       next one on every frame, holding every NPC perfectly still. */
    for (const [id, r] of this.remotes) if (!r.isNpc && !live.has(id)) r.seen = false;
  }

  /**
   * Interpolate every remote to `now - INTERP_DELAY` and write the result into
   * `absPos`/`quat`, which is what the renderer reads.
   *
   * Drawing other ships slightly in the past is the standard trade and the
   * right one here: the alternative is extrapolating from a stale velocity,
   * which at fold speeds puts a ship thousands of kilometres from where it
   * turns out to have been.
   */
  interpolate() {
    const target = performance.now() / 1000 - INTERP_DELAY;
    let seenTick = null;
    for (const r of this.remotes.values()) {
      if (!r.seen) continue;
      const span = r.next.at - r.prev.at;
      const a = span > 1e-6 ? THREE.MathUtils.clamp((target - r.prev.at) / span, 0, 1) : 1;
      r.absPos.lerpVectors(r.prev.pos, r.next.pos, a);
      r.quat.copy(r.prev.quat).slerp(r.next.quat, a);
      /* The room tick these ships are actually drawn at. Every remote is on
         the same pair of snapshots, so one of them speaks for all — and this
         is the number the server needs to rewind to when this client shoots.
         It is *behind* `this.tick`, which is the prediction and runs ahead. */
      if (seenTick === null) seenTick = r.prev.tick + (r.next.tick - r.prev.tick) * a;
    }
    /* With nobody else in sight there is nothing being interpolated, so the
       best available answer is the last snapshot we were given. A shot fired
       then has nothing to rewind against anyway. */
    this.renderTick = seenTick !== null ? seenTick : this.stats.lastTick;
  }

  /* Hunters go through the same buffer-and-interpolate path as pilots, into
     the same map. They are ships arriving at fifteen a second like everything
     else, and giving them their own list would mean giving the renderer, the
     interpolator and the beacon solve a second copy of each. */
  _readNpcs(m) {
    if (!m.npcs) return;
    const now = performance.now() / 1000;
    for (const o of m.npcs) {
      const r = this._ensure(o.id);
      r.isNpc = true;
      r.npcKind = o.k;
      r.faction = o.f2;
      r.aiState = o.st;
      r.hostile = !!o.h;
      r.prev.pos.copy(r.next.pos); r.prev.quat.copy(r.next.quat);
      r.prev.at = r.next.at; r.prev.tick = r.next.tick;
      r.next.pos.set(o.p[0], o.p[1], o.p[2]);
      r.next.quat.set(o.q[0], o.q[1], o.q[2], o.q[3]);
      r.next.at = now; r.next.tick = m.tick;
      if (!r.seen) {
        r.prev.pos.copy(r.next.pos); r.prev.quat.copy(r.next.quat);
        r.prev.at = now - TICK_DT; r.prev.tick = m.tick - 1;
      }
      r.throttle = o.th; r.boost = o.bo; r.foldMode = !!o.f;
      r.seen = true;
    }
  }

  _ensure(id) {
    let r = this.remotes.get(id);
    if (!r) {
      r = {
        id, name: `PILOT-${id}`, seen: false,
        absPos: new THREE.Vector3(), quat: new THREE.Quaternion(),
        throttle: 0, boost: 0, foldMode: false,
        prev: { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), at: 0, tick: 0 },
        next: { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), at: 0, tick: 0 },
      };
      this.remotes.set(id, r);
    }
    return r;
  }

  /* ----------------------------------------------------------------- misc */

  /** Ask the room to fold us elsewhere. The answer is JUMPED or JUMP_DENIED. */
  requestJump(systemId) {
    if (!this.connected) return false;
    this.ws.send(JSON.stringify({ t: C.JUMP, system: systemId | 0 }));
    return true;
  }

  setButtons({ fold = false, boost = false, stop = false } = {}) {
    this._buttons |= (fold ? BTN.FOLD : 0) | (boost ? BTN.BOOST : 0) | (stop ? BTN.STOP : 0);
  }

  /** The buttons banked since the last fixed step, for `sample()` to fold in. */
  takeButtons() { return this._buttons; }

  /**
   * A sampler over the game's live input state.
   *
   * Boost rides in the button mask rather than as its own number, because that
   * is where `decodeInput` reads it from on the far side — the client has to
   * predict from exactly the value the server will reconstruct, not from the
   * one it happens to have locally. Getting that wrong is a divergence that
   * only appears while the boost is held, which is the worst kind.
   */
  makeSampler(state, extra = {}) {
    const { aim = null, scanning = null, firing = null } = extra;
    return () => ({
      raw: {
        pitch: state.pitch, yaw: state.yaw, roll: state.roll,
        strafeX: state.strafeX, strafeY: state.strafeY,
        throttleDelta: state.throttleDelta,
        boost: state.boost ? 1 : 0,
      },
      // Held states are re-derived every sample rather than banked. `setButtons`
      // is for taps and clears itself on send; a scan key that did that would
      // reach the room for exactly one tick of a two-second hold.
      buttons: this.takeButtons()
        | (state.boost ? BTN.BOOST : 0)
        | (scanning && scanning() ? BTN.SCAN : 0)
        | (firing && firing() ? BTN.FIRE : 0),
      aim: aim ? aim() : null,
    });
  }

  close() { try { this.ws?.close(); } catch { /* already gone */ } }
}

const _before = new THREE.Vector3();
const _auth = new THREE.Vector3();
const _sink = [];
let _tickWas = 0;
let _dropped = 0;
export { emptyInput };
