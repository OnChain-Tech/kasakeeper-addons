// KasaKeeper — state persistence (localStorage) + scheduling. Multi-home, generic.
const KEY = 'kasakeeper.v1';
// Device-local snapshot of the last state this device knows the SERVER held —
// the common ancestor for the 3-way field-level merge in _mergeState/_mergeRow.
// Lives under its own key (never posted, never part of Store.state) so a
// corrupt/missing snapshot can never contaminate the synced document itself.
const BASE_KEY = 'kasakeeper.v1.base';
// Device-local home selection (DEFECT G). Lives outside the synced document
// entirely — see the note above _resolveHomeId() for why state.currentHomeId
// itself can no longer be trusted as this device's choice once two devices
// are browsing different homes.
const HOME_KEY = 'kasakeeper.v1.home';
const DAY = 86400000;
// The id-keyed collections in shared state — kept in one place because server.py's
// /api/state shape-check validates exactly this list (each must be a list).
const ID_KEYED = ['homes', 'assets', 'tasks', 'providers', 'quotes', 'logs', 'mail'];
// Per-home overrides for prefs that used to be global-only. Store.homeSetting()
// resolves home.settings[key] -> the legacy global state.settings[key] -> this
// documented default, so an old client (which only ever wrote the global key)
// keeps working unchanged and a new client can override per home. Nothing here
// is written eagerly — see the note on Store.homeSetting() for why that matters.
const HOME_SETTING_DEFAULTS = { soonDays: 30, notifyTarget: '' };
// The only window costUpcoming() is ever called with (app.js's dashboard
// uses costUpcoming(90)) — overdueTasks() below reuses it to bound how far a
// future-dated covering booking can reach before it stops suppressing the
// task's own overdue estimate. Without a bound, a booking dated months out
// hides the task's debt from costOverdue() while costUpcoming(90) can't see
// far enough out to pick it up either — the money vanishes from both sums.
const ATTENTION_WINDOW_DAYS = 90;
// _mergeRow's per-top-level-field comparison (see below) is too coarse for a
// few known nested objects: asset.ha, asset.usage, asset.recall, asset.pack,
// and a home's own settings (home.settings, distinct from the top-level
// state.settings which already gets field-level treatment directly). Each of
// these is a small plain object two devices can independently edit DIFFERENT
// sub-fields of in the same sync window (SD-6: a tablet re-links asset.ha.deviceId
// while the phone's fault scanner adds an entry to the SAME asset's
// asset.ha.watch) — treating the whole object as one field means whichever
// side's edit is "the field" wins outright and the other's is silently
// dropped. Recursing exactly one level deeper for these keys lets sibling
// sub-fields merge independently, same rule, same base/local/server 3-way
// diff, just one level down. Deliberately NOT deeper than that: ha.watch and
// ha.entities are arrays/objects holding an atomic list a single UI action
// (setWatch, a device re-link) always rewrites wholesale, so item-level
// merging inside them would need id-aware union logic this generic merge
// doesn't have — they stay whole-value at the second level, same as
// task.fault stays whole-value at the first (see _mergeRow's own comment).
const NESTED_MERGE_KEYS = new Set(['ha', 'usage', 'recall', 'pack', 'settings']);
const _isPlainObj = v => v != null && typeof v === 'object' && !Array.isArray(v);

