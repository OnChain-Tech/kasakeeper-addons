// KasaKeeper — UI, routing, and smart features.
const $app = document.getElementById('app');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const money = n => '$' + (Number(n) || 0).toLocaleString();
const webUrl = w => !w ? '' : (/^https?:\/\//i.test(w) ? w : 'https://' + w.replace(/^\/+/, ''));
const COLOR = { overdue: 'red', soon: 'amber', ok: 'green' };
// Sensible starting points for a usage trigger, by category (user tweaks per asset).
const USAGE_DEFAULTS = {
  Sauna:      { mode: 'runtime', threshold: 300,  unit: 'hrs' },
  HVAC:       { mode: 'runtime', threshold: 250,  unit: 'hrs' },
  'Pool/Spa': { mode: 'runtime', threshold: 150,  unit: 'hrs' },
  Pump:       { mode: 'energy',  threshold: 1000, unit: 'kWh' },
  Energy:     { mode: 'energy',  threshold: 2000, unit: 'kWh' },
};
// Search term per category, used for live provider search + Google fallback.
const TRADES = {
  Water:'water filter plumber', Garden:'lawn mowing garden maintenance', HVAC:'air conditioning service',
  Heating:'gas heater service', 'Pool/Spa':'pool cleaning spa service', Sauna:'sauna technician',
  Energy:'solar panel cleaning', Safety:'smoke alarm service', 'Roof/Exterior':'gutter cleaning',
  Vehicle:'auto service', Lighting:'electrician', Pump:'pump repair', Camera:'security camera installer',
  Appliance:'appliance repair', Cleaning:'house cleaning',
};
// Asset tile: the make's brand logo when resolvable, category emoji otherwise.
// The img reveals itself only on load, so a 404 (no logo) never leaves a hole.
const assetTile = (a, cls = 'emoji') => `<div class="${cls}">${a && a.make
  ? `<img class="brandlogo" src="api/brand-logo?name=${encodeURIComponent(a.make)}" alt="" onload="this.classList.add('on')" onerror="this.remove()">` : ''}<span class="em">${Store.icon((a || {}).category)}</span></div>`;
// Provider tile: their website's logo when we have one (same api/logo?domain= proxy
// providerCard search results use), a 👷 tile otherwise. Mirrors assetTile's reveal-on-load.
const providerTile = (p, cls = 'emoji') => { const dom = p && p.website ? p.website.replace(/^https?:\/\//i, '').split('/')[0].trim() : '';
  return `<div class="${cls}">${dom
    ? `<img class="brandlogo" src="api/logo?domain=${encodeURIComponent(dom)}" alt="" onload="this.classList.add('on')" onerror="this.remove()">` : ''}<span class="em">👷</span></div>`; };
// The trade to actually search/call for an asset. TRADES is a per-CATEGORY default,
// which is wrong for catch-all categories (a limestone wall under Roof/Exterior is
// not a gutter-cleaning job) — an explicit per-asset override always wins.
const tradeFor = a => (a && (a.trade || '').trim()) || TRADES[(a || {}).category] || (a || {}).category || '';
// What to actually SEARCH for. The category default lies for specific assets in
// broad categories (a limestone wall under Roof/Exterior is not a gutter job), so
// the search leads with the ASSET the user tapped: "Limestone wall repair and
// maintenance" finds stonemasons; "Ducted aircon repair and maintenance" finds
// aircon techs. An explicit "Trade to call" override always wins verbatim.
const searchQueryFor = a => (a && (a.trade || '').trim()) || (a && a.name ? `${a.name} repair and maintenance` : tradeFor(a));
// Suburb is a fact about the CURRENT home, not the app — two homes in two cities
// must not share one search location. settings.suburb stays as legacy fallback.
const homeSuburb = () => { const h = Store.home(); return (h && h.suburb) || Store.state.settings.suburb || ''; };
let FIND = { assetId: null, loading: false, providers: null, msg: '' };  // live find-a-service state
let LOOKUP = { assetId: null, status: 'idle', result: null };            // feature-lookup state (per asset)
let RECALL = { assetId: null, status: 'idle', result: null };            // recall-check state (per asset)
// Developer drawer — the data behind the actions. Device-local (never synced),
// off by default; toggled in Settings. Lives OUTSIDE #app so render() can't eat it.
const DBG = {
  KEY: 'kk.debug',
  get on() { return localStorage.getItem(DBG.KEY) === '1'; },
  logs: [],
  log(action, data) {
    if (!DBG.on) return;
    DBG.logs.unshift({ t: new Date().toLocaleTimeString(), action, data });
    if (DBG.logs.length > 30) DBG.logs.length = 30;
    DBG.paint();
  },
  paint() {
    let el = document.getElementById('kk-dbg');
    if (!DBG.on) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'kk-dbg'; document.body.appendChild(el); }
    el.innerHTML = `<div class="dbg-head" data-action="dbg-fold">⚙ data behind the actions <span class="pill">${DBG.logs.length}</span></div>
      <div class="dbg-body">${DBG.logs.length ? DBG.logs.map(l =>
        `<div class="dbg-row"><div class="dbg-meta">${esc(l.t)} · ${esc(l.action)}</div><pre>${esc(JSON.stringify(l.data, null, 1))}</pre></div>`).join('')
        : '<div class="dbg-row"><div class="dbg-meta">Use the app — every search and API call lands here with its real payload.</div></div>'}</div>`;
  }
};
const stars = r => { const n = Math.round(r || 0); return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n); };
// Seasonal windows (#9, slice 1) — display only, no due-date math. A task tagged
// with an AU season gets a chip once we're within ~60 days of that season starting,
// through to its end: "before summer" leading in, "summer" once we're inside it.
const SEASON_START = { spring: 9, summer: 12, autumn: 3, winter: 6 };  // 1-indexed start month
function seasonChip(season) {
  if (!season || !SEASON_START[season]) return '';
  const now = new Date(), startMonth = SEASON_START[season];
  for (const offset of [-1, 0, 1]) {   // summer/spring starts can fall in the prior or next calendar year
    const start = new Date(now.getFullYear() + offset, startMonth - 1, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 3, 1);
    const pre = new Date(start); pre.setDate(pre.getDate() - 60);
    if (now >= pre && now < end) {
      const label = now >= start ? season : `before ${season}`;
      return ` <span class="chip cost">${esc(label)}</span>`;
    }
  }
  return '';
}

// Test homes have no live HA behind them — no usage bar to draw or hydrate.
const usageBar = (a, mini) => (a.usage && !Store.isTestHome())
  ? `<div class="usagebar${mini ? ' mini' : ''}" data-usage="${a.id}"${mini ? ' data-mini="1"' : ''}><div class="u-lbl">usage: …</div></div>`
  : '';

function route() {
  const h = (location.hash || '#/').slice(1);
  return h.split('/').filter(Boolean); // ['asset','a3']
}
function go(path) { location.hash = path; }
// Structural back — history.back() can loop when saves and redirects push extra
// entries (edit task ⇄ asset forever). Every screen has ONE parent; ‹ Back always
// climbs the hierarchy, never replays history. The hash stays a shareable deep link.
function goBack() {
  const r = route();
  const parent = {
    'asset': '/assets',
    'edit-asset': r[1] && r[1] !== 'new' ? '/asset/' + r[1] : '/assets',
    'edit-task': '/asset/' + (r[1] || ''), 'edit-usage': '/asset/' + (r[1] || ''),
    'edit-job': r[2] ? '/asset/' + (r[1] || '') : '/asset/' + (r[1] || ''),
    'find': '/asset/' + (r[1] || ''),
    'provider': '/providers', 'edit-provider': r[1] && r[1] !== 'new' ? '/provider/' + r[1] : '/providers',
    'book': '/providers', 'catalog': r[1] !== undefined && r[1] !== '' ? '/catalog' : '/assets',
    'snap': '/assets', 'gmail-import': '/settings', 'triage': '/',
  }[r[0]];
  go(parent || '/');
}

/* ---------- shared bits ---------- */
// dashboard=true adds the two test-home tells that belong on the front page only:
// the chosen home photo beside the wordmark, and the honest "HA off" chip.
function topbar(title, rightIcon = '⚙︎', rightAction = 'settings', dashboard = false) {
  const h = Store.home();
  const sub = h && h.address ? esc(h.address) : 'Keeping watch.';
  // default right slot = live conditions chip (hydrated); explicit icons still honored.
  // A test home has no weather nudges behind it — hydrateNudges never populates the
  // chip, so it would otherwise sit there empty; just don't render it.
  const right = rightIcon === '⚙︎'
    ? (Store.isTestHome() ? '' : `<span class="chip weather" data-weather data-action="settings"></span>`)
    : (rightIcon ? `<button class="icon-btn" data-action="${rightAction}">${rightIcon}</button>` : '');
  const homePic = (dashboard && h && h.photo)
    ? `<img class="home-pic" src="api/home-photo/${esc(h.id)}" alt="" onload="this.classList.add('on')" onerror="this.remove()">` : '';
  const testChip = (dashboard && Store.isTestHome()) ? `<span class="chip dim">test home · HA off</span>` : '';
  return `<div class="topbar">
    <div class="brand" data-action="settings">${kkLogo()}${homePic}<div class="wordmark">${esc(title)}<small>${sub}</small></div></div>
    <div class="topbar-right">${testChip}${right}</div></div>`;
}
const WX_ICON = { 'clear-night':'🌙', cloudy:'☁️', fog:'🌫', hail:'🌨', lightning:'⛈', 'lightning-rainy':'⛈',
  partlycloudy:'⛅', pouring:'🌧', rainy:'🌧', snowy:'❄️', 'snowy-rainy':'🌨', sunny:'☀️', windy:'🌬', 'windy-variant':'🌬', exceptional:'⚠️' };
function healthHeadline(h, notSetUp) {
  if (notSetUp) return 'Ready to start keeping.';
  return h.score >= 90 ? 'The house is well kept.'
       : h.score >= 75 ? 'The house is fair, and mending.'
       : h.score >= 50 ? 'The house needs a hand.'
       : 'The house is calling.';
}
// The mark as a live status glyph. Brand §06: watching / blink / glance — plus
// sleep (lids held closed, an extension of blink). Status COLOR stays in the
// interface (§04/§08): the eye glances AT a red/amber count badge, never recolors.
function kkLogo(cls = 'logo') {
  return `<span class="${cls} kk-logo" data-eye="watch">
    <svg class="eye eye-open"><use href="#kk-mark"/></svg>
    <svg class="eye eye-shut"><use href="#kk-blink"/></svg>
    <svg class="eye eye-glance"><use href="#kk-glance"/></svg>
    <svg class="eye eye-sleep"><use href="#kk-sleep"/></svg>
    <span class="eye-badge" hidden></span>
  </span>`;
}
function eyeState() {
  const tasks = Store.homeTasks();
  // Usage-due assets count toward the red badge, but an asset that is ALSO
  // overdue-by-task is one problem, not two — count each asset once.
  const overdueTasks = tasks.filter(t => Store.status(t) === 'overdue');
  const overdueAssets = new Set(overdueTasks.map(t => t.assetId));
  const overdue = overdueTasks.length + usageDueAssets().filter(a => !overdueAssets.has(a.id)).length;
  const soon = tasks.filter(t => Store.status(t) === 'soon').length;
  const hr = new Date().getHours();
  if (overdue) return { state: 'glance', badge: overdue, cls: 'red' };
  if (soon) return { state: 'glance', badge: soon, cls: 'amber' };
  if (!tasks.length || hr >= 22 || hr < 6) return { state: 'sleep' };   // the keeper rests
  return { state: 'watch' };
}
function updateEye() {
  const el = document.querySelector('.kk-logo'); if (!el) return;
  const s = eyeState();
  el.dataset.eye = s.state;
  const b = el.querySelector('.eye-badge');
  if (b) { if (s.badge) { b.hidden = false; b.textContent = s.badge > 9 ? '9+' : s.badge; b.className = 'eye-badge ' + (s.cls || ''); }
           else { b.hidden = true; } }
}

/* ---------- snap-to-add: camera → Claude vision reads the nameplate ---------- */
let SNAP = { status: 'idle', result: null, image: null, pending: false };
function downscale(file, maxDim = 1100) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxDim / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
async function tryBarcode(file) {  // Chromium extra credit — silent no-op elsewhere
  try { if (!('BarcodeDetector' in window)) return '';
    const codes = await new BarcodeDetector().detect(await createImageBitmap(file));
    return (codes[0] && codes[0].rawValue) || '';
  } catch (e) { return ''; }
}
function pickPhoto(onPicked) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment';
  inp.onchange = () => { if (inp.files[0]) onPicked(inp.files[0]); };
  inp.click();
}
function snapAsset() {
  pickPhoto(async file => {
    SNAP = { status: 'reading', result: null, image: null, pending: false };
    go('/snap');
    try {
      const [image, barcode] = [await downscale(file), await tryBarcode(file)];
      SNAP.image = image;
      const r = await fetch('api/identify', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image, barcode }) });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || 'could not read the photo');
      SNAP.status = 'done'; SNAP.result = j;
    } catch (e) { SNAP.status = 'error'; SNAP.error = e.message; }
    if (route()[0] === 'snap') render();
  });
}
function viewSnap() {
  if (SNAP.status === 'reading') return `<button class="back" data-action="back">‹ Cancel</button>
    <div class="hero"><div class="emoji">📷</div><div><h1>Reading the nameplate…</h1><div class="t-sub">Claude is identifying the make, model and serial.</div></div></div>
    ${SNAP.image ? `<img class="snap-img" src="${SNAP.image}">` : ''}
    <div class="banner ok">◍ Looking closely…</div>`;
  if (SNAP.status === 'error') return `<button class="back" data-action="back">‹ Back</button>
    <div class="hero"><div class="emoji">📷</div><h1>Couldn't read it</h1></div>
    <div class="banner">${esc(SNAP.error || 'Try again with the nameplate filling the frame, in good light.')}</div>
    <div class="btn-row"><button class="btn primary" data-action="snap">📷 Try again</button>
      <button class="btn" data-action="new-asset">✎ Enter by hand</button></div>`;
  const r = SNAP.result || {};
  if (SNAP.status !== 'done') { snapNothing(); return viewDashboard(); }
  return `<button class="back" data-action="back">‹ Back</button>
    <div class="hero"><div class="emoji">${(CATEGORIES[r.category] || {}).icon || '🔧'}</div>
      <div><h1>${esc(r.name || 'Found it')}</h1><div class="t-sub">${esc(r.category || '')}${r.confidence ? ' · ' + esc(r.confidence) + ' confidence' : ''}</div></div></div>
    ${SNAP.image ? `<img class="snap-img" src="${SNAP.image}">` : ''}
    <div class="meta-grid">
      <div class="meta"><div class="k">Make</div><div class="v">${esc(r.make || '—')}</div></div>
      <div class="meta"><div class="k">Model</div><div class="v">${esc(r.model || '—')}</div></div>
      <div class="meta"><div class="k">Serial</div><div class="v">${esc(r.serial || '—')}</div></div>
      <div class="meta"><div class="k">Notes</div><div class="v">${esc(r.notes || '—')}</div></div>
    </div>
    <div class="btn-row">
      <button class="btn primary" data-action="snap-accept">✓ Add it — with schedule</button>
      <button class="btn" data-action="snap">📷 Retake</button>
    </div>`;
}
function snapNothing() { SNAP = { status: 'idle', result: null, image: null, pending: false }; }

/* ---------- inspection report import: PDF -> Claude reads the defects ---------- */
let INSPECT = { status: 'idle', result: null, picked: null, filename: '', applying: false };
const SEV_COLOR = { urgent: 'red', attention: 'amber', monitor: 'green' };
function pickPDF(onPicked) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/pdf';
  inp.onchange = () => { if (inp.files[0]) onPicked(inp.files[0]); };
  inp.click();
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function importInspection() {
  pickPDF(async file => {
    if (file.size > 10 * 1024 * 1024) { toast('That PDF is over 10MB'); return; }
    INSPECT = { status: 'scanning', result: null, picked: null, filename: file.name, applying: false };
    go('/inspect');
    try {
      const pdf = await fileToBase64(file);
      const start = await (await fetch('api/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdf, name: file.name }) })).json();
      if (!start.job_id) throw new Error(start.error || 'could not start the import');
      for (let n = 0; n < 60; n++) {                        // up to 3 min
        await new Promise(r2 => setTimeout(r2, 3000));
        if (route()[0] === 'inspect' && INSPECT.status === 'scanning') render();
        let job; try { job = await (await fetch('api/inspect/' + start.job_id)).json(); } catch (e2) { continue; }
        if (job.status === 'done' || job.status === 'error') {
          if (job.result && job.result.error) throw new Error(job.result.error);
          const defects = (job.result && job.result.defects) || [];
          const picked = new Set();
          defects.forEach((d, i) => { if (d.severity === 'urgent' || d.severity === 'attention') picked.add(i); });
          INSPECT = { status: 'done', result: { defects }, picked, filename: file.name, applying: false };
          if (route()[0] === 'inspect') render();
          return;
        }
      }
      throw new Error('import timed out');
    } catch (e3) { INSPECT = { status: 'idle', applying: false }; toast('Inspection import failed — ' + e3.message); go('/assets'); }
  });
}
function viewInspect() {
  const g = INSPECT;
  if (g.status === 'scanning') return `<button class="back" data-action="back">‹ Cancel</button>
    <div class="hero"><div class="emoji">📄</div><div><h1>Reading the report…</h1><div class="t-sub">${esc(g.filename || 'Inspection report')}</div></div></div>
    <div class="banner ok">◍ Claude is extracting the defects.</div>`;
  if (g.status !== 'done' || !g.result) return viewAssets();
  const defects = g.result.defects || [];
  const rows = defects.map((d, i) => `<div class="feat ${g.picked.has(i) ? 'on' : ''}" data-action="inspect-pick" data-i="${i}">
    <span class="feat-check">${g.picked.has(i) ? '✓' : '＋'}</span>
    <span class="dot ${SEV_COLOR[d.severity] || 'green'}" style="margin-right:8px"></span>
    <div class="grow"><div class="t-name">${esc(d.title)}</div>
    <div class="t-sub">${esc(d.area || 'General')}${d.recommendation ? ' · ' + esc(d.recommendation) : ''}</div></div></div>`).join('');
  return `<button class="back" data-action="back">‹ Back</button>
    <div class="hero"><div class="emoji">📄</div><div><h1>Found in the report</h1><div class="t-sub">${defects.length} defect${defects.length !== 1 ? 's' : ''} · ${esc(g.filename || '')}</div></div></div>
    ${rows || '<div class="empty">No defects found in that report.</div>'}
    <div class="btn-row"><button class="btn primary wide" data-action="inspect-apply" ${(g.applying || !g.picked.size) ? 'disabled' : ''}>${g.applying ? 'Adding…' : `Add ${g.picked.size} to schedule →`}</button></div>`;
}

/* ---------- Gmail supplier import (both modes share this flow) ---------- */
let GMSCAN = { status: 'idle', result: null, picked: null };
async function hydrateGmail() {
  const el = document.querySelector('[data-gmail-status]'); if (!el) return;
  try {
    const st = await (await fetch('api/gmail/status')).json();
    if (!st.configured) { el.textContent = 'Not connected yet — follow the setup steps below.'; return; }
    el.className = 'banner ' + (st.ok ? 'ok' : '');
    el.textContent = st.ok ? `✓ Connected as ${st.address} — read-only.` : `✗ ${st.address}: ${st.error || 'login failed'} — check the app password in the add-on Configuration.`;
  } catch (e) { el.textContent = 'Could not check Gmail status.'; }
}
function viewGmailImport() {
  const g = GMSCAN;
  if (g.status === 'scanning') return `<button class="back" data-action="back">‹ Cancel</button>
    <div class="hero"><div class="emoji">📬</div><div><h1>Reading your tradie mail…</h1><div class="t-sub">Quotes, invoices and bookings from the last 3 years.</div></div></div>
    <div class="banner ok">◍ ${esc(g.msg || 'Scanning…')}</div>`;
  if (g.status !== 'done' || !g.result) return viewDashboard();
  const r = g.result;
  const provNames = new Set(Store.homeProviders().map(p => p.name.toLowerCase()));
  const assetNames = new Set(Store.homeAssets().map(a => a.name.toLowerCase()));
  if (!g.picked) { g.picked = { s: new Set(), a: new Set() };
    (r.suppliers || []).forEach((s, i) => { if (!provNames.has((s.name || '').toLowerCase())) g.picked.s.add(i); });
    (r.inferredAssets || []).forEach((x, i) => { if (!assetNames.has((x.name || '').toLowerCase())) g.picked.a.add(i); }); }
  const sRows = (r.suppliers || []).map((s, i) => { const dup = provNames.has((s.name || '').toLowerCase());
    return `<div class="feat ${g.picked.s.has(i) ? 'on' : ''}" data-action="gmail-pick" data-kind="s" data-i="${i}">
      <span class="feat-check">${g.picked.s.has(i) ? '✓' : '＋'}</span>
      <div class="grow"><div class="t-name">${esc(s.name)}</div>
      <div class="t-sub">${esc(s.category || '')}${s.jobs && s.jobs.length ? ` · ${s.jobs.length} job${s.jobs.length > 1 ? 's' : ''}` : ''}${s.lastJob ? ' · last ' + esc(s.lastJob) : ''}${dup ? ' · already saved' : ''}</div></div></div>`; }).join('');
  const aRows = (r.inferredAssets || []).map((x, i) => { const dup = assetNames.has((x.name || '').toLowerCase());
    return `<div class="feat ${g.picked.a.has(i) ? 'on' : ''}" data-action="gmail-pick" data-kind="a" data-i="${i}">
      <span class="feat-check">${g.picked.a.has(i) ? '✓' : '＋'}</span>
      <div class="grow"><div class="t-name">${esc(x.name)}</div>
      <div class="t-sub">${esc(x.reason || '')}${dup ? ' · already tracked' : ''}</div></div></div>`; }).join('');
  return `<button class="back" data-action="back">‹ Back</button>
    <div class="hero"><div class="emoji">📬</div><div><h1>Found in your mail</h1><div class="t-sub">${r.scanned || 0} emails read · tap to include or exclude</div></div></div>
    <div class="section-title">Suppliers <span class="pill">${(r.suppliers || []).length}</span></div>
    ${sRows || '<div class="empty">No suppliers found.</div>'}
    <div class="section-title">The mail proves you have <span class="pill">${(r.inferredAssets || []).length}</span></div>
    ${aRows || '<div class="empty">Nothing new inferred.</div>'}
    <div class="btn-row"><button class="btn primary wide" data-action="gmail-import">Import ${g.picked.s.size + g.picked.a.size} selected →</button></div>`;
}

/* ---------- Home Assistant device import + auto-link (mirrors Gmail import) ---------- */
let HAIMPORT = { status: 'idle', result: null, groups: null, picked: null, vanished: null };

// Which existing asset (if any) a registry device is "the same thing" as.
// Priority: already linked (deviceId, or a linked usage.entity) > name/make
// token overlap >= 0.5 > the lone unlinked asset in the device's category.
function matchDevice(dev, assets) {
  let m = assets.find(a => a.ha && a.ha.deviceId === dev.deviceId);
  if (m) return m;
  const entIds = new Set((dev.entities || []).map(e => e.id));
  m = assets.find(a => a.usage && a.usage.entity && entIds.has(a.usage.entity));
  if (m) return m;
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const devMM = new Set(norm((dev.manufacturer || '') + ' ' + (dev.model || '')));
  const devName = new Set(norm(dev.name || ''));
  const overlap = (setA, tokensB) => { if (!setA.size || !tokensB.length) return 0;
    return tokensB.filter(t => setA.has(t)).length / Math.max(setA.size, tokensB.length); };
  // Weak-match guard (category-singleton or name/make overlap only — never the
  // exact deviceId/usage.entity links above, which are already trustworthy).
  // The August-lock incident: an "August Home Inc." smart lock singleton- and
  // name-matched a "Front door" asset made by "Sydney Woodworkers" (both read
  // as "the one door/lock thing") and proposed clobbering the correct maker
  // with the lock's — a correct-data-destroying edit the human had to catch.
  // Rule 1 (locks, unconditional): a kind:'lock' device may only weak-match
  // an asset whose own name reads as lock-ish — regardless of manufacturer.
  // Rule 2 (generalized, minimal): for anything else, a weak match whose
  // manufacturer disagrees with the asset's AND whose category has nothing
  // to do with the asset's own category is too flimsy to justify a field
  // correction — reject it so it lands as New instead of a bad Update.
  const weakMatchOk = a => {
    if (dev.kind === 'lock') return /lock|deadbolt|latch/i.test(a.name || '');
    const devMk = norm(dev.manufacturer || '').join(' '), assetMk = norm(a.make || '').join(' ');
    const manufacturerDiffers = devMk && assetMk && devMk !== assetMk;
    const profileDisjoint = dev.category !== a.category;
    return !(manufacturerDiffers && profileDisjoint);
  };
  let best = null, bestScore = 0;
  assets.forEach(a => {
    const aMM = norm((a.make || '') + ' ' + (a.model || '')), aName = norm(a.name || '');
    const score = Math.max(overlap(devMM, aMM), overlap(devName, aName), overlap(devMM, aName), overlap(devName, aMM));
    if (score > bestScore) { bestScore = score; best = a; }
  });
  if (best && bestScore >= 0.5 && weakMatchOk(best)) return best;
  const singleton = assets.filter(a => a.category === dev.category && !a.ha);
  return singleton.length === 1 && weakMatchOk(singleton[0]) ? singleton[0] : null;
}
// New / Update / Linked-and-current, exactly the Gmail-import three groups.
// Each device claims at most one asset so two devices never double-match a
// category singleton in the same scan.
function bucketHaDevices(devices) {
  const assets = Store.homeAssets(), used = new Set();
  const groups = { new: [], update: [], linked: [] };
  (devices || []).forEach(dev => {
    const m = matchDevice(dev, assets.filter(a => !used.has(a.id)));
    if (!m) {
      groups.new.push({ dev, proposal: { name: dev.name || dev.category, category: dev.category,
        make: dev.manufacturer || '', model: dev.model || '', serial: dev.serial || '', location: dev.area || '' } });
      return;
    }
    used.add(m.id);
    const fields = [];
    const check = (field, reg, cur) => { const r = String(reg || '').trim(), c = String(cur || '').trim();
      if (r && r !== c) fields.push({ field, current: c, proposed: r }); };
    check('make', dev.manufacturer, m.make); check('model', dev.model, m.model); check('serial', dev.serial, m.serial);
    (fields.length ? groups.update : groups.linked).push({ dev, asset: m, fields });
  });
  return groups;
}
function viewHaImport() {
  const g = HAIMPORT;
  if (g.status === 'loading') return `<button class="back" data-action="back">‹ Cancel</button>
    <div class="hero"><div class="emoji">🏠</div><div><h1>Reading your Home Assistant devices…</h1><div class="t-sub">Matching against what you already track.</div></div></div>
    <div class="banner ok">◍ Scanning the device registry…</div>`;
  if (g.status !== 'done' || !g.result) return viewDashboard();
  if (!g.result.available) return `<button class="back" data-action="back">‹ Back</button>
    <div class="hero"><div class="emoji">🏠</div><div><h1>Home Assistant not available</h1><div class="t-sub">This add-on isn't running with Home Assistant access right now.</div></div></div>`;
  const groups = g.groups || (g.groups = bucketHaDevices(g.result.devices));
  if (!g.picked) g.picked = { n: new Set(groups.new.map((_, i) => i)), u: new Set(groups.update.map((_, i) => i)) };
  const usageLine = dev => dev.suggestedUsage
    ? `<div class="t-sub">will meter: ${dev.suggestedUsage.mode === 'energy' ? 'energy' : 'runtime'} · ${esc(dev.suggestedUsage.unit)}</div>` : '';
  const nRows = groups.new.map((x, i) => `<div class="feat ${g.picked.n.has(i) ? 'on' : ''}" data-action="ha-import-pick" data-kind="n" data-i="${i}">
      <span class="feat-check">${g.picked.n.has(i) ? '✓' : '＋'}</span>
      <div class="grow"><div class="t-name">${esc(x.proposal.name)}</div>
      <div class="t-sub">${esc(x.proposal.category)}${x.proposal.make ? ' · ' + esc(x.proposal.make) : ''}${x.proposal.model ? ' ' + esc(x.proposal.model) : ''}${x.proposal.location ? ' · ' + esc(x.proposal.location) : ''}</div>
      ${usageLine(x.dev)}</div></div>`).join('');
  const uRows = groups.update.map((x, i) => `<div class="feat ${g.picked.u.has(i) ? 'on' : ''}" data-action="ha-import-pick" data-kind="u" data-i="${i}">
      <span class="feat-check">${g.picked.u.has(i) ? '✓' : '＋'}</span>
      <div class="grow"><div class="t-name">${esc(x.asset.name)}</div>
      <div class="t-sub">${x.fields.map(f => `${esc(f.field)}: ${esc(f.current || '—')} → <b style="color:var(--accent)">${esc(f.proposed)}</b>`).join(' · ')}</div>
      ${usageLine(x.dev)}</div></div>`).join('');
  const lRows = groups.linked.map(x => `<div class="feat on" style="opacity:.7">
      <span class="feat-check">✓</span>
      <div class="grow"><div class="t-name">${esc(x.asset.name)}</div>
      <div class="t-sub">linked & up to date · ${esc(x.dev.manufacturer || '')} ${esc(x.dev.model || '')}</div></div></div>`).join('');
  const elseCount = (g.result.everythingElse || []).length;
  // Assets whose linked device disappeared from the registry (Feature 4) — flag
  // only, never delete. The only action offered is unlinking (asset stays put).
  const vanished = g.vanished || [];
  const vRows = vanished.map(v => `<div class="feat" style="opacity:.55">
      <div class="grow"><div class="t-name">${esc(v.name || 'Unknown device')}</div>
      <div class="t-sub">no longer seen in Home Assistant</div></div>
      <button class="btn small" data-action="ha-unlink" data-id="${esc(v.assetId)}">Unlink</button></div>`).join('');
  return `<button class="back" data-action="back">‹ Back</button>
    <div class="hero"><div class="emoji">🏠</div><div><h1>Found on Home Assistant</h1><div class="t-sub">${(g.result.devices || []).length} relevant device${(g.result.devices || []).length !== 1 ? 's' : ''} · tap to include or exclude</div></div></div>
    <div class="section-title">New <span class="pill">${groups.new.length}</span></div>
    ${nRows || '<div class="empty">Nothing new.</div>'}
    <div class="section-title">Update <span class="pill">${groups.update.length}</span></div>
    ${uRows || '<div class="empty">Nothing to correct.</div>'}
    ${groups.linked.length ? `<div class="section-title">Linked &amp; current <span class="pill">${groups.linked.length}</span></div>${lRows}` : ''}
    ${vanished.length ? `<div class="section-title">No longer seen <span class="pill">${vanished.length}</span></div>${vRows}` : ''}
    ${elseCount ? `<div class="section-title">Everything else <span class="pill">${elseCount}</span></div><div class="empty">${elseCount} other device${elseCount !== 1 ? 's' : ''} — lights, switches, bridges — not maintenance-relevant.</div>` : ''}
    <div class="btn-row"><button class="btn primary wide" data-action="ha-import-apply" ${g.applying ? 'disabled' : ''}>${g.applying ? 'Applying…' : `Apply ${g.picked.n.size + g.picked.u.size} selected →`}</button></div>`;
}

/* ---------- describe-a-problem: text (+photo) → triage → pro ---------- */
let TRIAGE = { status: 'idle', result: null, image: null, text: '' };
function viewTriage() {
  const t = TRIAGE;
  if (t.status === 'thinking') return `<button class="back" data-action="back">‹ Cancel</button>
    <div class="hero"><div class="emoji">🛟</div><div><h1>Looking at it…</h1><div class="t-sub">Working out what it is and who you need.</div></div></div>
    <div class="banner ok">◍ Triaging…</div>`;
  if (t.status === 'done' && t.result) {
    const r = t.result;
    const urg = r.urgency === 'emergency' ? ['red', 'EMERGENCY'] : r.urgency === 'soon' ? ['amber', 'SOON'] : ['green', 'ROUTINE'];
    const matched = Store.homeAssets().find(a => a.category === r.category);
    const team = Store.activeProviders().find(p => p.trade === r.category);
    return `<button class="back" data-action="back">‹ Back</button>
      <div class="hero"><div class="emoji">${(CATEGORIES[r.category] || {}).icon || '🛟'}</div>
        <div><h1>${esc(r.summary || 'The problem')}</h1><div class="chip-row"><span class="due ${urg[0]}">${urg[1]}</span></div></div></div>
      <div class="banner ${r.urgency === 'emergency' ? '' : 'ok'}">${esc(r.advice || '')}</div>
      <div class="section-title">Tell the tradie</div>
      <div class="card"><div class="t-sub" style="white-space:normal;color:var(--text)">${esc(r.forTradie || '')}</div></div>
      <div class="btn-row">
        ${team ? `<button class="btn primary" data-action="triage-email" data-id="${team.id}">✉︎ Email ${esc(team.name)}</button>` : ''}
        <button class="btn ${team ? '' : 'primary'}" data-action="triage-find">🔎 Find: ${esc((r.trade || 'a pro').slice(0, 28))}</button>
        ${matched ? `<button class="btn" data-action="open-asset" data-id="${matched.id}">Open ${esc(matched.name)}</button>` : ''}
      </div>`;
  }
  return `<button class="back" data-action="back">‹ Cancel</button>
    <div class="hero"><div class="emoji">🛟</div><div><h1>Something's wrong?</h1><div class="t-sub">Describe it — I'll work out who you need.</div></div></div>
    <div class="card">
      <label>What's happening?</label>
      <textarea id="tr_desc" placeholder="e.g. water dripping from the hot water system's valve, hissing sound">${esc(t.text || '')}</textarea>
      ${t.image ? `<img class="snap-img" src="${t.image}">` : ''}
      <div class="btn-row">
        <button class="btn primary" data-action="triage-go">Triage it</button>
        <button class="btn" data-action="triage-photo">📷 ${t.image ? 'Retake photo' : 'Add a photo'}</button>
      </div>
    </div>`;
}
// Blink = task completed / all clear. Lids meet 120ms in, 90ms out. One blink, never loops.
function blinkMark() {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const el = document.querySelector('.kk-logo'); if (!el) return;
  el.classList.add('blinking');
  setTimeout(() => el.classList.remove('blinking'), 240);
}
function nav(active) {
  // Structural icons come from the mark's own stroke language (index.html symbols).
  const items = [['','#/','i-home','Home'],['schedule','#/schedule','i-schedule','Schedule'],['assets','#/assets','i-assets','Assets'],['providers','#/providers','i-trades','Trades'],['chat','#/chat','i-ask','Ask'],['settings','#/settings','i-settings','Settings']];
  return `<div class="nav">${items.map(([k,href,ic,l]) =>
    `<a href="${href}" class="${active===k?'active':''}"><svg class="ic" aria-hidden="true"><use href="#${ic}"/></svg>${l}</a>`).join('')}</div>`;
}
// Fire the maker research for an asset; the asset page's Model-intelligence card
// tracks LOOKUP and renders the result with the one-tap Apply. Shared by the
// manual "Look up features" tap and the Snap 2.0 auto-chain after snap-accept.
function startLookup(id) {
  const a = Store.asset(id); if (!a) return;
  LOOKUP = { assetId: id, status: 'running', result: null, stage: null };
  DBG.log('lookup', { asset: a.name, make: a.make || '', model: a.model || '', category: a.category || '' });
  Research.lookupFeatures(a, m => {                         // live server stages — "Searched “…”…"
    if (LOOKUP.assetId !== id || LOOKUP.status !== 'running') return;
    LOOKUP.stage = m;
    const el = document.getElementById('lookup-stage');
    if (el) el.textContent = m; else if (route()[0] === 'asset') render();
  }).then(r => {
    if (LOOKUP.assetId !== id) return;                      // superseded by another lookup meanwhile
    LOOKUP = { assetId: id, status: r && !r.error ? 'done' : 'error', result: r, applied: false };
    DBG.log('lookup-result', { asset: a.name, error: (r && r.error) || null, tasks: (r && r.tasks || []).length, ...((r && r.debug) || {}) });
    // The manual link is a fact about the asset, not this session — keep it.
    if (r && r.manualUrl) { const aa = Store.asset(id); if (aa && !aa.manualUrl) { aa.manualUrl = r.manualUrl; Store.upsertAsset(aa); } }
    if (route()[0] === 'asset') render();
  });
}
// Recall & safety check (#4, slice 1) — same fire-and-track shape as startLookup,
// its own module-level state so the two async checks never clobber each other.
function startRecall(id) {
  const a = Store.asset(id); if (!a) return;
  RECALL = { assetId: id, status: 'running', result: null };
  DBG.log('recall-check', { asset: a.name, make: a.make || '', model: a.model || '' });
  Research.checkRecall(a).then(r => {
    if (RECALL.assetId !== id) return;                      // superseded by another check meanwhile
    RECALL = { assetId: id, status: r && !r.error ? 'done' : 'error', result: r };
    // Persist onto the asset too (same shape the scheduled sweep writes) — so every
    // device sees it, not just this session's transient banner.
    if (r && !r.error && ['clear', 'recall', 'unknown'].includes(r.status)) {
      const aa = Store.asset(id);
      if (aa) {
        const cur = aa.recall || {};
        const changed = cur.status !== r.status || cur.summary !== r.summary || cur.url !== r.url || cur.remedy !== r.remedy;
        aa.recall = { status: r.status, summary: r.summary || '', url: r.url || null, remedy: r.remedy || null,
                      at: todayISO(), ack: changed ? false : (cur.ack || false),
                      // the SAME notice re-found: keep whatever task it's already linked to.
                      ...(!changed && cur.taskId ? { taskId: cur.taskId } : {}) };
        Store.upsertAsset(aa);
      }
    }
    if (route()[0] === 'asset') render();
  });
}
// Re-research sweep — reprocess EXISTING assets with the current research smarts
// (old assets carry old guesses: wrong trade, no maker schedule). SERVER-RESIDENT:
// the sweep runs on the Green (POST /api/sweep), one asset at a time, so it keeps
// going after the page (or tab, or tablet) closes. Each result lands on the asset
// as a lookupPending proposal (written by the server via state_mutate, so every
// device sees it), reviewed and applied per-asset on its page. Nothing changes
// without an Apply. This module just polls the job and renders its progress —
// same SWEEP shape the Settings card always rendered, so the card stays small.
let SWEEP = { running: false, done: 0, total: 0, current: '', log: [], jobId: null };
let SWEEP_CHECKED = false;   // have we asked /api/sweep/active yet this page load?
async function sweepResearch() {
  if (SWEEP.running) return;
  try {
    const r = await fetch('api/sweep', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ homeId: Store.state.currentHomeId }) });
    const j = await r.json();
    if (!r.ok || !j.job_id) { toast(j.error || 'could not start the sweep'); return; }
    attachSweep(j.job_id);
  } catch (e) { toast('could not start the sweep'); }
}
function attachSweep(jobId) {
  SWEEP = { running: true, done: 0, total: 0, current: '', log: [], jobId };
  SWEEP_CHECKED = true;
  render();
  pollSweep(jobId);
}
async function pollSweep(jobId) {
  const sleep = ms => new Promise(res => setTimeout(res, ms));
  for (;;) {
    if (SWEEP.jobId !== jobId) return;                      // superseded (stopped/attached elsewhere)
    let job;
    try { const p = await fetch('api/sweep/' + jobId); job = p.ok ? await p.json() : null; }
    catch (e) { job = null; }
    if (job && job.status !== 'unknown') {
      SWEEP.done = job.done || 0; SWEEP.total = job.total || 0; SWEEP.current = job.current || '';
      SWEEP.log = job.log || [];
      const lineEl = document.getElementById('sweep-line');
      if (lineEl) lineEl.textContent = `${SWEEP.done} of ${SWEEP.total} · researching ${SWEEP.current}…`;
      const logEl = document.getElementById('sweep-log');
      if (logEl) logEl.innerHTML = SWEEP.log.map(x => `<div>${esc(x)}</div>`).join('');
      // Each finished asset already landed on the shared store server-side —
      // pull it down live so ✦ badges (here and on Assets) show without a reload.
      await Store.syncRemote();
      if (job.status === 'done' || job.status === 'error') {
        SWEEP.running = false; SWEEP.jobId = null;
        const n = SWEEP.done;
        toast(job.status === 'error' && job.error ? job.error
          : `Re-research finished — ${n} asset${n !== 1 ? 's' : ''} processed. Look for ✦ research ready.`);
        if (route()[0] === 'settings' || route()[0] === 'assets') render();
        return;
      }
    }
    await sleep(2000);
  }
}
// Settings card mounts and finds a sweep already running on the Green (another
// device started it, or this device reloaded mid-sweep) — reattach so it doesn't
// look stalled. Checked once per page load, not on every render.
async function hydrateSweep() {
  if (SWEEP.running || SWEEP_CHECKED) return;
  if (!document.getElementById('sweep-card')) return;
  SWEEP_CHECKED = true;
  try {
    const j = await (await fetch('api/sweep/active')).json();
    if (j && j.job_id) attachSweep(j.job_id);
  } catch (e) { /* stay idle — the button still works */ }
}
// Theme is DEVICE-local — the wall tablet stays Night while a desktop runs Paper —
// so it lives in localStorage, deliberately outside the synced store.
const THEME_KEY = 'kk.theme';
function applyTheme() {
  const t = localStorage.getItem(THEME_KEY) || 'auto';
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--accent-d').trim() || '#0f6e56';
}
// A task's provider: its own override first, else the asset's. Two cleaners can
// finally share one asset — House clean (Ana) and Quick clean (Bobby and Jo).
const taskProv = (t, a) => Store.provider(t.providerId || (a && a.providerId));
// Effective DIY: the task's own flag, or the whole ASSET marked DIY — asset-level
// DIY covers every task that hasn't got its own provider override.
const isDiy = (t, a) => !!(t.diy || (a && a.diy && !t.providerId));
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
// Date-rail label: "AUG 1" this year, "AUG '25" for older history.
const railDate = iso => { const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return '—';
  return d.getFullYear() === new Date().getFullYear() ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : `${MONTHS[d.getMonth()]} '${String(d.getFullYear()).slice(2)}`; };
