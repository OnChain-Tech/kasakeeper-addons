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
- **Multi-home, multi-device** · phone, wall tablet and web share one live store · state lives on the HA host. Add more than one home, and give each its own Home Assistant connection.

## Configuration

Only the Anthropic key is required · everything else unlocks an optional capability. With no optional keys the app still runs · find-a-service falls back to keyless web search and enquiries open your device's mail client.

There are two ways to set a key, and you can mix them:

- **The add-on's Configuration tab** · the usual place, set once before or after Start.
- **The in-app key wizard** (🔑 in Settings, or the "Set up API keys" prompt on the Add-a-home screen) · paste a key, tap **Test** to check it against the real service before committing, then **Save**. It writes straight to the add-on's own storage and takes effect immediately, no restart.

If a key is set in both places, the Configuration-tab value always wins — the wizard only fills a key that Configuration leaves blank.

| Option | Required | What it unlocks |
| --- | --- | --- |
| `anthropic_api_key` | **Yes** | Property research, aerial vision, nameplate reading (Snap), asset feature lookup and the Ask assistant. Without it, research falls back to a generic baseline profile instead of your actual home. Get one at console.anthropic.com. |
| `google_places_api_key` | No | Find-a-service ranks real local businesses by rating × reviews, with photos and contacts. Without it, find-a-service falls back to a plain keyless web-search link. |
| `gmail_user` | No | The mailbox KasaKeeper sends trade enquiries from, polls for replies, and can one-time-import your existing trades from. Pair with `gmail_app_password`. Use a dedicated Gmail account, not your personal inbox. |
| `gmail_app_password` | No | A 16-character Gmail **app password** (not your login password · create one at myaccount.google.com/apppasswords with 2-step verification on). Enables the email quote-loop · without it, enquiries open your device's mail client instead. |
| `suburb` | No | A fallback suburb for find-a-service before any home has one set. Each home's own suburb (Settings → this home's preferences) takes priority once you've added it. |

Keys stay server-side either way · they are never sent to the browser, logged or baked into the image. A Configuration-tab change needs a restart to apply; a wizard/Settings save is live immediately (only code changes need a rebuild).

## First run

1. Install the add-on, then **Start** it — no keys are required to start.
2. Open **KasaKeeper** from the Home Assistant sidebar. With no home yet, you land on the **Add a home** screen.
3. If no Anthropic key is set yet, a banner offers **Set up API keys (2 min)** — tap it for the guided wizard (or open it any time from **Settings → 🔑 Manage API keys**).
4. The wizard walks each key in turn — **Anthropic** first (required), then **Google Places** and **Gmail** (optional, skip either freely): numbered console steps and a direct link, a paste field, **Test** to confirm it really works, then **Save**. A ✓ on the step tabs shows what's connected, live, no restart needed.
5. Back on **Add a home**, type your address · KasaKeeper researches the property and proposes the systems it detects · tick what's real and it builds each one's schedule from sensible defaults.
6. If your services already have history, tap **Start tracking** on the dashboard to mark everything serviced today · countdowns begin from there. Or set each task's *Last done* date by hand for accurate due dates from day one.
7. Add your fastest assets with **＋ → 📷 Snap** · photograph a nameplate and apply the maker's schedule in one tap.
8. **This home's Home Assistant** (Settings, per home) — choose how this home gets live device data:
   - **This add-on** (default) · uses the Home Assistant the add-on itself runs on. No setup.
   - **A different Home Assistant** · for a second home, or a friend's own separate instance. Needs a URL the add-on can actually reach — a Nabu Casa remote-access address or a properly reverse-proxied hostname works; a VPN also works if it hands out a routable address, but a bare LAN IP (like `192.168.x.x`) is rejected on purpose, the same guard that stops any pasted URL reaching into your network. You'll also need a long-lived access token from that Home Assistant's own profile page. **Test connection** before saving; the token is stored on the server only, keyed to that home, and never reaches any device.
   - **Not connected** · no live device data for this home, schedules stay calendar-only. Fine for a test home, a demo, or one you haven't wired up yet.

**Install to a phone:** open KasaKeeper in the browser, then Share → *Add to Home Screen*. It runs full-screen with its own icon and shares the same live house.

## The morning brief

At 8am in your Home Assistant timezone, a push notification summarises what's overdue, what's due soon and any weather nudges · delivered through your Home Assistant companion app. Toggle it in **Settings**. For a home left on the default **This add-on** connection, live HA state comes through the Supervisor token · there is no user token to set up. A home on **A different Home Assistant** or **Not connected** doesn't get device-driven nudges, but the calendar-based brief still runs.

## Your data

Everything lives on your own Home Assistant box under `/data`, which is included in Home Assistant backups · back up HA and you back up your whole house record. Nothing is stored in the cloud.

## Privacy

- **Keys stay server-side.** The Anthropic, Google and Gmail keys — whether set in the add-on's Configuration or saved through the in-app key wizard — are read at runtime and never sent to the browser, never logged, never committed. Image proxies keep the Google key off the wire.
- **A remote home's Home Assistant token stays server-side too.** It's stored keyed to that one home, separately from your keys above, and separately from the shared multi-device store — no device ever receives it, only the home's chosen connection mode and URL sync.
- **The email loop is read-only.** The reply poller only reads your dedicated mailbox to update quote status · it never deletes or replies on its own.
- **Every send is approved by you.** Enquiry and booking emails are drafted for your approval · nothing is sent without you.
- **Auth is handled by Home Assistant.** KasaKeeper runs behind HA ingress, so access uses your existing Home Assistant login · there is no separate password and no exposed port.

## Troubleshooting

- **Research falls back to a baseline home** · the Anthropic key is missing or invalid. Check the add-on log for "No Anthropic key set", or revisit it in the key wizard (Settings → 🔑 Manage API keys) and **Test** it.
- **A code change didn't take effect** · code is baked in at build time. Rebuild the add-on (⋮ → Rebuild), don't just restart. Configuration option and in-app key changes both apply without a rebuild.
- **Find-a-service results look thin** · add a Google Places key (Configuration tab or the key wizard) for rated, contactable local businesses.
- **A remote Home Assistant won't connect** · the URL has to be reachable from the add-on itself, not just from your phone or laptop — a bare LAN address like `192.168.x.x` is rejected by design. Use **Test connection** before saving, and prefer a Nabu Casa remote-access URL or a properly reverse-proxied hostname. A wrong or expired token fails the same test.
