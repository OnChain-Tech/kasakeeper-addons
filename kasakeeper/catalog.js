// KasaKeeper — full service catalog. Each service is addable manually, and many
// have VARIANTS (the specific type) that carry their own maintenance schedule,
// e.g. hot water: gas storage vs electric vs heat-pump vs solar.
// Task shape is compact: { t: title, d: cadenceDays, c: estCost }.
const SERVICES = [
  // ---- Water ----
  { cat: 'Water', name: 'Hot water service', variants: [
      { name: 'Gas storage',           tasks: [{ t: 'Gas hot-water service & relief-valve test', d: 365, c: 180 }, { t: 'Sacrificial anode check', d: 1825, c: 0 }] },
      { name: 'Gas continuous / instant', tasks: [{ t: 'Gas hot-water service', d: 365, c: 150 }] },
      { name: 'Electric storage',      tasks: [{ t: 'Relief-valve test', d: 365, c: 0 }, { t: 'Sacrificial anode replacement', d: 1825, c: 120 }] },
      { name: 'Heat pump',             tasks: [{ t: 'Heat-pump HWS service & filter clean', d: 365, c: 150 }] },
      { name: 'Solar (roof)',          tasks: [{ t: 'Solar HWS service & valves', d: 365, c: 150 }] },
  ]},
  { cat: 'Water', name: 'Mains water filter', tasks: [{ t: 'Replace filter cartridge', d: 365, c: 120 }] },
  { cat: 'Water', name: 'Rainwater tank', tasks: [{ t: 'Clean & inspect tank', d: 365, c: 0 }, { t: 'Check pump & first-flush', d: 365, c: 0 }] },

  // ---- HVAC / cooling ----
  { cat: 'HVAC', name: 'Air conditioning', variants: [
      { name: 'Ducted reverse-cycle', tasks: [{ t: 'Clean return-air filter', d: 180, c: 0 }, { t: 'Professional service', d: 365, c: 200, s: 'summer' }] },
      { name: 'Split system',         tasks: [{ t: 'Clean filters', d: 90, c: 0 }, { t: 'Professional service', d: 365, c: 150, s: 'summer' }] },
      { name: 'Evaporative cooler',   tasks: [{ t: 'Pre-summer service & pad check', d: 365, c: 180, s: 'summer' }] },
      { name: 'Ducted gas heating',   tasks: [{ t: 'Annual gas heater service & CO test', d: 365, c: 200, s: 'winter' }] },
  ]},

  // ---- Heating ----
  { cat: 'Heating', name: 'Gas heater / bayonet', tasks: [{ t: 'Annual gas service & safety check', d: 365, c: 180, s: 'winter' }] },
  { cat: 'Heating', name: 'Wood fireplace / flue', tasks: [{ t: 'Chimney sweep & flue inspection', d: 365, c: 200, s: 'winter' }] },
  { cat: 'Heating', name: 'Gas log fire', tasks: [{ t: 'Annual service & glass seal check', d: 365, c: 180, s: 'winter' }] },

  // ---- Pool / spa / sauna ----
  { cat: 'Pool/Spa', name: 'Pool', tasks: [{ t: 'Balance water chemistry', d: 7, c: 15, s: 'summer' }, { t: 'Clean filter cartridge', d: 30, c: 25 }, { t: 'Equipment service', d: 365, c: 200 }] },
  { cat: 'Pool/Spa', name: 'Spa', tasks: [{ t: 'Balance water chemistry', d: 7, c: 15, s: 'summer' }, { t: 'Clean filter cartridge', d: 30, c: 25 }] },
  { cat: 'Sauna', name: 'Sauna', variants: [
      { name: 'Infrared',   tasks: [{ t: 'Wipe down & check emitters', d: 90, c: 0 }] },
      { name: 'Traditional', tasks: [{ t: 'Check heater & stones', d: 180, c: 0 }] },
  ]},

  // ---- Energy ----
  { cat: 'Energy', name: 'Solar / battery', variants: [
      { name: 'Solar + battery', tasks: [{ t: 'Clean solar panels', d: 365, c: 150 }, { t: 'Battery health check', d: 365, c: 0 }, { t: 'Inverter check', d: 365, c: 0 }] },
      { name: 'Solar panels only', tasks: [{ t: 'Clean solar panels', d: 365, c: 150 }, { t: 'Inverter check', d: 365, c: 0 }] },
  ]},

  // ---- Safety ----
  { cat: 'Safety', name: 'Smoke alarms', variants: [
      { name: 'Photoelectric (10-yr)', tasks: [{ t: 'Test all alarms', d: 30, c: 0 }, { t: 'Replace units (10-yr)', d: 3650, c: 200 }] },
      { name: '9V battery',            tasks: [{ t: 'Test all alarms', d: 30, c: 0 }, { t: 'Replace 9V batteries', d: 365, c: 20 }] },
      { name: 'Hardwired',             tasks: [{ t: 'Test all alarms', d: 30, c: 0 }, { t: 'Replace backup batteries', d: 365, c: 20 }] },
  ]},
  { cat: 'Safety', name: 'Security alarm', tasks: [{ t: 'Service & backup battery', d: 365, c: 80 }] },
  { cat: 'Safety', name: 'Fire extinguisher / blanket', tasks: [{ t: 'Check & tag', d: 365, c: 0 }] },

  // ---- Roof / exterior ----
  { cat: 'Roof/Exterior', name: 'Gutters', tasks: [{ t: 'Clean gutters & downpipes', d: 182, c: 180, s: 'autumn' }] },
  { cat: 'Roof/Exterior', name: 'Roof', tasks: [{ t: 'Inspect roof & flashings', d: 365, c: 0 }] },
  { cat: 'Roof/Exterior', name: 'Timber deck', tasks: [{ t: 'Oil / reseal deck', d: 365, c: 150 }] },
  { cat: 'Roof/Exterior', name: 'Pest / termite', tasks: [{ t: 'Annual termite inspection', d: 365, c: 300 }] },

  // ---- Garden / grounds ----
  { cat: 'Garden', name: 'Gardens & lawn', variants: [
      { name: 'Weekly',     tasks: [{ t: 'Mow, edge & tidy', d: 7, c: 60 }] },
      { name: 'Fortnightly', tasks: [{ t: 'Mow, edge & tidy', d: 14, c: 80 }] },
      { name: 'Monthly',    tasks: [{ t: 'Leaf & dead-branch clean-up', d: 30, c: 150 }] },
  ]},
  { cat: 'Garden', name: 'Hedges & trees', tasks: [{ t: 'Prune / trim', d: 365, c: 200 }] },
  { cat: 'Garden', name: 'Irrigation system', tasks: [{ t: 'Seasonal check & adjust', d: 182, c: 0 }] },
  { cat: 'Garden', name: 'Hanging / wall gardens', tasks: [{ t: 'Annual maintenance service', d: 365, c: 250 }] },

  // ---- Pumps / water features ----
  { cat: 'Pump', name: 'Pond / water feature', tasks: [{ t: 'Clean pump & filter', d: 90, c: 0 }] },
  { cat: 'Pump', name: 'Sump / bore pump', tasks: [{ t: 'Test & inspect', d: 365, c: 0 }] },

  // ---- Lighting / cameras ----
  { cat: 'Lighting', name: 'Outdoor / feature lighting', tasks: [{ t: 'Check globes & cabling', d: 365, c: 0 }] },
  { cat: 'Camera', name: 'Security cameras', tasks: [{ t: 'Clean lenses / check mounts', d: 180, c: 0 }] },

  // ---- Vehicle ----
  { cat: 'Vehicle', name: 'Car', tasks: [{ t: 'Logbook service', d: 365, c: 350 }, { t: 'Tyre rotation', d: 180, c: 0 }, { t: 'Cabin air filter', d: 730, c: 40 }] },

  // ---- Appliances ----
  { cat: 'Appliance', name: 'Dishwasher', tasks: [{ t: 'Clean filter & descale', d: 180, c: 0 }] },
  { cat: 'Appliance', name: 'Oven / range hood', tasks: [{ t: 'Deep clean & filter', d: 180, c: 0 }] },
  { cat: 'Appliance', name: 'Washing machine', tasks: [{ t: 'Clean seal & run cleaning cycle', d: 90, c: 0 }] },
  { cat: 'Appliance', name: 'Garage door', tasks: [{ t: 'Service & lubricate tracks', d: 365, c: 0 }] },

  // ---- Cleaning ----
  { cat: 'Cleaning', name: 'House cleaning', variants: [
      { name: 'Weekly',      tasks: [{ t: 'House clean', d: 7, c: 120 }] },
      { name: 'Twice weekly', tasks: [{ t: 'House clean', d: 3, c: 120 }] },
      { name: 'Fortnightly', tasks: [{ t: 'House clean', d: 14, c: 160 }] },
  ]},
  { cat: 'Cleaning', name: 'Window cleaning', tasks: [{ t: 'Clean windows inside & out', d: 182, c: 150 }] },
];