function taskCard(t, { showAsset = true } = {}) {
  const a = Store.asset(t.assetId); if (!a) return '';
  const st = Store.status(t), prov = taskProv(t, a);
  const sub = (showAsset ? `${esc(a.name)} · ${esc(a.location||'')}` : esc(a.location||'')) + (isDiy(t, a) && !t.snoozed ? ' · 🛠 DIY' : '');
  if (t.snoozed) {  // disabled/ignored — sleeping eye, restore or delete
    return `<div class="card snoozed" data-action="open-asset" data-id="${a.id}">
      <div class="row">
        ${assetTile(a, 'emoji')}
        <div class="grow"><div class="t-name">${esc(t.title)}</div><div class="t-sub">${sub} · snoozed</div></div>
        <svg class="kk-zzz" viewBox="0 0 48 48" aria-label="snoozed"><use href="#kk-sleep"/></svg>
      </div>
      <div class="btn-row">
        <button class="btn small primary" data-action="unsnooze-task" data-id="${t.id}">↩︎ Restore</button>
        <button class="btn small" data-action="del-task-inline" data-id="${t.id}" style="color:var(--red)">Delete</button>
      </div></div>`;
  }
  // Three ways a job gets done: a linked provider, DIY (you), or still unassigned.
  // A provider with an email gets "Book service" (drafts the quoting email); an open
  // quote means booking is already in flight, so fall back to the call button.
  const findBtn = prov
    ? (prov.email && !Store.quoteForAsset(a.id)
        ? `<button class="btn small" data-action="book-service" data-id="${t.id}">✉︎ Book service</button>`
        : `<button class="btn small" data-action="call" data-id="${a.id}">📞 ${esc(prov.name)}</button>`)
    : isDiy(t, a)
      ? `<button class="btn small" data-action="${t.diy ? 'toggle-diy' : 'toggle-asset-diy'}" data-id="${t.diy ? t.id : a.id}" title="You do this yourself · tap to change">🛠 DIY ✓</button>`
      : `<button class="btn small" data-action="find" data-id="${a.id}">🔎 Find a service</button><button class="btn small" data-action="toggle-diy" data-id="${t.id}" title="No tradie needed · I do this myself">🛠 DIY</button>`;
  return `<div class="card" data-action="open-asset" data-id="${a.id}">
    <div class="row">
      ${assetTile(a, 'emoji')}
      <div class="grow"><div class="t-name">${esc(t.title)}${t.autoBook ? ' <span class="chip auto">🤖 auto</span>' : ''}${t.autopilot ? ' <span class="chip pilot">⟳ autopilot</span>' : ''}</div><div class="t-sub">${sub}</div>${t.note ? `<div class="t-sub note">📌 ${esc(t.note)}</div>` : ''}</div>
      <div class="due ${COLOR[st]}">${esc(Store.dueLabel(t))}<small>${t.estCost?money(t.estCost):''}</small></div>
    </div>
    ${usageBar(a, true)}
    <div class="btn-row">
      <button class="btn small primary" data-action="done" data-id="${t.id}">✓ Done</button>
      ${findBtn}
      <button class="btn small" data-action="snooze-task" data-id="${t.id}">💤 Snooze</button>
      <button class="btn small" data-action="edit-task" data-id="${t.id}" data-asset="${a.id}" title="Edit this job">✎</button>
      <button class="btn small" data-action="del-task-inline" data-id="${t.id}" title="Delete this job" style="color:var(--red)">🗑</button>
    </div></div>`;
}
// Feature lookup — the manufacturer's schedule and manual for this exact model.
// Research runs server-side (Claude + web_search); nothing changes without Apply.
function lookupSection(a) {
  // A re-research sweep may have left a proposal on the asset itself — surface it
  // for review exactly like a fresh lookup (never while another lookup is running).
  if (LOOKUP.assetId !== a.id && LOOKUP.status !== 'running' && a.lookupPending)
    LOOKUP = { assetId: a.id, status: 'done', result: a.lookupPending, applied: false };
  const mine = LOOKUP.assetId === a.id;
  if (!mine || LOOKUP.status === 'idle')
    return `<div class="btn-row"><button class="btn small" data-action="lookup" data-id="${a.id}">${(a.make || a.model) ? '🔎 Look up features' : '🔎 Research what this needs'}</button></div>`;
  if (LOOKUP.status === 'running')
    return `<div class="banner ok">Researching ${esc([a.make, a.model].filter(Boolean).join(' ') || a.name)} — ${(a.make || a.model) ? 'manufacturer schedule, specs and the manual' : 'what it needs and how often'}… (~1 min)
      <div class="kk-note" id="lookup-stage" style="margin-top:4px">${esc(LOOKUP.stage || 'Starting the research…')}</div></div>`;
  const r = LOOKUP.result || {};
  if (LOOKUP.status === 'error' || r.error)
    return `<div class="banner">${esc(r.error || 'Lookup failed — try again.')} <b data-action="lookup" data-id="${a.id}" style="color:var(--accent);cursor:pointer">Retry →</b></div>`;
  const specs = Object.entries(r.specs || {}).slice(0, 6);
  return `<div class="section-title">Model intelligence</div>
    <div class="card">
      ${r.summary ? `<div class="t-sub" style="white-space:normal;color:var(--text)">${esc(r.summary)}</div>` : ''}
      ${specs.length ? `<div class="chip-row" style="margin-top:8px">${specs.map(([k, v]) => `<span class="chip">${esc(k)} · ${esc(v)}</span>`).join('')}</div>` : ''}
      ${(r.tasks || []).length ? `<div class="t-sub" style="margin-top:10px">Manufacturer schedule:</div>
        ${r.tasks.map(t => `<div class="t-sub" style="white-space:normal">· ${esc(t.title)} — every ${t.cadenceDays}d${t.note ? ` (${esc(t.note)})` : ''}</div>`).join('')}` : ''}
      ${(r.tips || []).length ? r.tips.map(t => `<div class="t-sub dim" style="white-space:normal;margin-top:6px">💡 ${esc(t)}</div>`).join('') : ''}
      <div class="btn-row">
        ${(r.tasks || []).length && !LOOKUP.applied ? `<button class="btn small primary" data-action="lookup-apply">✓ Apply schedule</button>` : ''}
        ${LOOKUP.applied ? `<span class="chip live">✓ schedule tuned</span>` : ''}
        ${r.manualUrl ? `<a class="btn small" data-ext href="${esc(webUrl(r.manualUrl))}" target="_blank" rel="noopener">📖 Manual</a>` : ''}
        <button class="btn small" data-action="lookup" data-id="${a.id}">↻ Again</button>
      </div></div>`;
}
// Recall & safety check — manual per-asset action (ACCC Product Safety + the
// manufacturer, via Claude + web_search) AND a scheduled monthly sweep on the
// backend (server.py recall_sweep). Both land on the asset as a.recall, so
// the stored banner below is shared by whichever check found it.
function recallSection(a) {
  const mine = RECALL.assetId === a.id;
  if (mine && RECALL.status !== 'idle') {
    const label = esc([a.make, a.model].filter(Boolean).join(' ') || a.name);
    if (RECALL.status === 'running')
      return `<div class="banner ok">Checking ACCC Product Safety and the manufacturer for ${label}… (~1 min)</div>`;
    const r = RECALL.result || {};
    if (RECALL.status === 'error' || r.error)
      return `<div class="banner">${esc(r.error || 'Recall check failed — try again.')} <b data-action="check-recall" data-id="${a.id}" style="color:var(--accent);cursor:pointer">Retry →</b></div>`;
    // A 'done' check has already persisted onto a.recall (see startRecall) — fall
    // through to the stored banner below so there's exactly one render path for it.
  }
  return recallBanner(a);
}
// The stored, shared banner for a.recall — set by either a manual check
// (startRecall) or the backend's monthly sweep. Red for a live, un-acknowledged
// recall (source + remedy + the same "Add as urgent task" path, plus "OK, seen"
// to acknowledge); a dim green line for a clear result with its checked date.
function recallBanner(a) {
  const rec = a.recall;
  if (!rec || !rec.status) return '';
  const label = esc([a.make, a.model].filter(Boolean).join(' ') || a.name);
  if (rec.status === 'recall') {
    if (rec.ack)
      return `<div class="t-sub" style="color:var(--red);opacity:.7;margin-top:4px">⚠ Recall (seen) — ${esc(rec.summary || '')}${rec.url ? ` · <a data-ext href="${esc(webUrl(rec.url))}" target="_blank" rel="noopener" style="color:inherit">source</a>` : ''}</div>`;
    // "Already added" is read from a.recall.taskId (persisted, shared across devices/
    // sessions) and re-checked against live tasks — not a session-local flag — so a
    // reload or a check that landed via the scheduled sweep can't lose the guard and
    // double the task, and a task another device since deleted correctly re-offers it.
    const added = rec.taskId && Store.state.tasks.some(t => t.id === rec.taskId);
    return `<div class="banner urgent">
      <b style="color:var(--red)">⚠ Recall found</b> — ${esc(rec.summary || '')}
      ${rec.remedy ? `<div class="t-sub" style="white-space:normal;color:var(--text);margin-top:6px">${esc(rec.remedy)}</div>` : ''}
      <div class="btn-row">
        ${rec.url ? `<a class="btn small" data-ext href="${esc(webUrl(rec.url))}" target="_blank" rel="noopener">🔗 Source</a>` : ''}
        ${added ? `<span class="chip live">✓ added</span>` : `<button class="btn small primary" data-action="recall-task" data-id="${a.id}">＋ Add as urgent task</button>`}
        <button class="btn small" data-action="recall-ack" data-id="${a.id}">OK, seen</button>
      </div></div>`;
  }
  if (rec.status === 'clear')
    return `<div class="t-sub" style="color:var(--green);opacity:.7;margin-top:4px">✓ No recalls found for ${label} · checked ${esc(rec.at || '')}</div>`;
  return '';   // 'unknown' — nothing durable worth showing once the live banner's gone
}

// An asset that hit its usage threshold but has no overdue/soon task to carry it.
function usageDueCard(a) {
  const prov = Store.provider(a.providerId);
  return `<div class="card" data-action="open-asset" data-id="${a.id}">
    <div class="row">
      ${assetTile(a, 'emoji')}
      <div class="grow"><div class="t-name">${esc(a.name)}</div><div class="t-sub">${esc(a.location || a.category)}</div></div>
      <div class="due red">by usage</div>
    </div>
    ${usageBar(a, true)}
    <div class="btn-row">
      <button class="btn small primary" data-action="reset-usage" data-id="${a.id}">↺ Serviced</button>
      ${prov ? `<button class="btn small" data-action="call" data-id="${a.id}">📞 ${esc(prov.name)}</button>`
             : `<button class="btn small" data-action="find" data-id="${a.id}">🔎 Find a service</button>`}
    </div></div>`;
}

/* ---------- views ---------- */
function viewDashboard() {
  const tasks = Store.homeTasks().slice().sort((a,b) => (Store.daysUntil(a)??1e9) - (Store.daysUntil(b)??1e9));
  const overdue = tasks.filter(t => Store.status(t)==='overdue');
  const soon    = tasks.filter(t => Store.status(t)==='soon');
  const upcoming= tasks.filter(t => Store.status(t)==='ok' && Store.daysUntil(t)!==null).slice(0,4);
  // Usage-due assets (last known HA telemetry) lead the attention list: their own
  // tasks float to the front, and one with no due task gets a card of its own.
  const uDue = usageDueAssets();
  const uDueIds = new Set(uDue.map(a => a.id));
  const attention = overdue.concat(soon)
    .sort((x, y) => (uDueIds.has(y.assetId) ? 1 : 0) - (uDueIds.has(x.assetId) ? 1 : 0));
  const uCards = uDue.filter(a => !attention.some(t => t.assetId === a.id));
  const attnCount = attention.length + uCards.length;
  USAGE.rendered = uDue.map(a => a.id).sort().join();
  const openQuotes = Store.homeQuotes().filter(q => q.status !== 'booked');  // in-flight asks belong on the front page
  const h = Store.homeHealth();
  const next = Store.nextTask();
  const unsched = Store.unscheduled();
  const notSetUp = tasks.length > 0 && !next && unsched.length > 0;  // tasks exist but none scheduled
  const okCount = tasks.filter(t => Store.status(t) === 'ok' && Store.daysUntil(t) !== null).length;
  const R = 34, C = 2 * Math.PI * R, off = C * (1 - h.score / 100);
  // Instrument hero: tick-ring gauge, verdict, segmented status bar, counts.
  const ticks = [0,45,90,135,180,225,270,315].map(a => { const r1=46, r2=50, rad=a*Math.PI/180;
    return `<line x1="${(52+r1*Math.cos(rad)).toFixed(1)}" y1="${(52+r1*Math.sin(rad)).toFixed(1)}" x2="${(52+r2*Math.cos(rad)).toFixed(1)}" y2="${(52+r2*Math.sin(rad)).toFixed(1)}"/>`; }).join('');
  const segTotal = overdue.length + soon.length + okCount;
  const segbar = segTotal
    ? `<div class="segbar">${overdue.length ? `<i class="seg-red" style="flex:${overdue.length}"></i>` : ''}${soon.length ? `<i class="seg-amber" style="flex:${soon.length}"></i>` : ''}${okCount ? `<i class="seg-green" style="flex:${okCount}"></i>` : ''}</div>`
    : `<div class="segbar"><i class="seg-dim" style="flex:1"></i></div>`;
  const next90 = Store.costUpcoming(90);
  // Compact rail-row for an attention task: rail + pill carry status, one-tap ✓ stays.
  const kRow = t => { const a = Store.asset(t.assetId); if (!a) return '';
    const st = Store.status(t), prov = Store.provider(a.providerId);
    const sub = [a.name, isDiy(t, a) ? '🛠 DIY' : (prov ? prov.name : null)].filter(Boolean).join(' · ');
    return `<div class="k-row ${COLOR[st]}" data-action="open-asset" data-id="${a.id}">
      ${assetTile(a, 'k-tile')}
      <div class="k-main"><div class="k-title">${esc(t.title)}${t.autoBook ? ' <span class="chip auto">🤖 auto</span>' : ''}</div><div class="k-sub">${esc(sub)}</div></div>
      <div class="k-right"><span class="k-pill ${COLOR[st]}">${esc(Store.dueLabel(t))}</span>${t.estCost ? `<div class="k-cost">est ${money(t.estCost)}</div>` : ''}</div>
      <button class="k-done" data-action="done" data-id="${t.id}" title="Mark done"><svg><use href="#i-check"/></svg></button>
    </div>`; };
  const uRow = a => { const s = USAGE.map[a.id] && USAGE.map[a.id].s;
    const used = s ? `${s.unit === 'kWh' ? Math.round(s.used) : (s.used < 10 ? s.used.toFixed(1) : Math.round(s.used))} / ${s.threshold} ${s.unit} since last service` : 'over its usage threshold';
    return `<div class="k-row red" data-action="open-asset" data-id="${a.id}">
      ${assetTile(a, 'k-tile')}
      <div class="k-main"><div class="k-title">${esc(a.name)}</div><div class="k-sub">${esc(used)}</div></div>
      <div class="k-right"><span class="k-pill red">by usage</span></div>
      <button class="k-done" data-action="reset-usage" data-id="${a.id}" title="Serviced — reset the counter"><svg><use href="#i-check"/></svg></button>
    </div>`; };
  const tlRow = t => { const a = Store.asset(t.assetId); if (!a) return '';
    const nd = Store.nextDue(t), prov = Store.provider(a.providerId);
    const date = nd ? `${MONTHS[nd.getMonth()]} ${nd.getDate()}` : '—';
    const sub = [a.name, prov ? prov.name : (isDiy(t, a) ? 'DIY' : null), t.autopilot ? 'autopilot' : null, t.autoBook ? 'auto-book' : null].filter(Boolean).join(' · ');
    return `<div class="tl-row" data-action="open-asset" data-id="${a.id}">
      <div class="tl-date">${date}</div>
      <div class="tl-main"><div class="tl-title">${esc(t.title)}</div><div class="tl-sub">${esc(sub)}</div></div>
      ${t.estCost ? `<div class="tl-cost">${money(t.estCost)}</div>` : ''}
    </div>`; };
  const qDot = q => (q.status === 'dates_offered' || q.status === 'quoted') ? 'var(--green)' : 'var(--amber)';
  return topbar('KasaKeeper', '⚙︎', 'settings', true) + `
    <div class="hero2 ${h.color}">
      <svg class="ring2" viewBox="0 0 104 104" width="104" height="104">
        <g style="stroke:var(--line)" stroke-width="2">${ticks}</g>
        <circle cx="52" cy="52" r="${R}" fill="none" style="stroke:var(--surface2)" stroke-width="7"></circle>
        <circle cx="52" cy="52" r="${R}" fill="none" style="stroke:var(--${h.color})" stroke-width="7" stroke-linecap="round"
          stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 52 52)"></circle>
        <text x="52" y="60" text-anchor="middle" style="fill:var(--text)">${h.score}</text>
      </svg>
      <div class="grow">
        <div class="h-k">Home health · ${h.label}</div>
        <div class="h-line">${healthHeadline(h, notSetUp)}</div>
        ${segbar}
        <div class="h-counts">${notSetUp ? `<span>${unsched.length} service${unsched.length>1?'s':''} ready to track</span>`
          : `<span><span class="cdot" style="background:var(--red)"></span><b>${overdue.length}</b> overdue</span>
             ${uDue.length ? `<span><span class="cdot" style="background:var(--red)"></span><b>${uDue.length}</b> by usage</span>` : ''}
             <span><span class="cdot" style="background:var(--amber)"></span><b>${soon.length}</b> soon</span>
             <span><span class="cdot" style="background:var(--green)"></span><b>${okCount}</b> ok</span>
             ${next90 ? `<span><b>${money(next90)}</b> next 90d</span>` : ''}`}</div>
      </div>
    </div>
    ${notSetUp ? `<div class="setup-cta" data-action="start-tracking"><b>Start tracking — mark everything serviced today ↦</b><div>Your ${unsched.length} services will begin counting down to their next due dates.</div></div>` : ''}
    <div data-nudges></div>
    <div class="card triage-cta" data-action="triage-open"><div class="row"><div class="emoji">🛟</div>
      <div class="grow"><div class="t-name">Something's wrong?</div><div class="t-sub">Describe it · I'll triage and find who you need</div></div><span class="chip">›</span></div></div>
    <div class="section-title">Needs attention <span class="pill">${attnCount}</span></div>
    ${attnCount ? `<div class="k-list">${uCards.map(uRow).join('') + attention.map(kRow).join('')}</div>`
      : (next ? `<div class="eye-scene" data-eye-scene></div>
             <div class="banner ok allclear"><svg class="kk-shut"><use href="#kk-blink"/></svg><span>Nothing to see. Next up: <b>${esc(next.title)}</b> ${esc(Store.dueLabel(next))}.</span></div>`
             : notSetUp ? ''
             : `<div class="setup-cta" data-action="catalog"><b>Add your first service to track</b><div>Pick a system — hot water, aircon, gutters — and KasaKeeper builds the schedule.</div></div>`)}
    ${openQuotes.length ? `<div class="section-title">Quotes in flight <span class="pill">${openQuotes.length}</span></div>
      <div class="qchips">${openQuotes.map(q => { const a = Store.asset(q.assetId);
        return `<div class="qchip" data-action="open-quote" data-id="${q.id}">
          <div class="qn"><span class="cdot" style="background:${qDot(q)}"></span>${esc(q.provider || q.trade || (a ? a.name : 'Quote'))}</div>
          <div class="qs">${esc(QSTATUS[q.status] || q.status)}</div></div>`; }).join('')}</div>` : ''}
    ${upcoming.length ? `<div class="section-title">Coming up</div><div class="k-list" style="padding:2px 12px">${upcoming.map(tlRow).join('')}</div>` : ''}
    <button class="fab" data-action="catalog">＋</button>` + nav('');
}

