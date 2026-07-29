// KasaKeeper — state persistence (localStorage) + scheduling. Multi-home, generic.
const KEY = 'kasakeeper.v1';
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
  _shareable() {
    const { haUrl, haToken, ...settings } = this.state.settings || {};
    // Per-home HA source (home.ha, see homeHA()) is meant to carry only
    // {mode,url} — url is just an address, fine to sync. A token must never
    // land here even if something upstream mistakenly set one, same rule as
    // the legacy global haToken above.
    const homes = (this.state.homes || []).map(h => {
      if (!h || !h.ha) return h;
      const { haToken, token, ...ha } = h.ha;
      return { ...h, ha };
    });
    return { ...this.state, settings, homes };
  },
  _adopt(state) {
    const keep = this.state.settings || {};
    this.state = state;
    this.state.settings = { ...(state.settings || {}), haUrl: keep.haUrl, haToken: keep.haToken };
    if (!this.state.tombstones) this.state.tombstones = [];   // legacy server copy predating tombstones
    // Defensive strip on the way in too — an adopted server/merged copy must
    // never seed a per-home token into localStorage.
    (this.state.homes || []).forEach(h => { if (h && h.ha) { delete h.ha.haToken; delete h.ha.token; } });
    localStorage.setItem(KEY, JSON.stringify(this.state));
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
  // ---- merge-aware sync (#10) ----
  // A rev conflict (a 409 on push, or a GET that's moved on since our last rev)
  // means another device wrote first. Wholesale-adopting the server's copy — the
  // old behaviour — threw away anything WE'D written that hadn't reached the
  // server yet (a new asset added the moment another device's write raced ours).
  // Policy: for every id-keyed collection (ID_KEYED above), union by id — the
  // SERVER's row wins whenever an id exists on both sides (theirs is what won
  // the race, so treat it as newer), and any id that exists only locally is
  // KEPT, not dropped — UNLESS the server's tombstones say that id was deleted
  // by another device, in which case it's a delete, not a race, and it stays
  // gone. Symmetrically, a server row whose id is in OUR tombstones (we deleted
  // it locally but haven't pushed yet) is dropped from the merge too — without
  // this, a same-cycle "rescue" would immediately undo our own delete. Both
  // tombstone lists are unioned into the merged state (capped at 400, oldest
  // first out — see _tombstone). `settings` and everything else outside the
  // id-keyed collections (e.g. currentHomeId) take the server's copy outright,
  // same as a plain adopt. Device-local settings (haUrl/haToken) are re-applied
  // by _adopt() as always.
  _mergeState(serverState, localState) {
    const serverTomb = Array.isArray(serverState.tombstones) ? serverState.tombstones : [];
    const localTomb = Array.isArray(localState.tombstones) ? localState.tombstones : [];
    const serverTombIds = new Set(serverTomb.map(t => t && t.id));
    const localTombIds = new Set(localTomb.map(t => t && t.id));
    let rescued = 0;
    const merged = { ...serverState };
    ID_KEYED.forEach(key => {
      // A row the OTHER side deleted (their id is in the tombstones we're
      // checking against) never makes it into the merged collection, from
      // either source — that's the whole point of the tombstone.
      const serverList = (Array.isArray(serverState[key]) ? serverState[key] : [])
        .filter(x => !(x && localTombIds.has(x.id)));
      const localList = Array.isArray(localState[key]) ? localState[key] : [];
      const serverIds = new Set(serverList.map(x => x && x.id));
      const localOnly = localList.filter(x => x && x.id && !serverIds.has(x.id) && !serverTombIds.has(x.id));
      rescued += localOnly.length;
      merged[key] = serverList.concat(localOnly);
    });
    const tombById = new Map();
    serverTomb.concat(localTomb).forEach(t => { if (t && t.id) tombById.set(t.id, t); });
    merged.tombstones = Array.from(tombById.values())
      .sort((a, b) => String(a.at || '').localeCompare(String(b.at || ''))).slice(-400);
    if (rescued) console.info(`[Store] merge rescued ${rescued} local-only entit${rescued === 1 ? 'y' : 'ies'} that a sync conflict would otherwise have dropped`);
    return { state: merged, rescued };
  },
  async syncRemote() {
    try {
      const r = await fetch('api/state'); if (!r.ok) return false;
      const j = await r.json();
      if (j && j.state && j.state.homes && j.state.homes.length) {
        const rev = j.rev || 0;
        if (rev === this.rev && JSON.stringify(j.state) === JSON.stringify(this._shareable())) return 'same';
        // A local write may have raced this GET (queued for push but not sent yet,
        // or in flight) — merge rather than adopt so it isn't silently discarded.
        const { state: merged, rescued } = this._mergeState(j.state, this.state);
        this.rev = rev;
        this._adopt(merged);
        if (rescued) Store.push();   // hand the rescued entities back to the server (same 409→merge→retry-once→adopt guard as any other push)
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
  // a second 409 in a row adopts the server's copy outright rather than merging
  // and pushing again, so a hot conflict can never loop.
  async _pushNow(retried = false) {
    try {
      const r = await fetch('api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseRev: this.rev, state: this._shareable() }) });
      if (r.status === 409) {                            // another device wrote first
        const j = await r.json();
        if (!(j.state && j.state.homes)) return false;
        this.rev = j.rev || 0;
        if (retried) {                                   // loop guard — already merged & retried once
          this._adopt(j.state);
          if (typeof render === 'function') render();
          return false;
        }
        const { state: merged } = this._mergeState(j.state, this.state);
        this._adopt(merged);
        if (typeof render === 'function') render();
        return this._pushNow(true);                      // push once more with the server's rev as baseRev
      }
      const j = await r.json(); if (j.ok) this.rev = j.rev;
      return true;
    } catch { return false; }                            // offline — local cache holds; next save retries
  },
  reset() { this.state = JSON.parse(JSON.stringify(SEED)); this.save(); },
  uid: p => p + Math.random().toString(36).slice(2, 8),

  // ---- homes ----
  home: () => Store.state.homes.find(h => h.id === Store.state.currentHomeId) || null,
  // A test/demo home (a friend's house) — no live HA, no usage/nudges, no auto-mail.
  isTestHome: () => !!(Store.home() || {}).testMode,
  addHome(h) { h.id = Store.uid('h'); Store.state.homes.push(h); Store.state.currentHomeId = h.id; Store.save(); return h; },
  switchHome(id) { Store.state.currentHomeId = id; Store.save(); },
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
    if (Store.state.currentHomeId === id) Store.state.currentHomeId = (Store.state.homes[0] || {}).id || null;
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

  // ---- current-home scoped collections ----
  homeAssets: () => Store.state.assets.filter(a => a.homeId === Store.state.currentHomeId),
  homeProviders: () => Store.state.providers.filter(p => p.homeId === Store.state.currentHomeId),
  homeTasks: () => { const ids = new Set(Store.homeAssets().map(a => a.id)); return Store.state.tasks.filter(t => ids.has(t.assetId) && !t.snoozed); },  // active only — snoozed excluded everywhere
  homeTasksAll: () => { const ids = new Set(Store.homeAssets().map(a => a.id)); return Store.state.tasks.filter(t => ids.has(t.assetId)); },
  snoozedTasks: () => { const ids = new Set(Store.homeAssets().map(a => a.id)); return Store.state.tasks.filter(t => ids.has(t.assetId) && t.snoozed); },
  homeQuotes: () => Store.state.quotes.filter(q => q.homeId === Store.state.currentHomeId),
  quote: id => Store.state.quotes.find(q => q.id === id),
  quoteForAsset: assetId => Store.state.quotes.find(q => q.assetId === assetId && q.status !== 'booked' && q.status !== 'declined'),
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
  markDone(taskId, cost) {
    const t = Store.state.tasks.find(x => x.id === taskId); if (!t) return;
    const iso = Store.localISO();
    t.lastDone = iso;
    // Fault task: 'done' stops the server re-raising until the device is
    // observed normal again (fault_scan then retires the row — this log entry
    // keeps the history) and faults anew.
    if (t.fault && t.fault.state !== 'done') { t.fault.state = 'done'; t.fault.doneAt = iso; }
    const a = Store.asset(t.assetId);
    // Record WHAT was done and WHO did it, so it reads as real job history later.
    Store.state.logs.push({ id: Store.uid('l'), taskId, assetId: t.assetId, date: iso,
                            cost: Number(cost) || 0, note: t.title || '',
                            providerId: t.providerId || (a && a.providerId) || '', ref: '', source: 'done' });  // task override wins — the log credits who actually did it
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
  deleteTask(id) { Store.state.tasks = Store.state.tasks.filter(t => t.id !== id); Store._tombstone(id); Store.save(); },
  snoozeTask(id) { const t = Store.state.tasks.find(x => x.id === id); if (t) { t.snoozed = true; Store.save(); } },   // disable/ignore, keep it
  unsnoozeTask(id) { const t = Store.state.tasks.find(x => x.id === id); if (t) { delete t.snoozed; Store.save(); } }, // bring it back
  upsertProvider(p) {
    if (!p.id) { p.id = Store.uid('p'); p.homeId = p.homeId || Store.state.currentHomeId; Store.state.providers.push(p); }
    else { const i = Store.state.providers.findIndex(x => x.id === p.id);
           i === -1 ? Store.state.providers.push(p) : (Store.state.providers[i] = p); }
    Store.save(); return p;
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
  completeLog(id) { return Store.updateLog(id, { pending: false, source: 'done' }); },
  costUpcoming(days) {
    return Store.homeTasks().filter(t => { const d = Store.daysUntil(t); return d !== null && d <= days; }).reduce((s, t) => s + (t.estCost || 0), 0);
  },
};
