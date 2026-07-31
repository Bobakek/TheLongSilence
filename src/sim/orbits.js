import * as THREE from 'three';

/* Where everything in a system is, this instant.

   Lifted out of `Game._positionSystem`. It reads specs and writes `absPos`,
   and knows nothing about the meshes the client hangs off the same body
   records — which is the whole point: the server runs it over body records
   that have no meshes at all.

   Two ways in, and the second is what makes prediction possible.

   `positionSystem(bodies, dt)` advances the clock by dt, which is what a frame
   loop wants. `seekSystem(bodies, elapsed)` sets the clock *absolutely*, which
   is what a client that has just been told the server's tick number wants —
   and what a client joining an hour-old room needs, because its planets would
   otherwise start at phase zero while everyone else's are an hour along.

   Both are exact, because orbital phase is a pure accumulation:

       phase(t) = orbitPhase + orbitSpeed * t

   so seeking is not an approximation of stepping, it is the same number
   arrived at directly. */

const _v = new THREE.Vector3();

export const ORBIT_TIME = 1;      // orbit rates are already tuned in generate.js

/** Turn current phases into positions. Parents precede their moons in `bodies`. */
function place(bodies) {
  for (const b of bodies) {
    if (b.kind === 'planet') {
      const a = b.spec.orbitR;
      b.absPos.set(Math.cos(b.phase) * a, Math.sin(b.phase * 1.3) * a * b.spec.orbitInc, Math.sin(b.phase) * a);
    } else if (b.kind === 'moon') {
      const a = b.spec.orbitR;
      b.absPos.copy(b.parent.absPos).add(
        _v.set(Math.cos(b.phase) * a, Math.sin(b.phase * 1.7) * a * b.spec.orbitInc, Math.sin(b.phase) * a)
      );
    } else if (b.kind === 'station') {
      const host = bodies.find((x) => x.spec === b.station.hostSpec);
      b.absPos.copy(host ? host.absPos : _v.set(0, 0, 0)).add(b.station.offset);
    } else if (b.kind === 'anomaly') {
      const host = bodies.find((x) => x.spec === b.hostSpec);
      if (host) b.absPos.copy(host.absPos).add(b.offset);
      else b.absPos.copy(b.offset);
    }
  }
}

/** Advance every orbit by `dt` seconds. */
export function positionSystem(bodies, dt) {
  for (const b of bodies) {
    if (b.kind === 'planet' || b.kind === 'moon') b.phase += b.spec.orbitSpeed * dt * ORBIT_TIME;
  }
  place(bodies);
}

/**
 * Put every orbit where it would be `elapsed` seconds after the system was
 * generated. Idempotent, and the only way a late joiner agrees with the room.
 */
export function seekSystem(bodies, elapsed) {
  for (const b of bodies) {
    if (b.kind === 'planet' || b.kind === 'moon') {
      b.phase = b.spec.orbitPhase + b.spec.orbitSpeed * elapsed * ORBIT_TIME;
    }
  }
  place(bodies);
}