/* ---------- Ask — the house assistant ---------- */
let CHAT = { messages: [], busy: false };
const CHAT_SUGGESTIONS = [
  'What needs doing this month?',
  'Who cleans the house and what does it cost a year?',
  'Which warranties expire soonest?',
  'Log the gutter clean as done today',
];

function viewChat() {
  const bubbles = CHAT.messages.map((m, mi) => {
    const body = esc(m.content).replace(/\n/g, '<br>');
    const chg = (m.changes && m.changes.length)
      ? `<div class="chat-changes">${m.changes.map(c => `✓ ${esc(c)}`).join('<br>')}</div>` : '';
    // Grounding: what the reply was based on — the usage-tracked entities + their live state.
    const grounded = (m.grounded && m.grounded.length)
      ? `<div class="chat-grounded">${m.grounded.map(g =>
          `<span class="chip ground">● ${esc(g.entity)}${g.state != null ? ' · ' + esc(g.state) : ''}</span>`).join('')}</div>`
      : '';
    // Destructive tool calls land here as proposals, not done yet — the user confirms per-row.
    // applying lives on the proposal object itself (not a captured index or DOM flag) so a
    // re-render mid-flight (e.g. sending another message) can't resurrect a live "Do it" button.
    const proposals = (m.proposals && m.proposals.length)
      ? `<div class="chat-proposals">${m.proposals.map((p, pi) => `
          <div class="chat-proposal">
            <div class="cp-detail">${esc(p.detail)}</div>
            <div class="cp-actions">
              <button class="btn small primary" data-action="chat-apply" data-mi="${mi}" data-pi="${pi}" ${p.applying ? 'disabled' : ''}>${p.applying ? 'Applying…' : '✓ Do it'}</button>
              <button class="btn small" data-action="chat-dismiss" data-mi="${mi}" data-pi="${pi}" ${p.applying ? 'disabled' : ''}>Dismiss</button>
            </div>
          </div>`).join('')}</div>`
      : '';
    return m.role === 'user'
      ? `<div class="chat-row me"><div class="bubble me">${body}</div></div>`
      : `<div class="chat-row"><svg class="chat-mark"><use href="#kk-mark"/></svg><div class="bubble">${body}${chg}${grounded}${proposals}</div></div>`;
  }).join('');
  const empty = CHAT.messages.length ? '' : `<div class="chat-intro">
      <svg class="chat-hero"><use href="#kk-mark"/></svg>
      <div class="t-name">Ask me about the house</div>
      <div class="t-sub">I know your assets, schedules, warranties, trades and quotes — and I can update them.</div>
      <div class="chat-sugg">${CHAT_SUGGESTIONS.map(s => `<button class="chip sugg" data-action="chat-suggest" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    </div>`;
  return topbar('Ask') + `
    <div class="chat-log">${empty}${bubbles}
      ${CHAT.busy ? `<div class="chat-row"><svg class="chat-mark"><use href="#kk-mark"/></svg><div class="bubble typing">thinking…</div></div>` : ''}
    </div>
    <div class="chat-bar">
      <textarea id="chat_in" rows="1" placeholder="Ask anything, or tell me to change something…" ${CHAT.busy ? 'disabled' : ''}></textarea>
      <button class="btn primary" data-action="chat-send" ${CHAT.busy ? 'disabled' : ''}>Send</button>
    </div>` + nav('chat');
}

async function chatSend(text) {
  const q = (text || '').trim();
  if (!q || CHAT.busy) return;
  CHAT.messages.push({ role: 'user', content: q });
  CHAT.busy = true; render();
  const wire = CHAT.messages.map(m => ({ role: m.role, content: m.content }));
  const res = await Research.chat(wire);
  CHAT.busy = false;
  CHAT.messages.push({ role: 'assistant', content: res.reply || 'Done.', changes: res.changes || [],
    grounded: res.grounded || [], proposals: res.proposals || [] });
  // the assistant edits the shared store server-side — pull the changes down
  if (res.changes && res.changes.length) await Store.syncRemote();
  render();
  const log = document.querySelector('.chat-log'); if (log) window.scrollTo(0, document.body.scrollHeight);
}

function viewAssets(sub) {
  const onWarranty = sub === 'warranty';
  // Warranties live here (not on the dashboard): every asset with a warranty date,
  // soonest-expiring first. The pill counts what's expired or ending within 60 days.
  const warr = Store.homeAssets().map(a => ({ a, d: Store.warrantyDays(a) }))
    .filter(x => x.d !== null).sort((x, y) => x.d - y.d);
  const watch = warr.filter(x => x.d <= 60).length;
  const tabs = `<div class="tabs">
    <a class="tab ${onWarranty ? '' : 'on'}" href="#/assets">Assets <span class="pill">${Store.homeAssets().length}</span></a>
    <a class="tab ${onWarranty ? 'on' : ''}" href="#/assets/warranty">Warranties${watch ? ` <span class="pill warn">${watch}</span>` : ''}</a>
  </div>`;

  let body;
  if (onWarranty) {
    body = warr.length ? `<div class="k-list">${warr.map(({ a, d }) => {
      const mm = [a.make, a.model].filter(Boolean).join(' ');
      const cls = d < 0 ? 'red' : d <= 60 ? 'amber' : 'green';
      return `<div class="k-row ${cls}" data-action="open-asset" data-id="${a.id}">
        ${assetTile(a, 'k-tile')}
        <div class="k-main"><div class="k-title">${esc(a.name)}</div>
          <div class="k-sub">${esc(mm || a.location || a.category)}${a.warrantyUntil ? ' · until ' + esc(a.warrantyUntil) : ''}</div></div>
        <div class="k-right"><span class="k-pill ${cls}">${d < 0 ? `expired ${-d}d ago` : d === 0 ? 'ends today' : `${d}d left`}</span></div>
      </div>`;
    }).join('')}</div>` : `<div class="empty">No warranty dates yet — add one when you edit an asset.</div>`;
  } else {
    const byCat = {};
    Store.homeAssets().forEach(a => (byCat[a.category] = byCat[a.category] || []).push(a));
    body = Object.keys(byCat).sort().map(cat => `
      <div class="section-title">${Store.icon(cat)} ${esc(cat)} <span class="pill">${byCat[cat].length}</span></div>
      <div class="k-list">${byCat[cat].map(a => {
        const ts = Store.tasksFor(a.id).filter(t => !t.snoozed);
        // A never-serviced task has no due date: that is "not tracked", not "healthy" —
        // it must not wear the same green dot as an asset that's genuinely on schedule.
        const sts = ts.map(t => Store.daysUntil(t) === null ? 'unsched' : Store.status(t));
        const rank = { overdue:0, soon:1, unsched:2, ok:3 };
        const worst = sts.sort((x,y)=>rank[x]-rank[y])[0] || 'unsched';
        return `<div class="k-row ${worst==='unsched' ? '' : COLOR[worst]}" data-action="open-asset" data-id="${a.id}">
          ${assetTile(a, 'k-tile')}
          <div class="k-main"><div class="k-title">${esc(a.name)}</div><div class="k-sub">${esc(a.location||'')}${a.location?' · ':''}${worst==='unsched' ? 'not tracked yet' : ts.length + ' task' + (ts.length!==1?'s':'')}${a.lookupPending ? ' · <b style="color:var(--accent)">✦ research ready</b>' : ''}</div></div>
          <span class="dot ${worst==='unsched' ? 'dim' : COLOR[worst]}" style="margin-right:4px"></span>
        </div>`;
      }).join('')}</div>`).join('') || `<div class="empty">No assets yet.</div>`;
  }
  return topbar('Assets','＋','catalog') + tabs + (onWarranty ? '' : `<div data-ha-banner></div>`) + body +
    `<button class="fab" data-action="catalog">＋</button>` + nav('assets');
}

// Prepaid maintenance: what you bought, what you've used, what's left.
function packCard(a) {
  const p = Store.pack(a);
  if (!p) return `<div class="section-title">Prepaid maintenance</div>
    <div class="banner">Bought a block of services up front? <b data-action="edit-pack" data-id="${a.id}" style="color:var(--accent);cursor:pointer">＋ Add a service pack →</b></div>`;
  const left = Store.packLeft(a), pct = Math.round((p.used || 0) / p.bought * 100);
  const per = Store.packPerVisit(a);
  const unit = p.unit || 'visit';
  const label = `${left} of ${p.bought} ${unit}${p.bought !== 1 ? 's' : ''} left`;
  return `<div class="section-title">Prepaid maintenance</div>
    <div class="card">
      <div class="row"><div class="emoji">🎟️</div>
        <div class="grow"><div class="t-name">${esc(label)}</div>
          <div class="t-sub">${p.used || 0} used${p.cost ? ` · ${money(p.cost)} paid${per ? ` · ${money(per)} per ${esc(unit)}` : ''}` : ''}${p.purchasedOn ? ` · bought ${esc(p.purchasedOn)}` : ''}${p.ref ? ` · ${esc(p.ref)}` : ''}</div>
          ${p.note ? `<div class="t-sub dim">${esc(p.note)}</div>` : ''}</div>
        <div class="due ${left === 0 ? 'overdue' : left <= 1 ? 'soon' : 'ok'}">${left}</div></div>
      <div class="usagebar ${left === 0 ? 'due' : left <= 1 ? 'warn' : ''}">
        <div class="u-track"><div class="u-fill" style="width:${pct}%"></div></div>
        <div class="u-lbl"><b>${p.used || 0}</b> used of ${p.bought}</div></div>
      <div class="btn-row">
        ${left ? `<button class="btn small primary" data-action="book-pack" data-id="${a.id}">📅 Book a visit</button>` : ''}
        <button class="btn small" data-action="use-pack" data-id="${a.id}" ${left ? '' : 'disabled'}>− Use one</button>
        <button class="btn small" data-action="unuse-pack" data-id="${a.id}" ${p.used ? '' : 'disabled'}>↩ Undo</button>
        <button class="btn small" data-action="edit-pack" data-id="${a.id}">✎ Edit</button>
      </div>
      ${left === 0 ? `<div class="banner">All used up — time to rebook or buy another block.</div>` : ''}
    </div>`;
}
function viewAsset(id) {
  const a = Store.asset(id); if (!a) return viewDashboard();
  const ts = Store.tasksFor(id), prov = Store.provider(a.providerId);
  const liveChip = (a.haEntity && !Store.isTestHome()) ? `<span class="chip live" data-ha="${esc(a.haEntity)}">● live: …</span>` : '';
  const wd = Store.warrantyDays(a);
  const warrChip = wd !== null ? `<span class="chip ${wd < 0 ? 'expired' : wd <= 90 ? 'cost' : 'live'}">🛡 ${esc(Store.warrantyLabel(a))}</span>` : '';
  const provCard = prov ? `<div class="section-title">Service provider</div>
    <div class="card" data-action="open-provider" data-id="${prov.id}"><div class="row"><div class="emoji">👷</div>
      <div class="grow"><div class="t-name">${esc(prov.name)}</div>
      <div class="t-sub">${esc(prov.trade)}${prov.contact?' · '+esc(prov.contact):''}${prov.phone?' · '+esc(prov.phone):''}</div></div>
      ${prov.website?`<a class="btn small" data-ext href="${esc(webUrl(prov.website))}" target="_blank" rel="noopener">🔗</a>`:''}
      ${prov.phone?`<a class="btn small" data-ext href="tel:${esc(prov.phone.replace(/\s/g,''))}">📞</a>`:''}</div></div>`
    : (() => { const active = Store.tasksFor(a.id).filter(t => !t.snoozed);   // all-DIY asset: don't nag for a supplier nobody needs
        return a.diy || (active.length && active.every(t => t.diy))
          ? `<div class="banner ok">🛠 You handle this one yourself — no supplier needed.${a.diy ? ` <b data-action="toggle-asset-diy" data-id="${a.id}" style="color:var(--accent);cursor:pointer">Use a pro instead →</b>` : ''}</div>`
          : `<div class="banner">No service provider linked. <b data-action="find" data-id="${a.id}" style="color:var(--accent);cursor:pointer">Find one →</b> · or <b data-action="toggle-asset-diy" data-id="${a.id}" style="color:var(--accent);cursor:pointer">🛠 mark it DIY</b></div>`; })();
  // The manual chip is the document-vault seed: real link when we have one, an
  // honest "find it" affordance when we could, nothing when we couldn't.
  const manualChip = a.manualDoc
    ? `<a class="chip live" data-ext href="api/doc/${a.id}" target="_blank" rel="noopener"><svg class="ci"><use href="#i-doc"/></svg> manual · saved</a>`
    : a.manualUrl
      ? `<a class="chip live" data-ext href="${esc(webUrl(a.manualUrl))}" target="_blank" rel="noopener"><svg class="ci"><use href="#i-doc"/></svg> manual</a><span class="chip" data-action="save-manual" data-id="${a.id}" style="cursor:pointer" title="Fetch the PDF onto the Green — survives dead links, opens on every device">⤓ keep a copy</span>`
      : ((a.make || a.model) ? `<span class="chip" data-action="lookup" data-id="${a.id}" style="cursor:pointer"><svg class="ci"><use href="#i-doc"/></svg> find the manual →</span>` : '');
  // Maintenance row: cadence + who does it; status on the rail and the pill;
  // one-tap ✓ stays; the row itself opens the task editor.
  const cadLabel = t => !(t.cadenceDays > 0) ? 'not scheduled'
    : t.cadenceDays >= 360 ? `every ${Math.round(t.cadenceDays / 365)}y`
    : t.cadenceDays >= 28 ? `every ${Math.round(t.cadenceDays / 30)}mo` : `every ${t.cadenceDays}d`;
  const mRow = t => { const st = Store.status(t), tp = taskProv(t, a);
    const sub = [cadLabel(t), isDiy(t, a) ? '🛠 DIY' : (tp ? tp.name : null)].filter(Boolean).join(' · ');
    const provenance = t.src === 'maker' ? ` · <b style="color:var(--accent);font-weight:600">maker's interval</b>` : t.src === 'research' ? ` · <b style="color:var(--accent);font-weight:600">researched</b>` : '';
    return `<div class="k-row ${COLOR[st]}" data-action="edit-task" data-id="${t.id}" data-asset="${a.id}">
      <div class="k-main" style="padding-left:4px"><div class="k-title">${esc(t.title)}${t.autoBook ? ' <span class="chip auto">🤖 auto</span>' : ''}${t.autopilot ? ' <span class="chip pilot">⟳ autopilot</span>' : ''}${seasonChip(t.season)}</div>
        <div class="k-sub">${esc(sub)}${provenance}${t.note ? ` · 📌 ${esc(t.note)}` : ''}</div></div>
      <div class="k-right"><span class="k-pill ${COLOR[st]}">${esc(Store.dueLabel(t))}</span>${t.estCost ? `<div class="k-cost">est ${money(t.estCost)}</div>` : ''}</div>
      <button class="k-done" data-action="done" data-id="${t.id}" title="Mark done"><svg><use href="#i-check"/></svg></button>
    </div>`; };
  const histRow = l => { const p = l.providerId ? Store.provider(l.providerId) : null;
    const sub = [p ? p.name : (l.source === 'done' ? 'logged from ✓ Done' : null), l.ref].filter(Boolean).join(' · ');
    return `<div class="tl-row" data-action="edit-job" data-id="${l.id}" data-asset="${a.id}">
      <div class="tl-date">${railDate(l.date)}</div>
      <div class="tl-main"><div class="tl-title">${esc(l.note || 'Service')}</div>${sub ? `<div class="tl-sub">${esc(sub)}</div>` : ''}</div>
      <div class="tl-cost">${l.cost ? money(l.cost) : '—'}</div>
    </div>`; };
  return `<button class="back" data-action="back">‹ Back</button>
    <div class="hero">${assetTile(a, 'emoji')}
      <div><h1>${esc(a.name)}</h1><div class="t-sub">${esc(a.category)}${a.variant?' · '+esc(a.variant):''}${(a.make||a.model)?' · '+esc([a.make,a.model].filter(Boolean).join(' ')):''}${a.location?' · '+esc(a.location):''}</div><div class="chip-row">${liveChip}${warrChip}${manualChip}</div></div></div>
    ${a.ha ? `<div class="ha-strip" data-ha-strip="${a.id}"><span class="hs-lbl">live · via Home Assistant</span><span class="hs-vals">…</span></div>` : ''}
    <img class="asset-photo" src="api/photo/${a.id}" alt="" onerror="this.remove()">
    <div class="meta-grid">
      <div class="meta"><div class="k">Installed</div><div class="v">${a.installedOn?esc(a.installedOn):'—'}</div></div>
      <div class="meta"><div class="k">Warranty until</div><div class="v">${a.warrantyUntil?esc(a.warrantyUntil):'—'}</div></div>
      <div class="meta"><div class="k">Make / model</div><div class="v">${(a.make||a.model)?esc([a.make,a.model].filter(Boolean).join(' ')):'—'}</div></div>
      <div class="meta"><div class="k">Serial</div><div class="v">${a.serial?esc(a.serial):'—'}</div></div>
    </div>
    ${lookupSection(a)}
    ${(a.make || a.model) ? `<div class="btn-row"><button class="btn small" data-action="check-recall" data-id="${a.id}">🛡 Check for recalls</button></div>${recallSection(a)}` : ''}
    ${(() => { const m = Catalog.match(a.category, a.name); if (!m || !m.s.variants) return '';
      return `<div class="section-title">Type</div><div class="btn-row">${m.s.variants.map(v =>
        `<button class="btn small ${a.variant===v.name?'primary':''}" data-action="set-variant" data-id="${a.id}" data-svc="${m.idx}" data-var="${esc(v.name)}">${esc(v.name)}</button>`).join('')}</div>`; })()}
    ${packCard(a)}
    <div class="section-title">Usage tracking</div>
    ${a.usage ? `${usageBar(a)}
      <div class="btn-row">
        <button class="btn small" data-action="reset-usage" data-id="${a.id}">↺ Serviced (reset)</button>
        <button class="btn small" data-action="track-usage" data-id="${a.id}">✎ Edit</button>
        <button class="btn small" data-action="stop-usage" data-id="${a.id}" style="color:var(--red)">Stop</button>
      </div>`
    : `<div class="banner">Remind me by real usage, not just the calendar — pull run-hours or energy from Home Assistant. <b data-action="track-usage" data-id="${a.id}" style="color:var(--accent);cursor:pointer">📊 Track usage →</b></div>`}
    ${(() => { const act = ts.filter(t => !t.snoozed), snz = ts.filter(t => t.snoozed);
      return `<div class="section-title">Maintenance <span class="pill">${act.length}</span></div>
        ${act.length ? `<div class="k-list">${act.map(mRow).join('')}</div>` : `<div class="empty">No active tasks.</div>`}
        ${snz.length ? `<div class="section-title">Snoozed <span class="pill">${snz.length}</span></div>${snz.map(t => taskCard(t, { showAsset:false })).join('')}` : ''}`; })()}
    ${(() => { const q = Store.quoteForAsset(a.id);   // what's in flight for THIS asset belongs on its page, not just in Trades
      return q ? `<div class="section-title">Quote request</div>` + qCard(q) : ''; })()}
    <div class="btn-row">
      <button class="btn primary small" data-action="suggest" data-id="${a.id}">✨ Suggest schedule</button>
      <button class="btn small" data-action="new-task" data-id="${a.id}">＋ Add task</button>
      <button class="btn small" data-action="edit-asset" data-id="${a.id}">✎ Edit</button>
      <button class="btn small" data-action="enquiry" data-id="${a.id}">✉︎ Enquiry email</button>
      ${wd !== null && wd >= 0 ? `<button class="btn small" data-action="claim-warranty" data-id="${a.id}">🛡 Claim warranty</button>` : ''}
      ${(a.purchaseUrl || a.make || a.model) ? `<button class="btn small" data-action="buy" data-id="${a.id}">🛒 Buy replacements</button>` : ''}
    </div>
    ${(() => { const jobs = Store.logsFor(a.id);
      const pending = jobs.filter(l => l.pending), done = jobs.filter(l => !l.pending);
      const spent = done.reduce((s, l) => s + (l.cost || 0), 0);
      return `<div class="section-title">History <span class="pill">${done.length}</span>${spent ? `<span class="pill">${money(spent)} total</span>` : ''}</div>
        ${pending.map(jobRow).join('')}
        ${done.length ? `<div class="k-list" style="padding:2px 12px">${done.map(histRow).join('')}</div>` : `<div class="empty">No jobs logged yet — every ✓ Done lands here.</div>`}
        <div class="btn-row"><button class="btn small" data-action="new-job" data-id="${a.id}">＋ Log a past job</button></div>`; })()}
    ${provCard}
    <div class="btn-row"><button class="btn small" data-action="del-asset" data-id="${a.id}" style="color:var(--red)">Delete asset</button></div>`;
}

