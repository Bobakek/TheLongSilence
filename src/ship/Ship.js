import * as THREE from 'three';
import { buildHull } from './hull.js';
import { createShipState, stepFlight } from '../sim/flight.js';

/* ------------------------------------------------------------- flight model

   The model itself lives in `src/sim/flight.js`, because the server has to run
   the same one. What is left here is the hull: the geometry, the drive glow,
   the radiators, the dish and the strobe — everything the simulation has no
   opinion about. `Ship` holds the flight state as its own fields (that is what
   `createShipState` is mixed in for), so every existing reader — `Game`, the
   HUD, the cockpit instruments, `tools/` — keeps working unchanged. */

export class Ship {
  constructor() {
    const built = buildHull();
    this.object = new THREE.Group();
    this.model = built.root;
    this.object.add(this.model);
    this.engineMats = built.engineMats;
    this.radiator = built.radiator;
    this.vanes = built.vanes;
    this.dishPivot = built.dishPivot;
    this.strobe = built.strobe;
    this.nacelles = built.nacelles;
    this.gear = built.gear;
    this.length = built.length;

    // The flight state, from the one place that defines it. A server-side ship
    // is this object and nothing else, which is what keeps the two in step.
    Object.assign(this, createShipState());

    this._fwd = new THREE.Vector3();
  }

  /** Gear is down only on the ground; in flight it is stowed and invisible. */
  deployGear(on) { if (this.gear) this.gear.visible = !!on; }

  get forward() { return this._fwd.set(0, 0, -1).applyQuaternion(this.quat); }
  get speed() { return this.vel.length(); }

  update(dt, input, env) {
    stepFlight(this, dt, input, env);
    this.object.quaternion.copy(this.quat);
    this.updateVisuals(dt, env.time);
  }

  /* Everything the hull does that is not flight: the drive, the radiators, the
   * dish and the strobe.
   *
   * Split out because the landed branch of Game.update returns long before
   * `update` — there is no flight to integrate on the ground — and the plume's
   * decay lived at the bottom of it. `land()` sets throttle to zero, but
   * `this.power` is a spring toward the throttle and nothing was stepping it,
   * so it froze at whatever it held on the approach and the ship sat parked on
   * a planet with both engines at full burn for the length of the landing. */
  updateVisuals(dt, time) {
    const power = this.foldMode ? 1.6
      : THREE.MathUtils.clamp(this.throttle * (1 + this.boost * 1.2), 0, 1.6);
    this.power = (this.power || 0) + (power - (this.power || 0)) * Math.min(1, dt * 6);
    for (const m of this.engineMats) {
      m.uniforms.uTime.value = time;
      m.uniforms.uPower.value = this.power;
    }

    // Waste heat lags the drive by a long way — the vanes are still glowing
    // minutes after a burn, which is the detail that sells them as radiators
    // rather than as wings.
    this.heatGlow = (this.heatGlow || 0) + (this.power * 0.42 + this.heat * 0.35 - (this.heatGlow || 0))
      * Math.min(1, dt * 0.28);
    // Radiators run a few hundred kelvin, not orange-hot. Anything more than a
    // faint ember reads as damage.
    this.radiator.emissiveIntensity = this.heatGlow * 0.28;

    // The vanes open wider under load to present more area, and settle back
    // when the drive is cold. Slow — they are structures, not control surfaces.
    for (let i = 0; i < this.vanes.length; i++) {
      const s = i === 0 ? 1 : -1;
      const g = this.vanes[i];
      const want = g.userData.baseZ + s * this.heatGlow * 0.26;
      g.rotation.z += (want - g.rotation.z) * Math.min(1, dt * 0.9);
    }
    this.dishPivot.rotation.y += dt * 0.10;
    this.dishPivot.rotation.z = Math.sin(time * 0.21) * 0.16;

    // anti-collision strobe: a double flash, then a long gap
    const cyc = (time * 0.72) % 1;
    const flash = (cyc < 0.035 || (cyc > 0.09 && cyc < 0.125)) ? 6.0 : 0.0;
    this.strobe.material.color.setRGB(flash, flash, flash);
  }
}
