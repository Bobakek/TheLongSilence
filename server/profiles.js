import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/* ============================================================================
   Pilot profiles, on disk.

   What a pilot keeps between sessions is what they earned: the bodies they
   surveyed, the Cantos they attuned to, the logs they recovered and the
   upgrades those paid for. What they do not keep is where they were floating
   and how fast — a saved velocity is a saved accident, and arriving in a fresh
   session at four thousand units a second pointed at a planet is not a feature.
   Flight state is reset; progression is not.

   ------------------------------------------------------------------ identity

   A pilot is identified by a key their own client generated and stored. That
   is identification, NOT authentication: anyone holding the key is that pilot,
   exactly like a bearer token left in a drawer. It is the honest minimum for a
   development server with no accounts, and it is written down here so nobody
   later mistakes it for a login. Real accounts change this file and nothing
   else — the room only ever sees a resolved profile.

   ------------------------------------------------------------------- storage

   One JSON file, rewritten atomically, with writes coalesced. Deliberately not
   a file per pilot: the key comes from the client, and a key is a filename the
   moment you build a path out of it. One object keyed by string cannot be
   talked into escaping a directory.

   A few dozen pilots is what this is for. The Durable Object the plan aims at
   has its own per-room storage and would replace this module outright; nothing
   above it knows the difference.
   ========================================================================== */

const SAVE_DEBOUNCE_MS = 2000;

/** The shape of a stored profile, and the only fields ever read back. */
function blank(name) {
  return {
    name: name || null,
    createdAt: null,          // stamped by the caller; this module has no clock
    seenAt: null,
    system: 0,                // where they left off
    discoveries: [],
    cantos: [],
    logsFound: ['log_seeker'],
    scanRangeMul: 1,
    ship: { maxSpeed: 60, scanRate: 1, foldRegen: 1, hullMax: 1 },
  };
}

export class ProfileStore {
  constructor(path = '.data/pilots.json') {
    this.path = path;
    this.map = new Map();
    this._timer = null;
    this._dirty = false;
    this.load();
  }

  load() {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      for (const [k, v] of Object.entries(raw.pilots || {})) this.map.set(k, v);
      console.log(`[profiles] ${this.map.size} loaded from ${this.path}`);
    } catch (e) {
      /* A corrupt store must not stop the server: a pilot losing progress is
         bad, every pilot losing the ability to connect is worse. Move it aside
         so the next write does not overwrite whatever might be recoverable. */
      const aside = `${this.path}.corrupt-${Date.now()}`;
      try { renameSync(this.path, aside); } catch { /* nothing to move */ }
      console.error(`[profiles] could not read ${this.path} (${e.message}); moved to ${aside}`);
    }
  }

  /** Fetch or create. `now` is passed in so this module needs no clock. */
  get(key, name, now) {
    let p = this.map.get(key);
    if (!p) {
      p = blank(name);
      p.createdAt = now;
      this.map.set(key, p);
      this._dirty = true;
    }
    if (name && p.name !== name) { p.name = name; this._dirty = true; }
    p.seenAt = now;
    return p;
  }

  put(key, profile) {
    this.map.set(key, profile);
    this.touch();
  }

  /** Ask for a write. Coalesced: a busy room saves once every couple of seconds. */
  touch() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.flush(); }, SAVE_DEBOUNCE_MS);
    this._timer.unref?.();
  }

  /** Write now. Temp file plus rename, so a crash mid-write cannot truncate it. */
  flush() {
    if (!this._dirty) return;
    this._dirty = false;
    const dir = dirname(this.path);
    try {
      if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
      const tmp = join(dir || '.', `.pilots.${process.pid}.tmp`);
      const body = JSON.stringify({ version: 1, pilots: Object.fromEntries(this.map) });
      writeFileSync(tmp, body);
      renameSync(tmp, this.path);
    } catch (e) {
      this._dirty = true;                      // try again on the next touch
      console.error(`[profiles] save failed: ${e.message}`);
    }
  }

  get size() { return this.map.size; }
}

/* ------------------------------------------------------ player <-> profile */

/** Apply a stored profile to a freshly created Player. */
export function applyProfile(player, profile) {
  player.discoveries = new Set(profile.discoveries || []);
  player.cantos = [...(profile.cantos || [])];
  player.logsFound = new Set(profile.logsFound || ['log_seeker']);
  player.scanRangeMul = profile.scanRangeMul ?? 1;
  const s = profile.ship || {};
  player.ship.maxSpeed = s.maxSpeed ?? 60;
  player.ship.scanRate = s.scanRate ?? 1;
  player.ship.foldRegen = s.foldRegen ?? 1;
  player.ship.hullMax = s.hullMax ?? 1;
  /* Deliberately not restored: absPos, vel, quat, hull, foldCharge, foldMode.
     Those are the state of one moment in one system, and the room places
     arrivals itself. A pilot resumes with what they earned, not where they
     happened to be drifting. */
  return player;
}

/** Read a Player back out into something storable. */
export function captureProfile(player, systemId, now) {
  return {
    name: player.name,
    system: systemId,
    seenAt: now,
    discoveries: [...player.discoveries],
    cantos: [...player.cantos],
    logsFound: [...player.logsFound],
    scanRangeMul: player.scanRangeMul,
    ship: {
      maxSpeed: player.ship.maxSpeed,
      scanRate: player.ship.scanRate,
      foldRegen: player.ship.foldRegen,
      hullMax: player.ship.hullMax,
    },
  };
}
