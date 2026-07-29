# 0.3.14

- **No more system pop-ups.** Every confirmation and every "how much did it cost?" now uses KasaKeeper's own dark (or Paper) dialog instead of the browser's grey OS box · twenty of them, from marking a job done to erasing everything. Destructive choices are labelled and red ("Delete asset", not "OK"), Escape and a tap outside both cancel, and Enter accepts. On the wall tablet a system dialog looked like the app had crashed; now it looks like the app.

# 0.3.13

Security and correctness pass over the quote email loop, from a full review of this week's releases.

- **Only the real trade can fill in your quote card.** Reply matching is now a true ladder (exact sender → the address we wrote to → their domain), every hit is verified against the message's real sender rather than a header substring, free-mail domains are never used as a domain match, and a message already belonging to another quote's thread is left alone. A stranger who knows the KasaKeeper mailbox address can no longer stage a quote, a price, or their own address behind the Reply button.
- **Quote tokens are validated** before they ever reach the mail server, and rejected at the store boundary.
- **One reply, one notification** · a busy moment can no longer turn a single trade reply into a burst of duplicate pushes.
- **Replying no longer rewinds a quote**: sending an in-app reply on a priced quote keeps the price and the state instead of dropping it back to "awaiting reply".
- Amounts parsed out of email are coerced properly ("$250" no longer becomes $0), and email-derived text is length-bounded everywhere it's stored or shown.
- New offline test suite `tools/test-quote-matching.py` covers seventeen matching and parsing cases, including the attack scenarios above.
# 0.3.12

- **Restarting an address search can't be hijacked by the first try**: if you rerun the Create-a-Home research while a slow earlier attempt is still thinking, the old attempt's late answer is now dropped instead of overwriting the new one.

# 0.3.11

- **The watch picker now looks at the whole appliance, not just the linked device**: an Eight Sleep "Side" is the device your asset links to, but "needs priming" lives on the pod's hub · discovery now follows the device family (hub ↔ sides) so those sensors show up in the picker instead of "No problem sensors found".

# 0.3.10

- **Device watch finds shy sensors too**: some integrations report problems as plain True/False sensors instead of proper binary sensors (Eight Sleep's "needs priming", a dishwasher's "salt low") · the sensor picker now offers those as watchable fault candidates instead of "No problem sensors found". Healthy-when-True sensors (has water, is priming) are left out so they can't raise a task that never clears.

# 0.3.9

- **Worn part? The order link is on the card**: when a device reports a consumable running out (brushes, filters, bags), KasaKeeper finds the exact replacement part's real product page for your model and puts a tappable 🛒 Order link right on the task · manufacturer's store first, validated before it lands.

# 0.3.8

- **Your devices can now raise their own hand**: an HA-linked asset can watch its device's problem sensors · bin full, fault codes, filter life. When one trips, a task lands on that asset ("reported today"), and one tap drafts the enquiry email with what the device is saying · every send still approved by you. Pick the sensors from the asset page under Device watch.

# 0.3.7

- **Times survive messy threads**: when a trade corrects themselves ("13:00 tomorrow" · "sorry, that is Thursday"), the offered date now lands as the corrected day with its time attached · "Thu 30 Jul 1:00 PM", not just "Thursday".

# 0.3.6

- **Ask knows what to ask**: the empty Ask screen now offers twenty starter questions in six groups · Right now, Money, Assets & warranties, Trades & quotes, Make changes, and (when connected) Live house. Chips adapt to your data — quote questions only appear when there are quotes to talk about.

# 0.3.5

- **Forward a trade's email and KasaKeeper reads it**: trades often reply to your personal inbox instead of the enquiry thread · forward that email to the KasaKeeper mailbox and the quote fills itself in on the next check, with the reply address kept as the trade's, not yours.

# 0.3.4

