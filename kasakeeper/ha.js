// KasaKeeper — Home Assistant integration (live device state for usage-based reminders).
// Two paths: (1) the add-on's tokenless backend PROXY (/api/ha/*, uses the Supervisor
// token — zero config); (2) direct HA REST with a user URL + long-lived token.
const HA = {
  proxy: false,  // set true by init() when the backend proxy is available (i.e. inside the add-on)
  async init() {
    try { const r = await fetch('api/ha/available'); const j = await r.json(); HA.proxy = !!(j && j.available); }
    catch { HA.proxy = false; }
    return HA.proxy;
  },
  cfg() { const s = Store.state.settings; return { url: (s.haUrl || '').replace(/\/$/, ''), token: s.haToken || '' }; },
  ready() { const c = HA.cfg(); return !!(HA.proxy || (c.url && c.token)); },

  async _get(path) {
    const c = HA.cfg();
    const res = await fetch(c.url + path, { headers: { Authorization: 'Bearer ' + c.token } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  },

  async test() {
    if (HA.proxy) return { ok: true, msg: 'Connected via the add-on (no token needed).' };
    if (!HA.ready()) return { ok: false, msg: 'Add your HA URL + token first.' };
    try { const j = await HA._get('/api/'); return { ok: true, msg: j.message || 'Connected' }; }
    catch (e) {
      const hint = String(e).includes('Failed to fetch')
        ? 'Blocked — likely CORS. Add this app’s origin to HA http:cors_allowed_origins.'
        : String(e);
      return { ok: false, msg: hint };
    }
  },

  // Returns { state, attributes } or null. Never throws. Uses proxy when available.
  async entity(entityId) {
    if (!entityId || !HA.ready()) return null;
    try {
      if (HA.proxy) {
        const res = await fetch('api/ha/state?entity=' + encodeURIComponent(entityId));
        if (!res.ok) return null;
        return await res.json();
      }
      return await HA._get('/api/states/' + encodeURIComponent(entityId));
    } catch { return null; }
  },

  // Current numeric value of a sensor (e.g. a total_increasing kWh meter). null if not numeric.
  async sensorValue(entityId) {
    const s = await HA.entity(entityId);
    if (!s) return null;
    const n = parseFloat(s.state);
    return isNaN(n) ? null : n;
  },

  // Raw history rows for one entity since an ISO timestamp (recorder retention window).
  async history(entityId, sinceISO) {
    if (!entityId || !HA.ready()) return null;
    try {
      let res;
      if (HA.proxy) {
        res = await fetch(`api/ha/history?entity=${encodeURIComponent(entityId)}&since=${encodeURIComponent(sinceISO)}`);
      } else {
        const c = HA.cfg();
        const path = `/api/history/period/${encodeURIComponent(sinceISO)}?filter_entity_id=${encodeURIComponent(entityId)}`;
        res = await fetch(c.url + path, { headers: { Authorization: 'Bearer ' + c.token } });
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      return (j && j[0]) || [];
    } catch { return null; }
  },

  // Hours an entity spent in an "on-ish" state since `sinceISO`. Works for switches
  // (on/off) and climate (off vs heat/cool/auto/…). null if no history. Never throws.
  _OFF: new Set(['off', 'unavailable', 'unknown', 'idle', 'standby', 'closed', 'none', '0', 'false', '']),
  async onHours(entityId, sinceISO) {
    const rows = await HA.history(entityId, sinceISO);
    if (!rows || !rows.length) return null;
    const onish = s => !HA._OFF.has(String(s).toLowerCase());
    // HA's minimal_response drops last_changed on intermediate rows — fall back to
    // last_updated so run-hours are correct on both the proxy and direct paths.
    const ts = r => new Date(r.last_changed || r.last_updated).getTime();
    const since = new Date(sinceISO).getTime(), now = Date.now();
    let total = 0;
    for (let i = 0; i < rows.length; i++) {
      const t0 = Math.max(ts(rows[i]), since);
      const t1 = i + 1 < rows.length ? ts(rows[i + 1]) : now;
      if (onish(rows[i].state) && t1 > t0) total += t1 - t0;
    }
    return total / 3600000;
  },

  // Maintenance-relevant HA devices for the import screen. Never throws —
  // degrades to {available:false, devices:[]} so the caller always has shape.
  async devices() {
    try {
      const res = await fetch('api/ha/devices');
      const j = await res.json();
      return { available: !!(j && j.available), devices: (j && j.devices) || [], everythingElse: (j && j.everythingElse) || [] };
    } catch { return { available: false, devices: [], everythingElse: [] }; }
  },

  // Registry drift findings for the current home (field drift, vanished devices,
  // unimported new devices) — read-only, server writes nothing. Never throws.
  async drift() {
    try {
      const res = await fetch('api/ha/drift');
      const j = await res.json();
      return { available: !!(j && j.available), drift: (j && j.drift) || [],
               vanished: (j && j.vanished) || [], newDevices: (j && j.newDevices) || [] };
    } catch { return { available: false, drift: [], vanished: [], newDevices: [] }; }
  },

  // Watch candidates for one HA-linked asset (device-initiated maintenance) —
  // read-only, server-cached registry read. Never throws.
  async problemEntities(assetId) {
    try {
      const res = await fetch('api/ha/problem-entities?assetId=' + encodeURIComponent(assetId));
      const j = await res.json();
      return { available: !!(j && j.available), candidates: (j && j.candidates) || [], watching: (j && j.watching) || [] };
    } catch { return { available: false, candidates: [], watching: [] }; }
  },

  // A short human label for an entity's live value (used on asset cards).
  fmt(s) {
    if (!s) return null;
    const a = s.attributes || {};
    if (a.temperature != null || a.current_temperature != null)
      return `${a.current_temperature ?? a.temperature}°`;
    if (a.unit_of_measurement) return `${s.state} ${a.unit_of_measurement}`;
    return String(s.state);
  },
};
