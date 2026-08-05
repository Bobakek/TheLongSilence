import * as THREE from 'three';
import { TICK_DT } from '../src/net/protocol.js';

/* ============================================================================
   Where everybody was, for the last second or so.

   Lag compensation needs one thing the room does not otherwise keep: the past.
   A pilot aims at what is on their screen, and what is on their screen is
   older than the room by the time a snapshot took to arrive plus the delay the
   interpolator deliberately holds remotes at. Around two hundred milliseconds,
   most of it chosen rather than suffered.

   So every tick, every combatant's position is recorded here, and a bolt fired
   by a client is resolved against the world that client could actually see.

   ------------------------------------------------------------------ the cost

   This is not free and it is not neutral. Rewinding means the victim is judged
   where they *were*, so on their own screen a bolt can pass behind them and
   still land. That is the classic complaint about being shot around a corner,
   and it is the accepted price: the alternative is telling every pilot that
   their aim is wrong by an amount they cannot see or correct for.

   The rewind is capped. A client asking to be judged against a world two
   seconds old is either broken or lying, and either way the answer is no.
   ========================================================================== */

/** How far back the room will ever look. Beyond this a shot resolves at now. */
export const MAX_REWIND_TICKS = 30;          // one second at 30 Hz

export class History {
  constructor(depth = MAX_REWIND_TICKS + 4) {
    this.depth = depth;
    this.ring = new Array(depth);
    for (let i = 0; i < depth; i++) this.ring[i] = { tick: -1, at: new Map() };
  }

  /** Record this tick. `combatants` is `{ id, ship }`, as the room builds it. */
  record(tick, combatants) {
    const slot = this.ring[tick % this.depth];
    slot.tick = tick;
    // Reused vectors rather than fresh ones: this runs thirty times a second
    // for every ship in the room and would otherwise be the only allocation in
    // the tick.
    for (const c of combatants) {
      let v = slot.at.get(c.id);
      if (!v) { v = new THREE.Vector3(); slot.at.set(c.id, v); }
      v.copy(c.ship.absPos);
    }
    // Anything that left the room since this slot was last written would
    // otherwise linger and be shot at.
    if (slot.at.size !== combatants.length) {
      const live = new Set(combatants.map((c) => c.id));
      for (const id of slot.at.keys()) if (!live.has(id)) slot.at.delete(id);
    }
  }

  /** The recorded position of `id` at `tick`, or null if it is not held. */
  posAt(tick, id) {
    const slot = this.ring[((tick % this.depth) + this.depth) % this.depth];
    if (!slot || slot.tick !== tick) return null;
    return slot.at.get(id) || null;
  }

  /**
   * Turn a client's reported render tick into a rewind depth.
   *
   * Clamped at both ends: never negative — a client cannot ask to be judged
   * against the future — and never further back than the ring holds.
   */
  rewindTicks(nowTick, renderTick) {
    if (!Number.isFinite(renderTick)) return 0;
    const back = Math.round(nowTick - renderTick);
    return Math.max(0, Math.min(MAX_REWIND_TICKS, back));
  }
}

/** Seconds a given rewind is worth, for logs and tests. */
export const rewindSeconds = (ticks) => ticks * TICK_DT;
