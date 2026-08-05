import * as THREE from 'three';

/* ============================================================================
   Shooting, and being shot.

   ------------------------------------------------------------- why a segment

   The one thing in this file that cannot be done the obvious way. A bolt
   travels 600 units a second and the room ticks 30 times a second, so it moves
   twenty units between one step and the next. A ship is a tenth of a unit
   long. Testing whether a bolt's *position* is inside a target is therefore
   testing whether a twenty-unit stride happened to land inside a tenth-unit
   sphere: it essentially never does, and the weapon would appear to miss
   everything while passing straight through.

   So every bolt is tested as the segment it swept this tick, against the
   target's radius. That is not an optimisation or a nicety — it is the
   difference between a weapon that works and one that does not.

   ------------------------------------------------------------- who decides

   The room. A bolt is spawned by the room when it consumes an input with the
   fire bit set, flies on the room's clock, and hits on the room's arithmetic.
   Clients are told. A client that could declare its own hits could declare all
   of them.

   Damage lands on the shield first and the hull after it, and the shield stops
   regenerating for a few seconds once it has been hit — so a fight has a shape
   rather than being a race between two regeneration rates.
   ========================================================================== */

export const BOLT_SPEED = 600;          // units per second
export const BOLT_TTL = 2.0;            // seconds — about 1200 units of reach
export const BOLT_DAMAGE = 0.075;
export const FIRE_COOLDOWN = 0.25;      // four a second
export const HIT_RADIUS = 0.6;          // a ship is 0.1 long; this is generous

export const SHIELD_MAX = 1;
export const SHIELD_REGEN = 0.09;       // per second, once it is allowed to
export const SHIELD_HOLDOFF = 3.0;      // seconds of quiet before it recovers

/** Muzzle offset in the ship's own frame, in world units (1 unit = 1 km). */
export const MUZZLE = new THREE.Vector3(0, -0.004, -0.06);

const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _toC = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _muzzle = new THREE.Vector3();

let _nextBoltId = 1;
export function resetBoltIds() { _nextBoltId = 1; }

/** The weapon and damage fields a ship needs. Mixed into `createShipState`. */
export function createCombatState() {
  return {
    shield: SHIELD_MAX,
    shieldMax: SHIELD_MAX,
    shieldRegen: SHIELD_REGEN,
    cooldown: 0,
    hitAt: -999,        // room time of the last damage taken
  };
}

/**
 * Does the segment p0..p1 pass within `radius` of `centre`?
 *
 * Returns the fraction along the segment at closest approach when it does, and
 * -1 when it does not. The fraction matters: with two targets in line, the
 * nearer one has to be the one that is hit.
 */
export function segmentHitsSphere(p0, p1, centre, radius) {
  _seg.copy(p1).sub(p0);
  const len2 = _seg.lengthSq();
  _toC.copy(centre).sub(p0);
  // Clamped projection: a bolt that stopped short of a target has not hit it,
  // and one that started past it has not either.
  const t = len2 > 1e-12 ? THREE.MathUtils.clamp(_toC.dot(_seg) / len2, 0, 1) : 0;
  const dx = _toC.x - _seg.x * t;
  const dy = _toC.y - _seg.y * t;
  const dz = _toC.z - _seg.z * t;
  return (dx * dx + dy * dy + dz * dz) <= radius * radius ? t : -1;
}

/** Whether this ship may fire right now. Null if it may. */
export function canFire(s) {
  if (s.cooldown > 0) return 'cooling';
  if (s.hull <= 0) return 'dead';
  return null;
}

/**
 * Spawn a bolt from `s`, travelling along `dir` (unit, world space).
 *
 * The ship's own velocity is added: a bolt fired from something doing sixty
 * units a second and not inheriting that is a bolt that appears to drift
 * backwards out of the muzzle.
 */
export function fire(s, ownerId, dir, now) {
  s.cooldown = FIRE_COOLDOWN;
  _muzzle.copy(MUZZLE).applyQuaternion(s.quat).add(s.absPos);
  return {
    id: `b:${_nextBoltId++}`,
    owner: ownerId,
    pos: _muzzle.clone(),
    vel: dir.clone().multiplyScalar(BOLT_SPEED).add(s.vel),
    born: now,
    ttl: BOLT_TTL,
    damage: BOLT_DAMAGE,
  };
}

/** Forward axis of a ship, as a firing direction. */
export function aimForward(s, out = _dir) {
  return out.set(0, 0, -1).applyQuaternion(s.quat);
}

/**
 * Apply damage. Shield first, then hull, and the shield is held off for a
 * few seconds afterwards.
 *
 * Returns what actually happened, because the client needs to know whether to
 * flare a shield or scar a hull.
 */
export function applyDamage(s, amount, now) {
  s.hitAt = now;
  let toShield = 0, toHull = 0;
  if (s.shield > 0) {
    toShield = Math.min(s.shield, amount);
    s.shield -= toShield;
    amount -= toShield;
  }
  if (amount > 0) {
    toHull = Math.min(s.hull, amount);
    s.hull = Math.max(0, s.hull - amount);
  }
  return { shield: toShield, hull: toHull, destroyed: s.hull <= 0 };
}

/** Cooldown and shield recovery. Called once per tick per ship. */
export function stepCombatState(s, dt, now) {
  if (s.cooldown > 0) s.cooldown = Math.max(0, s.cooldown - dt);
  if (s.shield < s.shieldMax && now - s.hitAt > SHIELD_HOLDOFF) {
    s.shield = Math.min(s.shieldMax, s.shield + s.shieldRegen * dt);
  }
}

/**
 * Move every bolt and resolve what it hit.
 *
 *   targets  `{ id, ship }`, anything that can be shot
 *   now      room time in seconds
 *
 * Returns `{ alive, hits }`. Bolts do not collide with the world — a bolt that
 * flies into a planet simply expires — because the alternative is a raymarch
 * against a heightfield per bolt per tick, and nothing in this game is close
 * enough to a surface for it to read.
 */
export function stepProjectiles(bolts, targets, dt, now) {
  const alive = [];
  const hits = [];

  for (const b of bolts) {
    if (now - b.born > b.ttl) continue;

    _p0.copy(b.pos);
    _p1.copy(b.vel).multiplyScalar(dt).add(b.pos);

    let bestT = Infinity, victim = null;
    for (const t of targets) {
      if (t.id === b.owner) continue;            // never your own bolt
      if (t.ship.hull <= 0) continue;
      const f = segmentHitsSphere(_p0, _p1, t.ship.absPos, HIT_RADIUS);
      // Nearest along the flight path wins, so a line of ships is hit in order.
      if (f >= 0 && f < bestT) { bestT = f; victim = t; }
    }

    if (victim) {
      const dmg = applyDamage(victim.ship, b.damage, now);
      hits.push({ boltId: b.id, owner: b.owner, target: victim.id, at: _p0.clone().lerp(_p1, bestT), ...dmg });
      continue;                                   // the bolt is spent
    }

    b.pos.copy(_p1);
    alive.push(b);
  }

  return { alive, hits };
}
