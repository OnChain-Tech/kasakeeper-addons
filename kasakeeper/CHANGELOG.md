# 0.2.1

Five roadmap items land at once — built in parallel by the big-feature fan-out, each reviewed and verified in its own thread.

- **The re-research sweep lives on the server now**: close the tab, walk away — it keeps going, every device watches the same live progress, and proposals appear everywhere as each asset finishes. Skip and Stop are server calls; a reloaded page reattaches automatically.
- **Scheduled recall sweep**: once a month (capped and staggered) every make/model asset is checked against ACCC Product Safety and the manufacturer. A found recall lands on the asset with the remedy and source, adds a morning-brief line until you tap "OK, seen", and there's a manual "Run recall sweep now" in Settings → Developer.
- **Registry drift detection**: KasaKeeper now notices when Home Assistant disagrees with an asset (firmware moved, device vanished, new hardware appeared) — a Settings banner and a morning-brief sentence point you at the import screen; nothing changes without your approval, and vanished devices get a clean Unlink.
- **Smarter import**: cars are cars now (climate + odometer + tracker → 🚗 Vehicle, metered by energy), and a smart lock can never overwrite a non-lock asset — the proposal that tried to turn a timber front door into an August lock is structurally impossible.
- **Distribution pipeline**: `tools/publish-dist.sh` assembles the complete public add-on repo, verified by `tools/verify-dist.sh` — one push from shipping to the first external user.

# 0.2.0

The roadmap milestone release — R1 through R4 of the original plan are complete, so the minor version steps up per the versioning policy.

- **Vehicles are first-class assets**: a 🚗 Vehicle category with a sensible default schedule (annual service, tyre rotation & pressure, rego renewal). Born from importing a real Tesla Model X from Home Assistant — it arrived metered by its own lifetime-energy sensor.
- Roadmap refreshed: R1–R4 shipped; the live backlog is distribution, the scheduled recall sweep, HA drift detection, and import-filter tuning.

# 0.1.9

- **Watch the sweep work**: re-research now shows a live feed of what it finds per asset ("✓ Gutters — 3 tasks proposed · manual found") and a **⏭ Skip this one** button that moves on in under half a second. Stop also takes effect immediately.
- **Edit your home's facts**: address, levels, beds and baths are now correctable on the current home's Settings card — research proposes, you dispose.

# 0.1.8

The MOAT release — KasaKeeper talks to the hardware. QA-tested end to end (the LG-battery → Tesla Powerwall case is the acceptance test, and it passes).

- **Import from Home Assistant** (Settings → Home Assistant): KasaKeeper reads HA's device registry — the real manufacturer, model and serial of what's physically on the wall — and proposes new assets or field-level corrections to existing ones (make: LG → Tesla). You approve each item; a manual edit is never overwritten, even mid-race with another device.
- **Auto-linked telemetry**: imported assets (new *and* corrected) arrive with their usage entity already wired — service by real run-hours or kWh from day one, no entity ids typed. The Track-usage screen also gained a picker with a one-tap best-guess match.
- **Live readings** on the asset page for HA-linked assets.
- **Setup is a landing page**: the first screen now sells and teaches — brand hero, how-it-works, feature strip — with Google **address autocomplete**, a **test-home** option, and **quick add** (type assets one per line; research fills in the rest).
- **Test-home mode**: keep a friend's house or a demo without touching your Home Assistant — no live data, no weather nudges, no morning brief. Pick a street-view/aerial **photo for each home**, shown on the dashboard and in Settings.
- **Suburb is per-home now**: adding a second home no longer hijacks the first one's service searches. Each home keeps its own search location; the Settings field edits the home you're in.

# 0.1.7

Six parallel work-streams land at once — R2/R3/R4 roadmap features, each built and reviewed in its own thread.

