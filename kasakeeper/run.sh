#!/usr/bin/with-contenv bashio
# KasaKeeper add-on entrypoint: options -> env, then run the same server.py under ingress.

export ANTHROPIC_API_KEY="$(bashio::config 'anthropic_api_key')"
export KASA_GOOGLE_API_KEY="$(bashio::config 'google_places_api_key')"
export GMAIL_USER="$(bashio::config 'gmail_user')"
export GMAIL_APP_PASSWORD="$(bashio::config 'gmail_app_password')"
export KASA_SUBURB="$(bashio::config 'suburb')"
export KASA_HOST="0.0.0.0"     # HA ingress proxies to this; HA enforces auth
export KASA_PORT="8099"        # must match ingress_port in config.yaml
export PYTHONUNBUFFERED=1      # stdout is a pipe: without this, python's prints never reach `ha addons logs`

if bashio::config.has_value 'anthropic_api_key'; then
  bashio::log.info "Anthropic key present — live property research enabled."
else
  bashio::log.warning "No Anthropic key set — research falls back to a baseline home."
fi
if bashio::config.has_value 'google_places_api_key'; then
  bashio::log.info "Google Places key present — find-a-service uses real ratings & contacts."
else
  bashio::log.info "No Google Places key — find-a-service uses keyless web search."
fi
if bashio::config.has_value 'gmail_user' && bashio::config.has_value 'gmail_app_password'; then
  bashio::log.info "Gmail configured — trade enquiry emails + reply auto-parsing enabled."
else
  bashio::log.info "No Gmail set — enquiries fall back to opening the device mail client."
fi
bashio::log.info "Starting KasaKeeper on ingress port ${KASA_PORT}"

exec python3 /app/server.py