const QSTATUS = { to_contact: 'needs a supplier', enquiry_sent: 'enquiry sent', quoted: 'quote in', dates_offered: 'pick a date', booked: 'booked' };
// Schedule row in the instrument language: rail+pill carry status, the sub names
// the asset and who does it, and ONE context action drives the triage — everything
// else (edit/snooze/delete) lives one tap away on the asset page.
function scheduleRow(t) {
  const a = Store.asset(t.assetId); if (!a) return '';
  const st = Store.status(t), prov = taskProv(t, a), q = Store.quoteForAsset(a.id);
  let action;
  if (isDiy(t, a)) action = `<button class="btn small" data-action="${t.diy ? 'toggle-diy' : 'toggle-asset-diy'}" data-id="${t.diy ? t.id : a.id}" title="You do this yourself · tap to change">🛠 DIY ✓</button>`;
  else if (prov) action = prov.email && !q
    ? `<button class="btn small" data-action="book-service" data-id="${t.id}">✉︎ Book service</button>`
    : `<button class="btn small" data-action="call" data-id="${a.id}">📞 ${esc(prov.name)}</button>`;
  else if (q) action = `<span class="chip cost">${esc(QSTATUS[q.status] || q.status)}${q.amount ? ' · ' + money(q.amount) : ''}</span> <button class="btn small" data-action="open-quote" data-id="${q.id}">manage</button>`;
  else action = `<button class="btn small primary" data-action="find" data-id="${a.id}">🔎 Find a supplier</button>`;
  const sub = [a.name, isDiy(t, a) ? null : (prov ? prov.name : null)].filter(Boolean).join(' · ');
  return `<div class="k-row ${COLOR[st]}" data-action="open-asset" data-id="${a.id}">
    ${assetTile(a, 'k-tile')}
    <div class="k-main"><div class="k-title">${esc(t.title)}${t.autoBook ? ' <span class="chip auto">🤖 auto</span>' : ''}${t.autopilot ? ' <span class="chip pilot">⟳ autopilot</span>' : ''}${seasonChip(t.season)}</div>
      <div class="k-sub">${esc(sub)}${t.note ? ` · 📌 ${esc(t.note)}` : ''}</div>
      <div class="btn-row" style="margin-top:8px">${action}</div></div>
    <div class="k-right"><span class="k-pill ${COLOR[st]}">${esc(Store.dueLabel(t))}</span>${t.estCost ? `<div class="k-cost">est ${money(t.estCost)}</div>` : ''}</div>
  </div>`;
}
function viewSchedule() {
  const tasks = Store.homeTasks().slice().sort((a, b) => (Store.daysUntil(a) ?? 1e9) - (Store.daysUntil(b) ?? 1e9));
  const need = [], waiting = [], assigned = [], diy = [];
  // "Needs a supplier" must not contradict reality: a task whose asset already has
  // an open quote is mid-conversation with one, not still looking. to_contact stays
  // in "needs" though — that status means intent captured, no supplier engaged yet.
  tasks.forEach(t => { const a = Store.asset(t.assetId); const q = Store.quoteForAsset(t.assetId);
    (isDiy(t, a) ? diy : a && a.providerId ? assigned : q && q.status !== 'to_contact' ? waiting : need).push(t); });
  const snoozed = Store.snoozedTasks();
  const group = list => `<div class="k-list">${list.map(scheduleRow).join('')}</div>`;
  return topbar('Schedule') + `
    <div class="section-title">Needs a supplier <span class="pill">${need.length}</span></div>
    ${need.length ? group(need) : `<div class="empty">Everything's assigned 👍</div>`}
    ${waiting.length ? `<div class="section-title">Awaiting a quote <span class="pill">${waiting.length}</span></div>${group(waiting)}` : ''}
    <div class="section-title">Assigned <span class="pill">${assigned.length}</span></div>
    ${assigned.length ? group(assigned) : `<div class="empty">Nothing assigned yet — tap "Find a supplier" above.</div>`}
    ${diy.length ? `<div class="section-title">DIY · yours to do <span class="pill">${diy.length}</span></div>${group(diy)}` : ''}
    ${snoozed.length ? `<div class="section-title">Snoozed <span class="pill">${snoozed.length}</span></div>
      ${snoozed.map(t => taskCard(t, { showAsset: true })).join('')}` : ''}
    ` + nav('schedule');
}

// Provider profile — who they are, what they look after, and every job they've
// done for you across all assets. Tap-through target from any provider card.
function viewProvider(id) {
  const p = Store.provider(id); if (!p) return viewProviders();
  const jobs = Store.jobsForProvider(id);
  const spent = jobs.filter(l => !l.pending).reduce((s, l) => s + (l.cost || 0), 0);
  const assets = Store.homeAssets().filter(a => a.providerId === id);
  const quotes = Store.homeQuotes().filter(q => q.provider === p.name && q.status !== 'booked' && q.status !== 'declined');
  const sub = [p.trade, p.contact].filter(Boolean).join(' · ');
  return `<button class="back" data-action="back">‹ Back</button>
    <div class="hero"><div class="emoji">👷</div><div><h1>${esc(p.name)}</h1>
      <div class="t-sub">${esc(sub)}</div></div></div>
    <div class="btn-row">
      ${p.phone ? `<a class="btn small primary" data-ext href="tel:${esc(p.phone.replace(/\s/g,''))}">📞 Call</a>` : ''}
      ${p.email ? (p.draft
        ? `<button class="btn small primary" data-action="open-trade-draft" data-id="${p.id}">✉︎ Review &amp; send</button>`
        : `<button class="btn small" data-action="email-trade" data-id="${p.id}">✉︎ Email</button>`) : ''}
      ${p.website ? `<a class="btn small" data-ext href="${esc(webUrl(p.website))}" target="_blank" rel="noopener">🔗 Website</a>` : ''}
      <button class="btn small" data-action="edit-provider" data-id="${p.id}">✎ Edit</button>
      ${p.archived
        ? `<button class="btn small primary" data-action="unarchive-provider" data-id="${p.id}">↩ Make active</button>`
        : `<button class="btn small" data-action="archive-provider" data-id="${p.id}">📥 Archive</button>`}
    </div>
    ${p.archived ? `<div class="banner">Past provider — kept for history, hidden from the active list. Their ${jobs.length} job${jobs.length!==1?'s':''} still count towards what you've spent.</div>` : ''}
    <div class="meta-grid">
      <div class="meta"><div class="k">Jobs</div><div class="v">${jobs.length}</div></div>
      <div class="meta"><div class="k">Total spent</div><div class="v">${spent ? money(spent) : '—'}</div></div>
      <div class="meta"><div class="k">Last job</div><div class="v">${jobs.length ? jobDate(jobs[0].date) : '—'}</div></div>
    </div>
    ${p.notes ? `<div class="banner">${esc(p.notes)}</div>` : ''}
    <div class="section-title">Looks after <span class="pill">${assets.length}</span></div>
    ${assets.length ? `<div class="k-list">${assets.map(a => `<div class="k-row" data-action="open-asset" data-id="${a.id}">
        ${assetTile(a, 'k-tile')}
        <div class="k-main"><div class="k-title">${esc(a.name)}</div>
        <div class="k-sub">${esc(a.category)}${a.location ? ' · ' + esc(a.location) : ''}</div></div>
      </div>`).join('')}</div>`
      : `<div class="empty">Not linked to any asset yet.</div>`}
    <div class="section-title">Job history <span class="pill">${jobs.length}</span>${spent ? `<span class="pill">${money(spent)} total</span>` : ''}</div>
    ${jobs.length ? `<div class="k-list" style="padding:2px 12px">${jobs.map(l => {
        const a = Store.asset(l.assetId);
        const jsub = [a && a.name, l.ref].filter(Boolean).join(' · ');
        return `<div class="tl-row" data-action="edit-job" data-id="${l.id}" data-asset="${l.assetId}">
          <div class="tl-date">${railDate(l.date)}</div>
          <div class="tl-main"><div class="tl-title">${esc(l.note || 'Service')}</div>${jsub ? `<div class="tl-sub">${esc(jsub)}</div>` : ''}</div>
          ${l.cost ? `<div class="tl-cost">${money(l.cost)}</div>` : ''}
        </div>`;
      }).join('')}</div>` : `<div class="empty">No jobs recorded yet.</div>`}
    ${quotes.length ? `<div class="section-title">Open quotes <span class="pill">${quotes.length}</span></div>
      ${quotes.map(q => { const qa = Store.asset(q.assetId);
        return `<div class="card" data-action="open-quote" data-id="${q.id}"><div class="row"><div class="emoji">🧾</div>
        <div class="grow"><div class="t-name">${esc(qa && q.trade === qa.category ? qa.name : (q.trade || 'Quote'))}${q.amount ? ' · ' + money(q.amount) : ''}</div>
        <div class="t-sub">${esc(QSTATUS[q.status] || q.status)}</div></div></div></div>`; }).join('')}` : ''}
    ${(() => { const mail = Store.mailFor(id); if (!mail.length) return '';
      return `<div class="section-title">Correspondence <span class="pill">${mail.length}</span></div>
        ${mail.map(m => `<div class="card"><div class="row">
          <div class="emoji">${m.direction === 'out' ? '📤' : '📥'}</div>
          <div class="grow"><div class="t-name">${esc(m.subject || '(no subject)')}</div>
            <div class="t-sub">${esc([jobDate(m.date), m.direction === 'out' ? 'sent' : (mailAddr(m.from) || String(m.from || '').trim())].filter(Boolean).join(' · '))}</div>
            ${m.snippet ? `<div class="t-sub dim">${esc(m.snippet)}</div>` : ''}</div></div></div>`).join('')}`; })()}`;
}
// One quote request, with its next action inline — shared by Trades and the dashboard.
function qCard(q) {
    const a = Store.asset(q.assetId);
    const waiting = q.status === 'enquiry_sent' && q.channel === 'email';   // sent via backend, poller is watching
    const draftBtn = q.draft ? `<button class="btn small primary" data-action="open-draft" data-id="${q.id}">✉︎ Review &amp; send</button>` : '';
    const nextBtns = draftBtn + (q.status === 'to_contact' ? `<button class="btn small" data-action="quote-sent" data-id="${q.id}">✉︎ Mark enquiry sent</button>`
      : waiting ? `<span class="chip watching">⌁ awaiting reply</span><button class="btn small" data-action="quote-amount" data-id="${q.id}">💲 Log manually</button>`
      : q.status === 'enquiry_sent' ? `<button class="btn small" data-action="quote-amount" data-id="${q.id}">💲 Log quote</button>`
      : q.status === 'dates_offered' ? (q.offeredDates || []).map(d =>
          `<button class="btn small primary" data-action="confirm-date" data-id="${q.id}" data-date="${esc(d)}">✅ ${esc(d)}</button>`).join('')
          + `<button class="btn small" data-action="quote-amount" data-id="${q.id}">💲 Log quote</button>`
      : q.status === 'quoted' ? `<button class="btn small primary" data-action="quote-book" data-id="${q.id}">✅ Book it</button>` : '');
    const meta = [
      q.bookedDate ? `📌 booked — ${esc(q.bookedDate)}` : (q.availability ? `📅 ${esc(q.availability)}` : ''),
      q.replyNote ? esc(q.replyNote) : (waiting && q.enquiryTo ? `enquiry sent to ${esc(q.enquiryTo)}` : ''),
    ].filter(Boolean).join(' · ');
    return `<div class="card"><div class="row"><div class="emoji">🧾</div>
      <div class="grow"><div class="t-name">${esc((a && (!q.trade || q.trade === a.category)) ? a.name : (q.trade || 'Quote'))}${q.amount ? ' · ' + money(q.amount) : ''}${q.auto ? ' <span class="chip auto">🤖 auto</span>' : q.autoParsed ? ' <span class="chip auto">auto</span>' : ''}</div>
      <div class="t-sub">${a && q.trade && q.trade !== a.name && q.trade !== a.category ? esc(a.name) + ' · ' : ''}${esc(QSTATUS[q.status] || q.status)}${q.provider ? ' · ' + esc(q.provider) : ''}</div>
      ${meta ? `<div class="t-sub dim">${meta}</div>` : ''}</div>
      <span class="chip ${q.status === 'booked' ? 'live' : 'cost'}">${esc(QSTATUS[q.status] || q.status)}</span></div>
      <div class="btn-row">${nextBtns}
        ${a ? `<button class="btn small" data-action="find" data-id="${a.id}">🔎 Suppliers</button>` : ''}
        <button class="btn small" data-action="del-quote" data-id="${q.id}" style="color:var(--red)">Remove</button></div></div>`;
}
function viewProviders() {
  const quotes = Store.homeQuotes();
  // One row per technician: logo/tile, name + trade·phone, and — on the right —
  // what they've cost us to date, or a job count when nothing's been logged yet.
  const pRow = p => {
    const jobs = Store.jobsForProvider(p.id);
    const spent = jobs.filter(l => !l.pending).reduce((t, l) => t + (l.cost || 0), 0);
    const sub = [p.trade, p.phone].filter(Boolean).join(' · ');
    // Rebook stays a one-tap quick action right on the row (as it was on the old card) —
    // there's nowhere else in the new list language for it, and the row itself still opens the profile.
    return `<div class="k-row${p.archived ? ' past' : ''}" data-action="open-provider" data-id="${p.id}">
      ${providerTile(p, 'k-tile')}
      <div class="k-main"><div class="k-title">${esc(p.name)}${p.archived ? ' <span class="chip">past</span>' : ''}</div>
        <div class="k-sub">${esc(sub)}</div>
        ${p.archived ? '' : `<div class="btn-row" style="margin-top:8px"><button class="btn small" data-action="rebook" data-id="${p.id}">↻ Rebook</button></div>`}
      </div>
      <div class="k-right">${spent ? `<div class="k-cost">${money(spent)}</div>` : `<span class="k-pill dim">${jobs.length} job${jobs.length!==1?'s':''}</span>`}</div>
    </div>`;
  };
  const active = Store.activeProviders();
  const past = Store.pastProviders().slice()
    .sort((x, y) => Store.lastJobDate(y.id).localeCompare(Store.lastJobDate(x.id)));
  return topbar('Trades', '＋', 'new-provider') +
    `<div class="section-title">Quote requests <span class="pill">${quotes.length}</span></div>` +
    (quotes.length ? quotes.map(qCard).join('') : `<div class="banner">No open quotes. On the Schedule, tap "Find a supplier" on any job to request one.</div>`) +
    `<div class="section-title">Your technicians <span class="pill">${active.length}</span>${(() => { const t = Store.homeLogs().reduce((s2, l) => s2 + (l.cost || 0), 0); return t ? `<span class="pill">${money(t)} all-time</span>` : ''; })()}</div>` +
    (active.length ? `<div class="k-list">${active.map(pRow).join('')}</div>` : `<div class="empty">No active technicians yet.</div>`) +
    (past.length ? `<div class="section-title dim">Past providers <span class="pill">${past.length}</span></div>`
      + `<div class="t-sub dim" style="margin:-4px 4px 8px">No longer used — history kept.</div>`
      + `<div class="k-list">${past.map(pRow).join('')}</div>` : '') +
    `<button class="fab" data-action="new-provider">＋</button>` + nav('providers');
}

function viewSettings() {
  const s = Store.state.settings;
  const homes = Store.state.homes, cur = Store.state.currentHomeId;
  // Homes list in the instrument language: k-row per home, active one carries the
  // dot + a static tile (no tap target — nothing to switch to), the rest are
  // tap-to-switch rows (replaces the old explicit "Switch" button, same action).
  const homeRow = h => { const meta = [h.levels && h.levels + ' levels', h.beds && h.beds + ' bed'].filter(Boolean).join(' · ');
    return `<div class="k-row"${h.id === cur ? ' style="cursor:default"' : ` data-action="switch-home" data-id="${h.id}"`}>
      <div class="k-tile">${h.photo ? `<img class="home-thumb" src="api/home-photo/${esc(h.id)}" alt="" onload="this.classList.add('on')" onerror="this.remove()">` : ''}<span class="em">${h.id === cur ? '🏠' : '🏘️'}</span></div>
      <div class="k-main"><div class="k-title">${esc(h.address || 'Home')}</div><div class="k-sub">${esc(meta) || (h.id === cur ? 'current home' : 'tap to switch')}${h.testMode ? ' · test home' : ''}</div></div>
      <div class="k-right">${h.id === cur ? '<span class="dot green" title="current"></span>' : ''}</div>
      <button class="k-done" data-action="del-home" data-id="${h.id}" style="color:var(--red)" title="Delete home">🗑</button>
    </div>`; };
  // Per-home config (test mode + the home photo) lives on the CURRENT home's card —
  // switch to a home to configure it.
  const curHomeCard = (() => { const h = homes.find(x => x.id === cur); if (!h) return '';
    // Everything researched or inferred about the home is correctable here —
    // the address, the counts, the photo. Research proposes; the user disposes.
    return `<div class="card">
      <label>Address</label><input id="eh_addr" value="${esc(h.address || '')}">
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
        <div><label>Levels</label><input id="eh_levels" type="number" value="${h.levels || ''}"></div>
        <div><label>Beds</label><input id="eh_beds" type="number" value="${h.beds || ''}"></div>
        <div><label>Baths</label><input id="eh_baths" type="number" value="${h.baths || ''}"></div>
      </div>
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-top:10px">
        <input type="checkbox" data-action-change="toggle-testmode" data-id="${h.id}" ${h.testMode ? 'checked' : ''} style="width:auto">
        Test home — skip Home Assistant (a friend's house, a demo)
      </label>
      <div class="imagery-strip" data-imagery="${h.id}" data-address="${esc(h.address || '')}"></div>
      <div class="btn-row">
        <button class="btn primary small" data-action="save-home" data-id="${h.id}">Save</button>
        <button class="btn small" data-action="toggle-imagery" data-id="${h.id}">📷 ${h.photo ? 'Change' : 'Choose'} photo</button>
      </div>
    </div>`; })();
  return topbar('Settings','','') + `
    <div class="section-title">Homes <span class="pill">${homes.length}</span></div>
    ${homes.length ? `<div class="k-list">${homes.map(homeRow).join('')}</div>` : '<div class="empty">No homes yet.</div>'}
    ${curHomeCard}
    <div class="btn-row"><button class="btn primary" data-action="setup">＋ Add a home</button></div>
    <div class="section-title">Appearance</div>
    <div class="card">
      <label>Theme · this device only</label>
      <div class="btn-row">
        ${[['auto','Match system'],['night','Night'],['paper','Paper']].map(([t,l]) =>
          `<button class="btn small ${(localStorage.getItem(THEME_KEY)||'auto')===t?'primary':''}" data-action="set-theme" data-theme="${t}">${l}</button>`).join('')}
      </div>
      <div class="kk-note">Night suits the wall tablet · Paper suits a daytime desktop. Each device keeps its own choice.</div>
    </div>
    <div class="section-title">Home Assistant</div>
    ${HA.proxy ? `<div class="banner ok">✓ Connected automatically via the Home Assistant add-on — live device data and usage tracking work with no setup. (Manual URL + token below are optional, for running outside the add-on.)</div>
    <div class="btn-row"><button class="btn primary small" data-action="ha-import-scan">↯ Import from Home Assistant</button></div>
    <div data-ha-drift></div>` : ''}
    <div class="card">
      <label>HA URL</label><input id="haUrl" value="${esc(s.haUrl)}" placeholder="http://192.168.68.144:8123">
      <label>Long-lived access token</label><input id="haToken" type="password" value="${esc(s.haToken)}" placeholder="paste token">
      <div class="btn-row"><button class="btn primary small" data-action="save-settings">Save</button>
        <button class="btn small" data-action="test-ha">Test connection</button></div>
      <div id="haResult" class="spinner"></div>
    </div>
    <div class="section-title">Notifications</div>
    <div class="card">
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
        <input type="checkbox" id="pushDaily" ${s.pushDaily !== false ? 'checked' : ''} style="width:auto">
        Morning brief — a daily push at 8am with what's overdue, due soon and weather nudges
      </label>
      <div class="btn-row"><button class="btn primary small" data-action="save-settings">Save</button>
        <button class="btn small" data-action="push-test">Send test notification</button></div>
      <div id="pushResult" class="spinner"></div>
    </div>
    <div class="section-title">Gmail · trades import & quotes</div>
    <div class="card" data-gmail-host>
      <div class="t-sub" style="white-space:normal">Two ways to use it — pick what suits:</div>
      <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;margin-top:10px">
        <input type="radio" name="gmailMode" value="dedicated" style="width:auto;margin-top:3px" ${s.gmailMode !== 'onetime' ? 'checked' : ''} data-action-change="gmail-mode">
        <span><b>Dedicated quotes inbox</b> <span class="chip live">recommended</span><br>
        <span class="t-sub" style="white-space:normal">A separate address just for tradie mail. KasaKeeper keeps watching it — imports suppliers now, manages quotes there later. Your personal mail stays out of reach.</span></span>
      </label>
      <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;margin-top:10px">
        <input type="radio" name="gmailMode" value="onetime" style="width:auto;margin-top:3px" ${s.gmailMode === 'onetime' ? 'checked' : ''} data-action-change="gmail-mode">
        <span><b>One-time import</b><br>
        <span class="t-sub" style="white-space:normal">Scan your existing inbox once to find your trades and history, then remove the credentials if you like.</span></span>
      </label>
      <div class="banner" data-gmail-status style="margin-top:12px">Checking Gmail…</div>
      <div class="btn-row">
        <button class="btn primary small" data-action="gmail-scan">🔎 Scan for my trades</button>
      </div>
      <p class="t-sub" style="white-space:normal;margin-top:10px">Setup: ${s.gmailMode === 'onetime' ? 'use your existing Gmail —' : 'create the dedicated Gmail, then in your main account add a filter forwarding tradie mail (from servicem8.com, invoices, quotes) to it. On the dedicated account —'} turn on 2-Step Verification, create an <b>App Password</b> (myaccount.google.com → Security → App passwords), and paste the address + app password into the add-on <b>Configuration</b> tab, then restart the add-on. ${s.gmailMode === 'onetime' ? 'Read-only: KasaKeeper never sends, deletes or moves mail in this mode.' : 'KasaKeeper sends enquiries and booking confirmations from this mailbox (each one approved by you, or via 🤖 Auto-book) and reads the replies. It never deletes or moves mail.'}</p>
    </div>
    <div class="section-title">Auto-book</div>
    <div class="card">
      <div class="t-sub" style="white-space:normal">Tasks with <b>🤖 Auto-book</b> switched on (edit any task) get their booking enquiry emailed automatically when they come due — you just confirm a date. Dedicated-inbox mode only.</div>
      <label>Lead time — email the trade this many days before due</label>
      <input id="autoLead" type="number" value="${s.autoLeadDays || 14}">
      <div class="btn-row"><button class="btn primary small" data-action="save-settings">Save</button></div>
    </div>
    <div class="section-title">Preferences</div>
    <div class="card">
      <label>Suburb (for finding services · this home)</label><input id="suburb" value="${esc(homeSuburb())}">
      <label>Your name (email sign-off)</label><input id="ownerName" value="${esc(s.ownerName || '')}" placeholder="how outgoing emails sign off">
      <label>Cc me on outgoing mail</label><input id="emailCc" type="email" value="${esc(s.emailCc || '')}" placeholder="you@example.com">
      <p class="hint">Every enquiry, booking and quote request KasaKeeper sends is copied here, so the thread also lands in your own inbox and the trade sees an address they recognise.</p>
      <label>“Due soon” window (days)</label><input id="soonDays" type="number" value="${s.soonDays||30}">
      <div class="btn-row"><button class="btn primary small" data-action="save-settings">Save</button></div>
    </div>
    <div class="section-title">Data</div>
    <div class="card" id="sweep-card">
      <div class="t-sub" style="white-space:normal">Re-research runs the current research over every existing asset — older assets keep old guesses (wrong trade, no maker schedule). Runs on the Green, so it keeps going even if you close this. Each result waits on its asset page as <b style="color:var(--accent)">✦ research ready</b>; nothing changes without your Apply.</div>
      ${SWEEP.running
        ? `<div class="banner ok" style="margin-top:10px"><span id="sweep-line">${esc(`${SWEEP.done} of ${SWEEP.total} · researching ${SWEEP.current}…`)}</span></div>
           <div class="kk-note" id="sweep-log" style="font-family:var(--mono,ui-monospace,monospace);font-size:11.5px">${(SWEEP.log || []).map(x => `<div>${esc(x)}</div>`).join('')}</div>
           <div class="btn-row">
             <button class="btn small" data-action="sweep-skip">⏭ Skip this one</button>
             <button class="btn small" data-action="sweep-stop">Stop after this one</button>
           </div>`
        : `<div class="btn-row" style="margin-top:10px"><button class="btn small" data-action="sweep-research">🔄 Re-research all assets</button></div>
           ${(SWEEP.log || []).length ? `<div class="kk-note" id="sweep-log" style="font-family:var(--mono,ui-monospace,monospace);font-size:11.5px">${SWEEP.log.map(x => `<div>${esc(x)}</div>`).join('')}</div>` : ''}`}
      <div class="btn-row" style="margin-top:6px">
        <button class="btn small" data-action="export">⬇︎ Export backup</button>
        <a class="btn small" data-ext href="api/logbook?home=${esc(Store.state.currentHomeId || '')}" target="_blank" rel="noopener">⤓ Home logbook (PDF)</a>
        <button class="btn small" data-action="reset" style="color:var(--red)">Erase all data</button>
      </div></div>
    <div class="section-title">Developer</div>
    <div class="card">
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
        <input type="checkbox" id="dbgToggle" data-action-change="toggle-debug" ${DBG.on ? 'checked' : ''} style="width:auto">
        Show the data behind the actions — a drawer with every search query and API payload, live
      </label>
      <div class="kk-note">Device-local · nothing is synced or sent anywhere. Use it to catch a wrong search and tell Claude exactly what to fix.</div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn small" data-action="recall-sweep-now">🛡 Run recall sweep now</button>
      </div>
      <div class="kk-note">Triggers the scheduled monthly recall check on demand — the same job that normally runs once a month, capped at 12 assets a run.</div>
    </div>
    <div class="kk-note" style="text-align:center;margin-top:20px"><a href="guide.html" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none"><svg class="ci" style="width:13px;height:13px;vertical-align:-2px"><use href="#i-doc"/></svg> User guide</a></div>` + nav('settings');
}

/* ---------- forms ---------- */
function field(id, label, val = '', type = 'text', ph = '') {
  return `<label>${esc(label)}</label><input id="${id}" type="${type}" value="${esc(val)}" placeholder="${esc(ph)}">`;
}
// ---- job history ----
const MONS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function jobDate(d) {
  const s = String(d || ''); if (s.length < 10) return s || '—';
  return `${+s.slice(8,10)} ${MONS[+s.slice(5,7) - 1] || ''} ${s.slice(0,4)}`;
}
function jobRow(l) {
  const p = l.providerId ? Store.provider(l.providerId) : null;
  const meta = [jobDate(l.date), p && p.name, l.ref].filter(Boolean).join(' · ');
  // A booked-but-not-done job is a commitment: shown as scheduled, not counted as spend.
  if (l.pending) {
    const days = Math.round((new Date(l.date) - Store.today()) / 86400000);
    const when = isNaN(days) ? '' : (days > 0 ? `in ${days}d` : days === 0 ? 'today' : `${-days}d ago`);
    return `<div class="card pending"><div class="row"><div class="emoji">📅</div>
      <div class="grow"><div class="t-name">${esc(l.note || 'Booked job')} <span class="chip watching">booked</span></div>
      <div class="t-sub">${esc(meta)}${when ? ' · ' + when : ''}</div></div>
      ${l.cost ? `<div class="due soon">${money(l.cost)}</div>` : ''}</div>
      <div class="btn-row">
        <button class="btn small primary" data-action="job-done" data-id="${l.id}" data-asset="${l.assetId}">✓ It's done</button>
        <button class="btn small" data-action="edit-job" data-id="${l.id}" data-asset="${l.assetId}">✎ Edit</button>
      </div></div>`;
  }
  return `<div class="card" data-action="edit-job" data-id="${l.id}" data-asset="${l.assetId}">
    <div class="row"><div class="emoji">🧾</div>
      <div class="grow"><div class="t-name">${esc(l.note || 'Service')}</div>
      <div class="t-sub">${esc(meta)}</div></div>
      ${l.cost ? `<div class="due ok">${money(l.cost)}</div>` : ''}
    </div></div>`;
}
// Booking a quote: capture WHEN, record it as a scheduled job, and (if we can
// email) draft a confirmation to the trade for approval. Nothing sends itself.
function bookQuote(quoteId) {
  const q = Store.quote(quoteId); if (!q) return viewDashboard();
  const a = Store.asset(q.assetId);
  const prov = (a && a.providerId) ? Store.provider(a.providerId)
             : Store.homeProviders().find(p => p.name === q.provider);
  const to = q.replyFrom || q.enquiryTo || (prov && prov.email) || '';
  return `<button class="back" data-action="back">‹ Cancel</button>
    <div class="hero"><div class="emoji">📅</div><div><h1>Book this job</h1>
      <div class="t-sub">${esc(q.trade || (a ? a.name : 'Service'))}${q.amount ? ' · ' + money(q.amount) : ''}</div></div></div>
    <div class="card">
      <div class="t-sub" style="margin-bottom:10px">${esc(q.provider || 'Supplier')}${a ? ' · ' + esc(a.name) : ''}</div>
      ${field('b_date','Date booked', q.bookedDate || todayISO(), 'date')}
      ${field('b_time','Time (optional)', q.bookedTime || '', 'text', 'e.g. 1:30 PM')}
      ${field('b_note','What they are doing', q.trade || '', 'text')}
      ${field('b_cost','Agreed price ($)', q.amount || '', 'number')}
      <div class="kk-note">Saving adds this to the asset's Job history as <b>booked</b> — it won't count as spend until you mark it done.
        ${to ? `A confirmation email to <b>${esc(to)}</b> will be drafted for you to approve before anything sends.`
             : `No email on file for this supplier, so nothing will be sent.`}</div>
      <div class="btn-row"><button class="btn primary" data-action="save-booking" data-id="${q.id}">Confirm booking</button></div>
    </div>`;
}
function editJob(assetId, logId) {
  const a = Store.asset(assetId); if (!a) return viewDashboard();
  const l = logId ? Store.state.logs.find(x => x.id === logId) : null;
  const opts = [{ v:'', l:'— not recorded —' }]
    .concat(Store.homeProviders().map(p => ({ v: p.id, l: p.name + (p.archived ? ' (past)' : '') })));
  return `<button class="back" data-action="back">‹ Cancel</button>
    <div class="hero"><div class="emoji">🧾</div><div><h1>${logId ? 'Edit job' : 'Log a past job'}</h1>
      <div class="t-sub">${esc(a.name)}</div></div></div>
    <div class="card">
      ${field('j_note','What was done', l ? l.note : '', 'text', 'e.g. Annual service & filter clean')}
      ${field('j_date','Date', l ? l.date : todayISO(), 'date')}
      ${field('j_cost','Cost ($)', l ? l.cost : '', 'number')}
      ${selectField('j_prov','Who did it', l ? (l.providerId || '') : (a.providerId || ''), opts)}
      ${field('j_ref','Reference (optional)', l ? l.ref : '', 'text', 'invoice / job number')}
      <div class="btn-row">
        <button class="btn primary" data-action="save-job" data-asset="${assetId}" data-id="${logId || ''}">Save job</button>
        ${logId ? `<button class="btn" data-action="del-job" data-id="${logId}" data-asset="${assetId}" style="color:var(--red)">Delete</button>` : ''}
      </div>
    </div>`;
}
function selectField(id, label, val, opts) {
  return `<label>${esc(label)}</label><select id="${id}">${opts.map(o =>
    `<option value="${esc(o.v)}" ${o.v===val?'selected':''}>${esc(o.l)}</option>`).join('')}</select>`;
}
function editAsset(id) {
  const snap = id === 'new' && SNAP.pending && SNAP.result ? SNAP.result : null;
  const a = id === 'new'
    ? (snap ? { name: snap.name || '', category: CATEGORIES[snap.category] ? snap.category : 'Appliance',
                make: snap.make || '', model: snap.model || '', serial: snap.serial || '' }
            : { category:'Water' })
    : Store.asset(id) || { category:'Water' };
  const cats = Object.keys(CATEGORIES).map(c => ({ v:c, l:`${CATEGORIES[c].icon} ${c}` }));
  const provs = [{v:'',l:'— none —'}].concat(Store.homeProviders()
    .map(p => ({ v:p.id, l:p.name + (p.archived ? ' (past)' : '') })));
  return `<button class="back" data-action="back">‹ Cancel</button><div class="hero"><div class="emoji">${(CATEGORIES[a.category]||{}).icon||'🔧'}</div><h1>${id==='new'?'New asset':'Edit asset'}</h1></div>
    <div class="card">
      ${field('f_name','Name',a.name)}
      ${selectField('f_cat','Category',a.category,cats)}
      ${field('f_loc','Location',a.location)}
      ${field('f_trade','Trade to call (optional)',a.trade,'text','e.g. stonemason — overrides the category default')}
      ${field('f_installed','Installed on',a.installedOn,'date')}
      ${field('f_warranty','Warranty until (optional)',a.warrantyUntil,'date')}
      ${selectField('f_prov','Service provider',a.providerId||'',provs)}
      ${field('f_make','Make (optional)',a.make,'text','e.g. Daikin')}
      ${field('f_model','Model (optional)',a.model,'text','e.g. FDYAN160')}
      ${field('f_purchase','Where to buy (optional)',a.purchaseUrl,'text','supplier product page URL')}
      ${field('f_serial','Serial no. (optional)',a.serial,'text','from the nameplate')}
      ${field('f_ha','Home Assistant entity (optional)',a.haEntity,'text','e.g. climate.aircon')}
      <div class="btn-row"><button class="btn primary" data-action="save-asset" data-id="${id}">Save asset</button></div>
    </div>`;
}
function editUsage(id) {
  const a = Store.asset(id); if (!a) return viewDashboard();
  const def = USAGE_DEFAULTS[a.category] || { mode:'runtime', threshold:250, unit:'hrs' };
  const u = a.usage || { entity: a.haEntity || '', mode: def.mode, threshold: def.threshold, unit: def.unit };
  return `<button class="back" data-action="back">‹ Cancel</button>
    <div class="hero"><div class="emoji">📊</div><div><h1>Track usage</h1><div class="t-sub">${esc(a.name)}</div></div></div>
    <div class="card">
      ${field('u_entity','Home Assistant entity', u.entity, 'text', 'e.g. climate.sauna')}
      <datalist id="u_entities"></datalist>
      <div class="kk-note" id="u_suggest" data-usage-picker="${id}"></div>
      ${selectField('u_mode','Signal', u.mode, [
        { v:'runtime', l:'Run-hours — on/off entity (switch, climate)' },
        { v:'energy',  l:'Energy kWh — total meter (Emporia circuit)' }])}
      ${field('u_thresh','Service every', u.threshold, 'number')}
      ${field('u_unit','Unit', u.unit, 'text', 'hrs or kWh')}
      <div class="btn-row"><button class="btn primary" data-action="save-usage" data-id="${id}">Save & start tracking</button></div>
    </div>
    <p class="hint">Run-hours reads how long the entity has been on since the last service (Home Assistant history). Energy snapshots a total-increasing kWh meter now and counts up from there — best for pumps on an Emporia circuit. Marking the asset serviced resets the counter.</p>`;
}
// Track-usage entity picker — nobody should have to TYPE an entity id. Fills the
// datalist from the same registry scan the HA import uses (server-cached), and
// offers a best-guess match for this asset as a one-tap suggestion. Degrades to
// the plain text field when HA is unreachable.
async function hydrateUsagePicker() {
  const slot = document.querySelector('[data-usage-picker]'); if (!slot) return;
  const assetId = slot.getAttribute('data-usage-picker');
  const d = await HA.devices();
  if (document.querySelector('[data-usage-picker]') !== slot) return;   // navigated away meanwhile
  if (!d.available || !d.devices.length) return;                        // quiet — free text still works
  const input = document.getElementById('u_entity');
  const list = document.getElementById('u_entities');
  if (input) input.setAttribute('list', 'u_entities');
  if (list) list.innerHTML = d.devices.flatMap(dev => (dev.entities || []).map(e =>
    `<option value="${esc(e.id)}" label="${esc([dev.name, e.device_class || e.domain, e.unit].filter(Boolean).join(' · '))}"></option>`)).join('');
  // Best guess for THIS asset: token overlap between asset name/make and device name/manufacturer.
  const a = Store.asset(assetId); if (!a) return;
  const toks = s => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(x => x.length > 2);
  const at = new Set([...toks(a.name), ...toks(a.make), ...toks(a.model)]);
  let best = null, bestN = 0;
  d.devices.forEach(dev => {
    const n = [...new Set([...toks(dev.name), ...toks(dev.manufacturer), ...toks(dev.model)])].filter(t => at.has(t)).length;
    if (n > bestN) { bestN = n; best = dev; }
  });
  if (!best || !bestN) return;
  const su = best.suggestedUsage || null;
  const ent = (su && su.entity) || (best.entities && best.entities[0] && best.entities[0].id);
  if (!ent) return;
  slot.innerHTML = `Looks like <b>${esc(best.name)}</b> in Home Assistant — <b data-action="use-suggested-entity" data-entity="${esc(ent)}" data-mode="${esc((su && su.mode) || '')}" data-unit="${esc((su && su.unit) || '')}" style="color:var(--accent);cursor:pointer">use ${esc(ent)} →</b>`;
}
function editTask(assetId, taskId) {
  const t = taskId ? Store.state.tasks.find(x=>x.id===taskId) : { cadenceDays:365, estCost:0 };
  if (!t) return viewAsset(assetId);   // deleted from under us (another device) — fall back, don't freeze
  return `<button class="back" data-action="back">‹ Cancel</button><div class="hero"><div class="emoji">🔧</div><h1>${taskId?'Edit task':'New task'}</h1></div>
    <div class="card">
      ${field('f_title','Task',t.title)}
      ${field('f_cad','Every (days)',t.cadenceDays,'number')}
      ${field('f_last','Last done',t.lastDone,'date')}
      ${field('f_cost','Est. cost ($)',t.estCost,'number')}
      ${field('f_note','Note (optional)',t.note,'text','e.g. replace the filter at the next service')}
      ${selectField('f_prov_t','Who does this job', t.providerId || '',
        [{v:'',l:"— the asset's provider —"}].concat(Store.homeProviders().map(p => ({ v: p.id, l: p.name }))))}
      <label style="display:flex;gap:10px;align-items:flex-start;margin-top:12px;cursor:pointer">
        <input type="checkbox" id="f_auto" style="width:auto;margin-top:3px" ${t.autoBook ? 'checked' : ''}>
        <span><b>🤖 Auto-book this service</b><br>
        <span class="t-sub" style="white-space:normal">When it comes due, KasaKeeper emails the linked provider from its own mailbox asking for a quote and dates, then pings you to confirm one. Needs a provider with an email on the asset. Nothing is booked without your confirmation.</span></span>
      </label>
      <label style="display:flex;gap:10px;align-items:flex-start;margin-top:12px;cursor:pointer">
        <input type="checkbox" id="f_autopilot" style="width:auto;margin-top:3px" ${t.autopilot ? 'checked' : ''}>
        <span><b>⟳ On autopilot</b><br>
        <span class="t-sub" style="white-space:normal">A standing arrangement that just happens (a weekly cleaner, a lawn contract). It stays on the schedule with its next date, but never nags you as overdue.</span></span>
      </label>
      <label style="display:flex;gap:10px;align-items:flex-start;margin-top:12px;cursor:pointer">
        <input type="checkbox" id="f_diy" style="width:auto;margin-top:3px" ${t.diy ? 'checked' : ''}>
        <span><b>🛠 DIY — I do this myself</b><br>
        <span class="t-sub" style="white-space:normal">No tradie needed. The job stays on the schedule and still comes due as normal, but KasaKeeper stops suggesting suppliers for it and will never auto-email anyone about it (turns auto-book off).</span></span>
      </label>
      <div class="btn-row"><button class="btn primary" data-action="save-task" data-asset="${assetId}" data-id="${taskId||''}">Save task</button>
      ${taskId?`<button class="btn small" data-action="${t.snoozed?'unsnooze-task-back':'snooze-task-back'}" data-id="${taskId}" data-asset="${assetId}">${t.snoozed?'↩︎ Restore':'💤 Snooze'}</button>
      <button class="btn small" data-action="del-task" data-id="${taskId}" data-asset="${assetId}" style="color:var(--red)">Delete</button>`:''}</div>
    </div>`;
}
function editProvider(id) {
  const p = id === 'new' ? {} : Store.provider(id) || {};
  return `<button class="back" data-action="back">‹ Cancel</button><div class="hero"><div class="emoji">👷</div><h1>${id==='new'?'New provider':'Edit provider'}</h1></div>
    <div class="card">
      ${field('f_pname','Name',p.name)}
      ${field('f_trade','Trade',p.trade,'text','e.g. Electrician')}
      ${field('f_contact','Contact',p.contact,'text','Contact person')}
      ${field('f_phone','Phone',p.phone)}
      ${field('f_email','Email',p.email,'email')}
      ${field('f_website','Website',p.website,'text','e.g. business.com.au')}
      <label>Notes</label><textarea id="f_notes">${esc(p.notes||'')}</textarea>
      <div class="btn-row"><button class="btn primary" data-action="save-provider" data-id="${id}">Save</button>
        ${id === 'new' ? '' : `<button class="btn" data-action="del-provider" data-id="${id}" style="color:var(--red)">Delete</button>`}</div>
    </div>`;
}

/* ---------- Create-a-Home wizard ---------- */
let SETUP = { step: 1, address: '', msg: '', detected: null, selected: new Set(), testMode: false, selectedImage: null };
const existsCat = cat => Store.homeAssets().some(a => a.category === cat);
const existsLabel = l => Store.homeAssets().some(a => a.name.toLowerCase() === l.toLowerCase());

function runResearch(addr) {
  SETUP.address = addr || 'Your home'; SETUP.step = 2; SETUP.msg = 'Starting…'; render();
  Research.run(SETUP.address, m => { SETUP.msg = m; const el = document.querySelector('.wz-live'); if (el) el.textContent = '◍ ' + m; })
    .then(d => {
      SETUP.detected = d;
      SETUP.selected = new Set(d.features.map(f => f.key));   // detected = inferred → all pre-selected
      SETUP.extras = buildExtras(d.features);                 // everything else in the catalog → off until turned on
      SETUP.step = 3;   // detected suburb is written onto the HOME at create-home, never global settings
      render();
    });
}
// Remaining catalog services the research did NOT detect — offered below the detected ones.
function buildExtras(detected) {
  const norm = x => (x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const det = detected.map(f => ({ cat: f.category, n: norm(f.label) }));
  const seen = new Set(), out = [];
  (typeof SERVICES !== 'undefined' ? SERVICES : []).forEach(sv => {
    const n = norm(sv.name), key = 'svc_' + norm(sv.cat) + '_' + n;
    if (seen.has(key)) return;
    const dup = det.some(dd => dd.cat === sv.cat && (dd.n === n || dd.n.includes(n) || n.includes(dd.n)));
    if (dup) return;
    seen.add(key);
    out.push({ key, label: sv.name, category: sv.cat });
  });
  return out;
}
// Best-effort category for a free-form "Quick add" line — keyword match against the
// catalog's own service names first (specific), then the category names themselves,
// then a short list of everyday synonyms the catalog doesn't spell out (e.g. "aircon").
// No make/model parsing here — research fills the real detail in later.
const QUICK_SYNONYMS = { aircon: 'HVAC', ac: 'HVAC', heater: 'Heating', fridge: 'Appliance',
  freezer: 'Appliance', oven: 'Appliance', dishwasher: 'Appliance', washer: 'Appliance',
  dryer: 'Appliance', printer: 'Appliance', microwave: 'Appliance', wall: 'Roof/Exterior',
  fence: 'Roof/Exterior', deck: 'Roof/Exterior', roof: 'Roof/Exterior', gutter: 'Roof/Exterior',
  car: 'Vehicle', pool: 'Pool/Spa', spa: 'Pool/Spa', solar: 'Energy', battery: 'Energy',
  alarm: 'Safety', camera: 'Camera', light: 'Lighting', pump: 'Pump', garden: 'Garden', lawn: 'Garden' };
function guessCategory(text) {
  const n = (text || '').toLowerCase();
  // curated short words first (unambiguous, but too short to trust a catalog
  // substring match against — "wall" alone would otherwise hit "Hanging / wall
  // gardens" and mis-file a retaining wall under Garden)
  for (const k in QUICK_SYNONYMS) { if (n.includes(k)) return QUICK_SYNONYMS[k]; }
  const svcList = typeof SERVICES !== 'undefined' ? SERVICES : [];
  for (const sv of svcList) {
    const words = sv.name.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 4);
    if (words.some(w => n.includes(w))) return sv.cat;
  }
  for (const c of Object.keys(CATEGORIES)) { if (n.includes(c.toLowerCase().split('/')[0])) return c; }
  return 'Appliance';
}
function viewSetup() {
  const s = SETUP;
  if (s.step === 2) {
    return `<div class="hero"><div class="emoji">🔎</div><h1>Researching your home…</h1></div>
      <p class="t-sub" style="margin-left:2px">${esc(s.address)}</p>
      <div class="card"><div class="wz-live spinner">◍ ${esc(s.msg)}</div>
      <div class="t-sub" style="margin-top:8px">Reading listings, inspecting photos, and cross-referencing Home Assistant.</div></div>`;
  }
  if (s.step === 3 && s.detected) {
    const d = s.detected;
    const featChip = f => {
      const on = s.selected.has(f.key), tracked = existsLabel(f.label) || existsCat(f.category);
      const m = Catalog.match(f.category, f.label);
      const varSel = (m && m.s.variants)
        ? `<select id="var_${f.key}" class="feat-var">${m.s.variants.map(v => `<option value="${esc(v.name)}">${esc(v.name)}</option>`).join('')}</select>`
        : '';
      return `<div class="feat ${on ? 'on' : ''}" data-action="toggle-feat" data-key="${f.key}">
        <div class="emoji">${Store.icon(f.category)}</div>
        <div class="grow"><div class="t-name">${esc(f.label)}</div><div class="t-sub">${esc(f.source || f.category)}${tracked ? ' · already tracked' : ''}</div>${varSel}</div>
        <div class="feat-check">${on ? '✓' : '+'}</div></div>`;
    };
    const extras = s.extras || [];
    const onCount = d.features.filter(f => s.selected.has(f.key)).length;
    const extraOn = extras.filter(f => s.selected.has(f.key)).length;
    return `<button class="back" data-action="back">‹ Back</button>
      <div class="hero"><div class="emoji">🏠</div><div><h1>${esc(d.address)}</h1>
      <div class="t-sub">${[d.levels && d.levels + ' level' + (d.levels > 1 ? 's' : ''), d.beds && d.beds + ' bed', d.baths && d.baths + ' bath'].filter(Boolean).join(' · ')}</div></div></div>
      <div class="banner ok">Detected ${d.features.length} things to maintain — from listings, photos & your Home Assistant. These are switched on; add anything else below, then create your home.</div>
      <div class="section-title">Detected — included <span class="pill">${onCount}/${d.features.length}</span></div>
      ${d.features.map(featChip).join('')}
      ${extras.length ? `<div class="section-title">Add more services <span class="pill">${extraOn} on</span></div>
        <div class="t-sub" style="margin:0 2px 10px;color:var(--faint)">Not detected at your place — tap any you also want KasaKeeper to track.</div>
        ${extras.map(featChip).join('')}` : ''}
      <div class="section-title">Quick add <span class="pill">optional</span></div>
      <div class="t-sub" style="margin:0 2px 10px;color:var(--faint)">Anything else · one per line. KasaKeeper will research each one.</div>
      <div class="card"><textarea id="wz_quick" placeholder="Fujitsu ducted aircon\nBambu Lab X1C 3D printer\nLimestone retaining wall"></textarea></div>
      <div class="section-title">Home photo <span class="pill">optional</span></div>
      <div class="t-sub" style="margin:0 2px 10px;color:var(--faint)">Pick an image to represent this home — street view or aerial.</div>
      <div class="imagery-strip" data-imagery="setup" data-address="${esc(d.address)}"></div>
      <div class="btn-row"><button class="btn primary wide" data-action="create-home">Create home →</button></div>`;
  }
  return `<button class="back" data-action="back">‹ Cancel</button>
    <div class="su-hero">
      <div class="eye-scene" data-eye-scene></div>
      <div class="su-word">KasaKeeper</div>
      <div class="su-tag">The maintenance brain for your house</div>
    </div>
    <div class="card su-addr-card">
      <label>Address</label>
      <div class="su-addr-wrap">
        <input id="wz_addr" value="${esc(s.address)}" placeholder="e.g. 1 Beach Rd, Bondi NSW" autocomplete="off">
        <div class="su-suggest" id="wz_suggest" hidden></div>
      </div>
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-top:10px">
        <input type="checkbox" id="wz_test" ${s.testMode ? 'checked' : ''} style="width:auto">
        Test home — skip Home Assistant (a friend's house, a demo)
      </label>
      <div class="btn-row">
        <button class="btn primary" data-action="research-home">🔎 Research my home</button>
        <button class="btn" data-action="use-location">📍 Use my location</button>
      </div>
    </div>

    <div class="section-title">How it works</div>
    <div class="su-steps">
      <div class="card">
        <div class="su-step-head"><span class="su-num">01</span><svg class="su-ic"><use href="#i-doc"/></svg></div>
        <div class="su-step-t">Research</div>
        <div class="su-step-d">We read listings, photos and aerial imagery for pools, solar, aircon.</div>
      </div>
      <div class="card">
        <div class="su-step-head"><span class="su-num">02</span><svg class="su-ic"><use href="#i-check"/></svg></div>
        <div class="su-step-t">You confirm</div>
        <div class="su-step-d">Tick what's real, the schedules build themselves.</div>
      </div>
      <div class="card">
        <div class="su-step-head"><span class="su-num">03</span><svg class="su-ic"><use href="#i-home"/></svg></div>
        <div class="su-step-t">It keeps watch</div>
        <div class="su-step-d">Due dates, real usage from Home Assistant, weather nudges, quotes by email.</div>
      </div>
    </div>

    <div class="section-title">What it actually does</div>
    <div class="su-feats">
      <div class="card"><div class="row"><div class="emoji">📷</div>
        <div class="grow"><div class="t-name">Snap a nameplate</div>
        <div class="t-sub">The exact model's schedule and manual, found for you.</div></div></div></div>
      <div class="card"><div class="row"><div class="emoji">⚡</div>
        <div class="grow"><div class="t-name">Live telemetry</div>
        <div class="t-sub">From Home Assistant · service by real run-hours, not just a calendar.</div></div></div></div>
      <div class="card"><div class="row"><div class="emoji">✉️</div>
        <div class="grow"><div class="t-name">Quotes, handled</div>
        <div class="t-sub">Requested and read for you · every send approved by you.</div></div></div></div>
      <div class="card"><div class="row"><div class="emoji">🧠</div>
        <div class="grow"><div class="t-name">Ask anything</div>
        <div class="t-sub">About your own house · it answers from your real data.</div></div></div></div>
    </div>

    <div class="su-trust">🔒 Self-hosted · your data never leaves your Home Assistant box</div>`;
}

/* ---------- Find a service ---------- */
function runFind(id) {
  const a = Store.asset(id); if (!a) return;
  const s = Store.state.settings, home = Store.home();
  const trade = searchQueryFor(a);
  // Search near the ASSET's home, not whichever home happens to be current —
  // a deep link to another home's asset must not inherit this home's suburb.
  const ah = Store.state.homes.find(x => x.id === a.homeId) || home;
  const suburb = (ah && ah.suburb) || homeSuburb();
  const address = (ah && ah.address) || suburb;
  FIND = { assetId: id, loading: true, providers: null, query: trade, debug: null, msg: 'Searching local providers…' };
  DBG.log('find-service', { asset: a.name, query: trade, suburb, address });
  Research.findServices(trade, suburb, address, m => {
    if (FIND.assetId !== id) return;
    FIND.msg = m;
    const el = document.getElementById('find-msg');       // update just the text so the eye keeps scanning
    if (el) el.textContent = m; else render();
  }).then(res => { if (FIND.assetId === id) {
    FIND.loading = false;
    FIND.providers = (res && res.providers) || [];
    FIND.debug = (res && res.debug) || null;              // the query that ACTUALLY ran, per the server
    DBG.log('find-results', { asset: a.name, found: FIND.providers.length, ...(FIND.debug || {}) });
    render();
  } });
}
// Compact "searching" eye — the brand mark scanning for services (CSS-animated).
function searchingEye() {
  return `<div class="kk-search" aria-hidden="true"><svg viewBox="0 0 48 48">
    <path d="M8 25 L24 11 L40 25" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></path>
    <path d="M12.5 28 Q24 38.5 35.5 28" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"></path>
    <circle class="kks-iris" cx="24" cy="24" r="4.6" fill="var(--accent)"></circle>
  </svg></div>`;
}
function providerCard(a, p, i) {
  const rate = p.rating != null ? `${stars(p.rating)} ${p.rating}${p.reviews ? ` · ${p.reviews} reviews` : ''}` : (p.reviews ? `${p.reviews} reviews` : '');
  const loc = p.suburb ? ` · ${esc(p.suburb)}` : '';
  const tel = p.phone ? p.phone.replace(/\s/g, '') : '';
  const img = p.photo || p.logo;
  const avatar = img
    ? `<div class="prov-avatar"><img src="${esc(img)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="emoji prov-fallback" style="display:none">👷</div></div>`
    : `<div class="emoji">👷</div>`;
  const services = (p.services && p.services.length)
    ? `<div class="svc-chips">${p.services.slice(0, 4).map(s => `<span class="svc-chip">${esc(s)}</span>`).join('')}</div>` : '';
  return `<div class="card">
    <div class="row">${avatar}<div class="grow">
      <div class="t-name">${esc(p.name)}</div>
      <div class="t-sub rate">${rate}${loc}</div>
      ${p.blurb ? `<div class="t-sub">“${esc(p.blurb)}”</div>` : ''}
      ${p.website ? `<div class="t-sub"><a href="https://${esc(p.website)}" target="_blank" class="prov-web">${esc(p.website)}</a></div>` : ''}
    </div></div>
    ${services}
    <div class="btn-row">
      <button class="btn small primary" data-action="quote-provider" data-id="${a.id}" data-i="${i}">✉︎ Request quote</button>
      ${p.email ? `<button class="btn small" data-action="email-provider" data-id="${a.id}" data-i="${i}">✉︎ Email</button>` : ''}
      ${tel ? `<a class="btn small" data-ext href="tel:${esc(tel)}">📞 Call</a>` : ''}
      <button class="btn small" data-action="save-found" data-id="${a.id}" data-i="${i}">＋ Save</button>
      ${p.website ? `<a class="btn small" data-ext href="${esc(webUrl(p.website))}" target="_blank" rel="noopener">Website</a>` : ''}
    </div></div>`;
}
function viewFind(id) {
  const a = Store.asset(id); if (!a) return viewDashboard();
  const s = Store.state.settings;
  const findSuburb = ((Store.state.homes.find(x => x.id === a.homeId) || {}).suburb) || homeSuburb();   // the ASSET's home
  if (!FIND || FIND.assetId !== id) setTimeout(() => runFind(id), 0);  // kick off (also handles direct nav)
  const header = `<button class="back" data-action="back">‹ Back</button>
    <div class="hero">${assetTile(a, 'emoji')}<div><h1>Find a service</h1><div class="t-sub">${esc(a.name)}${findSuburb ? ' · ' + esc(findSuburb) : ''}</div></div></div>`;
  // Always show the query that runs — the user can only tell us it's wrong if they can see it.
  const queryLine = q => `<div class="kk-note" style="margin:6px 0 10px">Searching for <b style="color:var(--text)">“${esc(q)}”</b>${findSuburb ? ` near ${esc(findSuburb)}` : ''} · <b data-action="edit-asset" data-id="${a.id}" style="color:var(--accent);cursor:pointer">wrong? edit the asset →</b></div>`;
  if (!FIND || FIND.assetId !== id || FIND.loading) {
    return header + queryLine((FIND && FIND.query) || searchQueryFor(a)) + searchingEye() +
      `<div class="banner ok" id="find-msg">${esc((FIND && FIND.msg) || 'Searching local providers…')}</div>`;
  }
  const provs = FIND.providers || [];
  const ranQuery = (FIND.debug && FIND.debug.query) || FIND.query || searchQueryFor(a);
  let body;
  if (provs.length) {
    body = `<div class="section-title">Top rated near you <span class="pill">${provs.length}</span></div>
      ${queryLine(ranQuery)}
      ${provs.map((p, i) => providerCard(a, p, i)).join('')}
      <div class="btn-row"><button class="btn small" data-action="refind" data-id="${a.id}">↻ Search again</button>
        <button class="btn small" data-action="google" data-id="${a.id}">🔎 More on Google</button></div>`;
  } else {
    const sugg = Research.suggestProviders(a.category);
    body = `${queryLine(ranQuery)}<div class="banner">Couldn't fetch live listings right now — here are known locals${sugg.length ? '' : ' (try Google)'}.</div>
      ${sugg.map((p, i) => `<div class="card"><div class="row"><div class="emoji">👷</div>
        <div class="grow"><div class="t-name">${esc(p.name)}</div><div class="t-sub">${esc(p.blurb || '')}</div></div></div>
        <div class="btn-row"><button class="btn small primary" data-action="add-suggested" data-id="${a.id}" data-i="${i}">＋ Add & link</button>
          ${p.url ? `<a class="btn small" href="https://${esc(p.url)}" target="_blank">Website</a>` : ''}</div></div>`).join('')}
      <div class="btn-row"><button class="btn small" data-action="refind" data-id="${a.id}">↻ Try live search again</button>
        <button class="btn small" data-action="google" data-id="${a.id}">🔎 Search Google</button></div>`;
  }
  return header + body;
}

/* ---------- Add a service (catalog) ---------- */
function viewCatalog(i) {
  const cats = Catalog.cats();
  if (i === undefined || i === '') {
    return `<button class="back" data-action="back">‹ Back</button>
      <div class="hero"><div class="emoji">＋</div><h1>Add a service</h1></div>
      <div class="setup-cta" data-action="snap"><b>📷 Snap it</b><div>Point the camera at the appliance or its nameplate — make, model and serial fill themselves in.</div></div>
      <div class="setup-cta" data-action="inspect-import"><b>📄 Import inspection report</b><div>Upload a building or pest inspection PDF — Claude reads the defects and proposes tasks.</div></div>
      <div class="banner ok">Or pick anything to track — you'll choose the specific type (e.g. gas vs electric) next where it matters.</div>
      ${cats.map((c, idx) => { const n = Catalog.inCat(c).length;
        return `<div class="card" data-action="cat-open" data-i="${idx}"><div class="row">
          <div class="emoji">${Store.icon(c)}</div>
          <div class="grow"><div class="t-name">${esc(c)}</div><div class="t-sub">${n} service${n !== 1 ? 's' : ''}</div></div>
          <span class="chip">›</span></div></div>`; }).join('')}
      <div class="card" data-action="new-asset"><div class="row"><div class="emoji">✎</div>
        <div class="grow"><div class="t-name">Something else</div><div class="t-sub">add a custom item by hand</div></div><span class="chip">›</span></div></div>`;
  }
  const cat = cats[+i]; if (!cat) return viewCatalog();
  return `<button class="back" data-action="back">‹ Services</button>
    <div class="hero"><div class="emoji">${Store.icon(cat)}</div><h1>${esc(cat)}</h1></div>
    ${Catalog.inCat(cat).map(({ idx, s }) => `<div class="card">
      <div class="row"><div class="emoji">${Store.icon(cat)}</div>
        <div class="grow"><div class="t-name">${esc(s.name)}</div>${s.variants ? `<div class="t-sub">choose the type →</div>` : ''}</div>
        ${s.variants ? '' : `<button class="btn small primary" data-action="add-svc" data-svc="${idx}">＋ Add</button>`}</div>
      ${s.variants ? `<div class="btn-row">${s.variants.map(v => `<button class="btn small" data-action="add-svc" data-svc="${idx}" data-var="${esc(v.name)}">＋ ${esc(v.name)}</button>`).join('')}</div>` : ''}
    </div>`).join('')}`;
}

/* ---------- render + live HA ---------- */
function render() {
  const r = route();
  if (!Store.state.currentHomeId && r[0] !== 'setup') { location.hash = '#/setup'; return; }
  let html;
  if (r[0] === 'assets') html = viewAssets(r[1]);
  else if (r[0] === 'chat') html = viewChat();
  else if (r[0] === 'asset') html = viewAsset(r[1]);
  else if (r[0] === 'providers') html = viewProviders();
  else if (r[0] === 'settings') html = viewSettings();
  else if (r[0] === 'edit-asset') html = editAsset(r[1]);
  else if (r[0] === 'edit-task') html = editTask(r[1], r[2]);
  else if (r[0] === 'edit-usage') html = editUsage(r[1]);
  else if (r[0] === 'edit-job') html = editJob(r[1], r[2]);
  else if (r[0] === 'book') html = bookQuote(r[1]);
  else if (r[0] === 'provider') html = viewProvider(r[1]);
  else if (r[0] === 'edit-provider') html = editProvider(r[1]);
  else if (r[0] === 'schedule') html = viewSchedule();
  else if (r[0] === 'setup') html = viewSetup();
  else if (r[0] === 'catalog') html = viewCatalog(r[1]);
  else if (r[0] === 'snap') html = viewSnap();
  else if (r[0] === 'inspect') html = viewInspect();
  else if (r[0] === 'gmail-import') html = viewGmailImport();
  else if (r[0] === 'ha-import') html = viewHaImport();
  else if (r[0] === 'triage') html = viewTriage();
  else if (r[0] === 'find') html = viewFind(r[1]);
  else html = viewDashboard();
  $app.innerHTML = html;
  window.scrollTo(0, 0);
  hydrateHA();
  hydrateUsage();
  hydrateNudges();
  hydrateGmail();
  hydrateSweep();
  hydrateHaStrip();
  hydrateHaBanner();
  hydrateHaDrift();
  hydrateImagery();
  hydrateUsagePicker();
  updateEye(); // the mark reflects live status: watch / glance-at-badge / sleep
  if (typeof EyeScene !== 'undefined') EyeScene.mountAll(); // brand motion where a [data-eye-scene] host exists
}
/* ---------- home imagery picker (test-home photo) ---------- */
// key is 'setup' (the setup review step, home not created yet) or a home id (Settings).
// IMG_OPEN tracks which strips are expanded; IMAGERY caches each key's fetched list —
// the setup strip is always expanded (open at seed), Settings rows open on tap.
let IMG_OPEN = new Set(['setup']);
let IMAGERY = {};
function renderImageryHost(key) {
  const host = document.querySelector(`[data-imagery="${key}"]`);
  if (!host) return;
  if (!IMG_OPEN.has(key)) { host.innerHTML = ''; return; }
  const list = IMAGERY[key];
  if (!list) { host.innerHTML = `<div class="t-sub">Loading imagery…</div>`; return; }
  host.innerHTML = list.length
    ? `<div class="imagery-grid">${list.map((im, i) => `<img class="img-thumb" src="${esc(im.url)}" alt="${esc(im.kind || '')}" data-action="pick-image" data-key="${esc(key)}" data-i="${i}">`).join('')}</div>`
    : `<div class="t-sub">No imagery found for this address.</div>`;
}
function hydrateImagery() {
  document.querySelectorAll('[data-imagery]').forEach(host => {
    const key = host.getAttribute('data-imagery');
    renderImageryHost(key);
    if (!IMG_OPEN.has(key) || IMAGERY[key]) return;   // closed, or already fetched — nothing to do
    const addr = host.getAttribute('data-address') || '';
    fetch('api/home-imagery?address=' + encodeURIComponent(addr)).then(r => r.json())
      .then(j => { IMAGERY[key] = (j && j.images) || []; renderImageryHost(key); })
      .catch(() => { IMAGERY[key] = []; renderImageryHost(key); });
  });
}
async function hydrateHA() {
  if (Store.isTestHome()) return;   // a test home has no live HA behind it — skip the fetch entirely
  const nodes = document.querySelectorAll('[data-ha]');
  if (!nodes.length) return;
  if (!HA.ready()) { nodes.forEach(n => n.textContent = '● HA not configured'); return; }
  for (const n of nodes) {
    const s = await HA.entity(n.getAttribute('data-ha'));
    n.textContent = s ? '● live: ' + HA.fmt(s) : '● unavailable';
  }
}
// Live strip on an ha-linked asset page: 2–4 headline readings, hydrated async
// like hydrateUsage — never blocks render, degrades to hidden when unreachable.
let HASTRIP = { t: 0, map: {} };
async function hydrateHaStrip() {
  const el = document.querySelector('[data-ha-strip]'); if (!el) return;
  const a = Store.asset(el.getAttribute('data-ha-strip'));
  if (!a || !a.ha || !HA.ready()) { el.style.display = 'none'; return; }
  const live = (a.ha.entities && a.ha.entities.live) || [];
  if (!live.length) { el.style.display = 'none'; return; }
  if (Date.now() - HASTRIP.t < 30e3 && HASTRIP.map[a.id]) {
    const v = el.querySelector('.hs-vals'); if (v) v.innerHTML = HASTRIP.map[a.id];
    return;
  }
  const parts = [];
  for (const ent of live) { const s = await HA.entity(ent.id); if (s) parts.push(`<span class="hs-v">${esc(HA.fmt(s))}</span>`); }
  if (!parts.length) { el.style.display = 'none'; return; }
  const html = parts.join('<span class="hs-sep">·</span>');
  HASTRIP.map[a.id] = html; HASTRIP.t = Date.now();
  const v = el.querySelector('.hs-vals'); if (v) v.innerHTML = html;
}
// Assets-screen banner: a lightweight probe (server-cached — cheap to re-check)
// counting relevant HA devices with no matched asset yet.
let HABANNER = { t: 0, count: 0 };
async function hydrateHaBanner() {
  const host = document.querySelector('[data-ha-banner]'); if (!host || !HA.proxy) return;
  if (Date.now() - HABANNER.t > 5 * 60e3) {
    try { const result = await HA.devices(); const groups = bucketHaDevices(result.devices);
      HABANNER = { t: Date.now(), count: groups.new.length + groups.update.length }; }
    catch { HABANNER = { t: Date.now(), count: 0 }; }
  }
  host.innerHTML = HABANNER.count
    ? `<div class="banner ok" data-action="ha-import-scan">🏠 Home Assistant sees ${HABANNER.count} device${HABANNER.count !== 1 ? 's' : ''} you haven't imported. <b style="color:var(--accent)">Review →</b></div>` : '';
}
// Settings HA card: a quiet drift line (Feature 4, the correction loop) — the
// registry moved since the last import/apply. Cached client-side 5min, same
// cadence as the Assets banner above (the server's own registry read is cached
// 300s regardless of which client asks). Opens the same import screen, pre-filtered.
let HADRIFT = { t: 0, data: null };
async function hydrateHaDrift() {
  const host = document.querySelector('[data-ha-drift]'); if (!host || !HA.proxy) return;
  if (Date.now() - HADRIFT.t > 5 * 60e3) {
    try { HADRIFT = { t: Date.now(), data: await HA.drift() }; }
    catch { HADRIFT = { t: Date.now(), data: null }; }
  }
  const d = HADRIFT.data;
  const nCorr = d ? d.drift.length + d.vanished.length : 0, nNew = d ? d.newDevices.length : 0;
  if (!d || !d.available || (!nCorr && !nNew)) { host.innerHTML = ''; return; }
  const bits = [];
  if (nCorr) bits.push(`${nCorr} correction${nCorr !== 1 ? 's' : ''}`);
  if (nNew) bits.push(`${nNew} new device${nNew !== 1 ? 's' : ''}`);
  host.innerHTML = `<div class="banner ok" data-action="ha-import-scan">Registry drift: ${bits.join(' · ')} — review <b style="color:var(--accent)">→</b></div>`;
}
/* ---------- seasonal / weather nudges (the eye glances at what needs you) ---------- */
let NUDGES = { t: 0, list: null, weather: null };
async function computeNudges() {
  if (NUDGES.list && Date.now() - NUDGES.t < 30 * 60e3) return NUDGES.list;
  let w = null;
  try { const r = await fetch('api/ha/weather'); if (r.ok) w = await r.json(); } catch (e) {}
  NUDGES.weather = w && w.state ? w : null;
  if (!w || !Array.isArray(w.forecast) || !w.forecast.length) return [];
  const tasks = Store.homeTasks();
  const find = kw => { const t = tasks.find(x => kw.test(x.title)); return t || null; };
  const dayName = iso => { const d = new Date(iso); const today = new Date();
    return d.toDateString() === today.toDateString() ? 'today' : d.toLocaleDateString(undefined, { weekday: 'long' }); };
  const days = w.forecast.slice(0, 3), list = [];
  const push = (msg, t) => list.push({ msg, assetId: t && t.assetId });
  const windy = days.find(d => (d.wind_speed || 0) >= 38);
  const rainy = days.find(d => /rain|pour|lightning/i.test(d.condition || ''));
  const hot = days.find(d => (d.temperature ?? 0) >= 32);
  const cold = days.find(d => (d.temperature ?? 99) <= 9);
  if (windy) { const t = find(/gutter|tree|branch|festoon/i);
    push(`Wind to ${Math.round(windy.wind_speed)} km/h ${dayName(windy.datetime)} · ${t ? `good time for “${t.title}”` : 'secure loose outdoor items'}`, t); }
  if (rainy && !windy) { const t = find(/gutter|drain/i); if (t) push(`Rain ${dayName(rainy.datetime)} · “${t.title}” first`, t); }
  if (hot) { const t = find(/pool|chemistr|aircon|filter/i); if (t) push(`${Math.round(hot.temperature)}° ${dayName(hot.datetime)} · “${t.title}” before the heat`, t); }
  if (cold) { const t = find(/heat|fireplace|flue/i); if (t) push(`Cold snap ${dayName(cold.datetime)} (${Math.round(cold.temperature)}°) · “${t.title}”`, t); }
  if (list.length < 2) { // one gentle season suggestion (AU seasons), only if a matching task exists
    const m = new Date().getMonth() + 1;
    const s = (m >= 3 && m <= 5) ? { kw: /gutter|heat/i, msg: 'Autumn · gutters and heating before winter' }
      : (m >= 9 && m <= 11) ? { kw: /aircon|filter/i, msg: 'Spring · service the aircon before summer' }
      : (m === 12 || m <= 2) ? { kw: /pool/i, msg: 'Summer · stay on top of pool chemistry' }
      : { kw: /heat|hot-water|hot water/i, msg: 'Winter · heating and hot water run hardest now' };
    const t = find(s.kw); if (t && !list.some(n => n.assetId === t.assetId)) push(s.msg, t);
  }
  NUDGES = { t: Date.now(), list: list.slice(0, 2), weather: NUDGES.weather };
  return NUDGES.list;
}
async function hydrateNudges() {
  if (Store.isTestHome()) return;   // no weather/HA nudges — and skips the digest push below, too
  const host = document.querySelector('[data-nudges]');
  const nudges = await computeNudges();          // also runs for the digest even w/o a host
  postDigest(nudges);
  const wx = document.querySelector('[data-weather]');
  if (wx) { const w = NUDGES.weather;
    wx.textContent = w ? `${WX_ICON[w.state] || '☁️'} ${w.temperature != null ? Math.round(w.temperature) + '°' : ''} · ${w.state.replace(/-/g, ' ')}` : '';
    wx.style.display = w ? '' : 'none'; }
  if (!host || !nudges.length) return;
  host.innerHTML = `<div class="section-title">Keeping watch</div>` + nudges.map(n => `
    <div class="card nudge" ${n.assetId ? `data-action="open-asset" data-id="${n.assetId}"` : ''}>
      <div class="row"><svg class="kk-glance-ic"><use href="#kk-glance"/></svg>
      <div class="grow"><div class="t-sub" style="color:var(--text)">${esc(n.msg)}</div></div>${n.assetId ? '<span class="chip">›</span>' : ''}</div>
    </div>`).join('');
}
// keep the backend's daily-push digest fresh (debounced; fire-and-forget)
let DIGEST_TIMER;
function postDigest(nudges) {
  clearTimeout(DIGEST_TIMER);
  DIGEST_TIMER = setTimeout(() => {
    const tasks = Store.homeTasks(); const next = Store.nextTask();
    fetch('api/digest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      home: (Store.home() || {}).address || '',
      overdue: tasks.filter(t => Store.status(t) === 'overdue').map(t => t.title),
      soon: tasks.filter(t => Store.status(t) === 'soon').map(t => t.title),
      next: next ? `${next.title} ${Store.dueLabel(next)}` : null,
      nudges: (nudges || []).map(n => n.msg),
      pushDaily: Store.state.settings.pushDaily !== false,
    }) }).catch(() => {});
  }, 2500);
}