- **Reply matching got three tiers**: exact sender, the address the enquiry went to, then anyone at the trade's domain (with a job-mail relevance check so newsletters can't pose as replies) · catches the trade who answers from a different mailbox with a fresh subject.

# 0.3.3

- **Follow-ups without the tracking token are heard too**: when a trade sends a fresh email instead of replying (dropping the [KK-] subject token), KasaKeeper now also checks recent mail from their known address · Breezy's date offer is exactly this case.

# 0.3.2

- **KasaKeeper watches the whole conversation now**: replies keep being read until the job is booked · a trade who quotes first and offers dates in a second email no longer goes unheard.
- **Payments are read too**: a mentioned deposit shows on the card as "✓ $X paid · receipt #N · $Y owing" · recorded facts, never actions.
- **Reply without leaving**: quote cards gained an in-app ✉︎ Reply that keeps the tracked thread (and your approval step) · no more bouncing to a mail app.
- **Book from anywhere**: a phone-confirmed job books straight from the reply-in card · 📌 Book captures date and time, the confirmation email stays optional.

# 0.3.1

- **Trade replies now surface properly**: a reply that isn't a clean quote (a dispute, a question, "need to see it first") flips the card to a blue **reply in** state with the summary, a one-tap Log quote and a direct ✉︎ Reply · no more cards stuck on "awaiting reply" after the trade has answered. Existing stuck cards repair themselves on the next mail poll.
- **Proposed costs and dates are decisions, not facts**: the quote card leads with the number on Book it and adds ✎ Change; date offers stay one-tap confirmable. Every processed reply now pushes to your phone · a priced quote leads with the amount.
- **Idle devices stay fresh**: the wall tablet reconciles with the shared store every 3 minutes, so quote updates appear without touching it.

# 0.3.0

The multi-home release · KasaKeeper now works for houses beyond the one it runs in, and for households beyond the first.

- **Every home gets its own settings**: suburb, "due soon" window and notification target now live per home, with your existing global values still honoured as the fallback.
- **Every home picks its Home Assistant**: this add-on (as always, zero setup), a different Home Assistant (URL + long-lived token, kept server-side only), or none at all · schedules stay calendar-only and nothing nags about a connection that isn't there. Drift detection, weather, the daily brief and usage tracking all follow each home's choice.
- **First-run key wizard**: a new install now walks you through getting and testing each API key · Anthropic (research, snap, ask, recalls), Google Places (richer find-a-service) and Gmail (quote emails) · straight from the setup screen or Settings. Keys are tested against the real service before saving, stored on the server only, and never shown back.
- **Safer by construction**: pasted remote-HA URLs are strictly validated (private, loopback and cloud-metadata addresses rejected; connections pinned to the vetted IP; redirects refused), and the find-a-service fallback no longer carries any location baked into the source.
- For developers: CONTRIBUTING.md is new · zero-build philosophy, dev setup and the cache-bump rule, ready for the project's first outside contributor.

# 0.2.3

- Last of the punctuation pass: the start-tracking banner and the push-test result now use the house `·` instead of em-dashes, and the Cc-me helper text reads as a proper muted note.

# 0.2.2

- **One design language everywhere**: the full-UI consistency pass lands — Find-a-service, Add-a-service, the edit forms, Snap, Triage and every legacy sub-section (snoozed tasks, quote lists, correspondence, asset packs) now speak the same instrument row language as the rebuilt screens. Status is always colour *plus* text, every tap target clears 44px, helper notes read as notes, and the setup banners sit flat on the surface in both themes.
- **Assets list tells you why**: the bare status dot is now a labelled pill ("3d overdue" · "ok"), and empty states offer the next tap instead of a dead end.
- **Under the hood**: dead code removed across the stylesheet, app and server; the three vault-serving endpoints share one guarded helper; dev tools no longer ship inside the add-on image.
- Hygiene for the public add-on repository: the owner's street address is scrubbed from source — the offline research stub, the address-field placeholder and prompt examples are now generic.

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
