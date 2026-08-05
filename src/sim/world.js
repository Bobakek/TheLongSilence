import * as THREE from 'three';
import { generateGalaxy, generateSystem, mulberry32 } from '../world/generate.js';
import { positionSystem } from './orbits.js';

export const RESONATOR_COUNT = 7;

/* Which systems hold a Resonator.
 *
 * Lifted verbatim out of `Game.boot`. It has to be here because the server
 * decides whether a scan attunes anybody, and that answer depends on this set
 * — a room that disagreed with its clients about which system holds an
 * instrument would refuse a Canto the pilot could see on their own screen. */
export function resonatorSystemsFor(galaxySeed, galaxy) {
  const rr = mulberry32(galaxySeed ^ 0x9e37);
  const ids = galaxy.map((s) => s.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rr() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return new Set([0, ...ids.filter((i) => i !== 0).slice(0, RESONATOR_COUNT - 1)]);
}

export function resonatorIndexFor(resonatorSystems, sysId) {
  return [...resonatorSystems].sort((a, b) => a - b).indexOf(sysId) + 1;
}

/* The bounding radius each kind of anomaly is scanned and framed against.
   Constants in `Game._placeAnomalies` too — unlike a station's, which is drawn
   from the middle of its mesh generator's RNG stream and therefore cannot be
   known without building the mesh. That is why stations are not in the sim
   body list yet; see the note in buildSimBodies. */
export const ANOMALY_RADIUS = {
  resonator: 3.4,
  derelict: 1.3,
  wreck: 2.2,
  beacon: 0.6,
};

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

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
function romanize(n) { return ROMAN[n] || String(n); }

/**
 * Where the anomalies are, and what they are.
 *
 * The placement half of `Game._placeAnomalies`, with the mesh building left
 * behind — `buildResonator` and friends reach for canvas textures, which is
 * exactly the sort of thing the server must not need. The RNG stream is
 * untouched and drawn in the same order, so both processes put the same
 * Resonator in the same place with the same id.
 */
export function placeAnomalies(sys, stub, resonatorSystems, logIds = []) {
  const rnd = mulberry32(stub.seed ^ 0x5eed);
  const list = [];

  if (resonatorSystems.has(stub.id)) list.push({ type: 'resonator' });
  const n = 2 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const r = rnd();
    list.push({ type: r < 0.34 ? 'derelict' : r < 0.68 ? 'wreck' : 'beacon' });
  }

  const out = [];
  let idx = 0;
  for (const a of list) {
    const host = sys.planets[Math.floor(rnd() * sys.planets.length)];
    const ang = rnd() * Math.PI * 2;
    const rad = host.radius * (2.4 + rnd() * 4.0);
    const off = new THREE.Vector3(Math.cos(ang) * rad, (rnd() - 0.5) * rad * 0.7, Math.sin(ang) * rad);

    const kind = a.type;
    let name;
    if (kind === 'resonator') name = `RESONATOR ${romanize(resonatorIndexFor(resonatorSystems, stub.id))}`;
    else if (kind === 'derelict') name = `${stub.name} STATION ${String.fromCharCode(65 + idx)}`;
    else if (kind === 'wreck') name = `WRECKAGE ${stub.designation}-${idx + 1}`;
    else name = `BEACON ${stub.designation}-${idx + 1}`;

    out.push({
      kind: 'anomaly', anomalyType: kind, name,
      radius: ANOMALY_RADIUS[kind],
      absPos: new THREE.Vector3(),
      hostSpec: host, offset: off,
      id: `anom:${stub.name}:${idx}`,
      logId: kind === 'wreck' && logIds.length ? logIds[idx % Math.max(1, logIds.length - 1)] : null,
    });
    idx++;
  }
  return out;
}

export function buildSimBodies(sys, stub, opts = {}) {
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

  /* Anomalies, which is where the Resonators are and therefore the only
     scannable content the room genuinely has to arbitrate.

     Stations and traffic are deliberately absent. A station's radius is drawn
     from the middle of `buildStation`'s own RNG stream (`RING_R` at
     Station.js:1252), so knowing it means building the mesh, which means
     canvas textures, which the server has not got. Scanning those two kinds
     therefore stays client-side for now — a real gap, listed as such, and
     closed by making the station radius a pure function of its seed. */
  if (opts.resonatorSystems) {
    for (const a of placeAnomalies(sys, stub, opts.resonatorSystems, opts.logIds)) bodies.push(a);
  }

  // Settle the orbits before anyone reads a position, exactly as loadSystem
  // does before it places the ship.
  positionSystem(bodies, 0);
  return bodies;
}

/** Everything a headless tick needs, from a seed and a system index. */
export function createSimWorld(seed, systemId = 0, count = 14, opts = {}) {
  const galaxy = generateGalaxy(seed, count);
  const stub = galaxy[systemId];
  const sys = generateSystem(stub);
  const resonatorSystems = opts.resonatorSystems || resonatorSystemsFor(seed, galaxy);
  const bodies = buildSimBodies(sys, stub, { ...opts, resonatorSystems });
  return { galaxy, stub, sys, bodies, resonatorSystems };
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