// Usage statuses come from HA asynchronously, but the dashboard renders synchronously —
// so they're cached here and the dashboard reads the last known answer. hydrateUsage
// refreshes the cache and redraws once if an asset crossed its threshold since the draw.
let USAGE = { t: 0, map: {}, rendered: '' };   // map: assetId → { since, s: status|null }
const usageDueAssets = () => Store.homeAssets().filter(a => a.usage && USAGE.map[a.id] && USAGE.map[a.id].s && USAGE.map[a.id].s.due);
async function computeUsage(force) {
  const tracked = Store.homeAssets().filter(a => a.usage);
  if (!tracked.length || !HA.ready()) { USAGE.map = {}; return USAGE.map; }
  // A cache hit must cover THESE assets and THEIR current windows: a home switch brings
  // unseen ids, and a reset on any device (local or synced in) rewrites usage.since.
  const fresh = a => { const e = USAGE.map[a.id]; return e && e.since === a.usage.since; };
  if (!force && Date.now() - USAGE.t < 5 * 60e3 && tracked.every(fresh)) return USAGE.map;
  const map = {};
  for (const a of tracked) map[a.id] = { since: a.usage.since, s: await Store.usageStatus(a) };
  USAGE = { ...USAGE, t: Date.now(), map };
  return map;
}
async function hydrateUsage() {
  if (Store.isTestHome()) return;   // no live HA behind a test home — nothing to poll
  const nodes = document.querySelectorAll('[data-usage]');
  const dash = document.querySelector('[data-nudges]');   // only the dashboard has the nudge host
  if (!nodes.length && !dash) return;
  if (!HA.ready()) {
    // Full-size bars (asset page) get the same banner treatment as every other
    // fix-this prompt on that page; mini bars stay a quiet one-liner.
    nodes.forEach(n => { const mini = !!n.dataset.mini; n.className = 'usagebar' + (mini ? ' mini' : '');
      n.innerHTML = mini ? `<div class="u-lbl">usage: needs Home Assistant</div>`
        : `<div class="banner">Usage tracking is set up but can't reach Home Assistant. <a href="#/settings" style="color:var(--accent);font-weight:600;text-decoration:none">Open Settings →</a></div>`; });
    return;
  }
  await computeUsage();
  for (const n of nodes) {
    const mini = !!n.dataset.mini;
    const a = Store.asset(n.getAttribute('data-usage'));
    const s = a && USAGE.map[a.id] ? USAGE.map[a.id].s : null;
    if (!s) { n.className = 'usagebar' + (mini ? ' mini' : ''); n.innerHTML = `<div class="u-lbl">${esc((a && a.usage && a.usage.entity) || 'usage')}: waiting for data…</div>`; continue; }
    const cls = s.due ? 'due' : (s.pct >= 80 ? 'warn' : '');
    const used = s.unit === 'kWh' ? Math.round(s.used) : (s.used < 10 ? s.used.toFixed(1) : Math.round(s.used));
    n.className = `usagebar ${cls}${mini ? ' mini' : ''}`;
    n.innerHTML = `<div class="u-track"><div class="u-fill" style="width:${s.pct}%"></div></div>
      <div class="u-lbl">${s.due ? '⚠ service due · ' : ''}${used} / ${s.threshold} ${esc(s.unit)}${(a.usage && a.usage.src === 'maker') ? ` · maker's` : ''} <b>${s.pct}%</b></div>`;
  }
  // due-set changed since the dashboard was drawn → redraw so those assets join "Needs
  // attention". Only if the dashboard is still on screen: the await above can outlive a
  // navigation, and render() scrolls to top — don't yank a view the user has moved on to.
  const key = usageDueAssets().map(a => a.id).sort().join();
  if (dash && document.contains(dash) && key !== USAGE.rendered) render();
}

