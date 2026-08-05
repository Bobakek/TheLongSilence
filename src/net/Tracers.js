import * as THREE from 'three';

/* ============================================================================
   Bolts, drawn.

   A streak rather than a dot: a bolt covers twenty units in a tick and would
   strobe as a point, so each one is drawn as the short segment it is currently
   crossing, oriented along its own velocity. That is also honest — the segment
   the renderer draws is the segment the room tested for a hit.

   One `LineSegments` for all of them, rewritten each frame. Bolts live two
   seconds, are never interacted with and are replaced wholesale by every
   snapshot, so there is nothing to gain from an object per bolt and a good
   deal of garbage to be avoided.

   Additive and depth-write off, like every other emissive thing in the game;
   depth *test* stays on so a bolt passing behind a hull is occluded by it.
   ========================================================================== */

const MAX = 512;                  // bolts drawn at once; the room caps at 400
const STREAK = 0.05;              // units of visible trail, about half a ship

export class Tracers {
  constructor(scene) {
    this.scene = scene;
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(MAX * 6);
    this.colors = new Float32Array(MAX * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    geo.setDrawRange(0, 0);
    this.geo = geo;

    this.mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.mesh = new THREE.LineSegments(geo, this.mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /**
   * Redraw for this frame.
   *
   *   bolts   the room's last list, each `{ i, o, p, v }`
   *   origin  the floating-origin anchor
   *   mineId  our own `p:<id>`, so our shots read differently from theirs
   */
  update(bolts, origin, mineId) {
    const P = this.positions, C = this.colors;
    let n = 0;

    for (const b of bolts) {
      if (n >= MAX) break;
      const vx = b.v[0], vy = b.v[1], vz = b.v[2];
      const len = Math.hypot(vx, vy, vz) || 1;
      const s = STREAK / len;

      const x = b.p[0] - origin.x, y = b.p[1] - origin.y, z = b.p[2] - origin.z;
      const k = n * 6;
      P[k] = x; P[k + 1] = y; P[k + 2] = z;
      P[k + 3] = x - vx * s; P[k + 4] = y - vy * s; P[k + 5] = z - vz * s;

      // Ours cool, theirs hot — the one thing a pilot needs to read instantly
      // in a fight is which streaks are coming towards them.
      const mine = b.o === mineId;
      const r = mine ? 0.55 : 1.0, g = mine ? 0.85 : 0.45, bl = mine ? 1.0 : 0.25;
      C[k] = r; C[k + 1] = g; C[k + 2] = bl;
      C[k + 3] = r * 0.15; C[k + 4] = g * 0.15; C[k + 5] = bl * 0.15;   // tail fades
      n++;
    }

    this.geo.setDrawRange(0, n * 2);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.mesh.visible = n > 0;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}
