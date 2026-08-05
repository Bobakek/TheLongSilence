import { aimTargetFrom, inScanRange } from './targeting.js';

/* ============================================================================
   Scanning, as a decision.

   `Game.completeScan` did two jobs in one method: it decided that a body had
   been surveyed, and it played the consequences — a sound, a line in the log, a
   Canto, a cutscene, a dirty codex. Only the first of those is anybody else's
   business. This module is the decision; the reactions stay on the client and
   are driven by the event this produces.

   ------------------------------------------------------------------ personal

   Discoveries are per pilot, not per body. The single-player code already
   leaned that way — `discoveries` was a Set on the game and `scanned` was a
   flag on the shared body record, and the two disagreed the moment there was
   more than one pilot. Per pilot is also the only version that does not let
   the first player through a system take the content away from everyone after
   them: seven Resonators, first come, and the eighth pilot finds a dead
   galaxy. `Room` carries a `sharedDiscoveries` switch for whoever wants to
   argue the other way, but the default is personal and deliberate.
   ========================================================================== */

/** Rate the progress bar fills at, before the scanner-gain upgrade. */
export const SCAN_RATE = 0.42;
/** How fast it drains when you look away. */
export const SCAN_DECAY = 0.9;

export function createScanState() {
  return { progress: 0, targetId: null, scanning: false };
}

/**
 * One tick of the scanner.
 *
 *   scan     from `createScanState`, mutated in place
 *   cmd      { aim: Quaternion, scanning: boolean }
 *   opts     { scanRangeMul, discovered: (id) => boolean }
 *
 * Returns the body that just completed, or null. The caller decides what that
 * means — this does not know about Cantos, logs or upgrades.
 */
export function stepScan(scan, ship, bodies, dt, cmd, opts = {}) {
  const mul = opts.scanRangeMul ?? 1;
  const discovered = opts.discovered || (() => false);

  const aim = cmd.aim ? aimTargetFrom(ship, bodies, cmd.aim) : null;
  scan.targetId = aim ? aim.id : null;

  const usable = aim && !discovered(aim.id) && inScanRange(ship, aim, mul);
  if (!usable || !cmd.scanning) {
    scan.progress = Math.max(0, scan.progress - dt * SCAN_DECAY);
    scan.scanning = false;
    return null;
  }

  scan.scanning = true;
  scan.progress += dt * SCAN_RATE * (ship.scanRate || 1);
  if (scan.progress < 1) return null;

  scan.progress = 0;
  return aim;
}
