# KasaKeeper

The maintenance brain for your house. Give it an address and it researches the property, builds each system's maintenance schedule, tracks cost and warranties, manages your trades, finds new suppliers, emails them for quotes and reads the replies · and where Home Assistant can measure it, reminds you by how hard a thing is actually being used rather than just the calendar. It runs entirely on your own Home Assistant box · your data never leaves the house.

## What it does

- **Create a home from an address** · Claude reads public real-estate listings *and* inspects satellite imagery to detect pool, spa, solar, gardens, levels and more. Detected systems come pre-selected · the rest of the service catalogue is offered below to toggle on.
- **Automatic schedules** · every asset gets sensible maintenance tasks from a catalogue with variants (e.g. Hot water → Gas storage / Heat pump / Solar), each with its own cadence and cost.
- **Snap an asset** · photograph an appliance's nameplate and KasaKeeper reads the make, model and serial, then researches that exact unit · real specs, the manufacturer's schedule and the manual. One tap applies the maker's own intervals.
- **Dashboard** · a home-health score, what's overdue / due soon, upcoming cost, warranty status and weather-aware nudges from your own Home Assistant weather.
- **Trades & quotes** · find the best-reviewed local businesses for a specific asset, request a quote (drafted for your approval), and a background poller reads the reply, extracts the price and availability, and fills the quote in on every device.
- **Live Home Assistant data** · device values on asset cards, usage-based reminders (run-hours / energy), and a morning brief pushed to your phone.
- **Ask** · the house assistant answers from your real data · "what needs doing this month?", "who services the aircon and what does it cost a year?", "log the gutter clean as done".
- **Multi-device** · phone, wall tablet and web share one live store · state lives on the HA host.

## Configuration

Only the Anthropic key is required · everything else unlocks an optional capability. With no optional keys the app still runs · find-a-service falls back to keyless web search and enquiries open your device's mail client.

| Option | Required | What it unlocks |
| --- | --- | --- |
| `anthropic_api_key` | **Yes** | Live property research, aerial vision, nameplate reading, asset feature lookup and the Ask assistant. Without it, research falls back to a baseline home profile. Get one at console.anthropic.com. |
| `google_places_api_key` | No | Find-a-service ranks real local businesses by rating × reviews, with photos and contacts. Without it, find-a-service uses keyless web search. |
| `gmail_user` | No | The mailbox KasaKeeper sends trade enquiries from and polls for replies. Pair with `gmail_app_password`. Use a dedicated Gmail account, not your personal inbox. |
| `gmail_app_password` | No | A 16-character Gmail **app password** (not your login password · create one at myaccount.google.com/apppasswords with 2-step verification on). Enables the email quote-loop · without it, enquiries open your device's mail client instead. |
| `suburb` | No | Your suburb, biasing find-a-service results toward your area when an address hasn't been set yet. |

All keys are read at runtime and stay server-side · they are never sent to the browser, logged or baked into the image. Changing an option and restarting the add-on applies it (options are read at runtime · only code changes need a rebuild).

## First run

1. Install the add-on and open its **Configuration** tab.
2. Paste your `anthropic_api_key` and save. Add any optional keys you want now or later.
3. **Start** the add-on, then open **KasaKeeper** from the Home Assistant sidebar.
4. Go to **Settings → ＋ Add a home** and type your address. KasaKeeper researches the property and proposes the systems it detects · tick what's real and it builds each one's schedule from sensible defaults.
5. If your services already have history, tap **Start tracking** on the dashboard to mark everything serviced today · countdowns begin from there. Or set each task's *Last done* date by hand for accurate due dates from day one.
6. Add your fastest assets with **＋ → 📷 Snap** · photograph a nameplate and apply the maker's schedule in one tap.

**Install to a phone:** open KasaKeeper in the browser, then Share → *Add to Home Screen*. It runs full-screen with its own icon and shares the same live house.

## The morning brief

At 8am in your Home Assistant timezone, a push notification summarises what's overdue, what's due soon and any weather nudges · delivered through your Home Assistant companion app. Toggle it in **Settings**. Because `homeassistant_api` is enabled, the add-on reads live HA state through the Supervisor token · there is no user token to set up.

## Your data

Everything lives on your own Home Assistant box under `/data`, which is included in Home Assistant backups · back up HA and you back up your whole house record. Nothing is stored in the cloud.

## Privacy

- **Keys stay server-side.** The Anthropic, Google and Gmail keys live in the add-on's Configuration and are read at runtime · never sent to the browser, never logged, never committed. Image proxies keep the Google key off the wire.
- **The email loop is read-only.** The reply poller only reads your dedicated mailbox to update quote status · it never deletes or replies on its own.
- **Every send is approved by you.** Enquiry and booking emails are drafted for your approval · nothing is sent without you.
- **Auth is handled by Home Assistant.** KasaKeeper runs behind HA ingress, so access uses your existing Home Assistant login · there is no separate password and no exposed port.

## Troubleshooting

- **Research falls back to a baseline home** · the `anthropic_api_key` is missing or invalid. Check the add-on log for "No Anthropic key set".
- **A code change didn't take effect** · code is baked in at build time. Rebuild the add-on (⋮ → Rebuild), don't just restart. Configuration option changes only need a restart.
- **Find-a-service results look thin** · add a `google_places_api_key` for rated, contactable local businesses.