const Store = {
  state: null,
  rev: 0,            // server revision this device last saw
  _pushTimer: null,

  load() {  // instant boot from the local cache; syncRemote() reconciles with the Green after
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      this.state = s && s.homes ? s : JSON.parse(JSON.stringify(SEED));
    } catch { this.state = JSON.parse(JSON.stringify(SEED)); }
    if (!this.state.settings) this.state.settings = JSON.parse(JSON.stringify(SEED.settings));
    if (!this.state.homes) this.state.homes = [];
    if (!this.state.quotes) this.state.quotes = [];
    if (!this.state.mail) this.state.mail = [];      // email correspondence per trade
    if (!this.state.tombstones) this.state.tombstones = [];   // deleted ids — see _mergeState
    // Home selection is device-local (DEFECT G) — resolve it from HOME_KEY,
    // falling back to whatever this device's own cached copy last had. A
    // pre-migration client (no HOME_KEY yet) pins its existing
    // state.currentHomeId here on first load and every load after keeps
    // reading from HOME_KEY, same idea as haUrl/haToken.
    this.state.currentHomeId = this._resolveHomeId(this.state.homes, this.state.currentHomeId);
    // First run after this device gets the 3-way merge — seed a base snapshot
    // from what we've got so the next merge has something to diff against.
    // Never overwritten here once present; only _saveBase() (from a 200 push
    // or an outright adopt) moves it forward.
    if (!localStorage.getItem(BASE_KEY)) this._saveBase(this._shareable());
    return this.state;
  },
  save() {
    localStorage.setItem(KEY, JSON.stringify(this.state));
    clearTimeout(this._pushTimer);                       // debounce the server write
    this._pushTimer = setTimeout(() => Store.push(), 1500);
  },

  // ---- multi-device shared store (lives in the add-on's /data on the Green) ----
  // Returns 'adopted' (server copy taken), 'pushed' (local migrated up), 'same', or false.
  // HA direct-mode credentials are DEVICE-LOCAL: the long-lived token must never
  // ride the shared store (any ingress user can read /api/state). Stripped before
  // every push, re-applied from this device's copy whenever a server state is adopted.
  // Pure — strips device-local HA credentials out of an arbitrary state object
  // (not necessarily this.state). Shared by _shareable() (the live push
  // payload) and the base-snapshot writer, so both go through one definition
  // of "safe to leave this device".
  _strip(state) {
    const { haUrl, haToken, ...settings } = (state && state.settings) || {};
    // Per-home HA source (home.ha, see homeHA()) is meant to carry only
    // {mode,url} — url is just an address, fine to sync. A token must never
    // land here even if something upstream mistakenly set one, same rule as
    // the legacy global haToken above.
    const homes = ((state && state.homes) || []).map(h => {
      if (!h || !h.ha) return h;
      const { haToken, token, ...ha } = h.ha;
      return { ...h, ha };
    });
    return { ...state, settings, homes };
  },
  _shareable() { return this._strip(this.state); },
  // `state` is what this device now holds locally (a plain server copy, or a
  // merge result that may include edits the server hasn't seen yet).
  // `serverState` — when given — is what the server is actually known to hold
  // right now (the raw GET/409 body); the merge ancestor MUST be this, not our
  // merged copy, or a field-level edit that never reaches the server (no row
  // was rescued, so syncRemote never pushes it) gets recorded as "the server
  // has this" and is silently lost on the next conflict. Omit serverState for
  // a plain adopt of an already-server-shaped copy (state IS the server copy).
  _adopt(state, serverState) {
    const keep = this.state.settings || {};
    this.state = state;
    this.state.settings = { ...(state.settings || {}), haUrl: keep.haUrl, haToken: keep.haToken };
    if (!this.state.tombstones) this.state.tombstones = [];   // legacy server copy predating tombstones
    // Defensive strip on the way in too — an adopted server/merged copy must
    // never seed a per-home token into localStorage.
    (this.state.homes || []).forEach(h => { if (h && h.ha) { delete h.ha.haToken; delete h.ha.token; } });
    // currentHomeId is device-local (DEFECT G) — an adopted/merged copy must
    // never silently switch this device to whatever home another device had
    // open. Re-resolve from HOME_KEY exactly like haUrl/haToken above,
    // falling back to whatever the adopted state itself carries, then the
    // first home.
    this.state.currentHomeId = this._resolveHomeId(this.state.homes, this.state.currentHomeId);
    localStorage.setItem(KEY, JSON.stringify(this.state));
    // Reset the merge snapshot to what the SERVER holds so the NEXT conflict
    // diffs against the true common ancestor, not a merged-but-unpushed copy.
    this._saveBase(this._strip(serverState || state));
  },
  // ---- device-local home selection (DEFECT G) ----
  // _mergeState's `merged = {...serverState}` takes the server's copy of
  // every top-level scalar outright, currentHomeId included — exactly the
  // bug: switch to home h2 on this device, push, and the next sync's merge
  // silently put you back on whatever home the OTHER device last had
  // selected. upsertAsset then filed new assets under the WRONG home, and
  // the 409 branch calls render() so the UI visibly jumped mid-use. Home
  // selection is now device-local: HOME_KEY, never posted, never part of
  // Store.state on disk.
  _loadHomeId() { try { return localStorage.getItem(HOME_KEY); } catch { return null; } },
  _saveHomeId(id) { try { id ? localStorage.setItem(HOME_KEY, id) : localStorage.removeItem(HOME_KEY); } catch {} },
  // Resolves which home THIS device should be viewing: its own saved
  // selection (HOME_KEY) if it still names a home in `homes`; else
  // `fallback` (typically the adopted/loaded state's own currentHomeId —
  // the server's pick, or a pre-migration client's own last-known value) if
  // that still resolves; else the first home. Always re-saves the result so
  // HOME_KEY tracks the resolved id from the very first load, including a
  // fresh install or a pre-HOME_KEY client's first run under this code.
  _resolveHomeId(homes, fallback) {
    const list = Array.isArray(homes) ? homes : [];
    const local = this._loadHomeId();
    const id = (local && list.some(h => h.id === local)) ? local
      : (fallback && list.some(h => h.id === fallback)) ? fallback
      : (list[0] || {}).id || null;
    this._saveHomeId(id);
    return id;
  },
  // ---- device-local base snapshot (3-way merge ancestor) ----
  // Stored under its own localStorage key — see BASE_KEY. Never posted to the
  // server, never read by anything but _mergeState. A missing or corrupt
  // snapshot (fresh install between load() and its first save, JSON.parse
  // throws, quota errors on write) must never throw and must never block a
  // sync — callers treat a null base as "no snapshot available" and fall back
  // to the pre-3-way server-wins-per-row behaviour (see _mergeState). Note
  // that's a DEGRADE, not a silent-wrong-data bug — a null base just means
  // the server row wins per-field this one cycle, same as before merge
  // existed. The failure mode this pair guards against is the opposite one:
  // a STALE base that parses fine but describes a sync state older than
  // reality, which would make an already-synced field misread as a fresh
  // local edit forever (see _saveBase below) — so both a corrupt read and a
  // failed write clear BASE_KEY outright rather than leaving old bytes
  // sitting there.
  _loadBase() {
    try {
      const raw = localStorage.getItem(BASE_KEY);
      if (!raw) return null;
      const b = JSON.parse(raw);
      if (b && typeof b === 'object') return b;
    } catch { /* fall through to the clear below */ }
    try { localStorage.removeItem(BASE_KEY); } catch {}   // corrupt/malformed — don't leave it to poison every future merge
    return null;
  },
  // `strippedState` must already be the shareable (token-stripped) shape —
  // callers pass either this._shareable() or the exact payload just posted.
  _saveBase(strippedState) {
    try { localStorage.setItem(BASE_KEY, JSON.stringify(strippedState)); }
    catch {
      // A failed write must not leave the PREVIOUS (now stale) snapshot in
      // place — that reads as "still synced to what we last successfully
      // saved", when the real server has since moved past it. Null (via
      // _loadBase's same missing-key path) degrades safely to server-wins;
      // a stale base degrades to silently-wrong local data winning forever.
      try { localStorage.removeItem(BASE_KEY); } catch {}
    }
  },
  // Record a delete so a stale device's later push can't resurrect it — see the
  // merge policy in _mergeState. Every delete* method below calls this with the
  // id(s) it just removed (cascaded children included) before Store.save().
  // Capped at 400: oldest tombstones drop off first — by the time a tombstone is
  // that old, every device has long since synced past it, so there's nothing
  // left it needs to guard against.
  _tombstone(ids) {
    if (!this.state.tombstones) this.state.tombstones = [];
    const at = Store.localISO();
    (Array.isArray(ids) ? ids : [ids]).forEach(id => { if (id) this.state.tombstones.push({ id, at }); });
    if (this.state.tombstones.length > 400) this.state.tombstones = this.state.tombstones.slice(-400);
  },
  // Field-level 3-way merge for ONE row that exists on both sides of a sync
  // conflict. `base` is this device's last-known-synced snapshot of the row
  // (undefined if we never had one, e.g. a row the OTHER device created —
  // every field then reads as "not in base", same as a genuine local edit).
  // The result STARTS from the server row (untouched fields inherit whatever
  // the server currently holds, including a field the server has since
  // dropped) — any field whose local value differs from the base snapshot is
  // a genuine local edit made since our last sync and is re-applied on top; a
  // field the snapshot had but local no longer does (an explicit delete, e.g.
  // Store.unsnoozeTask's `delete t.snoozed`) is removed from the result the
  // same way, not silently resurrected by the server's copy. Comparison is
  // per top-level field (JSON-equal), not deep — with ONE documented
  // exception: a field named in NESTED_MERGE_KEYS (ha, usage, recall, pack,
  // settings — see its comment) whose base/local/server values are ALL plain
  // objects gets the same 3-way diff applied one level deeper instead of
  // being swapped wholesale, so two devices editing different sub-fields of
  // the same nested object (asset.ha.deviceId vs asset.ha.watch) both
  // survive. `depth` bounds that recursion to exactly one extra level — every
  // other field, including any field NOT in that set (task's whole `fault`
  // object, an asset's whole `usage` when the row is brand-new to this
  // device and has no base to diff against) stays whole-value, which is
  // exactly the granularity markDone's fault-clearing mutates at. Returns
  // { result, changed } — `changed` is true whenever a local field was
  // re-applied on top of the server row, so callers (see _mergeState) know a
  // field-level edit exists that the server has never seen and must be
  // pushed back, not just a rescued whole row.
  _mergeRow(base, local, server, depth = 1) {
    base = base || {};
    local = local || {};
    server = server || {};
    const result = { ...server };
    let changed = false;
    const keys = new Set([...Object.keys(base), ...Object.keys(local)]);
    keys.forEach(k => {
      if (JSON.stringify(base[k]) === JSON.stringify(local[k])) return;   // untouched since the snapshot -> server's value stands
      changed = true;
      if (!Object.prototype.hasOwnProperty.call(local, k)) { delete result[k]; return; }   // locally deleted this field
      if (depth > 0 && NESTED_MERGE_KEYS.has(k) && _isPlainObj(base[k]) && _isPlainObj(local[k]) && _isPlainObj(server[k])) {
        result[k] = this._mergeRow(base[k], local[k], server[k], depth - 1).result;
        return;
      }
      result[k] = local[k];
    });
    return { result, changed };
  },
  // ---- merge-aware sync (#10) ----
  // A rev conflict (a 409 on push, or a GET that's moved on since our last rev)
  // means another device wrote first. Wholesale-adopting the server's copy — the
  // old behaviour — threw away anything WE'D written that hadn't reached the
  // server yet (a new asset added the moment another device's write raced ours),
  // AND — the deeper bug — silently discarded any UPDATE to a row that existed
  // on both sides: markDone's own t.lastDone write, unsnoozeTask's `delete
  // t.snoozed`, every edit to an already-synced row. Policy now: for every
  // id-keyed collection (ID_KEYED above), union by id. A row present on only
  // one side is handled exactly as before — local-only is KEPT (rescued)
  // unless the server's tombstones say that id was deleted by another device,
  // and a server row whose id is in OUR tombstones (we deleted it locally but
  // haven't pushed yet) is dropped so a same-cycle rescue can't undo our own
  // delete. A row present on BOTH sides now goes through _mergeRow() — a
  // field-level 3-way merge against this device's base snapshot (_loadBase())
  // — instead of the server row winning wholesale. With NO usable snapshot
  // (missing or corrupt — first run before load() seeds one, storage was
  // cleared, JSON.parse failed) this degrades to the old server-wins-per-id
  // behaviour rather than throwing or guessing. Both tombstone lists are
  // unioned into the merged state (capped at 400, oldest first out — see
  // _tombstone). `settings` gets the same field-level treatment; everything
  // else outside ID_KEYED/settings takes the server's copy outright here,
  // same as a plain adopt — EXCEPT currentHomeId, which is device-local
  // (DEFECT G) and gets overwritten again by _adopt()'s call to
  // _resolveHomeId() right after this returns, exactly like haUrl/haToken.
  // Never part of ID_KEYED or the settings diff, so a currentHomeId
  // difference between two devices on different homes never sets
  // `fieldChanged` and never triggers a rev-churn push on its own.
  _mergeState(serverState, localState) {
    const serverTomb = Array.isArray(serverState.tombstones) ? serverState.tombstones : [];
    const localTomb = Array.isArray(localState.tombstones) ? localState.tombstones : [];
    const serverTombIds = new Set(serverTomb.map(t => t && t.id));
    const localTombIds = new Set(localTomb.map(t => t && t.id));
    const base = this._loadBase();   // null -> no snapshot to diff against, see above
    const baseTombIds = new Set((base && Array.isArray(base.tombstones) ? base.tombstones : []).map(t => t && t.id));
    // An explicit local re-do (markDone re-creating a row whose id was
    // tombstoned — see markDone) removes that id from OUR OWN tombstones
    // without the server knowing yet. Diffed against baseTombIds (this
    // device's last-synced snapshot) that shows up as "was tombstoned as of
    // last sync, isn't anymore" — a deliberate local un-delete, not just an
    // id the server never told us about. It must win over the server still
    // carrying the old tombstone (rescue the re-created row below, and never
    // let the union at the bottom hand the tombstone back), or the re-do
    // vanishes again on the very next merge.
    const revivedIds = new Set([...baseTombIds].filter(id => id && !localTombIds.has(id)));
    // Conversely: a local tombstone id ALSO already in baseTombIds is one this
    // device only ever adopted from a prior sync, not one it just created —
    // it must not be used to suppress a server row that has since come back
    // (e.g. another device revived that same id the way markDone does here).
    // Only a FRESH local delete (tombstoned since the base snapshot, so the
    // server hasn't seen it push yet) should drop a same-cycle server row.
    const freshLocalTombIds = new Set([...localTombIds].filter(id => !baseTombIds.has(id)));
    let rescued = 0;
    let fieldChanged = false;   // a field-level edit was re-applied on top of a server row — see _mergeRow
    const merged = { ...serverState };
    ID_KEYED.forEach(key => {
      // A row the OTHER side deleted (their id is in the tombstones we're
      // checking against) never makes it into the merged collection, from
      // either source — that's the whole point of the tombstone.
      const serverList = (Array.isArray(serverState[key]) ? serverState[key] : [])
        .filter(x => !(x && freshLocalTombIds.has(x.id)));
      const localList = Array.isArray(localState[key]) ? localState[key] : [];
      const localById = new Map(localList.filter(x => x && x.id).map(x => [x.id, x]));
      const baseList = base && Array.isArray(base[key]) ? base[key] : [];
      const baseById = new Map(baseList.filter(x => x && x.id).map(x => [x.id, x]));
      const serverIds = new Set(serverList.map(x => x && x.id));
      const mergedExisting = serverList.map(sRow => {
        const id = sRow && sRow.id;
        const lRow = id ? localById.get(id) : null;
        if (!lRow || !base) return sRow;   // nothing local to merge, or no snapshot to diff against -> server row stands
        const { result, changed } = this._mergeRow(baseById.get(id), lRow, sRow);
        if (changed) fieldChanged = true;
        return result;
      });
      const localOnly = localList.filter(x => x && x.id && !serverIds.has(x.id) &&
        (!serverTombIds.has(x.id) || revivedIds.has(x.id)));
      rescued += localOnly.length;
      merged[key] = mergedExisting.concat(localOnly);
    });
    const tombById = new Map();
    serverTomb.concat(localTomb).forEach(t => { if (t && t.id && !revivedIds.has(t.id)) tombById.set(t.id, t); });
    merged.tombstones = Array.from(tombById.values())
      .sort((a, b) => String(a.at || '').localeCompare(String(b.at || ''))).slice(-400);
    if (base) {
      // base.settings is always the token-stripped shape (see _saveBase/_strip)
      // — it never has haUrl/haToken keys at all. localState.settings is this
      // device's live copy, which DOES carry them (re-applied by _adopt on
      // every sync). Diffing the raw local object against that base made
      // haUrl/haToken read as "changed" on every single sync (missing key vs.
      // present key, even both ''), so fieldChanged was true and Store.push()
      // fired unconditionally on every conflict — a self-sustaining rev-churn
      // loop. Strip local the same way before comparing; these fields are
      // device-local and re-applied by _adopt regardless, so they must never
      // participate in the field-level diff.
      const settingsMerge = this._mergeRow(base.settings, this._strip(localState).settings || {}, serverState.settings || {});
      merged.settings = settingsMerge.result;
      if (settingsMerge.changed) fieldChanged = true;
    } else {
      merged.settings = serverState.settings || {};
    }
    if (rescued) console.info(`[Store] merge rescued ${rescued} local-only entit${rescued === 1 ? 'y' : 'ies'} that a sync conflict would otherwise have dropped`);
    return { state: merged, rescued, fieldChanged };
  },
  async syncRemote() {
    try {
      const r = await fetch('api/state'); if (!r.ok) return false;
      const j = await r.json();
      if (j && j.state && j.state.homes && j.state.homes.length) {
        const rev = j.rev || 0;
        // currentHomeId is device-local (DEFECT G) — this device's _shareable()
        // still carries its own selection while the server doc carries whatever
        // device last pushed. Normalise it out of the compare (same idea as the
        // haUrl/haToken strip above) so an otherwise-identical state still
        // short-circuits to 'same' instead of "adopting" a no-op diff forever.
        const mine = this._shareable();
        if (rev === this.rev && JSON.stringify({ ...j.state, currentHomeId: mine.currentHomeId }) === JSON.stringify(mine)) return 'same';
        // A local write may have raced this GET (queued for push but not sent yet,
        // or in flight) — merge rather than adopt so it isn't silently discarded.
        const { state: merged, rescued, fieldChanged } = this._mergeState(j.state, this.state);
        this.rev = rev;
        this._adopt(merged, j.state);   // base = what the server actually holds, not our merged copy
        // Hand back anything the server hasn't seen — a rescued whole row, or a
        // field-level edit re-applied onto an existing row (same 409→merge→
        // retry-once→adopt guard as any other push).
        if (rescued || fieldChanged) Store.push();
        return 'adopted';
      }
      // server empty — first device migrates its local data up
      if (this.state.homes.length) { await this.push(); return 'pushed'; }
      return 'same';
    } catch { return false; }
  },
  // Pushes are serialised. Two overlapping saves (clear the draft, then record what
  // was sent) both went up with the same baseRev: the second came back 409, and the
  // 409 branch below adopts the server copy — so the later, more important write was
  // silently thrown away. Queueing means each push sees the rev the last one earned.
  _pushQ: null,
  push() {
    this._pushQ = (this._pushQ || Promise.resolve()).then(() => this._pushNow(), () => this._pushNow());
    return this._pushQ;
  },
  // retried=true marks the one merge-then-retry attempt already spent this cycle —
  // a second 409 in a row no longer RE-POSTS (that's the loop guard: a hot
  // conflict can still never recurse forever), but it still runs the same
  // field-level merge as the first conflict before adopting. The old
  // behaviour did a wholesale `_adopt(j.state)` here, which threw away
  // whatever the first merge had just rescued — both locally and from the
  // next push, since adopting IS what gets pushed — the moment a SECOND
  // writer landed during the merge-then-retry round trip (defect 1 coming
  // back through this narrower door: see tools/test-store-js.py's
  // "double conflict" check). Merging and stopping means the rescued edit
  // survives in this.state and rides the NEXT debounced Store.save() up,
  // instead of being discarded.
  async _pushNow(retried = false) {
    try {
      // Serialise the body once and snapshot the posted state from THAT string,
      // not from a live reference into this.state — `_shareable()`'s spread is
      // shallow, so the array/row objects it returns are the same ones a user
      // action can mutate while this POST is in flight. Reading the snapshot
      // back out of the already-serialised body guarantees `_saveBase` records
      // exactly what the server received, not whatever the rows look like by
      // the time the response comes back.
      const body = JSON.stringify({ baseRev: this.rev, state: this._shareable() });
      const r = await fetch('api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (r.status === 409) {                            // another device wrote first
        const j = await r.json();
        if (!(j.state && j.state.homes)) return false;
        this.rev = j.rev || 0;
        const { state: merged } = this._mergeState(j.state, this.state);
        this._adopt(merged, j.state);   // base = what the server actually holds, not our merged copy
        if (typeof render === 'function') render();
        if (retried) {                                   // loop guard — already retried once this cycle
          Store.save();                                   // still schedule the merged edit for the NEXT debounced push
          return false;
        }
        return this._pushNow(true);                      // push once more with the server's rev as baseRev
      }
      const j = await r.json();
      // A 200 means the server now holds exactly the posted body at j.rev —
      // that's the new merge ancestor for this device (see _mergeState's base).
      // DEFECT J: this used to `return true` unconditionally past this point,
      // so a 400 (malformed state — server.py's /api/state shape-check) or
      // any other non-2xx read as success. _purgeVault's delete-only-after-
      // push-succeeds guard (see below) then believed a delete had reached
      // the server when it never did, and issued api/vault/delete for a
      // write that never persisted — silent data loss on the next resurrect.
      // Require BOTH the transport (r.ok) and the body (j.ok) to agree.
      if (r.ok && j.ok) { this.rev = j.rev; this._saveBase(JSON.parse(body).state); return true; }
      return false;
    } catch { return false; }                            // offline — local cache holds; next save retries
  },
  // The base snapshot (BASE_KEY) is a second full plaintext copy of the synced
  // document — "erase everything" must wipe it too, or a device someone else
  // later gets their hands on still has the address, provider contacts, quote
  // amounts and mail history sitting in localStorage after a reset.
  reset() { localStorage.removeItem(BASE_KEY); localStorage.removeItem(HOME_KEY); this.state = JSON.parse(JSON.stringify(SEED)); this.save(); },
  uid: p => p + Math.random().toString(36).slice(2, 8),
  // Empty means "leave it alone, use the fallback" — an untyped/cleared field.
  // Anything that parses as a number (including "0") is the user's explicit
  // value and must be honoured, not silently replaced by the fallback (see
  // DEFECT 5: `Number(val('b_cost')) || q.amount || 0` couldn't tell "typed 0"
  // from "typed nothing", so a warranty/no-charge job recorded the old quoted
  // amount instead of $0). A negative number is never a legitimate cost —
  // treated the same as non-numeric input (falls back) rather than honoured
  // literally, same contract a plain `<input type=number min=0>` enforces at
  // the browser level; nothing here relied on a negative reading through
  // (verified: the sole caller, save-booking's Agreed price, is the field
  // this exists for).
  numOr(raw, fallback) {
    if (raw === '' || raw === null || raw === undefined) return fallback;
    const n = Number(raw);
    return (Number.isNaN(n) || n < 0) ? fallback : n;
  },

  // ---- homes ----
  home: () => Store.state.homes.find(h => h.id === Store.state.currentHomeId) || null,
  // A test/demo home (a friend's house) — no live HA, no usage/nudges, no auto-mail.
  isTestHome: () => !!(Store.home() || {}).testMode,
  addHome(h) { h.id = Store.uid('h'); Store.state.homes.push(h); Store.state.currentHomeId = h.id; Store._saveHomeId(h.id); Store.save(); return h; },
  switchHome(id) { Store.state.currentHomeId = id; Store._saveHomeId(id); Store.save(); },
  deleteHome(id) {
    const assetIds = new Set(Store.state.assets.filter(a => a.homeId === id).map(a => a.id));
    const provIds = new Set(Store.state.providers.filter(p => p.homeId === id).map(p => p.id));
    // Tombstone every id this cascades away, not just the home itself — a stale
    // device holding any of these cached would otherwise "rescue" it right back.
    const goneTasks = Store.state.tasks.filter(t => assetIds.has(t.assetId)).map(t => t.id);
    const goneLogs = Store.state.logs.filter(l => assetIds.has(l.assetId)).map(l => l.id);
    const goneQuotes = (Store.state.quotes || []).filter(q => q.homeId === id || assetIds.has(q.assetId)).map(q => q.id);
    const goneMail = (Store.state.mail || []).filter(m => provIds.has(m.providerId)).map(m => m.id);
    Store.state.homes = Store.state.homes.filter(h => h.id !== id);
    Store.state.assets = Store.state.assets.filter(a => a.homeId !== id);
    Store.state.tasks = Store.state.tasks.filter(t => !assetIds.has(t.assetId));
    Store.state.providers = Store.state.providers.filter(p => p.homeId !== id);
    Store.state.logs = Store.state.logs.filter(l => !assetIds.has(l.assetId));
    // Quotes and correspondence belong to the home too — leaving them behind
    // orphans rows that nothing can reach but that keep growing the synced state.
    Store.state.quotes = (Store.state.quotes || []).filter(q => q.homeId !== id && !assetIds.has(q.assetId));
    Store.state.mail = (Store.state.mail || []).filter(m => !provIds.has(m.providerId));
    if (Store.state.currentHomeId === id) { Store.state.currentHomeId = (Store.state.homes[0] || {}).id || null; Store._saveHomeId(Store.state.currentHomeId); }
    Store._tombstone([id, ...assetIds, ...provIds, ...goneTasks, ...goneLogs, ...goneQuotes, ...goneMail]);
    Store.save();
    Store._purgeVault([id, ...assetIds]);   // the home id too — its vaulted home-<id>.jpg photo dies with it
  },
  // Vaulted photos/manuals live as files on the Green, outside the synced state —
  // tombstones never reach them. Purge only after the delete's push lands: the
  // double-409 loop guard in _pushNow can adopt the server copy and resurrect the
  // entities, and their files must not already be gone. A skipped purge (offline,
  // hot conflict) just leaves orphans — no worse than before, unreachable either way.
  _purgeVault(assetIds) {
    if (!assetIds.length) return;
    try {
      Store.push().then(ok => { if (!ok) return;
        fetch('api/vault/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ assetIds }) }).catch(() => {}); });
    } catch {}
  },

  // ---- per-home settings (soonDays override, notification target, …) ----
  // Per-home-first, falling back to the legacy global setting, then the
  // documented default (HOME_SETTING_DEFAULTS). Read-only — nothing is written
  // here. Deliberately lazy: a sync conflict's ID_KEYED merge (_mergeState)
  // takes the SERVER's whole home row whenever the id exists on both sides, so
  // eagerly stamping home.settings={} on load() would just get clobbered away
  // again on the next 409 — worse, it'd make load() non-idempotent against the
  // very state it's meant to tolerate. Home-settings writes only ever happen
  // from an explicit user save (Settings UI), same as the pre-existing
  // per-home `suburb` field.
  homeSetting(key) {
    const h = Store.home();
    if (h && h.settings && h.settings[key] !== undefined) return h.settings[key];
    if (Store.state.settings && Store.state.settings[key] !== undefined) return Store.state.settings[key];
    return HOME_SETTING_DEFAULTS[key];
  },
  // Per-home Home Assistant source: 'local' (SUPERVISOR_TOKEN — today's only
  // mode, and the default for a home that predates this field), 'remote' (a
  // friend's own HA — url lives here), or 'none' (not connected; the server
  // 503s cleanly and the UI treats that as disconnected). The long-lived
  // remote token is NEVER part of this object or the store — see
  // /data/kk-ha-secrets.json server-side, keyed by homeId.
  homeHA() {
    const h = Store.home();
    const ha = h && h.ha;
    if (ha && ha.mode) return { mode: ha.mode, ...(ha.url ? { url: ha.url } : {}) };
    return { mode: 'local' };
  },
  // The user-confirmed (or plain-geocoded) real-world location of a home —
  // "which house is mine" fix: home.geo = {lat, lon, source:'user'|'geocode',
  // confirmedAt, ring?:[[lat,lon],...], label?}. null means unconfirmed —
  // every aerial/scan consumer must still treat that as "may be a neighbour"
  // (the AERIAL_SYSTEM hedge only drops once source==='user'). Read-only,
  // lazy, same shape as homeHA()/homeSetting() above — nothing stamps a
  // default here, and homeId defaults to the current home like Store.home().
  homeGeo(homeId) {
    const h = homeId ? Store.state.homes.find(x => x.id === homeId) : Store.home();
    return (h && h.geo) || null;
  },
  // Persists a confirmed location. Coerces/clamps every field at this
  // boundary too — server.py's _sanitize_home_geo is the hard boundary on
  // the shared store, but a locally-malformed value (a NaN from a mis-clicked
  // hotspot, a footprint with thousands of vertices) must never even be
  // pushed. lat/lon out of range is rejected outright (a bad fix is worse
  // than none); ring vertices are clamped and capped instead, same policy as
  // the server's. syncRemote() -> mutate -> push() run as one uninterrupted
  // async block — no await sits between reading the current home row and
  // writing its geo field, so a concurrent edit elsewhere can't land in
  // between. Returns the saved geo, or null if the home doesn't exist or the
  // fix is unusable.
  async setHomeGeo(homeId, geo) {
    await Store.syncRemote();
    const h = Store.state.homes.find(x => x.id === (homeId || Store.state.currentHomeId));
    if (!h) return null;
    // typeof, not Number(...) — Number(null)/Number('')/Number(false) all
    // coerce to 0, a finite in-range value, so a cancelled/failed geocode
    // (the idiomatic null) or a stray boolean would silently confirm the
    // home at Null Island instead of being rejected. Only a real number is
    // accepted, same boundary as server.py's _sanitize_home_geo.
    if (!geo || typeof geo.lat !== 'number' || typeof geo.lon !== 'number') return null;
    const lat = geo.lat, lon = geo.lon;
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) return null;
    const ring = Array.isArray(geo && geo.ring)
      ? geo.ring.slice(0, 400)
          .map(p => (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number') ? [p[0], p[1]] : null)
          .filter(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]))
          .map(([plat, plon]) => [Math.max(-90, Math.min(90, plat)), Math.max(-180, Math.min(180, plon))])
      : undefined;
    h.geo = { lat, lon, source: (geo && geo.source === 'user') ? 'user' : 'geocode',
              confirmedAt: new Date().toISOString(),
              ...(ring && ring.length ? { ring } : {}),
              ...((geo && geo.label) ? { label: String(geo.label).slice(0, 12) } : {}) };
    Store.save();
    await Store.push();
    return h.geo;
  },

  // ---- current-home scoped collections ----
  homeAssets: () => Store.state.assets.filter(a => a.homeId === Store.state.currentHomeId),
  homeProviders: () => Store.state.providers.filter(p => p.homeId === Store.state.currentHomeId),
  homeTasks: () => { const ids = new Set(Store.homeAssets().map(a => a.id)); return Store.state.tasks.filter(t => ids.has(t.assetId) && !t.snoozed); },  // active only — snoozed excluded everywhere
  homeTasksAll: () => { const ids = new Set(Store.homeAssets().map(a => a.id)); return Store.state.tasks.filter(t => ids.has(t.assetId)); },
  snoozedTasks: () => { const ids = new Set(Store.homeAssets().map(a => a.id)); return Store.state.tasks.filter(t => ids.has(t.assetId) && t.snoozed); },
  homeQuotes: () => Store.state.quotes.filter(q => q.homeId === Store.state.currentHomeId),
  quote: id => Store.state.quotes.find(q => q.id === id),
  quoteForAsset: assetId => Store.state.quotes.find(q => q.assetId === assetId && q.status !== 'booked' && q.status !== 'declined' && q.status !== 'done'),
  // The open quote a "found a provider" action may REUSE, scope-matched.
  // quoteForAsset() above answers "what's in flight on this asset" for READ
  // paths (the asset page's card, the dashboard chip) where showing the one
  // open quote is right. It is NOT safe for a WRITE that stamps taskId: a
  // quote belongs to the job it was raised for, so a task-scoped search may
  // only touch a quote for that SAME task, and an asset-scoped one only a
  // quote that names no task. Any other open quote on the asset is a
  // different job — on a multi-trade asset (a garden's mower vs its lopper,
  // solar's panel cleaner vs its inverter pro) reusing it repointed that
  // quote's taskId and swapped its provider, and because bookingSettles()
  // resolves a booking's task THROUGH q.taskId, and settling is destructive
  // (overwrites cost, may rewrite the date, closes the quote), the wrong task
  // got settled while the real one stayed due. No match = the caller raises a
  // new quote rather than hijacking someone else's.
  // Legacy quotes carry no taskId at all, so an asset-scoped search still
  // reuses them exactly as it always did.
  quoteForScope: (assetId, taskId) => Store.state.quotes.find(q =>
    q.assetId === assetId && q.status !== 'booked' && q.status !== 'declined' && q.status !== 'done'
    && (q.taskId || '') === (taskId || '')),
  // The open quote to SHOW against one task: its own if it has one, else the
  // asset's taskId-less quote (which stands for the asset as a whole, so it
  // legitimately speaks for any of its jobs). Never another task's — once an
  // asset can carry a quote per job, quoteForAsset()'s "first open quote"
  // would put the panel-cleaning quote's status chip, and its manage button,
  // on the inverter task's row.
  quoteForTask: t => t && Store.state.quotes.find(q =>
    q.assetId === t.assetId && q.status !== 'booked' && q.status !== 'declined' && q.status !== 'done'
    && (q.taskId || '') === t.id)
    || (t && Store.quoteForScope(t.assetId, '')) || undefined,
  // Every open quote on an asset, so a page showing "what's in flight" shows
  // ALL of it rather than silently hiding the second job's.
  quotesForAsset: assetId => Store.state.quotes.filter(q =>
    q.assetId === assetId && q.status !== 'booked' && q.status !== 'declined' && q.status !== 'done'),
  upsertQuote(q) {
    if (!q.id) { q.id = Store.uid('q'); q.homeId = q.homeId || Store.state.currentHomeId; Store.state.quotes.push(q); }
    else { const i = Store.state.quotes.findIndex(x => x.id === q.id);
           i === -1 ? Store.state.quotes.push(q) : (Store.state.quotes[i] = q); }
    Store.save(); return q;
  },
  deleteQuote(id) { Store.state.quotes = Store.state.quotes.filter(q => q.id !== id); Store._tombstone(id); Store.save(); },

  // ---- lookups (by id, global) ----
  asset: id => Store.state.assets.find(a => a.id === id),
  provider: id => Store.state.providers.find(p => p.id === id),
  tasksFor: id => Store.state.tasks.filter(t => t.assetId === id),
  // ---- job history (logs) — newest first ----
  logsFor: id => Store.state.logs.filter(l => l.assetId === id)
                   .slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))),
  homeLogs() {
    const ids = new Set(Store.homeAssets().map(a => a.id));
    return Store.state.logs.filter(l => ids.has(l.assetId))
             .slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  },
  // Every job credited to a trade, newest first. Attribute by the providerId
  // recorded ON the log, falling back to the asset's provider for older entries
  // written before logs carried one.
  jobsForProvider: pid => Store.state.logs
    .filter(l => l.providerId === pid || (!l.providerId && (Store.asset(l.assetId) || {}).providerId === pid))
    .slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))),
  lastJobDate: pid => (Store.jobsForProvider(pid)[0] || {}).date || '',
  // ---- correspondence: the email thread with a trade, newest first ----
  mailFor: pid => (Store.state.mail || []).filter(m => m.providerId === pid)
                    .slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))),
  addMail(e) {
    if (!Store.state.mail) Store.state.mail = [];
    const m = { id: Store.uid('m'), providerId: e.providerId || '', quoteId: e.quoteId || '',
                date: e.date || '', from: e.from || '', subject: e.subject || '',
                snippet: e.snippet || '', direction: e.direction || 'in' };
    Store.state.mail.push(m); Store.save(); return m;
  },
  deleteMail(id) { Store.state.mail = (Store.state.mail || []).filter(m => m.id !== id); Store._tombstone(id); Store.save(); },
  icon: cat => (CATEGORIES[cat] || {}).icon || '🔧',

  // ---- scheduling ----
  today() { const d = new Date(); d.setHours(0,0,0,0); return d; },
  // The LOCAL calendar date. toISOString() is UTC: before ~10-11am Sydney it reads
  // yesterday, so morning "done" taps were logged a day early and Jan-1 spend
  // vanished from the year's total. All date-only stamps go through here.
  localISO() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); },
  // cadence <= 0 would make a task permanently overdue (lastDone + 0 days is always
  // in the past) — reachable via Gmail import or chat tool-writes; treat as unscheduled.
  nextDue(t) { if (!t.lastDone || !(t.cadenceDays > 0)) return null; const d = new Date(t.lastDone); d.setHours(0,0,0,0); return new Date(d.getTime() + t.cadenceDays * DAY); },
  // An active device-reported fault reads as "N days overdue since it was
  // reported" — negative daysUntil sorts it to the FRONT of every attention
  // list with no other scheduling change.
  faultAge(t) { if (!(t.fault && t.fault.state === 'active' && t.fault.raisedAt)) return null;
    const d = new Date(String(t.fault.raisedAt).slice(0, 10)); if (isNaN(d)) return 0;
    d.setHours(0,0,0,0); return Math.max(0, Math.round((Store.today() - d) / DAY)); },
  daysUntil(t) { const fa = Store.faultAge(t); if (fa !== null) return -fa;
    const nd = Store.nextDue(t); return nd ? Math.round((nd - Store.today()) / DAY) : null; },
  // autopilot = a standing arrangement that just happens (a weekly cleaner, a
  // lawn contract). It still sits on the schedule with its next date, but it
  // never counts as overdue/soon, so it can't nag the dashboard or the health score.
  // The "due soon" window is capped at half the task's own cadence. Without that,
  // any task whose cadence <= soonDays (a 30-day alarm test with a 30-day window)
  // is "soon" the instant you tick it done and can never leave Needs attention.
  soonWindow(t) {
    const pref = Store.homeSetting('soonDays') || 30;
    return Math.max(1, Math.min(pref, Math.ceil((t.cadenceDays || 365) / 2)));
  },
  status(t) {
    if (Store.faultAge(t) !== null) return 'overdue';   // a live fault outranks autopilot
    if (t.autopilot) return 'ok';
    const d = Store.daysUntil(t);
    if (d === null) return 'ok';
    if (d < 0) return 'overdue';
    return d <= Store.soonWindow(t) ? 'soon' : 'ok';
  },
  dueLabel(t) {
    const fa = Store.faultAge(t);
    if (fa !== null) return fa === 0 ? 'reported today' : `reported ${fa}d ago`;
    if (t.fault && t.fault.state === 'cleared') return 'device says it’s clear';
    const d = Store.daysUntil(t); if (d === null) return 'not scheduled'; if (d < 0) return `${-d}d overdue`; if (d === 0) return 'due today'; if (d === 1) return 'due tomorrow'; return `in ${d}d`; },

  // ---- warranty ----
  warrantyDays(a) { // days until warranty expiry, or null if none/invalid
    if (!a || !a.warrantyUntil) return null;
    const d = new Date(a.warrantyUntil); if (isNaN(d)) return null;
    d.setHours(0, 0, 0, 0);
    return Math.round((d - Store.today()) / DAY);
  },
  warrantyLabel(a) { const d = Store.warrantyDays(a); if (d === null) return null;
    if (d < 0) return `warranty expired ${-d}d ago`; if (d === 0) return 'warranty ends today';
    if (d <= 90) return `warranty ends in ${d}d`; return `under warranty`; },
  warrantyWatch() { // assets whose warranty is expiring within 60d or already expired
    return Store.homeAssets().map(a => ({ a, d: Store.warrantyDays(a) }))
      .filter(x => x.d !== null && x.d <= 60).sort((x, y) => x.d - y.d);
  },

  // ---- home-health score (0–100) — one glanceable signal for the dashboard ----
  homeHealth() {
    const tasks = Store.homeTasks();
    let score = 100;
    tasks.forEach(t => { const s = Store.status(t); if (s === 'overdue') score -= 8; else if (s === 'soon') score -= 2; });
    Store.homeAssets().forEach(a => { const w = Store.warrantyDays(a); if (w !== null && w < 0) score -= 5; });
    score = Math.max(0, Math.min(100, Math.round(score)));
    const label = score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 50 ? 'Needs care' : 'At risk';
    const color = score >= 75 ? 'green' : score >= 50 ? 'amber' : 'red';
    return { score, label, color };
  },
  nextTask() { // soonest scheduled task, for the "next up" line even when all caught up
    return Store.homeTasks().filter(t => Store.daysUntil(t) !== null)
      .sort((a, b) => Store.daysUntil(a) - Store.daysUntil(b))[0] || null;
  },
  // Tasks never marked done. Device-fault tasks are excluded: they're event-
  // driven (no lastDone by design) — "start tracking" must neither count them
  // nor stamp a lastDone onto a live fault.
  unscheduled() { return Store.homeTasks().filter(t => !t.lastDone && !t.fault); },
  startTracking() { // assume everything was just serviced today so the countdown begins
    const iso = Store.localISO();
    Store.unscheduled().forEach(t => { t.lastDone = iso; });
    Store.save();
  },

  // ---- actions ----
  // Deterministic identity for a "done" log: the SAME (taskId, local-calendar date)
  // always yields the SAME id, instead of a fresh Store.uid('l') every call. That's
  // what lets a second ✓ Done — a double-tap, or two devices racing on the same job
  // (DEFECT C: tablet and phone both tap ✓ on the same task before either has synced)
  // — converge on ONE record through the ordinary existing-row branch of
  // _mergeState/_mergeRow, rather than each minting its own random id that the
  // merge's local-only-row "rescue" rule would keep BOTH of, doubling the spend.
  _doneLogId(taskId, iso) { return 'ld_' + taskId + '_' + iso; },
  // THE single answer to "has this task already been marked done TODAY, and
  // with what record?" — the read half of the same identity markDone's write
  // half (the `existing` lookup below) uses to converge a re-tap onto one
  // row instead of minting a sibling. Checks the deterministic fresh-log id
  // first, then the taskId+source:'done'+settledOn match a SETTLED BOOKING
  // uses instead (a settled booking keeps its own original id — see markDone
  // below). Returns the log row, or null if nothing today.
  //
  // DEFECT 1 (2026-07 verifier round): doneDialogDefaultCost() (app.js) used
  // to ask a DIFFERENT question — "is there a PENDING booking covering this
  // task" — to decide what to pre-fill in the ✓ Done prompt. That's the right
  // question the FIRST time a job is marked done, but once markDone() has
  // already settled the booking (pending -> false), it silently stops
  // answering that question and the prefill fell through to the task's rough
  // estCost instead of the real price just recorded. A second ✓ Done tap —
  // "did that register?", or fixing a typo — then re-opened the prompt
  // showing the WRONG default, and accepting it unedited (the common case)
  // had markDone's own re-tap guard treat that wrong number as an explicit
  // user-typed correction, silently overwriting a real price (e.g. $450)
  // with the estimate (e.g. $180) with no undo. Both the prefill and the
  // write now ask this SAME question — one owner for "was this done today".
  _doneToday(taskId) {
    const iso = Store.localISO();
    const id = Store._doneLogId(taskId, iso);
    return Store.state.logs.find(l => l.id === id) ||
      Store.state.logs.find(l => l.taskId === taskId && l.source === 'done' && l.settledOn === iso) || null;
  },
  markDone(taskId, cost) {
    // Home-scoped, matching _pendingBookings() below (via Store.homeLogs() ->
    // Store.homeAssets()) — a global Store.state.tasks.find() here used to let
    // a task from a NON-current home resolve and get mutated even though its
    // own booking search could never see it (REVIEW-6, post-369cb0f). Not
    // reachable from today's UI (nothing calls markDone() for a task outside
    // the current home), but keeping the two scopes consistent closes the
    // trap rather than leaving it for the next caller. homeTasksAll(), not
    // homeTasks(), so a snoozed task can still be marked done — only the HOME
    // scope changes here, not the existing snoozed-inclusion behaviour.
    const t = Store.homeTasksAll().find(x => x.id === taskId); if (!t) return;
    const iso = Store.localISO();
    t.lastDone = iso;
    // Fault task: 'done' stops the server re-raising until the device is
    // observed normal again (fault_scan then retires the row — this log entry
    // keeps the history) and faults anew.
    if (t.fault && t.fault.state !== 'done') { t.fault.state = 'done'; t.fault.doneAt = iso; }
    const a = Store.asset(t.assetId);
    // DEFECT F: the task can already have a PENDING booking log (from Find-a-service /
    // confirm-date / save-booking) covering this exact job. Writing a fresh log here
    // would double the history AND leave that booking — and its quote — stuck
    // 'booked'/pending forever: invisible as done, nagging as overdue once its date
    // passes, and able to bank the cost again if its own ✓ ("job-done" -> completeLog)
    // were ever tapped afterwards. Settle the booking IN PLACE (same id — never
    // renamed, so a later completeLog() on it is a harmless no-op, and two devices
    // independently settling the SAME pre-existing booking row still converge
    // through the ordinary field-level 3-way merge, since it's one shared id on
    // both sides) instead of creating a second log.
    //
    // REVIEW-1 (post-369cb0f): this is a DESTRUCTIVE write — it overwrites cost,
    // may rewrite date, flips pending/source, and closes the owning quote. It
    // must therefore only ever act on a HIGH-confidence linkage: Store.bookingSettles()
    // below, NOT the full Store.bookingCovers() matcher. bookingCovers()'s rules 3
    // (note/title overlap) and 4 (sole taskless booking on a single-task asset) are
    // heuristics designed for READ-ONLY dashboard suppression, where the worst case
    // of a wrong guess is a row rendering twice or briefly not at all. Handed to a
    // WRITE path, rule 4 alone let markDone() settle an unrelated taskless booking —
    // e.g. a real $1,200 quoted job — onto whatever task's ✓ Done happened to be
    // tapped next, silently overwriting its price/date/status with no undo. See
    // bookingSettles()'s own comment for exactly which rules count as "high
    // confidence" and why.
    //
    // REVIEW-5 (post-369cb0f): more than one pending booking can be linked to the
    // SAME task. _pendingBookings() is newest-first (it inherits Store.homeLogs()'s
    // sort), so a plain .find() would settle whichever booking happens to be
    // newest — sort-order trivia, not a decision. Settle the OLDEST covering
    // booking instead: it's the longest-outstanding commitment, and the one most
    // likely to be the actual job just finished.
    const covering = Store._pendingBookings().filter(l => Store.bookingSettles(l, t));
    const booking = covering.length
      ? covering.slice().sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')))[0]
      : null;
    if (booking) {
      // REVIEW-3 (post-369cb0f): stamp taskId onto the settled row even when the
      // ONLY linkage was through the booking's quote (bookingSettles() rule 2) —
      // without it the row is unattributable to the task it completed, and the
      // l.taskId === taskId half of the re-tap guard below can never match it.
      const patch = { pending: false, source: 'done', taskId: t.id,
                       // REVIEW-2 (post-369cb0f): stamp the CALENDAR DAY this
                       // settle happened, separately from `date` below (which
                       // deliberately keeps a past booking date as-is). The
                       // re-tap guard needs a value that's stable for "same job,
                       // same day" regardless of what `date` ends up holding.
                       settledOn: iso };
      if (cost !== undefined) patch.cost = Number(cost) || 0;   // an explicit cost overrides the quoted/booked one
      // DEFECT 3 (2026-07 verifier round): a booking dated in the future is only
      // settled once the job is actually done TODAY — leaving `date` at the future
      // booking date would count the spend in the wrong calendar year
      // (costThisYear()) and show a job done today under a date that hasn't
      // happened yet, so that case was always pulled forward. But the ORIGINAL
      // condition (`booking.date > iso`) left EVERY past date alone, no matter how
      // stale — the comment's stated intent was the "confirmed for this morning"
      // case (booking.date === iso), not "any date up to and including never".
      // A long-outstanding booking (the real-shape fixture ships some 889 DAYS
      // overdue) settled today then filed its cost under 2024 — wrong on both the
      // History row and costThisYear()'s "what have I spent this year" answer,
      // since a job actually paid for today did not, in fact, happen two years
      // ago. Bound "leave it alone" to the CURRENT calendar year: a same-year
      // past date (booked last month, done a few days late — the common case)
      // still keeps its own date; a future date, or one from a year that has
      // already closed, is filed as of today instead.
      const bookingYear = String(booking.date || '').slice(0, 4);
      if (booking.date > iso || bookingYear !== String(new Date().getFullYear())) patch.date = iso;
      Store.updateLog(booking.id, patch);
      if (booking.quoteId) { const q = Store.quote(booking.quoteId); if (q) { q.status = 'done'; Store.upsertQuote(q); } }
      Store.save();
      return;
    }
    // DEFECT C: give the log a DETERMINISTIC id (task+date), not a random Store.uid('l')
    // — two devices marking the same job done independently (tablet taps ✓, then a
    // stale phone that hasn't synced yet taps the same ✓) used to each mint their own
    // random id, and the merge's local-only-row "rescue" rule kept BOTH, doubling the
    // banked cost. With the same id on both sides the row goes through the ordinary
    // existing-row merge instead, so a second tap — same device or a second device —
    // converges on one record.
    const id = Store._doneLogId(taskId, iso);
    // An explicit re-do (marking done again after this exact log was deleted) must
    // win over an old tombstone for the same id, or the resurrected-id guard in
    // _mergeState would make this write vanish again on the very next merge. Nothing
    // else here touches the tombstone list.
    if (Store.state.tombstones && Store.state.tombstones.length) {
      Store.state.tombstones = Store.state.tombstones.filter(x => !(x && x.id === id));
    }
    // Record WHAT was done and WHO did it, so it reads as real job history later.
    const row = { id, taskId, assetId: t.assetId, date: iso, cost: Number(cost) || 0, note: t.title || '',
                  providerId: t.providerId || (a && a.providerId) || '', ref: '', source: 'done', settledOn: iso };  // task override wins — the log credits who actually did it
    // A second ✓ Done on the SAME task+date must land on the SAME row even when
    // that row's id isn't the deterministic one above — the booking-settle branch
    // above updates a booking IN PLACE (keeping its own id) and flips it to
    // pending:false/source:'done', so a re-tap after that no longer finds it via
    // _pendingBookings() and would otherwise fall all the way through to here and
    // mint a second, differently-id'd log for the same job (double-banking the
    // cost). Match by id first (the ordinary repeat-tap-of-a-fresh-log case), then
    // fall back to taskId+source:'done'+settledOn===today. REVIEW-2 (post-369cb0f):
    // this used to fall back to taskId+date===today+source:'done', but a settled
    // booking deliberately keeps its OWN (possibly past) date, so that guard never
    // found it again and a same-day re-tap minted a second log for the same job
    // (double-banking the cost). `settledOn` is stamped by THIS flow alone (never
    // backfilled onto old rows), so it identifies "touched by markDone() today"
    // independently of the row's own job date — and, being scoped to source:'done'
    // + today, it still can't catch an unrelated MANUAL log (no settledOn) or a
    // genuinely earlier year's done record for a recurring task (settledOn from a
    // past day, not today). Never rename an existing row onto the deterministic
    // id, since other state (e.g. quoteId) still points at its original id.
    // Store._doneToday() (not a second hand-rolled copy of this same lookup) —
    // it's the exact same "was this task already marked done today" question
    // doneDialogDefaultCost() (app.js) asks before this function is even called,
    // so the prefill and the write can never drift onto different answers again.
    const existing = Store._doneToday(taskId);
    if (existing) {
      // REVIEW-4 (post-369cb0f): a re-tap only ever updates the price, and only
      // when the user actually typed one. kkPrompt() (app.js) returns '' — not
      // undefined — when the field is cleared, and Number('') || 0 === 0; a
      // wholesale Object.assign of a freshly-built, task-generic `row` onto an
      // existing row used to zero an already-settled real (quote-sourced) price
      // and overwrite its note/provider with the task's own generic identity.
      // Blank still means "no cost" on a genuinely NEW log below (row.cost),
      // matching the ✓ Done prompt's own hint — this only protects a row that
      // already carries real data.
      if (cost !== undefined && String(cost).trim() !== '') existing.cost = Number(cost) || 0;
    } else {
      Store.state.logs.push(row);
    }
    Store.save();
  },
  // A job that happened. taskId is OPTIONAL — one-off jobs (repairs, installs,
  // purchases, imported email history) have no recurring schedule behind them.
  addLog(e) {
    const l = { id: Store.uid('l'),
                date: e.date || Store.localISO(),
                assetId: e.assetId, taskId: e.taskId || '',
                cost: Number(e.cost) || 0, note: e.note || '',
                providerId: e.providerId || '', ref: e.ref || '',
                pending: !!e.pending,          // booked, not done yet
                source: e.source || 'manual',
                quoteId: e.quoteId || '' };    // links a 'booked' log back to its quote, so re-confirming updates it instead of duplicating
    Store.state.logs.push(l); Store.save(); return l;
  },
  updateLog(id, patch) {
    const l = Store.state.logs.find(x => x.id === id); if (!l) return null;
    Object.assign(l, patch); Store.save(); return l;
  },
  // Resolves a free-text offered date ('Tue 12 Aug, morning', '12 Aug',
  // 'Aug 12', '12/08', '12/08/2026', straight-through ISO) to a real
  // YYYY-MM-DD, or '' if it isn't confidently a date ('next week',
  // 'morning', '', garbage) — bookQuote() below refuses to guess when this
  // comes back empty rather than silently stamping today (DEFECT D). Numeric
  // slash dates are DAY-FIRST, never month-first — this app is AU-only, same
  // convention as everywhere else dates are typed by hand. When the text
  // carries no year, the year is whichever of this-year/next-year makes the
  // date land on or after `today` — trades only ever offer FUTURE dates, so
  // "3 Jan" said in December means next January, not the one 11 months
  // gone (the Dec->Jan rollover). Pure: `today` (YYYY-MM-DD, defaults to
  // Store.localISO()) is its only notion of "now", so it's fully testable
  // without mocking the clock — see tools/test-booking-dates.py.
  parseOfferedDate(text, today) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return '';
    const base = /^\d{4}-\d{2}-\d{2}$/.test(today || '') ? today : Store.localISO();
    const by = +base.slice(0, 4), bm = +base.slice(5, 7), bd = +base.slice(8, 10);
    const isValidYMD = (y, mo, d) => {
      if (!(y >= 1000 && y <= 9999) || mo < 1 || mo > 12 || d < 1 || d > 31) return false;
      const dt = new Date(y, mo - 1, d);   // rolls over invalid combos (Feb 30) — catch that, not accept it
      return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
    };
    const iso = (y, mo, d) => String(y).padStart(4, '0') + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const nearestForwardYear = (mo, d) => by + ((mo < bm || (mo === bm && d < bd)) ? 1 : 0);
    const isoM = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoM) {
      const y = +isoM[1], mo = +isoM[2], d = +isoM[3];
      return isValidYMD(y, mo, d) ? iso(y, mo, d) : '';
    }
    const MONTH_NAMES = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    // Full names are matched EXACTLY, never abbreviation + trailing [a-z]* —
    // that used to also match any longer word that merely starts with a
    // month's first 3 letters ("Maybe 12th works" read as 12 May, "12
    // Janitor" as 12 Jan, "Room 12 Augusta St" as 12 Aug), confidently
    // inventing a date out of ordinary hedging text instead of refusing it.
    const MONTH_FULL = ['january','february','march','april','may','june','july','august',
      'september','sept','october','november','december'];
    const monthRe = '(' + MONTH_FULL.concat(MONTH_NAMES).join('|') + ')';
    let day = null, monIdx = null;
    let m = s.match(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+' + monthRe + '\\b', 'i'));
    if (m) { day = +m[1]; monIdx = MONTH_NAMES.indexOf(m[2].slice(0, 3).toLowerCase()); }
    else {
      m = s.match(new RegExp('\\b' + monthRe + '\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b', 'i'));
      if (m) { monIdx = MONTH_NAMES.indexOf(m[1].slice(0, 3).toLowerCase()); day = +m[2]; }
    }
    if (day != null && monIdx != null && monIdx >= 0) {
      const mo = monIdx + 1;
      // A bare 4-digit token elsewhere in the text is only trusted as a year
      // if it's within a sane window of "now" — trade replies routinely carry
      // a stated clock time next to the date ("12 Aug at 1400"), and an
      // unbounded match read that as the year 1400 (or 9999), booking the job
      // ~228,000 days away/ago so it could never be marked done on time.
      const yM = s.match(/\b(\d{4})\b/);
      const yCand = yM ? +yM[1] : null;
      const y = (yCand != null && yCand >= by - 1 && yCand <= by + 5) ? yCand : nearestForwardYear(mo, day);
      return isValidYMD(y, mo, day) ? iso(y, mo, day) : '';
    }
    const sm = s.match(/^\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*$/);   // day/month[/year] — day-first
    if (sm) {
      const d = +sm[1], mo = +sm[2];
      const y = sm[3] ? (sm[3].length === 2 ? 2000 + (+sm[3]) : +sm[3]) : nearestForwardYear(mo, d);
      return isValidYMD(y, mo, d) ? iso(y, mo, d) : '';
    }
    return '';
  },
  // The ONE place that decides what "booked" means, so the two entry points —
  // picking one of the trade's offered dates ('confirm-date') and the full
  // booking form ('save-booking') — can't diverge (DEFECT 4: confirm-date used
  // to write zero logs, leaving the job invisible on 'Coming up' and with
  // nothing for job-done to act on). Sets the quote's status/bookedDate/
  // bookedTime/amount and upserts exactly one PENDING job-history log stamped
  // with quoteId — pending because a booking, even a re-booked date on a job
  // that was previously marked done, is a fresh commitment, not spend yet.
  // Matches an existing log by quoteId ONLY — never `source`, which
  // completeLog below rewrites to 'done' the moment a job is finished
  // (DEFECT 3: matching on source==='booked' meant "📌 Change date" on a
  // COMPLETED job couldn't find its own history entry and added a second one,
  // double-counting the spend). The single-unambiguous-legacy-log fallback
  // (a pending 'booked' log with no quoteId, written before this field
  // existed) is kept.
  //
  // Refuses — returns null, mutates NOTHING — in two shapes that both used to
  // half-book a job:
  //  DEFECT D: `date` can be a free-text offered date ('Tue 12 Aug, morning',
  //  picked straight off a trade's reply — see confirm-date in app.js). It's
  //  run through parseOfferedDate; anything that doesn't resolve to a real
  //  calendar date used to silently fall back to today, stamping the job with
  //  the wrong date and nagging as overdue up to two weeks early. Now it
  //  refuses instead of guessing, so the caller can ask the user for the
  //  actual date rather than inventing one.
  //  DEFECT E: a quote whose assetId doesn't resolve to a live asset (a
  //  home-level quote, or one orphaned by a cross-device delete) used to still
  //  flip q.status to 'booked' — the log write was gated on `if (a)` alone, so
  //  status changed but ZERO records were created: invisible on Coming up, no
  //  ✓ Done ever possible, permanently unfinishable. Now the whole booking is
  //  refused so the caller can attach a real asset first (see the /book
  //  asset-picker in app.js) instead of minting an unfinishable job.
  bookQuote(quoteId, { date, time = '', note = '', cost = 0, providerId = '', ref = '' } = {}) {
    const q = Store.quote(quoteId); if (!q) return null;
    const a = Store.asset(q.assetId); if (!a) return null;
    const isoDate = Store.parseOfferedDate(date, Store.localISO()); if (!isoDate) return null;
    const noteText = note || q.trade || 'Booked job';
    q.status = 'booked'; q.bookedDate = isoDate; q.bookedTime = time; q.amount = cost;
    Store.upsertQuote(q);
    let existing = Store.state.logs.find(l => l.assetId === a.id && l.quoteId === q.id);
    if (!existing) {
      // ...but only a log for the SAME job. This fallback was written when an
      // asset had one job in flight at a time, so "the single pending booking
      // on this asset" and "the booking this quote is for" were the same thing.
      // Task-scoped quotes make several bookings per asset the intended shape
      // (a garden's $80 mow and its $1,100 tree lopping), and adopting on asset
      // alone OVERWRITES the other job's commitment in place — its date, price
      // and note gone, with no second row and no undo. Same scope rule as
      // quoteForScope(): a taskless quote may still adopt a taskless log
      // (unchanged for every booking made before this existed), and anything
      // mismatched gets its own new row rather than eating someone else's.
      const legacy = Store.state.logs.filter(l => l.assetId === a.id && l.source === 'booked' && l.pending && !l.quoteId
                                                  && (l.taskId || '') === (q.taskId || ''));
      if (legacy.length === 1) existing = legacy[0];
    }
    const patch = { date: isoDate, note: noteText + (time ? ' · ' + time : ''), cost,
                     providerId: providerId || '', ref: ref || '', quoteId: q.id, pending: true,
                     taskId: q.taskId || '' };  // costUpcoming/_bookedTaskIds needs this to avoid double-pricing a booked task
    if (existing) Store.updateLog(existing.id, patch);
    else Store.addLog({ assetId: a.id, ...patch, source: 'booked' });
    return q;
  },
  deleteLog(id) { Store.state.logs = Store.state.logs.filter(l => l.id !== id); Store._tombstone(id); Store.save(); },
  upsertAsset(a) {
    if (!a.id) { a.id = Store.uid('a'); a.homeId = a.homeId || Store.state.currentHomeId; Store.state.assets.push(a); }
    else { const i = Store.state.assets.findIndex(x => x.id === a.id);
           i === -1 ? Store.state.assets.push(a) : (Store.state.assets[i] = a); }  // arr[-1]= silently loses the write
    Store.save(); return a;
  },
  deleteAsset(id) {
    const goneTasks = Store.state.tasks.filter(t => t.assetId === id).map(t => t.id);
    const goneLogs = Store.state.logs.filter(l => l.assetId === id).map(l => l.id);
    const goneQuotes = (Store.state.quotes || []).filter(q => q.assetId === id).map(q => q.id);
    Store.state.assets = Store.state.assets.filter(a => a.id !== id);
    Store.state.tasks = Store.state.tasks.filter(t => t.assetId !== id);
    // Same orphan rule as deleteHome: logs silently vanish from cost totals and a
    // quote with a live homeId still renders as a zombie card if left behind.
    Store.state.logs = Store.state.logs.filter(l => l.assetId !== id);
    Store.state.quotes = (Store.state.quotes || []).filter(q => q.assetId !== id);
    Store._tombstone([id, ...goneTasks, ...goneLogs, ...goneQuotes]);
    Store.save();
    Store._purgeVault([id]);
  },
  upsertTask(t) {
    if (!t.id) { t.id = Store.uid('t'); Store.state.tasks.push(t); }
    else { const i = Store.state.tasks.findIndex(x => x.id === t.id);
           i === -1 ? Store.state.tasks.push(t) : (Store.state.tasks[i] = t); }
    Store.save(); return t;
  },
  // A quote scoped to this task would otherwise be orphaned — pointing at a job
  // that no longer exists, so quoteForTask() can never surface it again and
  // bookingSettles() can never match it, while it keeps rendering on the asset
  // page forever. UNSCOPE rather than delete (what deleteAsset does to its
  // quotes): a quote can carry a real amount and a live email thread with a
  // trade, and losing the task it was raised for is no reason to silently
  // destroy that. Cleared of its taskId it simply becomes an asset-level quote
  // again — visible, usable, still attached to something real.
  deleteTask(id) {
    Store.state.tasks = Store.state.tasks.filter(t => t.id !== id);
    (Store.state.quotes || []).forEach(q => { if (q.taskId === id) { delete q.taskId; } });
    Store._tombstone(id); Store.save();
  },
  snoozeTask(id) { const t = Store.state.tasks.find(x => x.id === id); if (t) { t.snoozed = true; Store.save(); } },   // disable/ignore, keep it
  unsnoozeTask(id) { const t = Store.state.tasks.find(x => x.id === id); if (t) { delete t.snoozed; Store.save(); } }, // bring it back
  upsertProvider(p) {
    if (!p.id) { p.id = Store.uid('p'); p.homeId = p.homeId || Store.state.currentHomeId; Store.state.providers.push(p); }
    else { const i = Store.state.providers.findIndex(x => x.id === p.id);
           i === -1 ? Store.state.providers.push(p) : (Store.state.providers[i] = p); }
    Store.save(); return p;
  },
  // What a provider is actually on the hook for, now that "who does this job"
  // is a per-TASK decision: assets naming them as the default, PLUS tasks that
  // name them directly. Counting assets alone made a trade used for exactly one
  // job (a garden's tree lopper, solar's panel cleaner) look entirely unused —
  // so the delete confirmation offered to remove them without mentioning the
  // job that would be silently unlinked.
  providerLinks(id) {
    const assets = Store.homeAssets();
    const ids = new Set(assets.map(a => a.id));
    return { assets: assets.filter(a => a.providerId === id),
             tasks: Store.state.tasks.filter(t => t.providerId === id && ids.has(t.assetId)) };
  },
  // One phrase for a confirm or toast: "2 assets and 1 job", "1 job", or ''.
  providerLinkLabel(id) {
    const { assets, tasks } = Store.providerLinks(id);
    const bits = [];
    if (assets.length) bits.push(assets.length + ' asset' + (assets.length > 1 ? 's' : ''));
    if (tasks.length) bits.push(tasks.length + ' job' + (tasks.length > 1 ? 's' : ''));
    return bits.join(' and ');
  },
  deleteProvider(id) {
    const goneMail = (Store.state.mail || []).filter(m => m.providerId === id).map(m => m.id);
    Store.state.providers = Store.state.providers.filter(p => p.id !== id);
    Store.state.assets.forEach(a => { if (a.providerId === id) a.providerId = ''; });  // unlink, don't orphan
    // Task-level overrides too — a stale dead id here would MASK the asset's provider
    // (truthy but unresolvable), leaving the task looking unassigned forever.
    Store.state.tasks.forEach(t => { if (t.providerId === id) delete t.providerId; });
    // Correspondence only exists as a thread with this trade — with them gone it is
    // unreachable, so drop it. Job logs stay: they hang off the asset and are spend.
    Store.state.mail = (Store.state.mail || []).filter(m => m.providerId !== id);
    Store._tombstone([id, ...goneMail]);
    Store.save();
  },
  // Archiving keeps a trade you no longer use — their job history stays intact and
  // still counts towards what you've spent; they just drop to the bottom of the list.
  activeProviders: () => Store.homeProviders().filter(p => !p.archived),
  pastProviders: () => Store.homeProviders().filter(p => p.archived),
  setProviderArchived(id, v) {
    const p = Store.provider(id); if (!p) return null;
    p.archived = !!v;
    Store.save(); return p;
  },

  // ---- prepaid service packs ----
  // Some trades sell maintenance up front: "6 visits for $X". The pack lives on
  // the asset it covers, so the balance is visible exactly where you'd look for it.
  pack: a => (a && a.pack && a.pack.bought) ? a.pack : null,
  packLeft(a) { const p = Store.pack(a); return p ? Math.max(0, (p.bought || 0) - (p.used || 0)) : null; },
  packPerVisit(a) { const p = Store.pack(a); return (p && p.cost && p.bought) ? p.cost / p.bought : null; },
  usePack(assetId, n = 1) {
    const a = Store.asset(assetId); if (!a || !a.pack) return null;
    a.pack.used = Math.max(0, Math.min(a.pack.bought, (a.pack.used || 0) + n));
    Store.save(); return a.pack;
  },
  setPack(assetId, pack) {
    const a = Store.asset(assetId); if (!a) return null;
    if (!pack || !pack.bought) delete a.pack; else a.pack = pack;
    Store.save(); return a;
  },

  // ---- usage-based reminders (live HA telemetry augments the calendar) ----
  // asset.usage = { entity, mode:'runtime'|'energy', threshold, unit, since:ISO, baseline:kWh|null }
  // Reset the usage window — call after servicing. Energy mode snapshots the meter reading.
  async resetUsage(assetId) {
    const a = Store.asset(assetId); if (!a || !a.usage) return;
    a.usage.since = new Date().toISOString();
    if (a.usage.mode === 'energy') { const v = await HA.sensorValue(a.usage.entity); a.usage.baseline = (v == null ? a.usage.baseline : v); }
    Store.upsertAsset(a);
  },
  // Live progress toward the usage threshold. null = no HA / no data yet. Never throws.
  async usageStatus(a) {
    if (!a || !a.usage || !HA.ready()) return null;
    const u = a.usage; let used = null;
    if (u.mode === 'energy') {
      const v = await HA.sensorValue(u.entity);
      if (v != null && u.baseline != null) used = Math.max(0, v - u.baseline);
    } else {
      used = await HA.onHours(u.entity, u.since || new Date(Date.now() - 7 * DAY).toISOString());
    }
    if (used == null) return null;
    const pct = u.threshold > 0 ? Math.min(100, Math.round((used / u.threshold) * 100)) : 0;
    return { used, threshold: u.threshold, unit: u.unit, pct, due: used >= u.threshold };
  },

  // ---- device-initiated maintenance (problem-entity watches) ----
  // asset.ha.watch = [{ entity, kind:'problem'|'fault'|'consumable', label,
  //                     compare:'on'|'nonzero'|'lte'|'gte', threshold?, addedAt }]
  // The server's fault scanner is the only writer of task.fault (except the
  // 'done' stamp in markDone below) — clients only choose WHAT to watch.
  WATCH_MAX: 8,
  watchFor(assetId) { const a = Store.asset(assetId); return (a && a.ha && a.ha.watch) || []; },
  setWatch(assetId, list) {
    const a = Store.asset(assetId);
    if (!a || !a.ha || !a.ha.deviceId) return null;   // watches only make sense on an HA-linked asset
    const clean = (list || []).slice(0, Store.WATCH_MAX);
    if (clean.length) a.ha.watch = clean; else delete a.ha.watch;
    Store.upsertAsset(a); return a;
  },

  suggestTasks(assetId) {
    const a = Store.asset(assetId); if (!a) return 0;
    const cat = CATEGORIES[a.category]; if (!cat) return 0;
    const have = new Set(Store.tasksFor(assetId).map(t => t.title.toLowerCase()));
    let added = 0;
    cat.defaults.forEach(d => { if (have.has(d.title.toLowerCase())) return;
      Store.upsertTask({ assetId, title: d.title, cadenceDays: d.cadenceDays, estCost: d.estCost, lastDone: '', ...(d.season ? { season: d.season } : {}) }); added++; });
    return added;
  },

  // ---- costs (current home) ----
  costThisYear() {
    // Count by ASSET, not task: one-off jobs (and jobs whose task was later
    // deleted or snoozed) are real spend and must not vanish from the total.
    // `pending` = booked but not done yet — a commitment, not spend. Excluded
    // until you mark it done, so totals never count money you haven't paid.
    const y = String(new Date().getFullYear());
    const ids = new Set(Store.homeAssets().map(a => a.id));
    return Store.state.logs.filter(l => ids.has(l.assetId) && !l.pending && String(l.date || '').startsWith(y))
             .reduce((s, l) => s + (l.cost || 0), 0);
  },
  // A booked job that has happened: it stops being a commitment and becomes history.
  // Flips the OWNING quote to status 'done' too — otherwise the quote card
  // still read 'booked' forever, and "📌 Change date" was its only button,
  // silently re-opening a finished job (DEFECT 3).
  completeLog(id) {
    const l = Store.updateLog(id, { pending: false, source: 'done' });
    if (l && l.quoteId) { const q = Store.quote(l.quoteId); if (q) { q.status = 'done'; Store.upsertQuote(q); } }
    // Bump the linked task's countdown too — a booked job's log carries the
    // task id (see bookQuote), and without this t.lastDone stays at its old
    // value forever. server.py's autobook_scan excludes 'done' quotes from
    // its in-flight set specifically so the task's NEXT due date can autobook
    // again — that only holds if lastDone actually moves; otherwise
    // _task_days_until still reads the job as overdue and the very next scan
    // re-emails the trade for the job that was just completed.
    if (l && l.taskId) { const t = Store.state.tasks.find(x => x.id === l.taskId); if (t) { t.lastDone = l.date || Store.localISO(); Store.upsertTask(t); } }
    return l;
  },
  // Days between a YYYY-MM-DD log date and today (local calendar), or null if
  // unparsable. 'T00:00:00' (no zone) forces a date-only string to parse as
  // LOCAL midnight, matching Store.today() — a bare `new Date(dateStr)`
  // parses a date-only string as UTC midnight instead, which in any
  // negative-UTC-offset timezone (e.g. US) reads a job dated exactly TODAY as
  // a day earlier than intended (confirmed: this misdated a job due today in
  // western timezones before this fix).
  _dayDelta(dateStr) {
    if (!dateStr) return null;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? new Date(dateStr + 'T00:00:00') : new Date(dateStr);
    if (isNaN(d)) return null;
    d.setHours(0, 0, 0, 0);
    return Math.round((d - Store.today()) / DAY);
  },
  // Pending (booked, not-yet-done) logs for the current home — the actual-cost
  // half of both costUpcoming and costOverdue below.
  _pendingBookings() { return Store.homeLogs().filter(l => l.pending); },
  // THE single answer to "is this pending booking log the same job as this
  // task?" — every caller that used to ask this separately (dedupeAttentionTasks
  // in app.js matching on l.taskId alone, costUpcoming/costOverdue's old
  // _bookedTaskIds) drifted, because a quote born from Find-a-service or the
  // enquiry email NEVER sets a taskId on the log bookQuote() writes for it —
  // that is the COMMON path, not an edge case. An overdue task plus its own
  // slipped taskless booking rendered as two attention rows and summed to
  // $720 for a $420 job (DEFECT A); the reverse also happened — a taskless
  // slipped booking counted for money but not for count (DEFECT B(i)), and a
  // future-dated booking suppressed its task's estimate while contributing no
  // overdue money of its own (DEFECT B(ii)).
  // Resolution order (same-asset is a hard gate throughout):
  //   1. l.taskId set -> exact match/mismatch, nothing else considered.
  //   2. l.taskId blank but its quote names one (Store.quote(l.quoteId).taskId)
  //      -> exact match/mismatch, nothing else considered either — a quote that
  //      names a DIFFERENT task must never fall through to a fuzzy match below.
  //   3. neither side names a task: the booking's note and the task's title
  //      overlap (case-insensitive substring, either direction) AND no OTHER
  //      live task on the same asset has an equal-or-more-specific (equal-or-
  //      longer title) overlap with the same note — a booking must resolve to
  //      AT MOST ONE task, or a generic title ('Service') that's a substring
  //      of a more specific sibling ('Service filter') would independently
  //      match both and the overdue job gets double-counted.
  //   4. still nothing: this is the ONLY taskless (and quote-taskless) pending
  //      booking on an asset that has exactly one live (non-snoozed) task —
  //      nothing else it could be.
  //
  // READ-ONLY matcher — rules 3 and 4 are heuristics meant for dashboard
  // display/suppression (dedupeAttentionTasks, costOverdue/costUpcoming,
  // doneDialogDefaultCost), where a wrong guess costs at most a row rendering
  // twice or briefly not at all. Do NOT wire this into a path that WRITES —
  // markDone()'s destructive settle uses bookingSettles() below instead,
  // which only trusts rules 1-2 (see its own comment for why).
  bookingCovers(l, t) {
    if (!l || !t || l.assetId !== t.assetId) return false;
    if (l.taskId) return l.taskId === t.id;
    const q = l.quoteId ? Store.quote(l.quoteId) : null;
    if (q && q.taskId) return q.taskId === t.id;
    const title = String(t.title || '').trim().toLowerCase();
    const note = String(l.note || '').trim().toLowerCase();
    if (title && note && (note.indexOf(title) !== -1 || title.indexOf(note) !== -1)) {
      // homeTasksAll() (not Store.state.tasks) so this only ever weighs rivals
      // from the SAME home as t — same-asset filtering already guarantees that
      // in practice (an asset belongs to exactly one home), but scoping it
      // explicitly keeps this consistent with _pendingBookings()'s own home
      // scope rather than relying on that coincidence.
      const rivals = Store.homeTasksAll().filter(x => x.assetId === t.assetId && !x.snoozed && x.id !== t.id).filter(x => {
        const xt = String(x.title || '').trim().toLowerCase();
        return xt && (note.indexOf(xt) !== -1 || xt.indexOf(note) !== -1);
      });
      const exactRivals = rivals.filter(x => String(x.title || '').trim().toLowerCase() === note);
      if (title === note) {
        // An exact title===note match always beats a merely-overlapping
        // rival (however much longer its title is) — 'Service' must resolve
        // to the 'Service' task even with a 'Service filter' sibling. A tie
        // against another exact match is genuine ambiguity, so neither wins.
        if (!exactRivals.length) return true;
      } else if (!exactRivals.length && !rivals.some(x => String(x.title || '').trim().length >= title.length)) {
        // No rival matches the note exactly (that would always outrank a
        // mere substring match), and no rival is at least as specific as
        // this task's own substring match — safe to resolve here. A strict
        // tie (another task's title is exactly as specific) is genuine
        // ambiguity too — neither wins, so both fall through rather than
        // both winning independently.
        return true;
      }
    }
    const liveTasks = Store.homeTasksAll().filter(x => x.assetId === t.assetId && !x.snoozed);
    if (liveTasks.length !== 1 || liveTasks[0].id !== t.id) return false;
    const taskless = Store._pendingBookings().filter(x => x.assetId === t.assetId && !x.taskId &&
      !(x.quoteId && Store.quote(x.quoteId) && Store.quote(x.quoteId).taskId));
    return taskless.length === 1 && taskless[0].id === l.id;
  },
  // HIGH-confidence-only subset of bookingCovers() above, for the DESTRUCTIVE
  // settle path in markDone() (REVIEW-1, post-369cb0f). Only an explicit
  // l.taskId or its quote's taskId links a booking to a task strongly enough
  // to justify overwriting cost/date/pending and closing the quote — that's
  // rules 1-2 of bookingCovers() verbatim, and nothing else. The note/title-
  // overlap and sole-taskless-booking heuristics (rules 3-4) are fine for
  // read-only dashboard suppression (worst case: a row renders twice, or
  // briefly doesn't render at all) but are exactly what let markDone() settle
  // the WRONG booking and silently destroy an unrelated job's real price —
  // see bookingCovers()'s own comment. Never widen this to the heuristic
  // rules; if a task's own booking isn't linked by taskId/quote.taskId,
  // markDone() falls through to logging a fresh row instead of guessing.
  bookingSettles(l, t) {
    if (!l || !t || l.assetId !== t.assetId) return false;
    if (l.taskId) return l.taskId === t.id;
    const q = l.quoteId ? Store.quote(l.quoteId) : null;
    return !!(q && q.taskId && q.taskId === t.id);
  },
  // Overdue tasks with no double-booking: excludes any overdue task that a
  // pending booking already covers, PAST or FUTURE dated (DEFECT B(ii) — a
  // future-dated booking must still suppress the task's own estimate, exactly
  // like a past-dated one always did, or the task's money vanishes from
  // BOTH costUpcoming and costOverdue with nothing replacing it) — but ONLY
  // up to ATTENTION_WINDOW_DAYS out. Past that, costUpcoming(90) (the only
  // caller) can no longer see the covering booking either, so an unbounded
  // exclusion here would make the money vanish from both sums with nothing
  // replacing it — exactly the failure this comment used to claim it prevented.
  // An UNDATED pending booking (date cleared via save-job, still `pending`)
  // does NOT count as covering: it can never appear in overdueBookings() or
  // upcomingBookings() either (both require a parseable date), so treating
  // it as covering here made the task's own row vanish with nothing to
  // replace it — a booking and its task both silently disappearing from the
  // whole dashboard for a still-live job.
  overdueTasks() {
    const pending = Store._pendingBookings();
    return Store.homeTasks().filter(t => Store.status(t) === 'overdue' && !pending.some(l => {
      if (!Store.bookingCovers(l, t)) return false;
      const d = Store._dayDelta(l.date);
      return d !== null && d <= ATTENTION_WINDOW_DAYS;
    }));
  },
  // The canonical overdue count: overdue tasks not already covered by a
  // booking, plus overdue (past-dated) bookings — the same two sets
  // costOverdue() below prices, so count and money can never disagree again.
  overdueCount() { return Store.overdueTasks().length + Store.overdueBookings().length; },
  // Money falling due FROM TODAY forward within the window: scheduled tasks due
  // 0..days out (estCost, excluding any task a pending booking already covers)
  // plus pending bookings dated today..+days (actual cost). Overdue backlog is
  // deliberately excluded — see costOverdue() — so this number means what its
  // "next Nd" label says instead of swallowing years-old debt.
  costUpcoming(days) {
    const pending = Store._pendingBookings();
    const taskCost = Store.homeTasks()
      .filter(t => { if (pending.some(l => Store.bookingCovers(l, t))) return false; const d = Store.daysUntil(t); return d !== null && d >= 0 && d <= days; })
      .reduce((s, t) => s + (t.estCost || 0), 0);
    const bookingCost = pending
      .filter(l => { const d = Store._dayDelta(l.date); return d !== null && d >= 0 && d <= days; })
      .reduce((s, l) => s + (l.cost || 0), 0);
    return taskCost + bookingCost;
  },
  // The already-overdue backlog: est cost of Store.overdueTasks() plus the
  // cost of Store.overdueBookings() — exactly the two sets overdueCount()
  // above counts, so count and money describe the same rows by construction.
  costOverdue() {
    const taskCost = Store.overdueTasks().reduce((s, t) => s + (t.estCost || 0), 0);
    const bookingCost = Store.overdueBookings().reduce((s, l) => s + (l.cost || 0), 0);
    return taskCost + bookingCost;
  },
  // Pending booked logs dated before today — a confirmed job whose date has
  // slipped by unnoticed. Nothing nags about these otherwise (they aren't tasks).
  overdueBookings() {
    return Store._pendingBookings().filter(l => { const d = Store._dayDelta(l.date); return d !== null && d < 0; });
  },
};
