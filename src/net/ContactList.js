import * as THREE from 'three';
import { fmtDist } from '../ui/HUD.js';

/* ============================================================================
   Who else is out here, and how far.

   A hull is a tenth of a world unit long and a room is measured in thousands,
   so another ship is under a pixel at any distance worth calling one. All that
   is actually drawn of a contact is its beacon — a few pixels somewhere in a
   field of fourteen thousand stars. Finding another pilot by looking is
   therefore close to impossible, which is a strange property for a multiplayer
   game to have, and this list is the fix.

   Sorted by distance, because the only question anyone asks of it is "who is
   nearest". Three rows by default and the rest behind a key: a permanent
   twelve-row panel in the corner of a cockpit is a spreadsheet, not an
   instrument.

   The bearing glyph is worth more than it costs. Distance alone tells you a
   contact exists; distance plus "it is behind you" tells you what to do about
   it, and turning around is the single most common action this list should
   provoke.
   ========================================================================== */

const COLLAPSED_ROWS = 3;
const MAX_ROWS = 12;

const _fwd = new THREE.Vector3();
const _to = new THREE.Vector3();

/** Which of the three hues and labels a contact gets. Matches RemoteShips. */
function classify(r) {
  if (!r.isNpc) return { cls: 'pilot', tag: 'PILOT' };
  if (r.hostile || r.npcKind === 'raider') return { cls: 'raider', tag: 'RAIDER' };
  return { cls: 'patrol', tag: r.npcKind ? r.npcKind.toUpperCase() : 'CONTACT' };
}

/** Ahead, off to one side, or behind. */
function bearing(dot) {
  if (dot > 0.985) return '\u25C6';        // ◆ dead ahead
  if (dot > 0.2) return '\u25B2';          // ▲ ahead
  if (dot > -0.2) return '\u25CF';         // ● abeam
  return '\u25BC';                          // ▼ behind
}

export class ContactList {
  constructor({ onPick = null } = {}) {
    this.root = document.getElementById('contacts');
    this.list = document.getElementById('ctList');
    this.count = document.getElementById('ctCount');
    this.expanded = false;
    this.rows = [];
    this._sig = '';
    this.onPick = onPick;
    /** Id of the contact currently being flown to, for the row highlight. */
    this.navId = null;

    /* One delegated listener rather than one per row: the rows are pooled and
       reused as contacts come and go, so handlers bound to a row would end up
       closed over whichever contact happened to be in it when it was created. */
    this.list?.addEventListener('click', (e) => {
      const row = e.target.closest('.ct-row');
      if (!row || !row._contact) return;
      this.onPick?.(row._contact);
    });
  }

  toggle() { this.expanded = !this.expanded; return this.expanded; }

  show(on) { if (this.root) this.root.classList.toggle('hidden', !on); }

  /**
   * Rebuild from the client's live contact map.
   *
   *   remotes  NetClient.remotes — pilots and hunters together
   *   ship     ours, for range and bearing
   */
  update(remotes, ship) {
    if (!this.root) return;

    _fwd.set(0, 0, -1).applyQuaternion(ship.quat);

    const seen = [];
    for (const r of remotes.values()) {
      if (!r.seen) continue;
      _to.copy(r.absPos).sub(ship.absPos);
      const dist = _to.length();
      _to.multiplyScalar(1 / Math.max(dist, 1e-6));
      seen.push({ r, dist, dot: _to.dot(_fwd) });
    }
    seen.sort((a, b) => a.dist - b.dist);

    this.count.textContent = String(seen.length);
    const shown = seen.slice(0, this.expanded ? MAX_ROWS : COLLAPSED_ROWS);

    /* Rewriting the DOM thirty times a second for a list that changes every
       few seconds is a lot of layout for nothing, so the rendered content is
       hashed and skipped when it has not moved a meaningful amount. Distance
       is bucketed for the same reason: without it the signature changes every
       single frame and the guard never fires. */
    const sig = `${this.expanded}|${this.navId}|` + shown
      .map((s) => `${s.r.id}:${bearing(s.dot)}:${fmtDist(s.dist)}`).join('|');
    if (sig === this._sig) return;
    this._sig = sig;

    while (this.rows.length < shown.length) {
      const el = document.createElement('div');
      el.className = 'ct-row';
      el.innerHTML = '<span class="ct-b"></span><span class="ct-n"></span><span class="ct-d"></span>';
      this.list.appendChild(el);
      this.rows.push({ el, b: el.children[0], n: el.children[1], d: el.children[2] });
    }
    for (let i = shown.length; i < this.rows.length; i++) this.rows[i].el.style.display = 'none';

    for (let i = 0; i < shown.length; i++) {
      const { r, dist, dot } = shown[i];
      const { cls, tag } = classify(r);
      const row = this.rows[i];
      row.el.style.display = '';
      row.el.className = `ct-row ${cls}${r.id === this.navId ? ' nav' : ''}`;
      // what a click on this row means, kept on the element itself
      row.el._contact = r;
      row.b.textContent = bearing(dot);
      row.n.textContent = r.isNpc ? tag : (r.name || `PILOT ${String(r.id).replace(/^p:/, '')}`);
      row.d.textContent = fmtDist(dist);
    }

    // "nobody" is information too — it says the room is empty rather than that
    // the panel is broken.
    if (!this._empty) {
      this._empty = document.createElement('div');
      this._empty.className = 'ct-empty';
      this._empty.textContent = 'NO CONTACTS';
      this.list.appendChild(this._empty);
    }
    this._empty.style.display = seen.length ? 'none' : '';
  }

  dispose() { this.show(false); }
}
