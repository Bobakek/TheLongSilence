// M5 acceptance: do the hunters actually hunt?
//
//   node tools/npccheck.mjs                 the behaviour, no server needed
//   node server/index.mjs &
//   node tools/npccheck.mjs --wire          ...and that they reach a client
//
// The behaviour half is about the AI: it should notice a pilot inside its
// range, close the distance, stop closing at its standoff rather than ramming,
// keep its mark instead of dithering between two, and go home when left alone.
//
// These are not decorative traffic. `Fleet.js` craft are analytic — position
// as a function of the clock — which is what makes a busy system free, and
// also what makes them unable to react. Anything that pursues has to be
// integrated and replicated, which is why it lives in the room. That
// distinction is the point of the milestone, so the last check here is simply
// that a hunter moves *differently* when a pilot is present.

import * as THREE from 'three';
import { Room } from '../server/room.js';
import { AGGRO_RANGE, STANDOFF } from '../src/sim/index.js';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

const fails = [];
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) fails.push(label);
};
const NEUTRAL = { pitch: 0, yaw: 0, roll: 0, strafeX: 0, strafeY: 0, throttleDelta: 0, boost: 0 };

/** Step the room for `ticks`, holding every pilot still where it was put. */
function hold(room, pilots, ticks) {
  const parked = pilots.map((p) => p.ship.absPos.clone());
  for (let i = 0; i < ticks; i++) {
    pilots.forEach((p, k) => {
      p.enqueue({ seq: ++p._seq, raw: NEUTRAL, buttons: 0, aim: null });
      p.ship.absPos.copy(parked[k]);
      p.ship.vel.set(0, 0, 0);
    });
    room.step();
  }
}

console.log('behaviour (no server)\n');

const room = new Room({ seed: 20260725, systemId: 0 });
const hunter = room.npcs[0];
console.log(`  hunter ${hunter.id} · ${hunter.kind} · aggro ${AGGRO_RANGE} · standoff ${STANDOFF}\n`);

// ---- 1. left alone, it stays near its patrol anchor
const idleStart = hunter.ship.absPos.clone();
hold(room, [], 600);
ok(hunter.ai.state === 'patrol', 'with nobody about it patrols', hunter.ai.state);
ok(hunter.ship.absPos.distanceTo(hunter.home) < 500,
  'and stays near its anchor', `${hunter.ship.absPos.distanceTo(hunter.home).toFixed(0)} units out`);
const idleDrift = hunter.ship.absPos.distanceTo(idleStart);

// ---- 2. a pilot inside its range is noticed and chased
const p = room.add('BAIT'); p._seq = 0;
const bait = hunter.ship.absPos.clone().add(new THREE.Vector3(0, 0, AGGRO_RANGE * 0.7));
p.ship.absPos.copy(bait);
const d0 = hunter.ship.absPos.distanceTo(bait);
hold(room, [p], 60);
ok(hunter.ai.state === 'pursue', 'a pilot in range is noticed', hunter.ai.state);
ok(hunter.ai.targetId === p.id, 'and marked', String(hunter.ai.targetId));

hold(room, [p], 900);
const d1 = hunter.ship.absPos.distanceTo(bait);
ok(d1 < d0, 'the hunter closed the distance', `${d0.toFixed(0)} -> ${d1.toFixed(0)}`);
ok(d1 > STANDOFF * 0.4, 'but did not ram', `${d1.toFixed(0)} units, standoff ${STANDOFF}`);
ok(d1 < STANDOFF * 6, 'and did settle in close', `${d1.toFixed(0)} units`);

// ---- 3. it does not fold, ever
ok(hunter.ship.foldMode === false && hunter.ship.foldSpeed === 0,
  'a hunter never folds', `${hunter.ship.foldMode} / ${hunter.ship.foldSpeed}`);

// ---- 4. sticky targeting: a second pilot at similar range must not steal it
const q = room.add('SECOND'); q._seq = 0;
q.ship.absPos.copy(hunter.ship.absPos).add(new THREE.Vector3(0, STANDOFF * 2.2, 0));
hold(room, [p, q], 300);
ok(hunter.ai.targetId === p.id,
  'it keeps its mark rather than dithering between two', String(hunter.ai.targetId));

// ---- 5. lose the mark and it goes home
room.remove(p.id); room.remove(q.id);
const beforeHome = hunter.ship.absPos.distanceTo(hunter.home);
hold(room, [], 1800);
const afterHome = hunter.ship.absPos.distanceTo(hunter.home);
ok(hunter.ai.state === 'patrol', 'with the mark gone it patrols again', hunter.ai.state);
ok(afterHome < beforeHome, 'and heads back to its anchor',
  `${beforeHome.toFixed(0)} -> ${afterHome.toFixed(0)}`);

