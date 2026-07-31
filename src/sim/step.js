import { applyDriveInput, stepFlight, engageFold, dropFold } from './flight.js';
import { applyProximity } from './proximity.js';
import { nearestBodyInfo, foldFloor, foldCeiling, canFold } from './targeting.js';

/* ============================================================================
   One ship, one tick — the whole of it, in one place.

   M1 had this sequence written out in `Room.step` and nowhere else, which was
   fine while only the server ran it. M2 makes the client run it too, for
   prediction, and two copies of an ordered sequence are two copies that drift:
   the first person to insert a line in one of them produces a desync that
   shows up as rubber-banding a week later and is very hard to trace back to a
   reordering.

   So the order lives here and both callers get it from here. It is not
   arbitrary — every line is downstream of the one above it:

     1. discrete actions, edge-triggered, because a held key is not a press
     2. throttle and boost integrated from the stick
     3. the fold's own floor checks, *before* the step, so a drive that should
        have dropped does not get one more tick at eighty thousand km/s
     4. the flight integration
     5. the approach envelope, which corrects what the integration just did

   ------------------------------------------------------------------- edges

   Buttons arrive as a bitmask and the interesting thing is the *edge*, so the
   caller passes what was held last tick as well. During replay the client
   walks its input buffer carrying `prevButtons` forward exactly as the server
   did while consuming the same packets, which is what makes a replayed fold
   engage on the same tick on both sides.
   ========================================================================== */

export const CMD = {
  FOLD: 1 << 0,
  BOOST: 1 << 1,
  STOP: 1 << 2,
};

/**
 * Step one ship.
 *
 *   s            ship state, from `createShipState()`
 *   bodies       the system, already positioned for this tick
 *   dt           fixed — the client must use the server's, see NetClient
 *   cmd          { raw, buttons, prevButtons }
 *   host         the proximity contract: shake, proximityWarn, cancelAutopilot,
 *                setFold. May carry an `events` array, which this appends to.
 */
export function stepShip(s, bodies, dt, cmd, host) {
  const { raw, buttons = 0, prevButtons = 0 } = cmd;
  const tapped = (mask) => (buttons & mask) !== 0 && (prevButtons & mask) === 0;
  const say = (e) => { if (host.events) host.events.push(e); };

  // ---- 1. discrete
  if (tapped(CMD.STOP)) { s.throttle = 0; s.vel.multiplyScalar(0.02); say('stop'); }
  if (tapped(CMD.FOLD)) {
    if (s.foldMode) { dropFold(s); say('foldOff'); }
    else {
      const near = nearestBodyInfo(s, bodies);
      const refused = canFold(s, near);
      if (refused) say('foldRefused:' + refused);
      else { engageFold(s); say('foldOn'); }
    }
  }

  // ---- 2. continuous drive
  applyDriveInput(s, dt, raw);

  // ---- 3. the drive's floors
  const near = nearestBodyInfo(s, bodies);
  if (s.foldMode && near.surfaceDist < foldFloor(near)) { dropFold(s); say('foldOff'); }
  if (s.foldMode && s.foldCharge <= 0.001) { dropFold(s); say('foldOff'); }

  // ---- 4. flight. `time` is not passed: nothing in the model reads it — it
  // only ever drove the hull's visuals — and a clock the two processes would
  // have to agree on is a desync waiting to be written.
  stepFlight(s, dt, raw, { foldCeiling: foldCeiling(near) });

  // ---- 5. the envelope corrects it
  applyProximity(s, bodies, dt, host);
}

/**
 * A host that records rather than acts.
 *
 * The server has no camera to shake and no autopilot to cancel; a replaying
 * client has both but must not fire them again for a tick it has already
 * lived through. Both want the same thing: run the rules, keep the state,
 * drop the theatre.
 *
 * `setFold` is emphatically NOT a no-op. The envelope calls it to cut the
 * drive, and cutting the drive multiplies velocity by 0.0006 — that is state,
 * not presentation, and a host that swallowed it would put the client a very
 * long way from the server within a second of any close pass.
 */
export function createQuietHost(ship) {
  return {
    shake: 0,
    proximityWarn: null,
    events: [],
    cancelAutopilot() { this.events.push('autopilotOff'); },
    setFold(on) {
      if (on) engageFold(ship); else dropFold(ship);
      this.events.push(on ? 'foldOn' : 'foldOff');
    },
  };
}
