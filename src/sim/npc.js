import * as THREE from 'three';
import { createShipState, engageFold, dropFold } from './flight.js';
import { stepShip, createQuietHost } from './step.js';
import { steerToIntercept, steerToward } from './steer.js';
import { mulberry32 } from '../world/generate.js';

/* ============================================================================
   Craft that fly in response to you.

   This is the other half of the split the plan calls for, and the reason it
   has to be a split at all:

   `Fleet.js` traffic is *analytic*. A freighter's position is a function of the
   clock, so it needs no replication, no integration and no server — every
   client works out the same answer independently, and that is what makes a
   system full of shipping cost nothing. It also means those craft cannot
   react. A path keyed to time cannot turn because you turned.

   So anything that pursues has to be integrated instead: real state, stepped
   every tick, sent over the wire like a player. That is more expensive per
   craft by every measure, which is exactly why it is a separate kind rather
   than an upgrade to the existing traffic. Freighters stay analytic and
   client-side; hunters are simulated and replicated.

   ---------------------------------------------------------------- the flying

   NPCs fly the *same* `stepShip` as players. Not a lighter approximation of
   it: the envelope that keeps a pilot off a planet keeps a hunter off it too,
   the throttle curves are the same, and anything that turns out to be true of
   the flight model is true for both. The only difference is where the stick
   comes from.

   They do not fold. A hunter that could fold would either vanish or arrive
   instantly, and neither is a fight.
   ========================================================================== */

/** How far a hunter notices a pilot, and how close it then tries to sit. */
export const AGGRO_RANGE = 900;
export const LOSE_RANGE = 2400;
export const STANDOFF = 60;
/** Inside this, and lined up, a hostile craft shoots. Well within a bolt's reach. */
export const FIRE_RANGE = 500;

const _cmd = {};
const _toHome = new THREE.Vector3();

let _nextNpcId = 1;

/**
 * One hunter.
 *
 * `home` is where it loiters with nobody to chase — a patrol anchor rather
 * than a leash, so a system reads as watched rather than as a set of statues.
 */
export function createNpc({ kind = 'patrol', faction = 'institute', hostile = false, home, seed = 1 } = {}) {
  const rnd = mulberry32(seed >>> 0);
  const ship = createShipState();
  ship.absPos.copy(home);
  // hunters are a little quicker and a little tighter than the survey ship
  ship.maxSpeed = 66 + rnd() * 18;
  ship.turnAccel.set(3.0, 2.6, 3.6);
  ship.maxTurn.set(1.3, 1.1, 1.8);

  return {
    id: `npc:${_nextNpcId++}`,
    kind, faction, hostile,
    ship,
    home: home.clone(),
    ai: { state: 'patrol', targetId: null, since: 0, wanderAt: 0 },
    prevButtons: 0,
    // Its own envelope host, bound to its own ship. Sharing one between craft
    // would mean the fold drop — which multiplies velocity by 0.0006 — landing
    // on whichever ship the host happened to be pointed at.
    host: createQuietHost(ship),
  };
}

/** Reset the id counter, so a test can name things predictably. */
export function resetNpcIds() { _nextNpcId = 1; }

/**
 * Choose who to chase.
 *
 * Sticky on purpose: a hunter that re-picked the nearest target every tick
 * would oscillate between two pilots at similar range and fly at neither. It
 * keeps its mark until that mark is further away than `LOSE_RANGE`.
 */
