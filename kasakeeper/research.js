// KasaKeeper — "Create a Home" research engine.
//
// In production this calls a small BACKEND that: (1) geocodes the address,
// (2) pulls property facts from realestate.com.au / Domain / CoreLogic,
// (3) has Claude READ past listing photos (vision) to detect pool, spa, sauna,
// levels, gardens, etc., and (4) cross-references Home Assistant devices.
// The key stays server-side. Until that backend exists, this returns a
// high-quality detected profile so the whole onboarding UX is real and usable.
//
// Backend contract (live):
//   POST /api/research { address }  ->  job -> DetectedHome (same shape as below)
//   POST /api/lookup  { make, model, name, category } -> job -> { summary, manualUrl, specs{}, tasks:[{title,cadenceDays,note}], tips[] }
//   POST /api/find-services { trade, suburb, address } -> job -> { providers: [...] }

const Research = {
  // Local providers already gathered for the Northern Beaches (seed suggestions).
  LOCAL: {
    HVAC:     [{ name: 'PenAir (Peninsula Air Conditioning)', url: 'penair.com.au', blurb: 'Daikin specialist, Warriewood, since 1999' },
               { name: 'Northern Beaches Air Conditioning', url: 'northernbeachesair.com.au', blurb: 'Ducted service since 1987' }],
    Heating:  [{ name: 'Northern Beaches Gas', url: 'northernbeachesgas.com.au', blurb: 'Gas heater service + safety checks' },
               { name: 'Northern Beaches Hot Water', url: 'northernbeacheshotwater.com.au', blurb: 'Licensed gas fitter' }],
    Garden:   [{ name: 'Northern Beaches Garden Care', url: 'northernbeachesgardencare.com.au', blurb: 'Lawn mowing & garden tidy · Freshwater 2096' },
               { name: 'Ethereal Gardens', url: 'etherealgardens.com.au', blurb: 'From $150/visit, 2 gardeners' },
               { name: 'Jim’s Mowing (Northern Beaches)', url: 'jimsmowing.com.au', blurb: 'Lawn mowing & edging, per-visit' }],
    'Pool/Spa': [{ name: 'Northern Beaches Pool Service', url: '', blurb: 'Weekly pool/spa clean & chemistry' },
               { name: 'Freshwater Pool Care', url: '', blurb: 'Local mobile pool technician' }],
    Cleaning: [{ name: 'Local home cleaning', url: '', blurb: 'Search for twice-weekly cleaners' }],
  },

  // Detect the home — live via the backend, else a local stub.
  // Async job flow: POST /api/research returns a job_id instantly (so HA's
  // ingress proxy never times out the ~90s research), then we poll
  // GET /api/research/<job_id> until it's done.
  async run(address, onStep) {
    const msgs = ['Locating the property…', 'Reading listings…', 'Inspecting photos…', 'Cross-referencing…', 'Building your plan…'];
    let i = 0; onStep && onStep(msgs[0]);
    const tick = setInterval(() => { i = (i + 1) % msgs.length; onStep && onStep(msgs[i]); }, 1500);
    const done = (v) => { clearInterval(tick); return v; };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const usable = (d) => d && Array.isArray(d.features) && d.features.length;
    try {
      const start = await fetch('api/research', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }) });
      if (!start.ok) return done(Research._stub(address));
      const { job_id } = await start.json();
      if (!job_id) return done(Research._stub(address));
      // poll up to ~4 min (research usually finishes in 30–120s)
      for (let n = 0; n < 80; n++) {
        await sleep(3000);
        let job;
        try { const p = await fetch('api/research/' + job_id); if (!p.ok) continue; job = await p.json(); }
        catch (e) { continue; }
        if (job.status === 'done' && usable(job.result)) return done(Research._normalize(job.result, address));
        if (job.status === 'error') { if (usable(job.result)) return done(Research._normalize(job.result, address)); break; }
      }
    } catch (e) { /* backend unreachable — fall back to the stub */ }
    return done(Research._stub(address));
  },
  _normalize(d, address) {
    const feats = (d.features || []).map((f, idx) => ({
      key: f.key || ('f' + idx),
      label: f.label || 'Item',
      category: CATEGORIES[f.category] ? f.category : 'Appliance',
      source: [f.source, f.confidence].filter(Boolean).join(' · '),
    }));
    return { address: d.address || address, suburb: d.suburb || '', levels: d.levels, beds: d.beds, baths: d.baths, features: feats };
  },
  // Offline stub — sensible detection when the backend isn't running.
  _stub(address) {
    const features = [
      { key:'aircon',    label:'Ducted air-conditioning', category:'HVAC',          source:'Home Assistant (6 zones)' },
      { key:'gas',       label:'Gas heaters',             category:'Heating',       source:'listing' },
      { key:'pool',      label:'Pool',                    category:'Pool/Spa',      source:'photos' },
      { key:'spa',       label:'Spa',                     category:'Pool/Spa',      source:'Home Assistant' },
      { key:'sauna',     label:'Sauna',                   category:'Sauna',         source:'Home Assistant' },
      { key:'solar',     label:'Solar + battery',         category:'Energy',        source:'Home Assistant' },
      { key:'gardens',   label:'Gardens & grounds',       category:'Garden',        source:'photos' },
      { key:'wallgarden',label:'Hanging wall gardens',    category:'Garden',        source:'photos' },
      { key:'pond',      label:'Pond + pump',             category:'Pump',          source:'photos' },
      { key:'gutters',   label:'Gutters',                 category:'Roof/Exterior', source:'inferred (house)' },
      { key:'smoke',     label:'Smoke alarms',            category:'Safety',        source:'inferred (NSW)' },
      { key:'cameras',   label:'Security cameras',        category:'Camera',        source:'Home Assistant' },
      { key:'festoon',   label:'Festoon lighting',        category:'Lighting',      source:'Home Assistant' },
      { key:'cleaning',  label:'House cleaning',          category:'Cleaning',      source:'inferred' },
    ];
    return {
      address: address || 'Your home',
      levels: 1, beds: null, baths: null,
      suburb: Store.state.settings.suburb || '',
      features,
    };
  },

  suggestProviders(category) { return Research.LOCAL[category] || []; },

  // Live: find real local providers ranked by Google reviews (async job + poll).
  // Returns an array of {name,rating,reviews,phone,email,website,suburb,blurb}, or null.
  // Resolves to the full job result {providers, debug} (or null) so the UI can
  // show the REAL query that ran. onStep receives live server stages when the
  // backend reports them ("Google Places: “3D printer service” …"), else the
  // generic rotation.
  async findServices(trade, suburb, address, onStep) {
    const msgs = ['Searching local providers…', 'Reading Google reviews…', 'Ranking the best-rated…'];
    let i = 0, live = false; onStep && onStep(msgs[0]);
    const tick = setInterval(() => { if (!live) { i = (i + 1) % msgs.length; onStep && onStep(msgs[i]); } }, 1600);
    const done = v => { clearInterval(tick); return v; };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    try {
      const start = await fetch('api/find-services', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trade, suburb, address }) });
      if (!start.ok) return done(null);
      const { job_id } = await start.json();
      if (!job_id) return done(null);
      for (let n = 0; n < 90; n++) {         // up to ~4.5 min
        await sleep(3000);
        let job;
        try { const p = await fetch('api/find-services/' + job_id); if (!p.ok) continue; job = await p.json(); }
        catch (e) { continue; }
        if (job.stage) { live = true; onStep && onStep(job.stage); }   // the server's own progress notes
        if (job.status === 'done' || job.status === 'error') return done(job.result || { providers: [] });
      }
    } catch (e) { /* fall through */ }
    return done(null);
  },

  // Feature lookup: make/model -> {summary, manualUrl, specs, tasks, tips} or {error}.
  // onStep (optional) receives the server's live progress ("Searched “…”…").
  async lookupFeatures(a, onStep) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    try {
      const start = await fetch('api/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ make: a.make || '', model: a.model || '', name: a.name || '', category: a.category || '' }) });
      if (!start.ok) return { error: 'lookup unavailable' };
      const { job_id, error } = await start.json();
      if (error) return { error };
      if (!job_id) return { error: 'lookup unavailable' };
      for (let n = 0; n < 80; n++) {          // web research usually lands in 30-90s
        await sleep(3000);
        let job;
        try { const p = await fetch('api/lookup/' + job_id); if (!p.ok) continue; job = await p.json(); }
        catch (e) { continue; }
        if (job.stage) onStep && onStep(job.stage);
        if (job.status === 'done' || job.status === 'error') return job.result || { error: 'lookup failed' };
      }
    } catch (e) { /* fall through */ }
    return { error: 'lookup timed out — try again' };
  },

  // Recall & safety check (#4, slice 1): make/model (or name) -> {status, summary,
  // url, remedy} or {error}. Same async job/poll shape as lookupFeatures.
  async checkRecall(a) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    try {
      const start = await fetch('api/recall', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: a.id || '', make: a.make || '', model: a.model || '', name: a.name || '' }) });
      if (!start.ok) return { error: 'recall check unavailable' };
      const { job_id, error } = await start.json();
      if (error) return { error };
      if (!job_id) return { error: 'recall check unavailable' };
      for (let n = 0; n < 80; n++) {          // web research usually lands in 30-90s
        await sleep(3000);
        let job;
        try { const p = await fetch('api/recall/' + job_id); if (!p.ok) continue; job = await p.json(); }
        catch (e) { continue; }
        if (job.status === 'done' || job.status === 'error') return job.result || { error: 'recall check failed' };
      }
    } catch (e) { /* fall through */ }
    return { error: 'recall check timed out — try again' };
  },

  // House assistant: send the conversation, poll the job, get {reply, changes}.
  // Changes are applied server-side to the shared store, so the caller should
  // re-sync afterwards to pull them down.
  async chat(messages) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    try {
      const start = await fetch('api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }) });
      if (!start.ok) return { reply: 'The assistant is unavailable right now.', changes: [] };
      const { job_id } = await start.json();
      if (!job_id) return { reply: 'The assistant is unavailable right now.', changes: [] };
      for (let n = 0; n < 90; n++) {              // up to ~3 min
        await sleep(2000);
        let job;
        try { const p = await fetch('api/chat/' + job_id); if (!p.ok) continue; job = await p.json(); }
        catch (e) { continue; }
        if (job.status === 'done' || job.status === 'error') {
          return job.result || { reply: 'That request failed.', changes: [] };
        }
      }
      return { reply: 'That took too long — try again.', changes: [] };
    } catch (e) { return { reply: 'Could not reach the assistant.', changes: [] }; }
  },

  // Is the backend Gmail configured? (send-and-auto-track vs. mailto fallback.)
  // Cached after the first probe so click handlers can read it synchronously.
  _emailAvail: undefined, _emailFrom: null,
  async emailAvailable() {
    if (this._emailAvail !== undefined) return this._emailAvail;
    try {
      const r = await fetch('api/enquiry/available'); const j = await r.json();
      this._emailAvail = !!(j && j.available); this._emailFrom = (j && j.from) || null;
    } catch { this._emailAvail = false; }
    return this._emailAvail;
  },
  // Send a user-approved enquiry via the backend Gmail. token lets the reply-poller
  // match the trade's reply back to this quote. Returns { ok, subject } / { ok:false, error }.
  async sendEnquiry({ to, cc, subject, body, token }) {
    try {
      const r = await fetch('api/enquiry/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, cc, subject, body, token }) });
      const j = await r.json().catch(() => ({}));
      return (r.ok && j.ok) ? { ok: true, subject: j.subject } : { ok: false, error: j.error || ('HTTP ' + r.status) };
    } catch (e) { return { ok: false, error: String(e) }; }
  },

  // Build a ready-to-send enquiry email asking for an annual service quote.
  enquiryEmail(asset) {
    const s = Store.state.settings, home = s.home || {};
    const mm = [asset.make, asset.model].filter(Boolean).join(' ');
    const subject = `Annual service quote — ${asset.name}${mm ? ' (' + mm + ')' : ''}`;
    const body =
`Hi,

I'm after a quote for annual servicing of the ${asset.name.toLowerCase()}${mm ? ` (${mm})` : ''} at my home${home.address ? ` in ${home.address}` : (typeof homeSuburb === 'function' && homeSuburb() ? ` in ${homeSuburb()}` : '')}.

${asset.location ? `Location: ${asset.location}\n` : ''}Could you please let me know:
• your price for a service/inspection,
• earliest availability, and
• whether you offer an ongoing annual plan.

Thanks!`;
    return { subject, body };
  },
};