- **Recall & safety check**: any asset with a make/model can be checked against ACCC Product Safety and the manufacturer ("🛡 Check for recalls"); a found recall becomes an urgent task with the remedy and source link, one tap.
- **Seasonal windows**: seasonal jobs (aircon, pool, gutters, heating) wear a "before summer"-style chip as their season approaches. Display-only — no due dates moved.
- **Ask, grounded in your real telemetry**: the assistant now sees your usage-tracked assets' live entity states and shows chips for what grounded each answer. Destructive actions (complete, snooze, reduce a pack) are now proposed, not executed — you confirm each one in the chat.
- **Trades rebuilt** in the instrument language (railed rows, provider logos, lifetime spend) + **warranty claim helper**: in-warranty assets get "🛡 Claim warranty" — a prefilled claim letter with model, serial and dates, approved by you before it sends.
- **Settings rebuilt** in the instrument language.
- **Sync that can't eat your work**: a version conflict now merges by entity instead of adopting the server copy wholesale — local additions survive, and deletions carry tombstones so a stale device can't resurrect them.
- **Inspection report import**: feed it a building/pest inspection PDF and the defects become schedule items you approve one by one.
- **Home logbook export** (Settings → Data): a branded PDF of the whole house — assets, service history, spend.
- **Distribution pack**: DOCS.md for the add-on's Documentation tab, install README, store artwork, and a quickstart for the first Melbourne install.

# 0.1.6

The transparency release — you can now SEE what KasaKeeper is doing, and correct it.

- **The search query is always visible**: Find a service shows exactly what it's searching for ("3D printer repair and maintenance") with a one-tap "wrong? edit the asset" escape hatch.
- **Developer drawer** (Settings → Developer): a live device-local panel showing the data behind every action — search queries, research payloads, results. Built for "tell Claude exactly what's wrong".
- **Live progress in API searches**: research and find jobs report their real stages as they run — including the actual web searches Claude performs ("Searched "Bambu X1C maintenance schedule"…").
- **Re-research all assets** (Settings → Data): reprocess existing assets with the current research smarts — older assets keep old guesses. Results wait as "✦ research ready" proposals; nothing changes without your Apply.
- **Asset-level DIY**: mark a whole asset as yours — "no service provider linked" now offers "mark it DIY". DIY assets stop nagging for suppliers everywhere.
- **Back button fixed**: ‹ Back now climbs the screen hierarchy (task → asset → assets → home) instead of replaying history — no more edit-task loops. The URL hash stays a shareable deep link.
- Fixed a crash on a provider profile with an open quote.

# 0.1.5

- **Find a service searches for the actual asset**: tapping find on a limestone wall now queries "Limestone wall repair and maintenance", not the category's generic trade (which sent gutter cleaners to a stone wall). A "Trade to call" override on the asset still wins verbatim.
- **User guide**: a full guide ships with the app — linked at the bottom of Settings, works offline.

# 0.1.4

- **Assets list rebuilt**: railed rows with brand-logo tiles in category groups; the Warranties tab gets status rails and mono pills (expired / days left). Untracked assets keep their honest hollow dot.

# 0.1.3

- **Schedule rebuilt** in the instrument language: railed rows grouped by who's on the hook (Needs a supplier · Awaiting a quote · Assigned · DIY), one context action per row (book / call / manage quote / find / DIY), status pills, brand-logo tiles. Editing, snoozing and deleting live one tap away on the asset page.

# 0.1.2

The "Every asset knows itself" release (roadmap R1), plus the full UI rebuild groundwork.

- **Snap 2.0**: photograph a nameplate → identify → maker research auto-runs → one-tap Apply for the manufacturer's schedule.
- **Feature lookup**: any asset with a make/model can fetch its real specs, the manufacturer's maintenance schedule, and the manual (Claude + web search, apply-on-approval).
- **Document vault (first slice)**: "keep a copy" fetches the manual PDF onto the add-on's own storage — survives dead links, opens on every device.
- **Provenance**: tasks tuned from the manual carry a "maker's interval" marker, and run-hour intervals convert straight into the live usage threshold ("42 / 150 hrs · maker's").
- **Brand logos** on every asset tile (make → logo, emoji fallback).
- **Two themes**: Night (wall tablet) and Paper (desktop), per-device choice in Settings → Appearance.
- **Rebuilt screens**: dashboard as an instrument (gauge, segmented status bar, railed rows, quote chips, date-rail) and the asset page in the same language.
- **DIY jobs**, quotes on the dashboard, honest quote cards, 13 UX-audit fixes, ~30 security/correctness hardenings, `ownerName` email sign-off setting.

# 0.1.1

- The KasaKeeper eye-house mark as the sidebar icon (custom `kk:` iconset).

# 0.1.0

- Initial add-on: research-a-home onboarding, schedules, trades CRM with approved-email quote loop, Home Assistant live data + usage tracking, morning brief.