/* ---------- actions ---------- */
function findService(assetId) {
  const a = Store.asset(assetId); const s = Store.state.settings;
  const trade = searchQueryFor(a);
  const q = encodeURIComponent(`${trade} near ${homeSuburb()}`);
  window.open('https://www.google.com/search?q=' + q, '_blank');
}
const val = id => (document.getElementById(id)?.value || '').trim();
// The bare address out of a `Name <addr@host>` header, or '' if there isn't one.
const mailAddr = s => (String(s == null ? '' : s).match(/[\w.\-+]+@[\w.\-]+\.\w+/) || [''])[0];
const todayISO = () => Store.localISO();   // LOCAL calendar date — toISOString() is UTC and reads "yesterday" before ~10am Sydney
// Email sign-off from Settings — never a hardcoded name in front of a real tradie.
const signOff = () => { const n = (Store.state.settings.ownerName || '').trim(); return n ? `Thanks,\n${n}` : 'Thanks!'; };
// The booking email a "✉︎ Book service" tap drafts: everything THIS provider looks
// after for us — asset (make/model), each service due, and the parts notes — so
// they can quote in one reply. Built from the store, edited in the compose modal.
function bookingEmail(prov, focusAsset, focusTask) {
  const mine = (t2, a2) => t2.providerId ? t2.providerId === prov.id : a2.providerId === prov.id;
  const lines = [];
  Store.homeAssets().forEach(a2 => {
    const ts = Store.tasksFor(a2.id).filter(t2 => !t2.snoozed && !isDiy(t2, a2) && mine(t2, a2));
    if (!ts.length) return;
    const mm = [a2.make, a2.model].filter(Boolean).join(' ');
    lines.push(`• ${a2.name}${mm ? ` — ${mm}` : ''}`);
    ts.forEach(t2 => lines.push(`    - ${t2.title}${t2.note ? ` (${t2.note})` : ''}`));
  });
  const home = Store.home() || {};
  return {
    subject: `Booking request — ${focusTask ? focusTask.title : focusAsset.name}`,
    body: `Hi ${prov.name},\n\nWe'd like to book a service${home.address ? ` at ${home.address}` : ''}. `
      + `Could you quote for the following and offer a couple of dates that suit?\n\n${lines.join('\n')}\n\n`
      + signOff(),
  };
}

// Brief non-blocking confirmation (e.g. "Enquiry sent").
function toast(msg) {
  const t = document.createElement('div'); t.className = 'kk-toast'; t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, 3200);
}

// Draft-for-approval email composer. Shows the editable enquiry; on Send it goes out
// via the backend Gmail and onSent() fires. Nothing is sent without this explicit tap.
// Openers for emailing a trade. Only the ones their own record can actually
// fill in are offered — a "chase them up" chip is noise if you have never
// written to them, and "about that last job" is noise if they have not done one.
function tradeTemplates(p) {
  const home = Store.home() || {};
  const at = home.address ? ` at ${home.address}` : '';
  const hi = `Hi${p.contact ? ' ' + String(p.contact).split(' ')[0] : ''},`;
  const assets = Store.homeAssets().filter(a => a.providerId === p.id);
  const thing = assets.length === 1 ? assets[0].name.toLowerCase()
              : assets.length ? assets.map(a => a.name.toLowerCase()).join(' / ')
              : (TRADES[p.trade] || p.trade || 'work').toLowerCase();
  const jobs = Store.jobsForProvider(p.id).filter(l => !l.pending);
  const last = jobs[0];
  const mail = Store.mailFor(p.id);
  const lastOut = mail.find(m => m.direction === 'out');
  const newerIn = lastOut && mail.some(m => m.direction === 'in' && m.date >= lastOut.date);
  // the most pressing job on something they look after
  const due = assets.flatMap(a => Store.tasksFor(a.id).map(t => ({ a, t, d: Store.daysUntil(t) })))
    .filter(x => x.d !== null && !x.t.autopilot).sort((x, y) => x.d - y.d)[0];

  const out = [];
  if (due) out.push({ label: due.d < 0 ? 'Book — overdue' : 'Book a service',
    subject: `Booking — ${due.t.title} (${due.a.name})`,
    body: `${hi}\n\nI'd like to book the ${due.t.title.toLowerCase()} on our ${due.a.name.toLowerCase()}${at}.\n\n`
        + `What dates does your team have available over the next few weeks?\n\nThanks!` });
  out.push({ label: 'Ask for a quote',
    subject: `Quote request — ${assets.length === 1 ? assets[0].name : (TRADES[p.trade] || p.trade || 'work')}`,
    body: `${hi}\n\nCould you please quote me for work on the ${thing}${at}?\n\n`
        + `Happy to send photos or have someone take a look first — whatever is easiest.\n\nThanks!` });
  if (last) {
    out.push({ label: 'About that last job',
      subject: `Follow-up — ${last.note || 'your last visit'}${last.ref ? ' (' + last.ref + ')' : ''}`,
      body: `${hi}\n\nYou looked at our ${thing}${at} on ${jobDate(last.date)}`
          + `${last.ref ? ` (${last.ref})` : ''}.\n\nSince then I have noticed `
          + `[describe what it is doing]. Could you take a look?\n\nThanks!` });
    out.push({ label: 'Copy of the invoice',
      subject: `Copy of invoice — ${jobDate(last.date)}${last.ref ? ' (' + last.ref + ')' : ''}`,
      body: `${hi}\n\nCould you send me a copy of the invoice for the work on ${jobDate(last.date)}`
          + `${last.ref ? ` (${last.ref})` : ''}${at ? ',' + at : ''}?\n\nThanks!` });
  }
  if (lastOut && !newerIn) out.unshift({ label: 'Chase them up',
    subject: `Re: ${(lastOut.subject || 'my last email').replace(/^((re|fwd):\s*)+/i, '')}`,
    body: `${hi}\n\nJust following up on my email of ${jobDate(lastOut.date)}`
        + `${lastOut.subject ? ` about ${lastOut.subject.replace(/^((re|fwd):\s*)+/i, '')}` : ''}.\n\n`
        + `Have you had a chance to look at it?\n\nThanks!` });
  return out.slice(0, 4);
}

function composeEnquiry({ quoteId, providerId, to, cc, subject, body, sendLabel, templates, onSent }) {
  const wrap = document.createElement('div');
  wrap.className = 'kk-modal';
  wrap.innerHTML = `<div class="kk-modal-card" role="dialog" aria-modal="true">
      <div class="kk-modal-h">Review &amp; send</div>
      <label class="kk-l">To</label>
      <input class="kk-i" id="cm_to" value="${esc(to || '')}" ${to ? '' : 'placeholder="supplier@email.com"'} autocomplete="off">
      <label class="kk-l">Cc (keeps a copy in your own inbox)</label>
      <input class="kk-i" id="cm_cc" value="${esc(cc !== undefined ? cc : ((Store.state.settings && Store.state.settings.emailCc) || ''))}" placeholder="you@example.com" autocomplete="off">
      ${(templates && templates.length) ? `<label class="kk-l">Start from</label>
      <div class="kk-chips">${templates.map((t, i) =>
        `<button class="btn small" data-tpl="${i}">${esc(t.label)}</button>`).join('')}</div>` : ''}
      <label class="kk-l">Subject</label>
      <input class="kk-i" id="cm_su" value="${esc(subject)}">
      <label class="kk-l">Message</label>
      <textarea class="kk-t" id="cm_bo" rows="9">${esc(body)}</textarea>
      <div class="kk-note">Sends from your KasaKeeper mailbox. Replies are read automatically and the quote fills itself in.</div>
      <div class="kk-modal-b">
        <button class="btn" data-cm="cancel">Cancel</button>
        <button class="btn primary" data-cm="send">✉︎ ${esc(sendLabel || 'Send')}</button>
      </div></div>`;
  document.body.appendChild(wrap);
  // A draft only lived in this tab's DOM, so a reload — or picking the phone up
  // instead — lost it silently. Park it on the quote; the store is shared, so the
  // "Review & send" button follows you to whatever device you finish it on.
  const draftOn = () => quoteId ? Store.quote(quoteId) : (providerId ? Store.provider(providerId) : null);
  const saveDraft = () => {
    const o = draftOn(); if (!o) return;
    o.draft = { to: val('cm_to'), cc: val('cm_cc'), subject: val('cm_su'), body: val('cm_bo'), sendLabel: sendLabel || 'Send' };
    quoteId ? Store.upsertQuote(o) : Store.upsertProvider(o); Store.push && Store.push();
  };
  const clearDraft = () => { const o = draftOn(); if (!o || !o.draft) return;
    delete o.draft; quoteId ? Store.upsertQuote(o) : Store.upsertProvider(o); Store.push && Store.push(); };
  setTimeout(saveDraft, 0);
  const close = () => wrap.remove();
  let applied = body || '';
  wrap.addEventListener('click', async ev => {
    const ti = ev.target.getAttribute && ev.target.getAttribute('data-tpl');
    if (ti !== null && ti !== undefined) {
      const t = templates[+ti]; if (!t) return;
      const cur = val('cm_bo');
      if (cur && cur !== applied.trim() && !confirm('Replace what you have written with the "' + t.label + '" wording?')) return;
      document.getElementById('cm_su').value = t.subject;
      document.getElementById('cm_bo').value = t.body;
      applied = t.body; saveDraft(); return;
    }
    const cm = ev.target.getAttribute && ev.target.getAttribute('data-cm');
    if (ev.target === wrap || cm === 'cancel') { saveDraft(); return close(); }   // keep it — closing isn't discarding
    if (cm !== 'send') return;
    const to2 = val('cm_to'), su = val('cm_su'), bo = val('cm_bo');
    if (!/.+@.+\..+/.test(to2)) return alert('Enter a valid recipient email.');
    if (!su || !bo) return alert('Subject and message can’t be empty.');
    const btn = ev.target; btn.disabled = true; btn.textContent = 'Sending…';
    // No quote behind this email means nothing to track a reply back to — and the
    // backend stamps whatever it is given into the subject the trade actually reads.
    const res = await Research.sendEnquiry({ to: to2, cc: val('cm_cc'), subject: su, body: bo,
      token: quoteId ? 'KK-' + quoteId : '' });
    if (res.ok) { clearDraft(); close(); onSent && onSent({ to: to2, subject: res.subject || su, body: bo }); }
    else { btn.disabled = false; btn.textContent = '✉︎ ' + (sendLabel || 'Send'); alert('Send failed: ' + res.error); }
  });
}

const QORDER = { to_contact: 0, enquiry_sent: 1, quoted: 2, booked: 3 };
function ensureQuote(assetId, status) {
  const a = Store.asset(assetId); if (!a) return null;
  let q = Store.quoteForAsset(assetId);
  if (!q) return Store.upsertQuote({ assetId, trade: a.name, status: status || 'to_contact' });  // the card headline: the JOB (asset), never the category bucket
  if (status && QORDER[status] > QORDER[q.status]) { q.status = status; Store.upsertQuote(q); }
  return q;
}

