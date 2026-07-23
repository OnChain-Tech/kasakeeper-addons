// KasaKeeper — categories + default maintenance schedules. Generic; homes are created by the user.
const CATEGORIES = {
  Water:          { icon: '💧', defaults: [{ title: 'Replace filter cartridge', cadenceDays: 365, estCost: 120 }] },
  Garden:         { icon: '🪴', defaults: [{ title: 'Annual maintenance service', cadenceDays: 365, estCost: 250 }] },
  HVAC:           { icon: '❄️', defaults: [{ title: 'Clean filters', cadenceDays: 180, estCost: 0 }, { title: 'Professional service', cadenceDays: 365, estCost: 200, season: 'summer' }] },
  Heating:        { icon: '🔥', defaults: [{ title: 'Annual gas service & safety check', cadenceDays: 365, estCost: 180, season: 'winter' }] },
  Cleaning:       { icon: '🧹', defaults: [{ title: 'House clean', cadenceDays: 3, estCost: 120 }] },
  'Pool/Spa':     { icon: '🛁', defaults: [{ title: 'Balance water chemistry', cadenceDays: 7, estCost: 15, season: 'summer' }, { title: 'Clean filter cartridge', cadenceDays: 30, estCost: 25 }] },
  Sauna:          { icon: '🧖', defaults: [{ title: 'Wipe down & check heaters', cadenceDays: 90, estCost: 0 }] },
  Energy:         { icon: '🔋', defaults: [{ title: 'Clean solar panels', cadenceDays: 365, estCost: 150 }, { title: 'Battery health check', cadenceDays: 365, estCost: 0 }] },
  Safety:         { icon: '🚨', defaults: [{ title: 'Test alarms', cadenceDays: 30, estCost: 0 }, { title: 'Replace batteries', cadenceDays: 365, estCost: 20 }] },
  'Roof/Exterior':{ icon: '🏠', defaults: [{ title: 'Clean gutters & downpipes', cadenceDays: 182, estCost: 180, season: 'autumn' }] },
  Vehicle:        { icon: '🚗', defaults: [{ title: 'Cabin air filter', cadenceDays: 730, estCost: 40 }, { title: 'Tyre rotation', cadenceDays: 180, estCost: 0 }] },
  Lighting:       { icon: '💡', defaults: [{ title: 'Check globes & cabling', cadenceDays: 365, estCost: 0 }] },
  Pump:           { icon: '⚙️', defaults: [{ title: 'Clean pump & filter', cadenceDays: 90, estCost: 0 }] },
  Camera:         { icon: '📷', defaults: [{ title: 'Clean lenses / check mounts', cadenceDays: 180, estCost: 0 }] },
  Appliance:      { icon: '🔌', defaults: [{ title: 'Service / descale', cadenceDays: 365, estCost: 0 }] },
  Vehicle:        { icon: '🚗', defaults: [
    { title: 'Annual service', cadenceDays: 365, estCost: 0 },
    { title: 'Tyre rotation & pressure check', cadenceDays: 180, estCost: 0 },
    { title: 'Registration renewal', cadenceDays: 365, estCost: 0 },
  ] },
};

// Fresh install starts empty — the user creates their home(s) via the Create-a-Home flow.
const SEED = {
  homes: [],
  currentHomeId: null,
  providers: [],
  assets: [],
  tasks: [],
  logs: [],
  quotes: [],
  settings: { haUrl: '', haToken: '', suburb: '', soonDays: 30, emailCc: '' },
};