function pickTarget(npc, targets) {
  const current = npc.ai.targetId ? targets.find((t) => t.id === npc.ai.targetId) : null;
  if (current) {
    const d = current.ship.absPos.distanceTo(npc.ship.absPos);
    if (d < LOSE_RANGE) return current;
  }
  let best = null, bd = AGGRO_RANGE;
  for (const t of targets) {
    if (t.ship.hull <= 0) continue;
    const d = t.ship.absPos.distanceTo(npc.ship.absPos);
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}

/**
 * One tick of a hunter.
 *
 *   targets  things it may chase, each `{ id, ship }`
 *   host     the proximity contract, exactly as a player's
 */
export function stepNpc(npc, bodies, targets, dt, host = npc.host) {
  const s = npc.ship;
  const mark = pickTarget(npc, targets);
  npc.ai.targetId = mark ? mark.id : null;

  let cmd, wantThrottle, wantBoost = 0;
  if (mark) {
    npc.ai.state = 'pursue';
    // Lead the mark rather than tail-chase it. `maxSpeed` is a fair enough
    // guess at the closing rate at these distances.
    cmd = steerToIntercept(s, mark.ship.absPos, mark.ship.vel, s.maxSpeed, _cmd);

    /* Hold a standoff instead of ramming. Without this a hunter closes to
       zero, the envelope is not involved because a ship is not a planet, and
       the two end up inside one another. */
    const closing = cmd.dist - STANDOFF;
    wantThrottle = closing <= 0 ? 0
      : cmd.aligned ? Math.min(1, closing / 400)
        : 0.35;
    wantBoost = (cmd.aligned && closing > 600) ? 1 : 0;

    /* Only a hostile craft pulls the trigger, and only with the nose actually
       on the mark and the mark in reach. A patrol pursues to look at you —
       that is what a patrol is for — and shooting anyone who happens to be
       nearby would make every system a warzone by the second minute. */
    npc.ai.wantsFire = npc.hostile && cmd.aligned && cmd.dist < FIRE_RANGE;
  } else {
    /* Nothing to chase: drift back toward the patrol anchor and idle there. */
    npc.ai.state = 'patrol';
    _toHome.copy(npc.home).sub(s.absPos);
    const d = _toHome.length();
    cmd = steerToward(s, npc.home, _cmd);
    wantThrottle = d > 400 ? (cmd.aligned ? 0.7 : 0.3) : 0;
    npc.ai.wantsFire = false;
  }

  /* Drive the throttle through the stick, not by assignment.
     `stepShip` runs `applyDriveInput`, which recomputes throttle from
     `raw.throttleDelta` and boost from `raw.boost` — so setting the fields
     directly here was overwritten a moment later, and worse: the steering
     command carries no `throttleDelta`, so the arithmetic ran on `undefined`
     and throttle became NaN. `stepFlight` then guards with `dvLen > 1e-6`,
     which is false for NaN, so velocity was never touched and the hunter sat
     perfectly still while believing it was in pursuit.

     Going through the stick is also the honest thing: the claim in the header
     is that an NPC differs from a pilot only in where the input comes from,
     and that is only true if it uses the same two fields. */
  cmd.throttleDelta = THREE.MathUtils.clamp((wantThrottle - s.throttle) * 8, -1, 1);
  cmd.boost = wantBoost;

  // No fold, ever — see the header. Buttons stay empty for the same reason.
  if (s.foldMode) dropFold(s);

  stepShip(s, bodies, dt, { raw: cmd, buttons: 0, prevButtons: npc.prevButtons }, host);
  npc.prevButtons = 0;
  npc.ai.since += dt;
  return npc;
}

/**
 * The hunters a system starts with, from its own seed.
 *
 * Deterministic so that two servers built from the same seed agree, and so a
 * test can say "the second patrol" and mean it. They are anchored to inhabited
 * worlds because that is where a patrol has a reason to be.
 */
export function spawnPatrols(sys, stub, bodies, count = 2, raiders = 1) {
  const rnd = mulberry32((stub.seed ^ 0x7a1f) >>> 0);
  const hosts = bodies.filter((b) => b.kind === 'planet');
  if (!hosts.length) return [];

  const anchor = () => {
    const host = hosts[Math.floor(rnd() * hosts.length)];
    const ang = rnd() * Math.PI * 2;
    const rad = host.radius * (1.8 + rnd() * 1.6);
    return new THREE.Vector3(
      host.absPos.x + Math.cos(ang) * rad,
      host.absPos.y + (rnd() - 0.5) * rad * 0.4,
      host.absPos.z + Math.sin(ang) * rad,
    );
  };

  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(createNpc({
      kind: 'patrol', faction: 'institute', hostile: false,
      home: anchor(), seed: stub.seed + i * 131,
    }));
  }
  /* And something that shoots. A system of patrols that only ever look at you
     is not PvE; a system where everything shoots is not this game. One hostile
     craft per system is enough to have a fight worth having. */
  for (let i = 0; i < raiders; i++) {
    out.push(createNpc({
      kind: 'raider', faction: 'free', hostile: true,
      home: anchor(), seed: stub.seed + 977 + i * 419,
    }));
  }
  return out;
}