const Catalog = {
  all: () => SERVICES,
  get: idx => SERVICES[idx],
  cats() { const seen = []; SERVICES.forEach(s => { if (!seen.includes(s.cat)) seen.push(s.cat); }); return seen; },
  inCat(cat) { return SERVICES.map((s, idx) => ({ idx, s })).filter(x => x.s.cat === cat); },

  // Best service in a category for a detected label (word overlap; else first).
  match(category, label) {
    const L = (label || '').toLowerCase();
    const cands = SERVICES.map((s, idx) => ({ idx, s })).filter(x => x.s.cat === category);
    if (!cands.length) return null;
    let best = null, bestScore = -1;
    for (const c of cands) {
      const words = c.s.name.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 3);
      let score = 0;
      for (const w of words) if (L.includes(w)) score++;
      if (score > bestScore) { best = c; bestScore = score; }
    }
    return bestScore > 0 ? best : cands[0];
  },

  // Expand a service (+ optional variant) to [{title, cadenceDays, estCost}].
  tasksFor(svc, variantName) {
    let raw = svc.tasks;
    if (svc.variants) {
      const v = svc.variants.find(x => x.name === variantName) || svc.variants[0];
      raw = v.tasks;
    }
    return (raw || []).map(t => ({ title: t.t, cadenceDays: t.d, estCost: t.c, lastDone: '', ...(t.s ? { season: t.s } : {}) }));
  },
};
