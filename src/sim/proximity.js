import * as THREE from 'three';
import { isMassive } from './targeting.js';

/* The approach envelope: a soft floor rather than a wall.

   Real ships do not stop dead on a surface. You feel the field push back, the
   drive cuts, and you settle. This mutates velocity, position and hull, so it
   is authoritative — the client runs it to predict and the server runs it to
   decide, and if only one of them did, every close pass would snap.

   ---------------------------------------------------------------- the host

   The envelope does three things that are not arithmetic: it cancels the
   autopilot, it drops the fold, and it shakes the camera. Those cannot be
   deferred to after the loop — `setFold(false)` bleeds off velocity that later
   bodies in the same iteration then read — so they are called at exactly the
   point they always were, through a small interface:

     host.shake            number, read and written
     host.proximityWarn    string | null, written
     host.cancelAutopilot(quiet)
     host.setFold(on)

   In the browser the host is the `Game`. On the server it is a stub that
   records the events and throws the shake away. */

const _v = new THREE.Vector3();

export function applyProximity(ship, bodies, dt, host) {
  host.proximityWarn = null;
  for (const b of bodies) {
    if (!isMassive(b)) continue;
    const isStar = b.kind === 'star';
    const floor = b.radius * (isStar ? 2.2 : 1.02);
    const soft = b.radius * (isStar ? 4.0 : 1.16);

    _v.copy(ship.absPos).sub(b.absPos);
    const d = _v.length();
    if (d > soft) continue;
    _v.multiplyScalar(1 / Math.max(d, 1e-6));

    const t = THREE.MathUtils.clamp((soft - d) / (soft - floor), 0, 1);
    host.proximityWarn = isStar ? 'STELLAR PROXIMITY' : 'TERRAIN PROXIMITY';

    // cancel automation and cut the drive as the envelope closes
    if (t > 0.25) { host.cancelAutopilot(true); if (ship.foldMode) host.setFold(false); }
    if (t > 0.5) ship.throttle = Math.min(ship.throttle, 1 - t);

    // repulsion grows sharply, and inward velocity is bled off
    const push = t * t * 120 + (d < floor ? 900 : 0);
    ship.vel.addScaledVector(_v, push * dt);
    const vn = ship.vel.dot(_v);
    if (vn < 0) ship.vel.addScaledVector(_v, -vn * Math.min(1, t * 2.4));

    if (d < floor) {
      ship.absPos.copy(b.absPos).addScaledVector(_v, floor);
      ship.hull = Math.max(0, ship.hull - 0.00035 * Math.min(200, Math.abs(vn)));
      host.shake = Math.min(1, host.shake + 0.25);
    }
    host.shake = Math.min(1, host.shake + t * dt * 1.6);
    if (isStar && t > 0.35) ship.hull = Math.max(0, ship.hull - dt * 0.05 * t);
  }
}
