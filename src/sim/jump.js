/* ============================================================================
   Interstellar transit.

   The rule was inside `HoloMap.confirm`, next to the button that draws it —
   which was the right place while the only pilot was the one holding the
   mouse. It is a rule about ship state, though: it spends the fold charge, and
   a client that could spend its own charge could also decline to, so it moves
   here where the room can reach it.

   The cost is the map distance in light years over eighty, capped at a full
   charge. That is the whole of it, and it is deliberately the same expression
   the star map has always drawn on the plate — a pilot reading "FOLD COST 62%"
   and being refused at 62% would be a worse bug than any desync.
   ========================================================================== */

export function jumpCost(galaxy, fromId, toId) {
  const a = galaxy[fromId], b = galaxy[toId];
  if (!a || !b) return Infinity;
  return Math.min(1, Math.hypot(b.x - a.x, b.y - a.y) / 80);
}

/** Null if the jump is allowed, otherwise why not. */
export function canJump(ship, galaxy, fromId, toId) {
  if (toId === fromId) return 'sameSystem';
  if (!galaxy[toId]) return 'noSuchSystem';
  if (ship.foldCharge < jumpCost(galaxy, fromId, toId)) return 'noCharge';
  return null;
}

/** Spend the charge. Separate from the test so a refusal cannot half-charge. */
export function payJump(ship, galaxy, fromId, toId) {
  const cost = jumpCost(galaxy, fromId, toId);
  ship.foldCharge = Math.max(0, ship.foldCharge - cost);
  return cost;
}
