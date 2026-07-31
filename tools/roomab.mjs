// Room vs client stepper, same inputs, no network.
//
// Aligned by *consumed input*, not by tick number: the room has a jitter
// cushion, so at any moment it has consumed fewer inputs than the client has
// produced, and comparing them at the same tick compares two different points
// in the same stream. The client is stepped with whichever input the room just
// consumed, so both sides have eaten exactly the same packets in the same order.
import { Room } from '../server/room.js';
import {
  createSimWorld, createShipState, stepShip, createQuietHost, seekSystem,
} from '../src/sim/index.js';
import { TICK_DT, quantizeInput, BTN } from '../src/net/protocol.js';

const room = new Room({ seed: 20260725, systemId: 0 });
const p = room.add('A');

const { bodies } = createSimWorld(20260725, 0);
const ship = createShipState();
ship.absPos.copy(p.ship.absPos);
const host = createQuietHost(ship);

/* A unit is a kilometre and the trace spends most of its time in a fold at
   several thousand units a second, so a micron of drift after twelve hundred
   ticks is double-precision noise — about 1e-13 relative. The bar is the same
   millimetre `predictcheck` uses: below it, the two are running one set of
   rules; above it, they are not. */
const TOLERANCE = 1e-3;

const N = 1200;
const byId = new Map();
let firstDiff = -1;
let prevButtons = 0;
let clientSteps = 0;

for (let i = 1; i <= N; i++) {
  const t = i * TICK_DT;
  const buttons = (i % 60 === 17 ? BTN.FOLD : 0) | (i % 200 < 40 ? BTN.BOOST : 0);
  const raw = quantizeInput({
    pitch: Math.sin(t * 0.9) * 0.8,
    yaw: Math.cos(t * 0.6 + 1) * 0.7,
    roll: Math.sin(t * 1.7) * 0.4,
    strafeX: (i % 150 < 20) ? 0.8 : 0,
    strafeY: 0,
    throttleDelta: 1,
  }, buttons);
  byId.set(i, { raw, buttons });

  p.enqueue({ seq: i, raw, buttons });
  const before = p.lastSeq;
  room.step(TICK_DT);

  // Step the client with exactly what the room just ate, and on the room's
  // own tick number so the envelope sees the same planets.
  if (p.lastSeq !== before) {
    const cmd = byId.get(p.lastSeq);
    seekSystem(bodies, room.tick * TICK_DT);
    host.events = [];
    stepShip(ship, bodies, TICK_DT, { raw: cmd.raw, buttons: cmd.buttons, prevButtons }, host);
    prevButtons = cmd.buttons;
    clientSteps++;

    const d = ship.absPos.distanceTo(p.ship.absPos);
    if (d > TOLERANCE && firstDiff < 0) {
      firstDiff = i;
      console.log(`first divergence at input ${p.lastSeq} (room tick ${room.tick}), ${d.toExponential(3)} units`);
      console.log('  pos client', ship.absPos.toArray().map((n) => n.toFixed(6)).join(', '));
      console.log('  pos server', p.ship.absPos.toArray().map((n) => n.toFixed(6)).join(', '));
      console.log('  vel client', ship.vel.toArray().map((n) => n.toFixed(6)).join(', '));
      console.log('  vel server', p.ship.vel.toArray().map((n) => n.toFixed(6)).join(', '));
      console.log('  fold client', ship.foldMode, ship.foldSpeed.toFixed(3),
        ' server', p.ship.foldMode, p.ship.foldSpeed.toFixed(3));
    }
  }

  if (!Number.isFinite(ship.vel.x) || !Number.isFinite(p.ship.vel.x)) {
    console.log(`\nNaN at input ${i}: client vel ${ship.vel.x} server vel ${p.ship.vel.x}`);
    console.log('  client fold', ship.foldMode, 'foldSpeed', ship.foldSpeed, 'throttle', ship.throttle);
    console.log('  server fold', p.ship.foldMode, 'foldSpeed', p.ship.foldSpeed);
    console.log('  client quat', ship.quat.toArray().join(', '));
    console.log('  client pos', ship.absPos.toArray().join(', '));
    break;
  }
}

console.log(`\nclient steps ${clientSteps}, room lastSeq ${p.lastSeq}, starved ${p.starved}`);
console.log('  pos delta', ship.absPos.distanceTo(p.ship.absPos).toExponential(3));
console.log('  vel delta', ship.vel.distanceTo(p.ship.vel).toExponential(3));
console.log(firstDiff < 0
  ? `\nPASS — room and client run one set of rules (drift under ${TOLERANCE} units)\n`
  : `\nFAIL — diverged at input ${firstDiff}; the rules differ\n`);
process.exit(firstDiff < 0 ? 0 : 1);
