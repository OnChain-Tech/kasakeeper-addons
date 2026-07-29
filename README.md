# KasaKeeper add-ons

The Home Assistant add-on repository for **KasaKeeper** — the maintenance brain for your house. See the [KasaKeeper project](https://github.com/OnChain-Tech/kasakeeper) for what it does and how it works.

## Install

1. In Home Assistant, go to **Settings → Add-ons → Add-on store → ⋮ (top right) → Repositories**, paste this repository's URL and **Add**:

   ```
   https://github.com/OnChain-Tech/kasakeeper-addons
   ```
2. **Install.** Find **KasaKeeper** in the store list and click **Install** (first build pulls a base image · give it a few minutes).
3. **Set your key.** Open the add-on's **Configuration** tab and paste your `anthropic_api_key` (from console.anthropic.com), then save. The Google Places and Gmail options are optional · see the add-on's Documentation tab for what each unlocks.
4. **Start** the add-on, then open **KasaKeeper** from the Home Assistant sidebar (it runs behind ingress · your HA login is the auth, no separate password).
5. **Add your home.** Go to **Settings → ＋ Add a home** and type your address · KasaKeeper researches the property, proposes the systems it detects, and builds each one's maintenance schedule.

## What's in this repo

This is a thin *distribution* repository — each release, the add-on's runtime files are vendored in here from the private KasaKeeper development repo (see `docs/DISTRIBUTION.md` there for how). There is one add-on:

- `kasakeeper/` — the KasaKeeper add-on (config.yaml, Dockerfile, server, frontend, docs).

Current version: **0.3.14**.