document.addEventListener('click', async e => {
  if (e.target.closest('select')) return; // let dropdowns work without toggling rows
  if (e.target.closest('a[data-ext]')) return; // tel:/website links: let the browser open them, don't route the card
  const node = e.target.closest('[data-action]'); if (!node) return;
  const act = node.getAttribute('data-action'), id = node.getAttribute('data-id');
  switch (act) {
    case 'settings': return go('/settings');
    case 'open-asset': return go('/asset/' + id);
    case 'open-provider': return go('/provider/' + id);
    case 'back': return goBack();
    case 'new-asset': return go('/edit-asset/new');
    case 'catalog': return go('/catalog');
    case 'cat-open': return go('/catalog/' + node.getAttribute('data-i'));
    case 'add-svc': {
      const svc = Catalog.get(+node.getAttribute('data-svc')), v = node.getAttribute('data-var') || '';
      const a = Store.upsertAsset({ name: svc.name + (v ? ` (${v})` : ''), category: svc.cat, variant: v, location: '', providerId: '' });
      Catalog.tasksFor(svc, v).forEach(t => Store.upsertTask({ ...t, assetId: a.id }));
      return go('/asset/' + a.id);
    }
    case 'set-variant': {
      const a = Store.asset(id), svc = Catalog.get(+node.getAttribute('data-svc')), v = node.getAttribute('data-var');
      if (!a || a.variant === v) return;
      if (!confirm(`Set “${a.name}” to ${v} and use that schedule?`)) return;
      a.variant = v; Store.upsertAsset(a);
      Store.tasksFor(a.id).forEach(t => Store.deleteTask(t.id));
      Catalog.tasksFor(svc, v).forEach(t => Store.upsertTask({ ...t, assetId: a.id }));
      return render();
    }
    case 'edit-asset': return go('/edit-asset/' + id);
    case 'new-task': return go('/edit-task/' + id);
    case 'edit-task': return go('/edit-task/' + node.getAttribute('data-asset') + '/' + id);
    case 'new-provider': return go('/edit-provider/new');
    case 'edit-provider': return go('/edit-provider/' + id);
    case 'find': return go('/find/' + id);   // browsing suppliers is NOT a quote request — no silent quote record
    case 'refind': FIND = { assetId: null }; runFind(id); return render();
    case 'save-found': {
      const p = (FIND.providers || [])[+node.getAttribute('data-i')], a = Store.asset(id);
      if (!p || !a) return;
      const prov = Store.upsertProvider({ name: p.name, trade: tradeFor(a), phone: p.phone || '', email: p.email || '', website: p.website || '',
        notes: [p.rating != null ? `${p.rating}★ ${p.reviews || ''} reviews` : ''].filter(Boolean).join(' · ') });
      a.providerId = prov.id; Store.upsertAsset(a);
      const q = Store.quoteForAsset(a.id); if (q) { q.provider = p.name; Store.upsertQuote(q); }
      return go('/asset/' + id);
    }
    case 'quote-provider': {
      const p = (FIND.providers || [])[+node.getAttribute('data-i')], a = Store.asset(id);
      if (!p || !a) return;
      const prov = Store.upsertProvider({ name: p.name, trade: tradeFor(a), phone: p.phone || '', email: p.email || '', website: p.website || '',
        notes: [p.rating != null ? `${p.rating}★ ${p.reviews || ''} reviews` : '', p.blurb].filter(Boolean).join(' · ') });
      a.providerId = prov.id; Store.upsertAsset(a);
      const q = ensureQuote(id, 'to_contact'); if (q) { q.provider = p.name; Store.upsertQuote(q); }
      const { subject, body } = Research.enquiryEmail(a);
      // Backend Gmail available + we have their email -> draft-for-approval, send & auto-track the reply.
      if (p.email && await Research.emailAvailable()) {
        return composeEnquiry({ quoteId: q.id, to: p.email, subject, body, sendLabel: 'Send enquiry', onSent: ({ to }) => {
          q.status = 'enquiry_sent'; q.token = 'KK-' + q.id; q.channel = 'email'; q.enquiryTo = to; q.enquirySentAt = todayISO();
          Store.upsertQuote(q); toast('Enquiry sent to ' + p.name + ' — watching for the reply'); go('/providers'); } });
      }
      if (p.email) {  // no backend mailbox — hand off to the device mail client
        q.status = 'enquiry_sent'; Store.upsertQuote(q);
        location.href = `mailto:${encodeURIComponent(p.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        return go('/asset/' + id);
      }
      alert(`${p.name} has no public email. ${p.phone ? 'Call ' + p.phone : ''}${p.website ? ' or visit ' + p.website : ''}. I've saved them and started a quote you can track.`);
      return go('/asset/' + id);
    }
    case 'email-provider': {  // free-form email to a found business (distinct from the quote template)
      const p = (FIND.providers || [])[+node.getAttribute('data-i')], a = Store.asset(id);
      if (!p || !a || !p.email) return;
      const prov = Store.upsertProvider({ name: p.name, trade: tradeFor(a), phone: p.phone || '', email: p.email, website: p.website || '',
        notes: [p.rating != null ? `${p.rating}★ ${p.reviews || ''} reviews` : '', p.blurb].filter(Boolean).join(' · ') });
      a.providerId = prov.id; Store.upsertAsset(a);
      const q = ensureQuote(id, 'to_contact'); if (q) { q.provider = p.name; Store.upsertQuote(q); }
      const home = (Store.state.settings && Store.state.settings.home) || {};
      const where = home.address || homeSuburb() || 'my home';
      const subject = `Enquiry — ${a.name}`;
      // Lead with the actual JOB, never a category-derived trade guess — this sentence
      // goes to a real business, and "gutter cleaning" about a limestone wall is nonsense.
      const body = `Hi${p.name ? ' ' + p.name : ''},\n\nI'm looking for help with our ${a.name.toLowerCase()} near ${where}.\n\nAre you available, and what are your rates?\n\nThanks!`;
      if (await Research.emailAvailable()) {
        return composeEnquiry({ quoteId: q.id, to: p.email, subject, body, sendLabel: 'Send email', onSent: ({ to }) => {
          q.status = 'enquiry_sent'; q.token = 'KK-' + q.id; q.channel = 'email'; q.enquiryTo = to; q.enquirySentAt = todayISO();
          Store.upsertQuote(q); toast('Email sent to ' + p.name + ' — watching for the reply'); go('/providers'); } });
      }
      location.href = `mailto:${encodeURIComponent(p.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      return go('/asset/' + id);
    }
    case 'google': return findService(id);   // ditto — a Google search creates nothing
    case 'email-trade': case 'open-trade-draft': {
      const p = Store.provider(id); if (!p || !p.email) return;
      // No backend mailbox: hand off to their mail app WITH the drafted/template
      // content — the app already computed it; a bare mailto threw it away.
      if (!await Research.emailAvailable()) {
        const d0 = p.draft || {}, t0 = tradeTemplates(p)[0] || {};
        location.href = `mailto:${encodeURIComponent(d0.to || p.email)}?subject=${encodeURIComponent(d0.subject || t0.subject || '')}&body=${encodeURIComponent(d0.body || t0.body || '')}`;
        return;
      }
      const d = p.draft || {};
      const tpls = tradeTemplates(p);
      const first = d.subject ? null : tpls[0];
      return composeEnquiry({ providerId: p.id, to: d.to || p.email, cc: d.cc,
        subject: d.subject || (first ? first.subject : ''),
        body: d.body || (first ? first.body : ''),
        sendLabel: 'Send email', templates: tpls,
        onSent: async ({ to: t, subject: su, body: bo }) => {
          Store.addMail({ providerId: p.id, date: todayISO(), from: 'me', subject: su,
            snippet: (bo || '').split('\n').filter(Boolean)[1] || '', direction: 'out' });
          await Store.push(); toast('Sent to ' + p.name); go('/provider/' + p.id);
        } });
    }
    case 'open-draft': {
      const q = Store.quote(id); if (!q || !q.draft) return;
      const d = q.draft, aa = Store.asset(q.assetId);
      const prov = (aa && aa.providerId) ? Store.provider(aa.providerId)
                 : Store.homeProviders().find(p => p.name === q.provider);
      return composeEnquiry({ quoteId: q.id, to: d.to, cc: d.cc, subject: d.subject, body: d.body, sendLabel: d.sendLabel,
        onSent: async ({ to: t, subject: su }) => {
          q.status = 'enquiry_sent'; q.token = 'KK-' + q.id; q.channel = 'email';
          q.enquiryTo = t; q.enquirySentAt = todayISO(); Store.upsertQuote(q);
          if (prov) Store.addMail({ providerId: prov.id, quoteId: q.id, date: todayISO(),
            from: 'me', subject: su, snippet: (d.body || '').split('\n').filter(Boolean)[1] || '', direction: 'out' });
          await Store.push(); toast('Sent — watching for the reply'); go('/providers');
        } });
    }
    case 'open-quote': return go('/providers');
    case 'quote-sent': { const q = Store.quote(id); if (q) { q.status = 'enquiry_sent'; Store.upsertQuote(q); } return render(); }
    case 'quote-amount': { const q = Store.quote(id); if (!q) return; const amt = prompt('Quoted amount ($)?', q.amount || ''); if (amt === null) return; q.amount = Number(amt) || 0; q.status = 'quoted'; Store.upsertQuote(q); return render(); }
    case 'quote-book': return go('/book/' + id);   // capture the date, log it, draft the confirmation
    case 'confirm-date': {  // auto-book: user picks one of the offered dates -> approved confirmation email
      const q = Store.quote(id); if (!q) return;
      const date = node.getAttribute('data-date') || '';
      const a = Store.asset(q.assetId);
      const home = Store.home() || {};
      const to = q.replyFrom || q.enquiryTo;
      const subject = `Booking confirmation — ${q.trade || (a ? a.name : 'service')}${q.token ? ` [${q.token}]` : ''}`;
      const body = `Hi${q.provider ? ' ' + q.provider : ''},\n\nThanks for the dates — ${date} works for us. `
        + `Please consider it confirmed${home.address ? ` for ${home.address}` : ''}${q.amount ? ` at ${money(q.amount)}` : ''}.`
        + `\n\nSee you then!`;
      const finalize = () => {
        q.status = 'booked'; q.bookedDate = date; q.confirmedAt = todayISO(); Store.upsertQuote(q);
        if (a && q.provider && !a.providerId) {
          const p = Store.upsertProvider({ name: q.provider, trade: q.trade || a.category, email: to || '', notes: 'Auto-booked' });
          a.providerId = p.id; Store.upsertAsset(a);
        }
      };
      if (to && await Research.emailAvailable()) {
        return composeEnquiry({ quoteId: q.id, to, subject, body, sendLabel: 'Confirm booking', onSent: () => {
          finalize(); toast('Booked — ' + date); blinkMark(); render(); } });
      }
      // No add-on mailbox: hand the confirmation to the device's mail app (same
      // fallback as every other enquiry flow) — never book silently without telling the trade.
      if (to) location.href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      finalize(); toast('Booked — ' + date); return render();
    }
    case 'del-quote': if (confirm('Remove this quote request?')) { Store.deleteQuote(id); return render(); } return;
    case 'setup': SETUP = { step:1, address:'', msg:'', detected:null, selected:new Set(), extras:[], testMode:false, selectedImage:null }; delete IMAGERY.setup; return go('/setup');
    case 'research-home': SETUP.testMode = !!document.getElementById('wz_test')?.checked; return runResearch(val('wz_addr'));
    case 'pick-addr': {
      const input = document.getElementById('wz_addr'), box = document.getElementById('wz_suggest');
      if (input) input.value = node.getAttribute('data-label') || '';
      if (box) { box.hidden = true; box.innerHTML = ''; }
      return;
    }
    case 'use-location':
      SETUP.testMode = !!document.getElementById('wz_test')?.checked;
      if (navigator.geolocation) navigator.geolocation.getCurrentPosition(() => runResearch('Current location'), () => toast('Location unavailable — type your address instead.'));
      else toast('Type your address instead.');
      return;
    case 'toggle-feat': { const k = node.getAttribute('data-key'); SETUP.selected.has(k) ? SETUP.selected.delete(k) : SETUP.selected.add(k); return render(); }
    case 'create-home': {
      const d = SETUP.detected; if (!d) return;
      SETUP.detected = null;   // claim it NOW — the photo-vault await below opens a double-tap window otherwise
      const home = Store.addHome({ address: d.address, levels: d.levels, beds: d.beds, baths: d.baths, testMode: !!SETUP.testMode });
      if (d.suburb) { home.suburb = d.suburb; Store.save(); }   // the suburb belongs to THIS home — never the global settings
      const all = d.features.concat(SETUP.extras || []);   // detected + any extras the user turned on
      const variants = {};
      all.forEach(f => { const el = document.getElementById('var_' + f.key); if (el) variants[f.key] = el.value; });
      let made = 0;
      all.forEach(f => { if (!SETUP.selected.has(f.key) || existsLabel(f.label)) return;
        const v = variants[f.key] || '';
        const a = Store.upsertAsset({ name: f.label, category: f.category, variant: v, location: '', providerId: '' });
        const m = Catalog.match(f.category, f.label);
        if (m && m.s.variants) Catalog.tasksFor(m.s, v).forEach(t => Store.upsertTask({ ...t, assetId: a.id }));
        else Store.suggestTasks(a.id);
        made++;
      });
      // Quick add: free-form lines -> bare assets, no schedule yet. Category is a
      // best guess only; no make/model parsing — a later research pass fills that in.
      const qEl = document.getElementById('wz_quick');
      let quickMade = 0;
      if (qEl && qEl.value.trim()) {
        const seen = new Set();
        qEl.value.split('\n').map(l => l.trim().slice(0, 80)).filter(Boolean).slice(0, 30).forEach(line => {
          const key = line.toLowerCase();
          if (seen.has(key) || existsLabel(line)) return;
          seen.add(key);
          Store.upsertAsset({ name: line, category: guessCategory(line), variant: '', location: '', providerId: '' });
          quickMade++;
        });
      }
      if (SETUP.selectedImage) {   // the picked home photo — fetched & vaulted server-side, home just flags it
        try {
          const r = await fetch('api/home-photo', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ homeId: home.id, url: SETUP.selectedImage }) });
          const j = await r.json().catch(() => ({}));
          if (r.ok && j.ok) { home.photo = true; Store.save(); }
        } catch {}
      }
      toast(`Home created — ${made} asset${made !== 1 ? 's' : ''} added with schedules${quickMade ? ` · ${quickMade} quick-added for research` : ''}`);
      SETUP = { step:1, address:'', msg:'', detected:null, selected:new Set(), extras:[], testMode:false, selectedImage:null }; delete IMAGERY.setup; return go('/');
    }
    case 'save-home': {   // inferred home facts are the user's to correct
      const h = Store.state.homes.find(x => x.id === id); if (!h) return render();
      const addr = (val('eh_addr') || '').trim().slice(0, 200);
      if (addr) h.address = addr;
      const num = fid => { const n = Number(val(fid)); return Number.isFinite(n) && n > 0 && n < 100 ? n : null; };
      h.levels = num('eh_levels'); h.beds = num('eh_beds'); h.baths = num('eh_baths');
      Store.save(); toast('Home updated'); return render();
    }
    case 'switch-home': Store.switchHome(id); return go('/');
    case 'del-home':
      if (confirm('Delete this home and all its assets?')) { Store.deleteHome(id); return Store.state.currentHomeId ? go('/') : go('/setup'); }
      return;
    case 'toggle-imagery': { IMG_OPEN.has(id) ? IMG_OPEN.delete(id) : IMG_OPEN.add(id); return render(); }
    case 'pick-image': {
      const key = node.getAttribute('data-key'), i = +node.getAttribute('data-i');
      const img = (IMAGERY[key] || [])[i]; if (!img) return;
      if (key === 'setup') { SETUP.selectedImage = img.url; return render(); }
      const h = Store.state.homes.find(x => x.id === key); if (!h) return;
      try {
        const r = await fetch('api/home-photo', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ homeId: h.id, url: img.url }) });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.ok) { h.photo = true; Store.save(); toast('Photo updated'); }
        else toast('Could not save that photo');
      } catch { toast('Could not save that photo'); }
      return render();
    }
    case 'add-suggested': {
      const a = Store.asset(id), p = Research.suggestProviders(a.category)[Number(node.getAttribute('data-i'))];
      const prov = Store.upsertProvider({ name: p.name, trade: a.category, notes: p.url || '' });
      a.providerId = prov.id; Store.upsertAsset(a);
      const q = Store.quoteForAsset(a.id); if (q) { q.provider = p.name; Store.upsertQuote(q); }
      return go('/asset/' + a.id);
    }
    case 'book-service': {   // task card → drafted quoting email listing this provider's assets, services and parts
      const t = Store.state.tasks.find(x => x.id === id); if (!t) return render();
      const a = Store.asset(t.assetId); if (!a) return render();
      const prov = taskProv(t, a); if (!prov || !prov.email) return render();
      const { subject, body } = bookingEmail(prov, a, t);
      const q = ensureQuote(a.id, 'to_contact'); if (q) { q.provider = prov.name; q.taskId = t.id; Store.upsertQuote(q); }
      if (await Research.emailAvailable()) {
        return composeEnquiry({ quoteId: q.id, to: prov.email, subject, body, sendLabel: 'Send booking request', onSent: ({ to: to2 }) => {
          q.status = 'enquiry_sent'; q.token = 'KK-' + q.id; q.channel = 'email'; q.enquiryTo = to2; q.enquirySentAt = todayISO();
          Store.upsertQuote(q); toast('Booking request sent to ' + prov.name + ' — watching for the reply'); render(); } });
      }
      if (q) { q.status = 'enquiry_sent'; Store.upsertQuote(q); }
      location.href = `mailto:${encodeURIComponent(prov.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      return render();
    }
    case 'enquiry': {
      const a = Store.asset(id); if (!a) return render();   // gone from under us (another device / chat edit)
      const { subject, body } = Research.enquiryEmail(a), prov = Store.provider(a.providerId);
      const to = prov && prov.email ? prov.email : '';
      const q = ensureQuote(id, 'to_contact'); if (q && prov) { q.provider = prov.name; Store.upsertQuote(q); }
      if (await Research.emailAvailable()) {
        return composeEnquiry({ quoteId: q.id, to, subject, body, sendLabel: 'Send enquiry', onSent: ({ to: t }) => {
          q.status = 'enquiry_sent'; q.token = 'KK-' + q.id; q.channel = 'email'; q.enquiryTo = t; q.enquirySentAt = todayISO();
          Store.upsertQuote(q); toast('Enquiry sent — watching for the reply'); go('/providers'); } });
      }
      if (q) { q.status = 'enquiry_sent'; Store.upsertQuote(q); }
      location.href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`; return;
    }
    case 'claim-warranty': {
      const a = Store.asset(id); if (!a) return render();   // gone from under us (another device / chat edit)
      const wd = Store.warrantyDays(a); if (wd === null || wd < 0) return render();   // no longer in warranty — button shouldn't have fired
      const prov = Store.provider(a.providerId);
      const to = prov && prov.email ? prov.email : '';
      const mm = [a.make, a.model].filter(Boolean).join(' ');
      const home = Store.home() || {};
      const subject = `Warranty claim — ${mm || a.name} (purchased ${a.installedOn || 'date unknown'})`;
      const body = `Hi,\n\nI'd like to make a warranty claim for our ${a.name.toLowerCase()}${mm ? ` (${mm})` : ''}${home.address ? ` at ${home.address}` : ''}.\n\n`
        + `Make/model: ${mm || '—'}\nSerial: ${a.serial || '—'}\nInstalled/purchased: ${a.installedOn || '—'}\nWarranty until: ${a.warrantyUntil || '—'}\n\n`
        + `Fault: <describe the issue>\n\nCould you let me know the next steps to have this looked at under warranty?\n\n` + signOff();
      if (await Research.emailAvailable()) {
        return composeEnquiry({ to, subject, body, sendLabel: 'Send claim', onSent: async () => {
          if (prov) { Store.addMail({ providerId: prov.id, date: todayISO(), from: 'me', subject, snippet: 'Warranty claim', direction: 'out' }); await Store.push(); }
          toast('Warranty claim sent' + (prov ? ' to ' + prov.name : '')); go('/asset/' + id);
        } });
      }
      location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`; return;
    }
    case 'lookup': {
      if (!Store.asset(id)) return render();
      startLookup(id);
      return render();
    }
    case 'lookup-apply': {
      if (LOOKUP.applied) return;   // idempotent — a double-tap must not double the schedule
      const r = (LOOKUP || {}).result, a = Store.asset(LOOKUP.assetId);
      if (!r || !a || !(r.tasks || []).length) return;
      const existing = Store.tasksFor(a.id);
      const srcTag = (a.make || a.model) ? 'maker' : 'research';
      let added = 0, updated = 0;
      r.tasks.forEach(pt => {
        if (!pt.title || !(pt.cadenceDays > 0)) return;
        const m = existing.find(t => (t.title || '').toLowerCase() === pt.title.toLowerCase());
        if (m) { m.cadenceDays = pt.cadenceDays; m.src = srcTag; if (pt.note && !m.note) m.note = pt.note; Store.upsertTask(m); updated++; }
        else { Store.upsertTask({ assetId: a.id, title: pt.title, cadenceDays: pt.cadenceDays, note: pt.note || '', lastDone: '', estCost: 0, src: srcTag }); added++; }
      });
      // The maker's interval in RUN-HOURS beats a calendar guess when we're already
      // metering this asset from Home Assistant — tune the usage threshold too.
      let usageTuned = false;
      if (r.usageIntervalHours > 0 && a.usage && a.usage.mode === 'runtime') {
        a.usage.threshold = r.usageIntervalHours; a.usage.unit = a.usage.unit || 'hrs'; a.usage.src = 'maker';
        USAGE.t = 0; delete USAGE.map[a.id]; usageTuned = true;
      }
      if (a.lookupPending) delete a.lookupPending;   // sweep proposal reviewed — badge comes off everywhere
      Store.upsertAsset(a);
      LOOKUP.applied = true;
      toast(`Schedule tuned — ${added} added · ${updated} updated${usageTuned ? ` · usage threshold set to ${r.usageIntervalHours}h (maker's)` : ''}`);
      return render();
    }
    case 'check-recall': {
      if (!Store.asset(id)) return render();
      startRecall(id);
      return render();
    }
    case 'recall-task': {
      const a = Store.asset(id), r = a && a.recall;
      if (!a || !r || r.status !== 'recall') return render();
      // Idempotent against the PERSISTED link, not session state — a reload, or a
      // recall found by the scheduled sweep, must not lose the guard and double
      // the task. If the linked task is gone (another device deleted it), re-offer.
      if (r.taskId && Store.state.tasks.some(t => t.id === r.taskId)) return render();
      // cadenceDays:1 + a lastDone two calendar days back guarantees this reads as
      // OVERDUE the moment it lands, regardless of time-of-day/timezone rounding —
      // a recall needs to demand attention, not sit at "due today".
      const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); d.setDate(d.getDate() - 2);
      const overdueSince = d.toISOString().slice(0, 10);
      const note = [r.remedy, r.url].filter(Boolean).join(' · ');
      const t = Store.upsertTask({ assetId: a.id, title: `RECALL: ${(r.summary || 'safety recall').slice(0, 60)}`,
        cadenceDays: 1, lastDone: overdueSince, estCost: 0, note, src: 'research' });
      a.recall.taskId = t.id;
      Store.upsertAsset(a);
      toast('Added as an urgent task');
      return render();
    }
    case 'recall-ack': {
      const a = Store.asset(id);
      if (!a || !a.recall) return render();
      a.recall.ack = true;
      Store.upsertAsset(a);
      toast('Marked as seen');
      return render();
    }
    case 'call': { const p = Store.provider((Store.asset(id)||{}).providerId); if (p?.phone) location.href = 'tel:'+p.phone.replace(/\s/g,''); else if (Store.asset(id)) findService(id); return; }
    case 'done': {
      const t = Store.state.tasks.find(x=>x.id===id); if (!t) return render();
      const c = prompt('Log this as done. Cost ($)?', t.estCost || 0);
      if (c === null) return;
      Store.markDone(id, c);
      const a = Store.asset(t.assetId);
      if (a && a.usage) { await Store.resetUsage(a.id); USAGE.t = 0; delete USAGE.map[a.id]; } // servicing resets the usage counter
      if (Store.pack(a)) {                            // a prepaid visit just got spent
        Store.usePack(a.id, 1);
        toast(`${Store.packLeft(a)} prepaid ${(a.pack.unit || 'visit')}${Store.packLeft(a) !== 1 ? 's' : ''} left`);
      }
      render();
      blinkMark(); // brand behavior: the keeper blinks when a task completes
      return;
    }
    case 'job-done': Store.completeLog(id); toast('Logged as done'); return render();
    case 'save-booking': {
      const q = Store.quote(id); if (!q) return;
      const a = Store.asset(q.assetId);
      const prov = (a && a.providerId) ? Store.provider(a.providerId)
                 : Store.homeProviders().find(p => p.name === q.provider);
      const date = val('b_date') || todayISO();
      const time = val('b_time');
      const note = val('b_note') || q.trade || 'Booked job';
      const cost = Number(val('b_cost')) || q.amount || 0;
      q.status = 'booked'; q.bookedDate = date; q.bookedTime = time; q.amount = cost;
      Store.upsertQuote(q);
      if (a) Store.addLog({ assetId: a.id, date, note: note + (time ? ' · ' + time : ''), cost,
                            providerId: prov ? prov.id : '', ref: q.ref || '', source: 'booked', pending: true });
      const to = q.replyFrom || q.enquiryTo || (prov && prov.email) || '';
      if (to && await Research.emailAvailable()) {
        const home = Store.home() || {};
        const subject = `Booking confirmation — ${note}`;
        const body = `Hi${q.provider ? ' ' + q.provider : ''},\n\nConfirming ${note}`
          + `${cost ? ' at ' + money(cost) : ''} for ${jobDate(date)}${time ? ', ' + time : ''}`
          + `${home.address ? ' at ' + home.address : ''}.\n\nCould you please confirm that time works?\n\nThanks!`;
        return composeEnquiry({ quoteId: q.id, to, subject, body, sendLabel: 'Send confirmation',
          onSent: () => { toast('Booked · confirmation sent to ' + (q.provider || to)); go('/asset/' + (a ? a.id : '')); } });
      }
      toast(to ? 'Booked ✓ — mailbox off, so no email sent' : 'Booked ✓');
      return go('/asset/' + (a ? a.id : ''));
    }
    case 'new-job': return go('/edit-job/' + id);
    case 'edit-job': return go('/edit-job/' + node.getAttribute('data-asset') + '/' + id);
    case 'save-job': {
      const assetId = node.getAttribute('data-asset');
      const patch = { assetId, note: val('j_note'), date: val('j_date'),
                      cost: Number(val('j_cost')) || 0, providerId: val('j_prov'), ref: val('j_ref') };
      if (id) Store.updateLog(id, patch); else Store.addLog(patch);
      return go('/asset/' + assetId);
    }
    case 'del-job':
      if (confirm('Remove this job from the history?')) { Store.deleteLog(id); return go('/asset/' + node.getAttribute('data-asset')); }
      return;
    case 'track-usage': return go('/edit-usage/' + id);
    case 'save-usage': {
      const a = Store.asset(id); if (!a) return;
      const mode = val('u_mode') || 'runtime';
      a.usage = {
        entity: val('u_entity'), mode,
        threshold: Number(val('u_thresh')) || 0,
        unit: val('u_unit') || (mode === 'energy' ? 'kWh' : 'hrs'),
        since: (a.usage && a.usage.since) || new Date().toISOString(),
        baseline: a.usage ? a.usage.baseline : null,
      };
      Store.upsertAsset(a);
      if (mode === 'energy') await Store.resetUsage(id); // snapshot the meter now
      USAGE.t = 0;
      return go('/asset/' + id);
    }
    case 'reset-usage': { if (!confirm('Reset the usage counter (mark as just serviced)?')) return; await Store.resetUsage(id); USAGE.t = 0; delete USAGE.map[id]; return render(); }
    case 'stop-usage': { const a = Store.asset(id); if (a) { delete a.usage; Store.upsertAsset(a); USAGE.t = 0; } return render(); }
    case 'suggest': { const n = Store.suggestTasks(id); alert(n ? `Added ${n} suggested task${n>1?'s':''}.` : 'Already has the standard schedule.'); return render(); }
    case 'start-tracking': { const n = Store.unscheduled().length; Store.startTracking(); alert(`Tracking ${n} service${n>1?'s':''} — countdowns started.`); return render(); }
    case 'book-pack': {
      // Another device may have removed the asset or the pack since this view
      // rendered — read through it and bail rather than throwing on a dead tap.
      const a = Store.asset(id); if (!a) return render();
      const p = Store.pack(a);
      if (!p) { toast('That prepaid pack is no longer on record'); return render(); }
      const prov = Store.provider(a.providerId);
      const left = Store.packLeft(a), home = Store.home() || {};
      const unit = p.unit || 'visit';
      const first = (prov && prov.contact) ? String(prov.contact).split(' ')[0] : '';
      const to = (prov && prov.email) || '';
      const subject = `Maintenance booking — ${a.name}${home.address ? ' · ' + home.address : ''}`;
      const body = `Hi${first ? ' ' + first : ''},\n\n`
        + `I'd like to book the next maintenance ${unit} for our ${a.name.toLowerCase()}`
        + `${home.address ? ` at ${home.address}` : ''}.\n\n`
        + `My records show ${left} of ${p.bought} prepaid ${unit}${p.bought !== 1 ? 's' : ''} still outstanding`
        + `${p.ref ? ` from ${p.ref}` : ''}${p.purchasedOn ? `, paid ${p.purchasedOn}` : ''}. `
        + `Could you confirm how many remain on the pack, and let me know what dates your team has available?\n\n`
        + `Thanks,`;
      // Reuse the quote pipeline so the reply-poller can offer dates back into the UI.
      // Update the open PACK booking rather than minting a new one: tapping "Book
      // a visit" a few times while you think about it should leave one request, not
      // three. Matched on packAsset, not just assetId — a normal quote request you
      // already have open on this asset must not be overwritten by a booking.
      // An already-sent booking keeps its status; this is not a re-send.
      const open = Store.state.quotes.find(x => x.packAsset === a.id && x.status !== 'booked' && x.status !== 'declined');
      const q = Store.upsertQuote(Object.assign(open || { status: 'to_contact' }, {
        assetId: a.id, trade: (prov && prov.trade) || a.category,
        provider: (prov && prov.name) || '', channel: 'email',
        packAsset: a.id, note: `Prepaid ${unit} — ${left} left` }));
      if (to && await Research.emailAvailable()) {
        return composeEnquiry({ quoteId: q.id, to, subject, body, sendLabel: 'Send booking request',
          onSent: async (r) => {
            q.status = 'enquiry_sent'; q.enquiryTo = r.to; q.token = 'KK-' + q.id; Store.upsertQuote(q);
            await Store.push(); toast('Booking request sent — watching for a reply'); render();
          } });
      }
      // No mailbox configured on the add-on: hand a fully written draft to your own mail app.
      await Store.push();
      window.open(`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank');
      toast('Draft opened in your mail app');
      return render();
    }
    case 'use-pack': {
      const p = Store.usePack(id, 1), a = Store.asset(id);
      if (p) toast(`${Store.packLeft(a)} of ${p.bought} left`);
      await Store.push(); return render();
    }
    case 'unuse-pack': { Store.usePack(id, -1); await Store.push(); return render(); }
    case 'edit-pack': {
      const a = Store.asset(id), p = a.pack || {};
      const bought = prompt(`How many services did you buy for ${a.name}?\n(0 removes the pack)`, p.bought || '');
      if (bought === null) return;
      const n = parseInt(bought, 10) || 0;
      if (!n) { Store.setPack(id, null); await Store.push(); toast('Pack removed'); return render(); }
      const used = parseInt(prompt('How many have you used so far?', p.used || 0), 10) || 0;
      const cost = parseFloat(prompt('What did the whole block cost? ($, blank to skip)', p.cost || '')) || 0;
      const when = prompt('When did you buy it? (YYYY-MM-DD, blank to skip)', p.purchasedOn || '') || '';
      Store.setPack(id, { bought: n, used: Math.min(used, n), cost, purchasedOn: when.trim(),
                          unit: p.unit || 'visit', note: p.note || '' });
      await Store.push(); toast('Service pack saved'); return render();
    }
    case 'archive-provider': {
      const p = Store.setProviderArchived(id, true);
      const linked = Store.homeAssets().filter(a => a.providerId === id);
      if (p) toast(`${p.name} moved to past providers${linked.length ? ` — still linked to ${linked.length} asset${linked.length>1?'s':''}` : ''}`);
      return render();
    }
    case 'unarchive-provider': {
      const p = Store.setProviderArchived(id, false);
      if (p) toast(`${p.name} is active again`);
      return render();
    }
    case 'del-provider': {
      const p = Store.provider(id); if (!p) return go('/providers');
      const linked = Store.homeAssets().filter(a => a.providerId === id).length;
      const msg = `Delete ${p.name || 'this provider'}?` + (linked ? `\nThey're linked to ${linked} asset${linked>1?'s':''} — those will be unlinked (assets kept).` : '');
      if (confirm(msg)) { Store.deleteProvider(id); return go('/providers'); }
      return;
    }
    case 'del-asset': if (confirm('Delete this asset and its tasks?')) { Store.deleteAsset(id); return go('/assets'); } return;
    case 'del-task': if (confirm('Delete this task?')) { Store.deleteTask(id); return go('/asset/' + node.getAttribute('data-asset')); } return;
    case 'buy': {
      const a = Store.asset(id); if (!a) return;
      const url = a.purchaseUrl ? webUrl(a.purchaseUrl)
        : 'https://www.google.com/search?q=' + encodeURIComponent([a.make, a.model, a.name, 'buy australia'].filter(Boolean).join(' '));
      window.open(url, '_blank'); return;
    }
    case 'chat-send': return chatSend(val('chat_in'));
    case 'chat-suggest': return chatSend(node.getAttribute('data-q'));
    case 'chat-dismiss': {
      const m = CHAT.messages[+node.getAttribute('data-mi')];
      const p = m && m.proposals && m.proposals[+node.getAttribute('data-pi')];
      if (!p || p.applying) return;
      const i = m.proposals.indexOf(p);        // by reference — data-pi may be stale by now
      if (i > -1) m.proposals.splice(i, 1);
      return render();
    }
    case 'chat-apply': {
      const m = CHAT.messages[+node.getAttribute('data-mi')];
      const p = m && m.proposals && m.proposals[+node.getAttribute('data-pi')];
      if (!p || p.applying) return;
      p.applying = true; render();             // state lives on the proposal, survives any re-render
      let j = {};
      try {
        const r = await fetch('api/chat/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool: p.tool, args: p.args }) });
        j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) { toast(j.detail || j.error || "That didn't go through — try again."); p.applying = false; return render(); }
      } catch (e) { toast("That didn't go through — try again."); p.applying = false; return render(); }
      const i = m.proposals.indexOf(p);         // by reference — never the index captured at click time
      if (i > -1) m.proposals.splice(i, 1);
      await Store.syncRemote();
      toast(j.detail || 'Done.');
      return render();
    }
    case 'del-task-inline': if (confirm('Delete this task permanently?')) { Store.deleteTask(id); return render(); } return;
    case 'set-theme': { localStorage.setItem(THEME_KEY, node.getAttribute('data-theme') || 'auto'); applyTheme(); return render(); }
    case 'save-manual': {   // vault the manual: server fetches the PDF onto /data; flag syncs to every device
      const a = Store.asset(id); if (!a || !a.manualUrl) return render();
      node.textContent = 'saving…';
      fetch('api/doc', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ assetId: a.id, url: webUrl(a.manualUrl) }) })
        .then(r => r.json()).then(j => {
          if (j.error) { toast(j.error); }
          else { const aa = Store.asset(id); if (aa) { aa.manualDoc = true; Store.upsertAsset(aa); } toast('Manual saved to the house'); }
          if (route()[0] === 'asset') render();
        }).catch(() => { toast('Save failed — try again'); if (route()[0] === 'asset') render(); });
      return;
    }
    case 'snooze-task-back': { Store.snoozeTask(id); return go('/asset/' + node.getAttribute('data-asset')); }
    case 'unsnooze-task-back': { Store.unsnoozeTask(id); return go('/asset/' + node.getAttribute('data-asset')); }
    case 'use-suggested-entity': {   // one-tap fill from the registry match on Track usage
      const set = (fid, v) => { const el = document.getElementById(fid); if (el && v) el.value = v; };
      set('u_entity', node.getAttribute('data-entity'));
      set('u_mode', node.getAttribute('data-mode'));
      set('u_unit', node.getAttribute('data-unit'));
      return;
    }
    case 'sweep-research': sweepResearch(); return;
    case 'sweep-skip':   // discards the in-flight asset's result server-side when its lookup returns
      fetch('api/sweep/skip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
      return;
    case 'sweep-stop':
      fetch('api/sweep/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
      toast('Stopping after the current asset…');
      return;
    case 'recall-sweep-now': {   // on-demand trigger for the scheduled monthly recall sweep (fire-and-forget)
      fetch('api/recall-sweep', { method: 'POST' }).then(r => r.json()).then(j => {
        toast(j && j.started ? 'Recall sweep started — results land on each asset as they’re checked'
                              : (j && j.error) || 'Could not start the sweep');
      }).catch(() => toast('Could not reach the server'));
      return;
    }
    case 'dbg-fold': { const d = document.getElementById('kk-dbg'); if (d) d.classList.toggle('open'); return; }
    case 'toggle-diy': { const t = Store.state.tasks.find(x => x.id === id); if (t) { t.diy = !t.diy; if (t.diy) t.autoBook = false; Store.upsertTask(t); } return render(); }
    case 'toggle-asset-diy': {  // the WHOLE asset is yours: no supplier nags, no auto-emails, ever
      const a = Store.asset(id); if (!a) return render();
      a.diy = !a.diy;
      if (a.diy) Store.tasksFor(a.id).forEach(t => { if (!t.providerId && t.autoBook) { t.autoBook = false; Store.upsertTask(t); } });
      Store.upsertAsset(a);
      toast(a.diy ? '🛠 Marked DIY — you look after this one' : 'Back to using a pro');
      return render(); }
    case 'snooze-task': Store.snoozeTask(id); return render();     // disable/ignore — stops counting toward due/overdue/nudges
    case 'unsnooze-task': Store.unsnoozeTask(id); return render(); // bring it back
    case 'save-asset': {
      const a = id==='new' ? {} : Store.asset(id);
      Object.assign(a, { name:val('f_name'), category:val('f_cat'), location:val('f_loc'), trade:val('f_trade'),
        installedOn:val('f_installed'), warrantyUntil:val('f_warranty'), providerId:val('f_prov'),
        make:val('f_make'), model:val('f_model'), serial:val('f_serial'), haEntity:val('f_ha'),
        purchaseUrl:val('f_purchase') });
      const saved = Store.upsertAsset(a);
      if (SNAP.pending) {  // snapped asset: keep the photo on the Green + build its schedule
        if (SNAP.image) fetch('api/photo', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ assetId: saved.id, image: SNAP.image }) }).catch(()=>{});
        Store.suggestTasks(saved.id);
        snapNothing();
      }
      // Understand what THIS thing needs: every newly added asset gets researched —
      // maker's schedule when a make/model exists (the Snap 2.0 chain), the accepted
      // trade-standard schedule when it's just "Limestone wall". One Apply either way.
      if (id === 'new') startLookup(saved.id);
      return go('/asset/' + saved.id);
    }
    case 'snap': return snapAsset();
    case 'snap-accept': SNAP.pending = true; return go('/edit-asset/new');
    case 'inspect-import': return importInspection();
    case 'inspect-pick': { const i = +node.getAttribute('data-i');
      INSPECT.picked.has(i) ? INSPECT.picked.delete(i) : INSPECT.picked.add(i); return render(); }
    case 'inspect-apply': {
      // Idempotency guard: syncRemote()/push() below cross the network, and the
      // button stays in the DOM until the next render — a second tap in that
      // window must not re-run the loop and double every task it creates.
      if (INSPECT.applying || !INSPECT.picked || !INSPECT.picked.size) return;
      INSPECT.applying = true; render();
      try {
        const defects = (INSPECT.result && INSPECT.result.defects) || [];
        await Store.syncRemote();
        const assetsByName = new Map(Store.homeAssets().map(a => [a.name.toLowerCase(), a]));
        let findingsAsset = null, n = 0;
        defects.forEach((d, i) => {
          if (!INSPECT.picked.has(i)) return;
          let asset = d.area ? assetsByName.get(String(d.area).toLowerCase()) : null;
          if (!asset) {
            if (!findingsAsset) {
              findingsAsset = Store.homeAssets().find(a => a.name === 'Inspection findings')
                || Store.upsertAsset({ name: 'Inspection findings', category: 'Appliance', location: '' });
            }
            asset = findingsAsset;
          }
          const note = [d.recommendation, INSPECT.filename ? `from ${INSPECT.filename}` : ''].filter(Boolean).join(' — ').slice(0, 400);
          Store.upsertTask({ assetId: asset.id, title: (d.title || 'Defect').slice(0, 80),
            cadenceDays: d.cadenceDays || 365, note, src: 'research', lastDone: '' });
          n++;
        });
        await Store.push();
        toast(`Added ${n} to the schedule`);
        INSPECT = { status: 'idle', result: null, picked: null, filename: '', applying: false };
        return go('/assets');
      } finally {
        // A failed sync leaves INSPECT.applying set only if the object above wasn't
        // replaced (i.e. we didn't reach the success path) — clear it so the tap is
        // retryable instead of wedging the button disabled forever.
        INSPECT.applying = false;
      }
    }
    case 'gmail-scan': {
      GMSCAN = { status:'scanning', result:null, picked:null, msg:'Connecting…' };
      go('/gmail-import');
      (async () => {
        try {
          const start = await (await fetch('api/gmail/scan', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' })).json();
          if (!start.job_id) throw new Error(start.error || 'could not start the scan');
          const msgs = ['Searching for quotes & invoices…', 'Reading the tradie mail…', 'Extracting suppliers & history…'];
          for (let n = 0; n < 120; n++) {                       // up to ~6 min for big inboxes
            await new Promise(r2 => setTimeout(r2, 3000));
            GMSCAN.msg = msgs[Math.min(msgs.length - 1, Math.floor(n / 8))];
            if (route()[0] === 'gmail-import' && GMSCAN.status === 'scanning') render();
            let job; try { job = await (await fetch('api/gmail/scan/' + start.job_id)).json(); } catch (e2) { continue; }
            if (job.status === 'done' || job.status === 'error') {
              if (job.result && job.result.error) throw new Error(job.result.error);
              GMSCAN = { status:'done', result: job.result || {}, picked:null };
              if (route()[0] === 'gmail-import') render();
              return;
            }
          }
          throw new Error('scan timed out');
        } catch (e3) { GMSCAN = { status:'idle' }; toast('Gmail scan failed — ' + e3.message); go('/settings'); }
      })();
      return;
    }
    case 'gmail-pick': {
      const kind = node.getAttribute('data-kind'), i = +node.getAttribute('data-i');
      const set = GMSCAN.picked[kind === 's' ? 's' : 'a'];
      set.has(i) ? set.delete(i) : set.add(i);
      return render();
    }
    case 'gmail-import': {
      const r = GMSCAN.result || {}; let np = 0, na = 0;
      (r.suppliers || []).forEach((s, i) => {
        if (!GMSCAN.picked.s.has(i)) return;
        const jobs = (s.jobs || []).slice(0, 6).map(j => `${j.date || ''} ${j.what || ''}${j.amount ? ' $' + j.amount : ''}`.trim()).join(' · ');
        const existing = Store.homeProviders().find(p => p.name.toLowerCase() === (s.name || '').toLowerCase());
        const doc = { name: s.name, trade: CATEGORIES[s.category] ? s.category : 'Appliance',
          email: s.email || '', phone: s.phone || '',
          notes: ['From Gmail import', s.website, s.lastJob ? 'last job ' + s.lastJob : '', jobs].filter(Boolean).join(' · ').slice(0, 400) };
        if (existing) Object.assign(existing, { email: existing.email || doc.email, phone: existing.phone || doc.phone, notes: existing.notes || doc.notes }) && Store.upsertProvider(existing);
        else { Store.upsertProvider(doc); np++; }
      });
      (r.inferredAssets || []).forEach((x, i) => {
        if (!GMSCAN.picked.a.has(i)) return;
        if (Store.homeAssets().some(a2 => a2.name.toLowerCase() === (x.name || '').toLowerCase())) return;
        const a2 = Store.upsertAsset({ name: x.name, category: CATEGORIES[x.category] ? x.category : 'Appliance', location:'', providerId:'' });
        Store.suggestTasks(a2.id); na++;
        if (x.lastServiced) Store.tasksFor(a2.id).forEach(t => { t.lastDone = x.lastServiced; Store.upsertTask(t); });
      });
      GMSCAN = { status:'idle' };
      alert(`Imported ${np} supplier${np !== 1 ? 's' : ''} and ${na} asset${na !== 1 ? 's' : ''}.`);
      return go('/providers');
    }
    case 'ha-import-scan': {
      HAIMPORT = { status:'loading', result:null, groups:null, picked:null, vanished:null };
      go('/ha-import');
      (async () => {
        const [result, drift] = await Promise.all([HA.devices(), HA.drift()]);
        HAIMPORT = { status:'done', result, groups:null, picked:null, vanished: drift.vanished };
        if (route()[0] === 'ha-import') render();
      })();
      return;
    }
    case 'ha-unlink': {
      if (!confirm('Unlink this asset from Home Assistant? It stays as a regular asset — nothing else changes.')) return;
      await Store.syncRemote();   // BEFORE reading — another device may have edited or deleted this asset since the scan
      const a = Store.asset(id); if (!a) return;   // gone (or never existed) — nothing to unlink
      delete a.ha;
      Store.upsertAsset(a);
      await Store.push();
      if (HAIMPORT.vanished) HAIMPORT.vanished = HAIMPORT.vanished.filter(v => v.assetId !== id);
      toast('Unlinked from Home Assistant.');
      return render();
    }
    case 'ha-import-pick': {
      const kind = node.getAttribute('data-kind'), i = +node.getAttribute('data-i');
      const set = HAIMPORT.picked[kind === 'n' ? 'n' : 'u'];
      set.has(i) ? set.delete(i) : set.add(i);
      return render();
    }
    case 'ha-import-apply': {
      if (HAIMPORT.applying) return;   // idempotent — a double-tap (or a slow network) must not double the assets
      HAIMPORT.applying = true;
      render();   // Apply button goes disabled/"Applying…" immediately, before the first await
      try {
        const groups = HAIMPORT.groups, picked = HAIMPORT.picked;
        if (!groups || !picked) return;
        await Store.syncRemote();
        let nNew = 0, nApplied = 0, nSkipped = 0;
        for (let i = 0; i < groups.new.length; i++) {
          if (!picked.n.has(i)) continue;
          const x = groups.new[i], p = x.proposal;
          const asset = Store.upsertAsset({ name: p.name, category: CATEGORIES[p.category] ? p.category : 'Appliance',
            make: p.make, model: p.model, serial: p.serial, location: p.location, providerId: '' });
          Store.suggestTasks(asset.id);
          asset.ha = { deviceId: x.dev.deviceId,
            entities: { usage: (x.dev.suggestedUsage && x.dev.suggestedUsage.entity) || null, live: (x.dev.live || []).slice(0, 4) },
            snapshot: { manufacturer: x.dev.manufacturer || '', model: x.dev.model || '', sw_version: x.dev.sw_version || '', serial: x.dev.serial || '' },
            importedAt: new Date().toISOString() };
          if (x.dev.suggestedUsage) {
            const def = USAGE_DEFAULTS[asset.category] || { mode:'runtime', threshold:250, unit:'hrs' };
            asset.usage = { entity: x.dev.suggestedUsage.entity, mode: x.dev.suggestedUsage.mode,
              threshold: def.threshold, unit: x.dev.suggestedUsage.unit || def.unit, since: new Date().toISOString(), baseline: null };
          }
          Store.upsertAsset(asset);
          if (asset.usage) await Store.resetUsage(asset.id);   // energy mode snapshots the baseline now
          nNew++;
        }
        for (let i = 0; i < groups.update.length; i++) {
          if (!picked.u.has(i)) continue;
          const x = groups.update[i];
          const asset = Store.asset(x.asset.id); if (!asset) continue;   // deleted mid-flow — skip, don't resurrect
          // The proposal's `current` was captured back at scan time. syncRemote() just
          // pulled in whatever the store looks like NOW — if another device edited this
          // field in between, current has drifted off the proposal, and writing the
          // stale `proposed` value would silently stomp that edit. Re-check per field
          // and skip (never overwrite) anything that moved out from under us.
          x.fields.forEach(f => {
            const live = String(asset[f.field] || '').trim();
            if (live !== f.current) { nSkipped++; return; }
            asset[f.field] = f.proposed; nApplied++;
          });
          // The review row promised "will meter: …" for Updates too — link the telemetry
          // exactly like the New path, but NEVER clobber a usage config the user already set.
          const justLinked = !!(x.dev.suggestedUsage && !(asset.usage && asset.usage.entity));
          if (justLinked) {
            const def = USAGE_DEFAULTS[asset.category] || { mode:'runtime', threshold:250, unit:'hrs' };
            asset.usage = { entity: x.dev.suggestedUsage.entity, mode: x.dev.suggestedUsage.mode,
              threshold: (asset.usage && asset.usage.threshold) || def.threshold,
              unit: x.dev.suggestedUsage.unit || def.unit, since: new Date().toISOString(), baseline: null };
          }
          asset.ha = { deviceId: x.dev.deviceId,
            entities: { usage: (asset.usage && asset.usage.entity) || null, live: (x.dev.live || []).slice(0, 4) },
            snapshot: { manufacturer: x.dev.manufacturer || '', model: x.dev.model || '', sw_version: x.dev.sw_version || '', serial: x.dev.serial || '' },
            importedAt: new Date().toISOString() };
          Store.upsertAsset(asset);
          // Reset ONLY when we linked it just now — a re-applied correction to an
          // already-tracked asset must not zero its run-hours-since-service.
          if (justLinked) await Store.resetUsage(asset.id);
        }
        HAIMPORT = { status:'idle', result:null, groups:null, picked:null, vanished:null };
        await Store.push();
        const parts = [];
        if (nNew) parts.push(`imported ${nNew} asset${nNew !== 1 ? 's' : ''}`);
        if (nApplied) parts.push(`${nApplied} correction${nApplied !== 1 ? 's' : ''} applied`);
        if (nSkipped) parts.push(`${nSkipped} skipped — changed on another device`);
        toast(parts.length ? parts.join(' · ') : 'Nothing to apply.');
        return go('/assets');
      } finally {
        if (HAIMPORT.applying) { HAIMPORT.applying = false; render(); }   // failure path: leave it retryable
      }
    }
    case 'triage-open': TRIAGE = { status:'idle', result:null, image:null, text:'' }; return go('/triage');
    case 'triage-photo': {
      TRIAGE.text = val('tr_desc');
      pickPhoto(async f => { TRIAGE.image = await downscale(f, 1100); render(); });
      return;
    }
    case 'triage-go': {
      TRIAGE.text = val('tr_desc');
      if (!TRIAGE.text && !TRIAGE.image) { toast('Describe the problem first (or add a photo).'); return; }
      TRIAGE.status = 'thinking'; render();
      fetch('api/triage', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ text: TRIAGE.text, image: TRIAGE.image }) })
        .then(r => r.json()).then(j => { TRIAGE.status = j.error ? 'idle' : 'done'; TRIAGE.result = j.error ? null : j;
          if (j.error) toast(j.error); if (route()[0] === 'triage') render(); })
        .catch(e => { TRIAGE.status = 'idle'; toast('Triage failed — ' + e.message); if (route()[0] === 'triage') render(); });
      return;
    }
    case 'triage-find': {
      const r = TRIAGE.result; if (!r) return;
      let a = Store.homeAssets().find(x => x.category === r.category);
      if (!a) { const svc = Catalog.inCat(r.category)[0];
        a = Store.upsertAsset({ name: (svc && svc.s.name) || r.category, category: CATEGORIES[r.category] ? r.category : 'Appliance', location:'', providerId:'' }); }
      return go('/find/' + a.id);   // the quote is created when they actually engage a provider there
    }
    case 'triage-email': {
      const r = TRIAGE.result, p = Store.provider(id); if (!r || !p) return;
      const home = Store.home();
      const subject = `Job request · ${r.summary || r.category}${home ? ' · ' + home.address : ''}`;
      const matched = Store.homeAssets().find(x => x.category === r.category);
      if (matched) { const q = ensureQuote(matched.id, 'enquiry_sent'); if (q) { q.provider = p.name; Store.upsertQuote(q); } }
      location.href = `mailto:${encodeURIComponent(p.email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent('Hi ' + p.name + ',\n\n' + (r.forTradie || TRIAGE.text) + '\n\nCould you let me know availability and a price?\n\n' + signOff())}`;
      return;
    }
    case 'rebook': {
      const p = Store.provider(id); if (!p) return;
      const home = Store.home();
      const linked = Store.homeAssets().filter(x => x.providerId === p.id).map(x => x.name);
      const subject = `Booking request · ${p.trade}${home ? ' · ' + home.address : ''}`;
      const body = `Hi ${p.name},\n\nWe'd like to book our usual ${p.trade.toLowerCase()} service${linked.length ? ' (' + linked.join(', ') + ')' : ''}.\nWhat's your earliest availability?\n\n` + signOff();
      if (linked.length) { const a = Store.homeAssets().find(x => x.providerId === p.id);
        const q = ensureQuote(a.id, 'enquiry_sent'); if (q) { q.provider = p.name; Store.upsertQuote(q); } }
      if (p.email) location.href = `mailto:${encodeURIComponent(p.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      else if (p.phone) location.href = 'tel:' + p.phone.replace(/\s/g, '');
      else alert('No email or phone saved for ' + p.name + ' — add one via ✎.');
      return;
    }
    case 'save-task': {
      const tid = id, assetId = node.getAttribute('data-asset');
      const t = tid ? Store.state.tasks.find(x=>x.id===tid) : { assetId };
      const diy = !!(document.getElementById('f_diy') || {}).checked;
      const auto = !!(document.getElementById('f_auto') || {}).checked && !diy;   // DIY wins: never auto-email about a job you do yourself
      Object.assign(t, { assetId, title:val('f_title'), cadenceDays:Number(val('f_cad'))||365,
        lastDone:val('f_last'), estCost:Number(val('f_cost'))||0, note:val('f_note'), providerId:val('f_prov_t'), autoBook: auto, diy,
        autopilot: !!(document.getElementById('f_autopilot')||{}).checked });
      Store.upsertTask(t);
      if (auto) {  // auto needs somewhere to send the enquiry — nudge if the link is missing
        const a = Store.asset(assetId), p = a && Store.provider(a.providerId);
        if (!p || !p.email) alert('Auto-book is on, but this asset has no provider with an email yet. Use "Find a service" (or edit the provider) so KasaKeeper knows who to contact.');
        if (!t.lastDone) alert('Auto-book needs a countdown — set "Last done" so the due date is known.');
      }
      return go('/asset/' + assetId);
    }
    case 'save-provider': {
      const p = id==='new' ? {} : Store.provider(id);
      Object.assign(p, { name:val('f_pname'), trade:val('f_trade'), contact:val('f_contact'), phone:val('f_phone'), email:val('f_email'), website:val('f_website'), notes:val('f_notes') });
      Store.upsertProvider(p); return go('/providers');
    }
    case 'save-settings': {
      const pd = document.getElementById('pushDaily');
      const lead = document.getElementById('autoLead');
      // Catch a bad Cc here, not at send time: this value is dropped into every
      // outgoing email, so a typo would quietly fail every send from now on.
      const cc = val('emailCc');
      if (cc && !mailAddr(cc)) { toast("That Cc doesn't look like an email — fix it or clear it"); return; }
      Object.assign(Store.state.settings, { haUrl:val('haUrl')||Store.state.settings.haUrl, haToken:val('haToken'),
        soonDays:Number(val('soonDays'))||30, emailCc:cc, ownerName:val('ownerName'),
        ...(lead ? { autoLeadDays: Math.max(1, Number(lead.value) || 14) } : {}),
        ...(pd ? { pushDaily: pd.checked } : {}) });
      { const h = Store.home();   // suburb is per-home — the field edits the CURRENT home
        if (h) h.suburb = val('suburb'); else Store.state.settings.suburb = val('suburb'); }
      Store.save(); postDigest(NUDGES.list); const r = document.getElementById('haResult'); if (r) r.textContent = 'Saved ✓';
      const pr = document.getElementById('pushResult'); if (pr) pr.textContent = 'Saved ✓'; return;
    }
    case 'push-test': {
      const pr = document.getElementById('pushResult'); if (pr) pr.textContent = 'Sending…';
      fetch('api/ha/notify', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ title:'KasaKeeper', message:'Test — push notifications are working. Keeping watch.' }) })
        .then(r => r.json()).then(j => { if (pr) pr.innerHTML = j.ok
          ? '<span style="color:var(--green)">✓ Sent — check your phone</span>'
          : `<span style="color:var(--red)">✗ ${esc(j.error || 'notify service unavailable')}</span>`; })
        .catch(e => { if (pr) pr.innerHTML = `<span style="color:var(--red)">✗ ${esc(e.message)}</span>`; });
      return;
    }
    case 'test-ha': {
      const r = document.getElementById('haResult'); r.textContent = 'Testing…';
      HA.test().then(res => r.innerHTML = `<span class="${res.ok?'':''}" style="color:${res.ok?'var(--green)':'var(--red)'}">${res.ok?'✓ ':'✗ '}${esc(res.msg)}</span>`); return;
    }
    case 'export': {
      const blob = new Blob([JSON.stringify(Store.state, null, 2)], { type:'application/json' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = 'kasakeeper-backup.json'; a.click(); URL.revokeObjectURL(url); return;
    }
    // Honest destructive copy: there is no "sample house" — this empties the store,
    // and the shared-store sync propagates the wipe to every device.
    case 'reset': if (confirm('Erase everything? This permanently deletes all homes, assets, tasks, quotes and history — on every device, since KasaKeeper syncs your data. This cannot be undone.')) { Store.reset(); return go('/'); } return;
  }
});

document.addEventListener('change', e => {   // radios/selects that persist settings
  const el = e.target.closest('[data-action-change="gmail-mode"]');
  if (el) { Store.state.settings.gmailMode = el.value; Store.save(); render(); }
  const dbg = e.target.closest('[data-action-change="toggle-debug"]');
  if (dbg) {   // device-local, never synced
    if (dbg.checked) localStorage.setItem(DBG.KEY, '1'); else localStorage.removeItem(DBG.KEY);
    DBG.paint();
  }
  const tm = e.target.closest('[data-action-change="toggle-testmode"]');
  if (tm) { const h = Store.state.homes.find(x => x.id === tm.getAttribute('data-id'));
    if (h) { h.testMode = tm.checked; Store.save(); render(); } }
});

// Setup screen: address autocomplete. Debounced so it doesn't hammer the backend
// per keystroke; the box's own text nodes are patched directly (not render()) so
// typing never loses focus or cursor position.
let ADDR_DEBOUNCE = null;
let ADDR_SEQ = 0;   // guards against a slower earlier fetch resolving after a newer one
function renderAddrSuggest(list) {
  const box = document.getElementById('wz_suggest'); if (!box) return;
  if (!list || !list.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = list.map(s => `<div class="su-suggest-row" data-action="pick-addr" data-label="${esc(s.label)}">${esc(s.label)}</div>`).join('')
    + `<div class="su-pow">Address suggestions · powered by Google</div>`;
}
document.addEventListener('input', e => {
  if (e.target.id !== 'wz_addr') return;
  clearTimeout(ADDR_DEBOUNCE);
  const q = e.target.value.trim();
  if (q.length < 3) { ADDR_SEQ++; renderAddrSuggest(null); return; }
  const seq = ++ADDR_SEQ;
  ADDR_DEBOUNCE = setTimeout(() => {
    fetch('api/address-suggest?q=' + encodeURIComponent(q)).then(r => r.json())
      .then(d => { if (seq === ADDR_SEQ) renderAddrSuggest(d.suggestions); }).catch(() => {});
  }, 350);
});
document.addEventListener('click', e => {   // tap outside the address field dismisses its dropdown
  const box = document.getElementById('wz_suggest');
  if (box && !box.hidden && e.target.id !== 'wz_addr' && !e.target.closest('#wz_suggest')) { box.hidden = true; box.innerHTML = ''; }
});
window.addEventListener('hashchange', render);
Store.load();
applyTheme();
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);  // 'auto' follows the OS live
render();
DBG.paint();   // the developer drawer lives outside #app, so render() never eats it
// Detect the add-on's tokenless HA proxy, then re-render so live data hydrates.
HA.init().then(ok => { if (ok) render(); });
Research.emailAvailable();   // probe the backend mailbox once so enquiry taps are instant
// Multi-device shared store: reconcile with the Green on boot and whenever the app
// regains focus (wall tablet / phone pick up each other's changes).
Store.syncRemote().then(res => {
  if (res !== 'adopted') return;
  // a fresh device lands on #/setup before sync finishes — bounce home once data arrives
  if (Store.state.homes.length && route()[0] === 'setup') go('/'); else render();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') Store.syncRemote().then(res => { if (res === 'adopted') render(); });
});
// The live strip must not poll HA hard, but should feel fresh when you pick the
// tablet back up — force past the 30s min-interval on regaining visibility.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { HASTRIP.t = 0; hydrateHaStrip(); }
});