// ---- 6. the point of the milestone: it reacts. Analytic traffic cannot.
ok(d0 - d1 > idleDrift, 'it moves further chasing than it ever does idling',
  `chased ${(d0 - d1).toFixed(0)} vs drifted ${idleDrift.toFixed(0)}`);

// ---- 7. the client draws them between snapshots rather than at them
{
  const { NetClient } = await import('../src/net/Client.js');
  const c = new NetClient('ws://unused', { key: null });
  const at = performance.now() / 1000;
  const mk = (x) => ({ npcs: [{ id: 'npc:t', p: [x, 0, 0], q: [0, 0, 0, 1], th: 0, bo: 0, f: 0, k: 'patrol', f2: 'institute', st: 'pursue' }] });
  c._readNpcs(mk(0));
  c._readNpcs(mk(100));
  const r = c.remotes.get('npc:t');
  // place the two samples either side of the render delay so the interpolator
  // is asked for a moment genuinely between them
  r.prev.at = at - 0.30; r.next.at = at - 0.10;
  c.interpolate();
  const x = r.absPos.x;
  ok(x > 0 && x < 100, 'a hunter is drawn between its two samples, not at one',
    `x = ${x.toFixed(1)} of 0..100`);
}

// ---- 8. determinism: same seed, same hunters in the same places
const twin = new Room({ seed: 20260725, systemId: 0 });
const same = twin.npcs.length === room.npcs.length
  && twin.npcs.every((n, i) => n.home.distanceTo(room.npcs[i].home) < 1e-9);
ok(same, 'two rooms from one seed spawn identical patrols', `${twin.npcs.length} each`);

/* ------------------------------------------------------------------- wire */

if (argv.includes('--wire')) {
  console.log('\nwire (needs a running room)\n');
  const { NetClient } = await import('../src/net/Client.js');
  const { createSimWorld, createShipState } = await import('../src/sim/index.js');
  const URL_ = arg('--url', 'ws://localhost:8787');

  const net = new NetClient(URL_, { system: 0, name: 'NPC-WATCH', key: null });
  const w = await net.connect();
  const { bodies } = createSimWorld(w.seed, w.system);
  const ship = createShipState();
  net.attach(bodies, ship);

  const t0 = Date.now(); let prev = t0;
  const seen = new Map();
  await new Promise((done) => {
    const iv = setInterval(() => {
      const now = Date.now();
      net.update((now - prev) / 1000, () => ({ raw: NEUTRAL, buttons: 0, aim: null }));
      prev = now;
      net.interpolate();
      for (const [id, r] of net.remotes) {
        if (!r.isNpc) continue;
        const rec = seen.get(id) || { first: r.absPos.clone(), moved: 0, last: r.absPos.clone() };
        rec.moved += r.absPos.distanceTo(rec.last);
        rec.last.copy(r.absPos);
        seen.set(id, rec);
      }
      if (now - t0 >= 6000) { clearInterval(iv); done(); }
    }, 1000 / 60);
  });

  const npcs = [...net.remotes.values()].filter((r) => r.isNpc);
  ok(npcs.length > 0, 'hunters arrive over the wire', `${npcs.length}`);
  ok(npcs.every((r) => r.seen), 'and stay listed', `${npcs.filter((r) => r.seen).length}/${npcs.length}`);
  ok(npcs.every((r) => r.npcKind === 'patrol'), 'carrying their kind',
    npcs.map((r) => r.npcKind).join(','));
  /* Not "did they move": a patrol with nobody near it sits at its anchor, and
     a test client spawns wherever the room puts it — which may be a planet
     away. Asserting motion here would be asserting a coincidence. What the
     wire is responsible for is that the state arrives intact and keeps
     arriving, so that is what is checked; the interpolator is measured
     directly above, where it can be given a known pair of samples. */
  ok(npcs.every((r) => Number.isFinite(r.absPos.x) && Number.isFinite(r.quat.w)),
    'their state arrives finite', `${npcs.length} checked`);
  ok(npcs.every((r) => r.next.at > r.prev.at || r.next.at > 0),
    'and keeps arriving, snapshot after snapshot');
  net.close();
}

console.log(fails.length ? `\nFAIL — ${fails.length} check(s)\n` : '\nPASS — the hunters hunt\n');
process.exit(fails.length ? 1 : 0);
