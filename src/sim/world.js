import * as THREE from 'three';
import { generateGalaxy, generateSystem } from '../world/generate.js';
import { positionSystem } from './orbits.js';

/* A system as the simulation sees it: body records with a kind, a radius, a
   spec and a position, and no meshes.

   The browser builds the same records in `Game.loadSystem` and hangs a `Planet`
   or a `Star` off each one. Nothing in `src/sim` ever looks at those, so the
   two body lists are interchangeable as far as the model is concerned — which
   is what makes server and client agree without sharing a renderer.

   Only the bodies that steer a ship are here: the star, the planets and their
   moons. Stations, anomalies and traffic are targets and conversation, and
   nothing in the flight model reads them — `isMassive` filters them out on the
   client too. They arrive when the server needs to arbitrate scanning. */

export function buildSimBodies(sys, stub) {
  const bodies = [];

  bodies.push({
    kind: 'star',
    name: sys.star.name,
    radius: sys.star.radius,
    absPos: new THREE.Vector3(0, 0, 0),
    spec: sys.star,
    id: `star:${stub.name}`,
  });

  for (const ps of sys.planets) {
    const body = {
      kind: 'planet',
      name: ps.name,
      radius: ps.radius,
      absPos: new THREE.Vector3(),
      spec: ps,
      id: `planet:${ps.name}`,
      phase: ps.orbitPhase,
    };
    bodies.push(body);

    for (const ms of ps.moons) {
      bodies.push({
        kind: 'moon',
        name: ms.name,
        radius: ms.radius,
        absPos: new THREE.Vector3(),
        spec: ms,
        id: `moon:${ms.name}`,
        parent: body,
        phase: ms.orbitPhase,
      });
    }
  }

  // Settle the orbits before anyone reads a position, exactly as loadSystem
  // does before it places the ship.
  positionSystem(bodies, 0);
  return bodies;
}

/** Everything a headless tick needs, from a seed and a system index. */
export function createSimWorld(seed, systemId = 0, count = 14) {
  const galaxy = generateGalaxy(seed, count);
  const stub = galaxy[systemId];
  const sys = generateSystem(stub);
  return { galaxy, stub, sys, bodies: buildSimBodies(sys, stub) };
}

/**
 * The no-op side of the host contract in `proximity.js`.
 *
 * The server has no autopilot to cancel and no camera to shake, but it does
 * have to drop the fold — that bleeds off velocity, which is authoritative —
 * so `setFold` is a real hook rather than a stub, and the caller supplies it.
 */
export function createHostStub(onFold) {
  return {
    shake: 0,
    proximityWarn: null,
    events: [],
    cancelAutopilot(quiet) { this.events.push({ type: 'autopilotOff', quiet: !!quiet }); },
    setFold(on) { this.events.push({ type: 'fold', on: !!on }); if (onFold) onFold(on); },
  };
}
