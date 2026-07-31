// M0 acceptance: does src/sim fly the same ship in Node as it does in a tab?
//
//   node tools/determinism.mjs                     run in Node, print a summary
//   node tools/determinism.mjs --out node.json     ...and save the trace
//   node tools/determinism.mjs --cmp a.json b.json compare two saved traces
//
// The browser side does not need Playwright: `window.__simTrace` is hung on the
// window at import time by src/main.js, so any page served by `npm run dev`
// can produce a trace without the game booting. Save it next to the Node one
// and compare with --cmp.
//
// Bit-identical output is not the bar and never was — Math.sin is not specified
// to the last bit across engines. What must match is the *rules*: the same fold
// refusals, the same envelope entries, the same branches. Those show up as
// counters, and a rule that differs shows up as a divergence that grows without
// bound rather than one that stays in the noise.

import { readFileSync, writeFileSync } from 'node:fs';
import { runTrace, compareTraces } from '../src/sim/trace.js';

// Positions are in world units, one unit = one kilometre. A metre of drift
// after ten thousand ticks is rounding; a kilometre is a different branch.
const POS_TOLERANCE = 1e-3;

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? true);
};

function fmt(n) {
  if (n === 0) return '0';
  if (Math.abs(n) < 1e-4) return n.toExponential(2);
  return n.toFixed(6);
}

function report(cmp, aName, bName) {
  console.log(`\ncompared ${cmp.compared} samples · ${aName} vs ${bName}`);
  for (const p of cmp.problems) console.log(`  RULE MISMATCH: ${p}`);
  console.log(`  max position divergence  ${fmt(cmp.maxPos)} units (worst at tick ${cmp.atTick})`);
  console.log(`  max velocity divergence  ${fmt(cmp.maxVel)} units/s`);
  console.log(`  max quaternion component ${fmt(cmp.maxQuat)}`);
  console.log(`  max scalar (hull/charge) ${fmt(cmp.maxScalar)}`);

  const ok = cmp.problems.length === 0 && cmp.maxPos <= POS_TOLERANCE;
  console.log(ok
    ? `\nPASS — same rules, divergence within ${POS_TOLERANCE} units\n`
    : `\nFAIL — see above\n`);
  return ok;
}

if (flag('--cmp')) {
  const i = argv.indexOf('--cmp');
  const aPath = argv[i + 1], bPath = argv[i + 2];
  if (!aPath || !bPath) {
    console.error('usage: node tools/determinism.mjs --cmp <a.json> <b.json>');
    process.exit(2);
  }
  const a = JSON.parse(readFileSync(aPath, 'utf8'));
  const b = JSON.parse(readFileSync(bPath, 'utf8'));
  process.exit(report(compareTraces(a, b), aPath, bPath) ? 0 : 1);
}

const ticks = +(flag('--ticks') || 0) || undefined;
const t0 = process.hrtime.bigint();
const trace = runTrace(ticks ? { ticks } : {});
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

console.log(`system ${trace.meta.systemName} · ${trace.meta.bodies} bodies · `
  + `${trace.meta.ticks} ticks @ ${trace.meta.dt.toFixed(5)}s · ${ms.toFixed(0)} ms`);
console.log(`start body ${trace.meta.planet}`);
console.log('counters', trace.counters);
console.log('final absPos', trace.final.absPos.map((v) => +v.toFixed(6)));
console.log('final vel   ', trace.final.vel.map((v) => +v.toFixed(6)));
console.log('final hull  ', +trace.final.hull.toFixed(6),
  '· foldCharge', +trace.final.foldCharge.toFixed(6));

/* A trace that never entered the envelope, or never had a fold both refused
   and granted, has not visited the branches it exists to visit — and would
   compare clean while proving nothing at all. Say so loudly. */
const gaps = [];
if (trace.counters.envelopeTicks === 0) gaps.push('the approach envelope was never entered');
if (trace.counters.foldRefusals === 0) gaps.push('no fold was ever refused (canFold untested)');
if (trace.counters.foldEngaged === 0) gaps.push('no fold was ever granted');
if (trace.counters.autopilotCancels === 0) gaps.push('the envelope never went deep enough to cut the drive');
if (gaps.length) {
  console.log('\nCOVERAGE GAPS — this trace does not test what it claims to:');
  for (const g of gaps) console.log(`  · ${g}`);
}

/* One branch stays untested on purpose, and it should be said out loud rather
   than quietly counted as covered: the hard floor inside the envelope, where
   the ship is snapped to the surface and scrapes its hull. Entries at 4000 and
   even 40000 units/s never reach it — the velocity bleed is stiff enough to
   stop everything short — which is exactly what the envelope is for. If a
   future change makes it reachable, `hull` will drop below 1 here. */
if (trace.final.hull === 1) {
  console.log('\nNOTE: the hard floor was never reached (hull intact) — the envelope held,'
    + '\n      so the snap-to-surface branch is not covered by this trace.');
}

const out = flag('--out');
if (out && typeof out === 'string') {
  writeFileSync(out, JSON.stringify(trace));
  console.log(`\nwrote ${out}`);
}
