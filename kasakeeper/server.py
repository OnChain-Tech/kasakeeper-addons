#!/usr/bin/env python3
"""
KasaKeeper backend — serves the PWA and does live property research.

  POST /api/research  { "address": "1 Beach Rd, Bondi NSW" }
      -> DetectedHome JSON (beds/baths/levels + maintenance features)

It asks Claude (with the web_search server tool) to research the address on
Domain / realestate.com.au / sold-price sites, read the listing details, and
map what it finds to maintenance categories. Structured JSON is guaranteed via
output_config.format. No paid property API — Claude's web search reads the
public listings (which block direct scraping) for us.

Run:
    pip3 install anthropic
    export ANTHROPIC_API_KEY=sk-ant-...
    python3 server.py            # http://localhost:8777

With no key / no SDK it still serves the app and returns a sensible baseline
home, so the UI always works.
"""
import json, os, re, time, functools, threading, base64, urllib.request, urllib.parse, urllib.error, socket, ipaddress, http.client
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import pdfkit  # tiny stdlib PDF writer (repo-root module) — the home logbook export

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = "/data" if os.path.isdir("/data") else ROOT       # /data = add-on persistent volume

def _load_env(root):
    """Load KEY=VALUE lines from a local .env (never overrides real env vars)."""
    path = os.path.join(root, ".env")
    if not os.path.exists(path):
        return
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
_load_env(ROOT)

# ---- server-side secret stores (never in the shared store, never echoed/logged) ----
# /data/kk-secrets.json holds the general API keys (Anthropic/Places/Gmail), written
# by the first-run setup wizard / Settings when the add-on has no Configuration option
# set for them. /data/kk-ha-secrets.json holds per-home REMOTE Home Assistant tokens
# (a friend's own HA — see Store.homeHA() in store.js), keyed by homeId; local mode
# keeps using the Supervisor-injected SUPERVISOR_TOKEN as today. Both are plain files
# on the add-on's persistent volume, same trust boundary as kk-state.json — never sent
# to the client, never logged. Precedence is env / add-on option FIRST, file SECOND:
# run.sh always exports the option env vars (blank when unset), so "present" means
# non-empty and not bashio's literal "null" — see _env_present().
SECRETS_FILE = os.path.join(DATA_DIR, "kk-secrets.json")
HA_SECRETS_FILE = os.path.join(DATA_DIR, "kk-ha-secrets.json")
_SECRETS_LOCK = threading.Lock()
_HA_SECRETS_LOCK = threading.Lock()

_SECRET_ENV_MAP = {                 # kk-secrets.json key -> env var it seeds
    "anthropic": "ANTHROPIC_API_KEY",
    "places": "KASA_GOOGLE_API_KEY",
    "gmailUser": "GMAIL_USER",
    "gmailPassword": "GMAIL_APP_PASSWORD",
}

def _env_present(envk):
    v = os.getenv(envk)
    return bool(v) and bool(v.strip()) and v.strip().lower() != "null"

def _atomic_write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, path)   # a crash never leaves a half-written secrets file

def _secrets_read():
    try:
        with open(SECRETS_FILE) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}

def _secrets_update(mutate):
    """Read-modify-write kk-secrets.json as ONE critical section — the read and
    the write must share a lock acquisition, not just the write, or two saves
    landing close together (e.g. the wizard's Anthropic step and Places step)
    each read the pre-update file and the second write silently clobbers the
    first's change. mutate(dict) edits in place; returns the saved dict."""
    with _SECRETS_LOCK:
        d = _secrets_read()
        mutate(d)
        _atomic_write_json(SECRETS_FILE, d)
        return d

def _ha_secrets_read():
    try:
        with open(HA_SECRETS_FILE) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}

def _ha_secrets_update(mutate):
    """Same lock-spans-the-read-and-write fix as _secrets_update(), for the
    per-home HA token file (two homes' Settings saves can race too)."""
    with _HA_SECRETS_LOCK:
        d = _ha_secrets_read()
        mutate(d)
        _atomic_write_json(HA_SECRETS_FILE, d)
        return d

def ha_secret_for(home_id):
    """{'url','token'} for a home's remote HA, or None. Server-side only — never
    sent to the client, never logged. Consumed by the (per-home-aware) HA proxy."""
    if not home_id:
        return None
    v = _ha_secrets_read().get(home_id)
    return v if isinstance(v, dict) and v.get("url") and v.get("token") else None

# Snapshot BEFORE the file is loaded — a key already live via a real env var or
# add-on option must keep winning even after a later /api/keys save writes the
# file (the file is only ever the second-tier source).
_ENV_PRESET = {k for k, envk in _SECRET_ENV_MAP.items() if _env_present(envk)}

def _load_secrets_file():
    """Fill process env from kk-secrets.json for whichever keys aren't already
    live from a real env var / add-on option. Never overwrites, never logs values."""
    d = _secrets_read()
    for k, envk in _SECRET_ENV_MAP.items():
        if k in _ENV_PRESET:
            continue
        v = d.get(k)
        if v:
            os.environ[envk] = str(v)
_load_secrets_file()

PORT = int(os.getenv("KASA_PORT", "8777"))
MODEL = os.getenv("KASA_MODEL", "claude-opus-4-8")

# Categories the app knows how to schedule (must match data.js CATEGORIES).
CATEGORIES = ["Water", "Garden", "HVAC", "Heating", "Cleaning", "Pool/Spa", "Sauna",
              "Energy", "Safety", "Roof/Exterior", "Vehicle", "Lighting", "Pump",
              "Camera", "Appliance"]

PROPERTY_SITES = ["domain.com.au", "realestate.com.au", "allhomes.com.au",
                  "onthehouse.com.au", "getsoldprice.com.au", "propertyvalue.com.au"]

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["address", "suburb", "levels", "beds", "baths", "summary", "features"],
    "properties": {
        "address": {"type": "string"},
        "suburb": {"type": "string"},
        "levels": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
        "beds": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
        "baths": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
        "summary": {"type": "string"},
        "features": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["key", "label", "category", "source", "confidence"],
                "properties": {
                    "key": {"type": "string"},
                    "label": {"type": "string"},
                    "category": {"type": "string", "enum": CATEGORIES},
                    "source": {"type": "string"},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                },
            },
        },
    },
}

SYSTEM = (
    "You research an Australian residential property and produce its home-maintenance profile. "
    "Use the web_search tool to find the address on real-estate sites (Domain, realestate.com.au, "
    "allhomes, onthehouse, getsoldprice, propertyvalue) and read the most recent sale/lease listing. "
    "Extract bedrooms, bathrooms, number of levels/storeys, and suburb. From the listing's description "
    "and photos, detect maintenance-relevant features and map EACH to exactly one category from this list: "
    + ", ".join(CATEGORIES) + ". Examples: pool/spa->Pool/Spa; sauna->Sauna; 'ducted'/'reverse cycle'/"
    "'air conditioning'->HVAC; 'gas heating'/'gas bayonet'/fireplace->Heating; solar/battery->Energy; "
    "gardens/lawn/landscaped->Garden; pond/water feature->Pump; security cameras/alarm->Camera; "
    "festoon/feature lighting->Lighting. ALWAYS also include the baseline items every house needs even if "
    "the listing doesn't mention them: gutters (Roof/Exterior), smoke alarms (Safety), hot-water service "
    "(Water), termite/pest inspection (Roof/Exterior), and general house cleaning (Cleaning). For each feature set source to where it came from "
    "('listing', 'photos', 'inferred') and confidence high/medium/low. If you cannot find the specific "
    "address, set levels/beds/baths to null, note that in summary, and still return the baseline features. "
    "Give each feature a short lowercase key (e.g. 'pool', 'ducted_aircon'). "
    "When finished searching, respond with ONLY a single JSON object (no markdown fences, no commentary "
    "before or after) with exactly these keys: address (string), suburb (string), levels (integer or null), "
    "beds (integer or null), baths (integer or null), lat (number or null), lon (number or null), "
    "summary (string), features (array of objects with keys "
    "key, label, category, source, confidence). For lat/lon give the property's decimal-degree coordinates if "
    "the listing or a map makes them available (this centres an aerial scan), else null. category must be one "
    "of the categories listed above; confidence is one of high, medium, low."
)

# ---- baseline fallback (no key / SDK / error) --------------------------------
def baseline_home(address, note="Baseline profile — live research unavailable."):
    base = [
        ("gutters", "Gutters", "Roof/Exterior"),
        ("smoke_alarms", "Smoke alarms", "Safety"),
        ("hot_water", "Hot-water service", "Water"),
        ("pest", "Termite / pest inspection", "Roof/Exterior"),
        ("aircon", "Air-conditioning", "HVAC"),
        ("gardens", "Gardens & lawn", "Garden"),
        ("house_cleaning", "House cleaning", "Cleaning"),
    ]
    suburb = ""
    parts = [p.strip() for p in address.split(",")]
    if len(parts) > 1:
        suburb = parts[-1]
    return {
        "address": address or "Your home", "suburb": suburb,
        "levels": None, "beds": None, "baths": None, "summary": note,
        "features": [{"key": k, "label": l, "category": c, "source": "inferred", "confidence": "low"}
                     for (k, l, c) in base],
    }

# ---- aerial inspection (free: OSM geocode + Esri imagery + Claude vision) -----
AERIAL_MODEL = os.getenv("KASA_AERIAL_MODEL", MODEL)
# what the vision pass looks for -> how it maps into the maintenance profile
# Detected key -> (label, category). lawn & garden share the "Gardens & lawn" label
# so they collapse into one entry and dedupe against the baseline garden item
# (avoids 3 overlapping mow schedules). Trees/pool/spa/solar are distinct services.
AERIAL_MAP = {
    "pool":         ("Swimming pool",  "Pool/Spa"),
    "spa":          ("Spa",            "Pool/Spa"),
    "solar":        ("Solar panels",   "Energy"),
    "lawn":         ("Gardens & lawn", "Garden"),
    "garden":       ("Gardens & lawn", "Garden"),
    "large_trees":  ("Large trees",    "Garden"),
    "tennis_court": ("Tennis court",   "Garden"),
}

# Verify TLS with certifi's CA bundle (ships with the anthropic SDK) so urllib works
# on both macOS (no system bundle) and the Alpine add-on. Falls back to system default.
try:
    import ssl, certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:
    _SSL_CTX = None

def _http_get(url, headers=None, timeout=25):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": "KasaKeeper/1.0 (home-maintenance app)"})
    with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as r:
        return r.read()

# --- Home Assistant proxy (add-on only) ---------------------------------------
# With homeassistant_api:true the Supervisor injects SUPERVISOR_TOKEN and exposes
# the core API at http://supervisor/core/api/. Proxying through it means the app
# reads live HA state WITHOUT the user pasting a URL or long-lived token.
#
# Multi-home: every home has a Store.homeHA() source — 'local' (this add-on's
# own Supervisor-proxied HA, today's only mode and the default for a home that
# predates this field), 'remote' (a friend's own HA elsewhere — see
# ha_secret_for()), or 'none' (not connected). ha_api_get/post resolve which one
# to use per call via home_id; every existing call site that doesn't pass one
# keeps behaving exactly as before (home_id=None -> 'local').
def _home_ha_config(home_id):
    """(mode, url_or_None) for a home's HA source. No home_id, no matching home,
    or a home predating this field all resolve to ('local', None) — mirrors
    Store.homeHA()'s default in store.js. Never returns a token — that's
    ha_secret_for()'s job, kept out of the shared state file entirely."""
    if not home_id:
        return "local", None
    try:
        homes = (state_read().get("state") or {}).get("homes") or []
    except Exception:
        homes = []
    h = next((x for x in homes if isinstance(x, dict) and x.get("id") == home_id), None)
    ha = h.get("ha") if isinstance(h, dict) else None
    if isinstance(ha, dict) and ha.get("mode") in ("remote", "none"):
        return ha["mode"], (ha.get("url") or None)
    return "local", None

def _ha_remote_request(home_id, url, path, method="GET", body=None, timeout=20):
    """Fetch <path> from a home's remote HA (a friend's own instance elsewhere).
    Re-validates the stored url on EVERY call, not just at save time — a host
    can answer a public record now and a private one a moment later (DNS
    rebinding), so trusting a URL because it passed _valid_ha_url() once at save
    isn't enough (see _pinned_opener). Returns None when the home has no saved
    remote credentials or the url now fails re-validation (both treated as
    'not connected', same as local mode's missing-token case) — never raises
    for those; a genuine request failure (timeout, HTTP error) DOES raise, same
    as the local branch's urlopen, so callers' existing except/degrade paths
    keep working unchanged."""
    sec = ha_secret_for(home_id)
    if not sec:
        return None
    ok, err, ip = _valid_ha_url(sec["url"])
    if not ok:
        print(f"[ha] remote url for home={home_id} failed re-validation: {err}")
        return None
    req_url = sec["url"].rstrip("/") + "/api/" + path
    headers = {"Authorization": "Bearer " + sec["token"]}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(req_url, data=data, method=method, headers=headers)
    with _pinned_opener(ip).open(req, timeout=timeout) as r:
        return r.read()

def ha_available(home_id=None):
    """Whether the given home's HA source (or, called bare, the legacy local-only
    check) is usable right now. 'none' is always unavailable; 'remote' needs a
    saved url+token; 'local' needs the Supervisor-injected token."""
    mode, _ = _home_ha_config(home_id)
    if mode == "none":
        return False
    if mode == "remote":
        return bool(ha_secret_for(home_id))
    return bool(os.getenv("SUPERVISOR_TOKEN"))

def ha_api_get(path, home_id=None):
    """GET <path> from the home's HA source. Raw bytes, or None ('none' mode, no
    saved remote creds, or a remote url that failed re-validation — the UI reads
    all three as 'not connected')."""
    mode, url = _home_ha_config(home_id)
    if mode == "none":
        return None
    if mode == "remote":
        return _ha_remote_request(home_id, url, path)
    token = os.getenv("SUPERVISOR_TOKEN")
    if not token:
        return None
    req = urllib.request.Request("http://supervisor/core/api/" + path,
                                 headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=20) as r:  # internal http, no TLS
        return r.read()

def ha_api_post(path, body, home_id=None):
    """POST to the home's HA source. Parsed JSON, or None (same 'not connected'
    cases as ha_api_get)."""
    mode, url = _home_ha_config(home_id)
    if mode == "none":
        return None
    if mode == "remote":
        raw = _ha_remote_request(home_id, url, path, method="POST", body=body)
        if raw is None:
            return None
        return json.loads(raw) if raw else {}
    token = os.getenv("SUPERVISOR_TOKEN")
    if not token:
        return None
    req = urllib.request.Request("http://supervisor/core/api/" + path,
                                 data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": "Bearer " + token,
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = r.read()
    return json.loads(raw) if raw else {}

# ---- remote HA (a friend's own instance, per home — see Store.homeHA()) -------
# The url is USER-SUPPLIED and this server fetches it — both here (save-time
# validate) and on every proxied call (_ha_remote_request, above) — guard
# against SSRF into the add-on's own network (the Supervisor, loopback, RFC1918
# ranges) same as any other server that fetches an address a user typed in.
def _valid_ha_url(url):
    """(ok, error, ip) — plausible PUBLIC http(s) endpoint, not a private/loopback/
    link-local address and not the Supervisor's own hostname, plus the single IP
    that host resolved to. Defence-in-depth: this doesn't need to be exhaustive
    (a determined user already has shell access to their own add-on), just
    enough that pasting a URL here can't be used to reach internal services the
    ingress boundary is supposed to hide.

    The caller MUST pass `ip` on to _validate_ha_remote (which pins the real
    connection to it) rather than re-resolving the hostname — otherwise a host
    that answers a public record now and a private one a moment later (DNS
    rebinding, or just a flaky resolver) would pass this check and still reach
    an internal address at connect time."""
    try:
        p = urllib.parse.urlparse(url)
    except Exception:
        return False, "not a valid URL", None
    if p.scheme not in ("http", "https"):
        return False, "url must start with http:// or https://", None
    host = (p.hostname or "").strip().lower()
    if not host:
        return False, "url must include a host", None
    if host in ("localhost", "supervisor", "0.0.0.0") or host.endswith(".local"):
        return False, "that host isn't reachable from the add-on", None
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return False, "couldn't resolve that host", None
    pinned_ip = None
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except Exception:
            continue
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            return False, "that address isn't reachable from here", None
        if pinned_ip is None:
            pinned_ip = str(ip)
    if pinned_ip is None:
        return False, "couldn't resolve that host", None
    return True, None, pinned_ip

def _safe_err(e):
    """A validate-endpoint error safe to hand back to the client — never the raw
    exception (some urllib/smtplib errors can echo back request details)."""
    if isinstance(e, urllib.error.HTTPError):
        return f"HTTP {e.code}"
    if isinstance(e, smtplib.SMTPAuthenticationError):
        return "authentication failed"
    if isinstance(e, (TimeoutError, socket.timeout)):
        return "timed out"
    return e.__class__.__name__

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """_valid_ha_url() only vets the host the USER typed — silently following a
    3xx would let that host redirect the request (bearer token included) to an
    internal address after the check already passed. Returning None here makes
    urlopen raise the original response instead of following it."""
    def redirect_request(self, *a, **kw):
        return None

def _pinned_opener(ip):
    """Build a one-shot opener whose connections go to the given pre-vetted IP
    instead of letting http.client re-resolve the request's hostname — the TLS
    handshake (SNI + cert check) still uses the original hostname via
    server_hostname, so a real cert still validates normally."""
    class _PinnedHTTPConnection(http.client.HTTPConnection):
        def connect(self):
            self.sock = self._create_connection((ip, self.port), self.timeout, self.source_address)

    class _PinnedHTTPSConnection(http.client.HTTPSConnection):
        def connect(self):
            sock = self._create_connection((ip, self.port), self.timeout, self.source_address)
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)

    class _PinnedHTTPHandler(urllib.request.HTTPHandler):
        def http_open(self, req):
            return self.do_open(_PinnedHTTPConnection, req)

    class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
        def https_open(self, req):
            return self.do_open(_PinnedHTTPSConnection, req, context=_SSL_CTX)

    return urllib.request.build_opener(_NoRedirect, _PinnedHTTPHandler, _PinnedHTTPSHandler)

def _validate_ha_remote(url, token, ip):
    """Real test call: GET {url}/api/ with the given bearer token, connecting to
    the pre-vetted `ip` from _valid_ha_url rather than re-resolving the hostname
    (see _pinned_opener — closes the DNS-rebinding/TOCTOU gap). HA's base /api/
    endpoint returns a small 'API running.' payload for any valid token — cheap
    and side-effect-free. No redirects followed — see _NoRedirect."""
    try:
        req = urllib.request.Request(url.rstrip("/") + "/api/",
                                     headers={"Authorization": "Bearer " + token})
        with _pinned_opener(ip).open(req, timeout=10) as r:
            r.read()
        return True, None
    except Exception as e:
        return False, _safe_err(e)

# ---- weather (for seasonal/weather nudges) ------------------------------------
_WEATHER_CACHE = {}   # home_id (or "" for the legacy bare call) -> {t, data, entity}

def ha_weather(home_id=None):
    """Current conditions + daily forecast from the home's weather entity (auto-found).
    Cached 30 min per home. Returns dict or None."""
    key = home_id or ""
    now = time.time()
    cached = _WEATHER_CACHE.get(key)
    if cached and cached.get("data") and now - cached["t"] < 1800:
        return cached["data"]
    if not ha_available(home_id):
        return None
    try:
        ent = (cached or {}).get("entity")
        if not ent:
            states = json.loads(ha_api_get("states", home_id))
            ent = next((s["entity_id"] for s in states if s["entity_id"].startswith("weather.")), None)
        if not ent:
            return None
        cur = json.loads(ha_api_get("states/" + urllib.parse.quote(ent, safe=""), home_id))
        # modern HA: forecast comes from the weather.get_forecasts service, not attributes
        fc = ha_api_post("services/weather/get_forecasts?return_response",
                         {"entity_id": ent, "type": "daily"}, home_id)
        forecast = (((fc or {}).get("service_response") or {}).get(ent) or {}).get("forecast") or []
        data = {"entity": ent, "state": cur.get("state"),
                "temperature": (cur.get("attributes") or {}).get("temperature"),
                "forecast": forecast[:5]}
        _WEATHER_CACHE[key] = {"t": now, "data": data, "entity": ent}
        return data
    except Exception as e:
        print(f"[weather] failed: {e}")
        return None

# ---- device registry (telemetry MOAT: import real makes/models from HA) -------
# Server-authored Jinja template for HA's device registry. This string is a
# MODULE CONSTANT — it is POSTed to /core/api/template verbatim and is NEVER
# concatenated with user input (no address, name, or request data is ever
# spliced into it). It ends in `| tojson`, so the rendered body is already a
# JSON array and the existing ha_api_post() (json.loads(raw)) parses it as-is.
# device_id()/device_attr()/device_entities()/area_name() are HA's built-in
# template globals; the registry proper is WS-only, so this walks `states` to
# find every device id instead (misses zero-entity devices — irrelevant here,
# a maintainable device has entities).
HA_DEVICES_TEMPLATE = """
{% set ns = namespace(devs=[]) %}
{% set ids = states | map(attribute='entity_id') | map('device_id')
             | reject('none') | unique | list %}
{% for d in ids %}
  {% set ns.ents = [] %}
  {% for e in device_entities(d) %}
    {% set ns.ents = ns.ents + [{'id': e, 'domain': e.split('.')[0],
       'device_class': state_attr(e, 'device_class'),
       'unit': state_attr(e, 'unit_of_measurement'),
       'state_class': state_attr(e, 'state_class')}] %}
  {% endfor %}
  {% set ns.devs = ns.devs + [{'device_id': d,
     'name': device_attr(d, 'name_by_user') or device_attr(d, 'name'),
     'manufacturer': device_attr(d, 'manufacturer'),
     'model': device_attr(d, 'model'),
     'sw_version': device_attr(d, 'sw_version'),
     'hw_version': device_attr(d, 'hw_version'),
     'serial_number': device_attr(d, 'serial_number'),
     'entry_type': device_attr(d, 'entry_type'),
     'area': area_name(d),
     'entities': ns.ents}] %}
{% endfor %}
{{ ns.devs | tojson }}
"""

# Noise domains: on their own they never make a device maintenance-relevant.
_HA_NOISE_DOMAINS = {'light', 'switch', 'button', 'remote', 'scene', 'automation', 'update', 'binary_sensor'}
_HA_BRIDGE_HINTS = ('bridge', 'coordinator', 'hub', 'gateway', 'adapter')
_HA_ENERGY_HINTS = ('powerwall', 'solaredge', 'fronius', 'enphase', 'inverter', 'solar', 'battery')
_HA_CHARGER_HINTS = ('charger', 'ev charger', 'wallbox', 'evse')
_HA_APPLIANCE_HINTS = ('thinq', 'lg_thinq', 'home connect', 'home_connect', 'miele', 'smartthings')
# Car brands (lowercased) — a device_tracker off one of these is a vehicle,
# not the aircon its climate entities would otherwise suggest (the Model X
# misread: its cabin climate entities dominated and the import proposed HVAC
# nonsense onto a car).
_HA_CAR_BRANDS = {'tesla', 'bmw', 'mercedes-benz', 'audi', 'hyundai', 'kia', 'polestar',
                   'rivian', 'ford', 'toyota', 'volvo', 'mg', 'byd'}

def _ha_lock_only(dev):
    """True if the device is 'just a lock' — its maintainable domains are
    lock, optionally plus a battery-level sensor reporting the lock's own
    battery (the common real shape: August/Yale/Z-Wave locks all expose a
    plain `sensor.xxx_battery` alongside `lock.xxx` on the SAME device — a
    strict maintainable == {'lock'} check would miss almost every real lock).
    Shared by _ha_relevant()'s Safety rule and _ha_kind()'s client-side lock
    tag so the two can never drift apart."""
    entities = dev.get('entities') or []
    domains = {e.get('domain') for e in entities if e.get('domain')}
    maintainable = {d for d in domains if d not in _HA_NOISE_DOMAINS and not d.startswith('input_')}
    if 'lock' not in maintainable:
        return False
    extra = maintainable - {'lock'}
    if not extra:
        return True
    extra_entities = [e for e in entities if e.get('domain') in extra]
    return all(e.get('device_class') == 'battery' for e in extra_entities)

def _ha_relevant(dev):
    """Maintenance-relevant KasaKeeper category for one registry device, or
    None. Single source of truth for import (and, later, drift) — one curated
    ruleset shared by both."""
    if (dev.get('entry_type') or '') == 'service':   # non-physical (bridges, integrations-as-device)
        return None
    text = ((dev.get('name') or '') + ' ' + (dev.get('model') or '')).lower()
    if any(h in text for h in _HA_BRIDGE_HINTS):
        return None
    entities = dev.get('entities') or []
    domains = {e.get('domain') for e in entities if e.get('domain')}
    dclasses = {e.get('device_class') for e in entities if e.get('device_class')}
    if not domains:
        return None
    maintainable = {d for d in domains if d not in _HA_NOISE_DOMAINS and not d.startswith('input_')}
    if not maintainable:
        return None
    # Vehicle — must be checked (and WIN) before the climate rule below: a
    # car's cabin climate entities otherwise dominate and the device reads as
    # HVAC (the Model X misread). Vehicle if it's a known car-brand device
    # that reports a location, OR it tracks location AND reports mileage
    # (an odometer-ish sensor) alongside a battery reading — car-shaped even
    # for an unrecognised brand.
    if 'device_tracker' in domains:
        manufacturer = (dev.get('manufacturer') or '').strip().lower()
        odometer_ish = any(
            'odometer' in (e.get('id') or '').lower()
            or (e.get('unit') in ('km', 'mi') and e.get('state_class') == 'total_increasing')
            for e in entities)
        if manufacturer in _HA_CAR_BRANDS or (odometer_ish and 'battery' in dclasses):
            return 'Vehicle'
    # Lock-only devices (see _ha_lock_only) are Safety, not matched against
    # arbitrary category singletons — see _ha_kind() and matchDevice() in
    # app.js for the client-side half of this rule (the August-lock-onto-a-
    # timber-front-door incident).
    if _ha_lock_only(dev):
        return 'Safety'
    if 'climate' in domains:
        return 'Heating' if ('heat' in text or 'gas' in text) else 'HVAC'
    if 'water_heater' in domains:
        return 'Water'
    if 'humidifier' in domains:
        return 'HVAC'
    if 'vacuum' in domains:
        return 'Cleaning'
    if 'lawn_mower' in domains:
        return 'Garden'
    if 'cover' in domains and 'garage' in dclasses:
        return 'Roof/Exterior'
    if 'camera' in domains:
        return 'Camera'
    if 'media_player' in domains:
        return 'Appliance'
    if ({'battery', 'power', 'energy'} & dclasses) and any(h in text for h in _HA_ENERGY_HINTS):
        return 'Energy'
    if ({'current', 'power'} & dclasses) and any(h in text for h in _HA_CHARGER_HINTS):
        return 'Energy'
    if any(h in text for h in _HA_APPLIANCE_HINTS):
        return 'Appliance'
    return None

def _ha_kind(dev):
    """Special device 'kind' for the client's match guard, or None. Right now
    just 'lock': matchDevice() in app.js must never let a lock device
    category-singleton or name-similarity match onto an asset unless the
    asset itself reads as lock-ish — otherwise a smart-lock import can
    propose overwriting a correct maker/model with the lock's own (the
    August-lock-onto-a-timber-front-door incident). Shares _ha_lock_only()
    with _ha_relevant()'s lock rule so they can never disagree."""
    return 'lock' if _ha_lock_only(dev) else None

def _ha_suggested_usage(dev):
    """The device's own entity to meter this asset by (Feature 2), or None.
    Prefers a true energy meter; falls back to the primary stateful entity for
    a runtime (on-hours) reading. No meterable entity -> no usage block.
    (Also covers vehicles: a Tesla-style lifetime-energy sensor is device_class
    'energy' + state_class 'total_increasing', so it's already preferred here
    over falling back to the car's climate entity for a runtime reading.)"""
    ents = dev.get('entities') or []
    for e in ents:
        if e.get('device_class') == 'energy' and e.get('state_class') == 'total_increasing':
            return {'entity': e['id'], 'mode': 'energy', 'unit': e.get('unit') or 'kWh'}
    for e in ents:
        if e.get('domain') in ('climate', 'humidifier', 'fan', 'water_heater'):
            return {'entity': e['id'], 'mode': 'runtime', 'unit': 'hrs'}
    return None

_HA_LIVE_PRIORITY = {'battery': 0, 'power': 1, 'energy': 2, 'temperature': 3}
_HA_LIVE_PRIMARY_DOMAINS = ('climate', 'humidifier', 'fan', 'water_heater', 'vacuum', 'lawn_mower', 'media_player', 'camera', 'cover')

def _ha_live_entities(dev):
    """Up to 4 headline entities for the asset-page live strip, ordered
    battery -> power -> energy -> temperature -> the device's own state."""
    ents = dev.get('entities') or []
    scored = sorted(((_HA_LIVE_PRIORITY[e['device_class']], e) for e in ents if e.get('device_class') in _HA_LIVE_PRIORITY),
                     key=lambda x: x[0])
    picked = [e for _, e in scored[:4]]
    if not picked:
        prim = next((e for e in ents if e.get('domain') in _HA_LIVE_PRIMARY_DOMAINS), None)
        if prim:
            picked = [prim]
    return [{'id': e['id'], 'dc': e.get('device_class'), 'unit': e.get('unit')} for e in picked[:4]]

_DEV_CACHE = {}   # home_id (or "" for the legacy bare call) -> {t, data}

def ha_devices(force=False, home_id=None):
    """Maintenance-relevant HA devices, synchronous + cached 300s per home (mirrors
    _WEATHER_CACHE — the wall tablet must not re-scan the registry on every
    open). Never raises: any failure degrades to an empty, still-well-shaped
    response so the client always has something to render."""
    if not ha_available(home_id):
        return {"available": False, "devices": []}
    key = home_id or ""
    now = time.time()
    cached = _DEV_CACHE.get(key)
    if not force and cached and now - cached["t"] < 300:
        return cached["data"]
    try:
        raw = ha_api_post("template", {"template": HA_DEVICES_TEMPLATE}, home_id)
        devs = raw if isinstance(raw, list) else []
    except Exception as e:
        print(f"[ha] device registry read failed: {e}")
        return {"available": True, "devices": [], "everythingElse": [], "error": "registry read failed"}
    devices, everything_else = [], []
    for d in devs:
        try:
            cat = _ha_relevant(d)
            if not cat:
                everything_else.append({"deviceId": d.get("device_id"), "name": d.get("name") or ""})
                continue
            devices.append({
                "deviceId": d.get("device_id"), "name": d.get("name") or "", "category": cat,
                "kind": _ha_kind(d),
                "manufacturer": d.get("manufacturer") or "", "model": d.get("model") or "",
                "sw_version": d.get("sw_version") or "", "serial": d.get("serial_number") or "",
                "area": d.get("area") or "", "entities": d.get("entities") or [],
                "suggestedUsage": _ha_suggested_usage(d), "live": _ha_live_entities(d),
            })
        except Exception as e:
            print(f"[ha] device row skipped: {e}")
            continue
    data = {"available": True, "devices": devices, "everythingElse": everything_else}
    _DEV_CACHE[key] = {"t": now, "data": data}
    return data

# ---- drift detection (the correction loop — slice 3) --------------------------
# Compares imported assets' stamped ha.snapshot (see app.js ha-import-apply)
# against a fresh registry read. Pure/no-network: callers pass in already-fetched
# `devices`/`everythingElse` (ha_devices()'s shape) — this makes it unit-testable
# with fabricated dicts, same as _ha_relevant. Never mutates its inputs.
_HA_SNAPSHOT_FIELDS = ("manufacturer", "model", "sw_version", "serial")

def _ha_compute_drift(assets, devices, everything_else=None):
    """Returns (drift, vanished, new_devices) for one home's assets against one
    registry read. `drift` entries compare against the STORED snapshot (not the
    asset's current field values), so a user's own manual edit is never re-flagged
    — only a real change in the registry since the asset was last imported/applied
    is. `vanished` is checked against the FULL registry read (relevant + everything
    else) so a device that merely became irrelevant (e.g. its entities changed)
    isn't wrongly reported as gone. `new_devices` excludes any relevant device
    already linked to an asset's `ha.deviceId`."""
    by_id = {d.get("deviceId"): d for d in (devices or []) if d.get("deviceId")}
    all_ids = set(by_id) | {d.get("deviceId") for d in (everything_else or []) if d.get("deviceId")}
    linked_ids = set()
    drift, vanished = [], []
    for a in (assets or []):
        ha = a.get("ha")
        if not isinstance(ha, dict) or not ha.get("deviceId"):
            continue
        did = ha["deviceId"]
        linked_ids.add(did)
        live = by_id.get(did)
        if not live:
            if did not in all_ids:
                vanished.append({"assetId": a.get("id"), "name": a.get("name") or "", "deviceId": did})
            continue
        snap = ha.get("snapshot") or {}
        for field in _HA_SNAPSHOT_FIELDS:
            was, now = str(snap.get(field) or "").strip(), str(live.get(field) or "").strip()
            if now and now != was:   # absent live field -> no drift (never flag on missing data)
                drift.append({"assetId": a.get("id"), "field": field, "was": was, "now": now})
    new_devices = [{"deviceId": d.get("deviceId"), "name": d.get("name") or "", "category": d.get("category")}
                   for d in (devices or []) if d.get("deviceId") not in linked_ids]
    return drift, vanished, new_devices

# ---- push notifications (HA notify) + daily digest ----------------------------
DIGEST_FILE = os.path.join(DATA_DIR, "kk-digest.json")   # DATA_DIR is defined near the top, by the secret stores

# ---- multi-device shared state (single household: rev-guarded last-write-wins) --
STATE_FILE = os.path.join(DATA_DIR, "kk-state.json")
_STATE_LOCK = threading.Lock()

def state_read():
    try:
        return json.load(open(STATE_FILE))
    except Exception:
        return {"rev": 0, "state": None}

def state_write(base_rev, new_state):
    """Returns (ok, doc). ok=False means the caller was stale — doc is the server copy."""
    with _STATE_LOCK:
        cur = state_read()
        if base_rev != cur.get("rev", 0):
            return False, cur
        doc = {"rev": cur.get("rev", 0) + 1, "state": new_state,
               "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
        tmp = STATE_FILE + ".tmp"
        json.dump(doc, open(tmp, "w"))
        os.replace(tmp, STATE_FILE)  # atomic — a crash never corrupts the store
        return True, doc

def ha_drift(home_id=None):
    """GET /api/ha/drift — read-only findings for a home (defaults to the shared
    store's currentHomeId): field drift, vanished devices, unimported new
    devices. Writes NOTHING (per the PRD's approval-first principle —
    corrections still go through ha-import-apply). Reuses ha_devices()'s cached
    registry read, so this costs nothing extra on top of a recent import scan.
    Never raises: any failure degrades to an empty, well-shaped response."""
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%S")
    state = state_read().get("state") or {}
    hid = home_id or state.get("currentHomeId")
    if not ha_available(hid):
        return {"available": False, "drift": [], "vanished": [], "newDevices": [], "checkedAt": now_iso}
    try:
        reg = ha_devices(home_id=hid)
        assets = [a for a in (state.get("assets") or []) if a.get("homeId") == hid]
        drift, vanished, new_devices = _ha_compute_drift(assets, reg.get("devices"), reg.get("everythingElse"))
        return {"available": True, "drift": drift, "vanished": vanished, "newDevices": new_devices, "checkedAt": now_iso}
    except Exception as e:
        print(f"[ha] drift check failed: {e}")
        return {"available": True, "drift": [], "vanished": [], "newDevices": [], "checkedAt": now_iso}

NOTIFY_HOUR = int(os.getenv("KASA_NOTIFY_HOUR", "8"))

def ha_notify(title, message, home_id=None):
    """Send a push via a home's HA notify service (mobile apps; defaults to the
    legacy local-only source when no home_id is given). Returns (ok, err) — err
    is sanitised (_safe_err), since /api/ha/notify hands it straight to the
    client and a remote home's HA can now be a url the user typed in."""
    try:
        res = ha_api_post("services/notify/notify", {"title": title, "message": message}, home_id)
        if res is None:   # 'none' mode / no local token / unconfigured or unreachable remote
            return False, "ha not connected"
        return True, None
    except Exception as e:
        return False, _safe_err(e)

def _ha_timezone():
    try:
        from zoneinfo import ZoneInfo
        cfg = json.loads(ha_api_get("config"))
        return ZoneInfo(cfg.get("time_zone") or "UTC")
    except Exception:
        return None

def _digest_pusher():
    """Once a day at NOTIFY_HOUR (home's timezone), push the saved digest if actionable."""
    import datetime
    last_sent = None
    tz = None
    while True:
        try:
            if tz is None:
                tz = _ha_timezone()
            now = datetime.datetime.now(tz) if tz else datetime.datetime.now()
            today = now.date().isoformat()
            _maybe_recall_sweep(now)   # monthly recall sweep piggybacks this same tick
            if now.hour == NOTIFY_HOUR and last_sent != today and os.path.exists(DIGEST_FILE):
                d = json.load(open(DIGEST_FILE))
                if d.get("pushDaily", True):
                    state = state_read().get("state") or {}
                    home_id = d.get("homeId") or state.get("currentHomeId")
                    parts = _digest_push_parts(d, state, home_id)
                    if parts:
                        ok, err = ha_notify("KasaKeeper — morning brief", " · ".join(parts)[:250], home_id)
                        print(f"[push] daily digest sent={ok} err={err}")
                last_sent = today
        except Exception as e:
            print(f"[push] pusher error: {e}")
        time.sleep(300)

def geocode(address):
    """Address -> (lat, lon) via OpenStreetMap Nominatim (free, street-level). None on failure."""
    try:
        q = urllib.parse.urlencode({"format": "json", "limit": "1", "q": address, "countrycodes": "au"})
        raw = _http_get("https://nominatim.openstreetmap.org/search?" + q)
        arr = json.loads(raw)
        if not arr:
            return None
        return float(arr[0]["lat"]), float(arr[0]["lon"])
    except Exception as e:
        print(f"[aerial] geocode failed: {e}")
        return None

def aerial_image_b64(lat, lon):
    """Fetch a ~70 m satellite crop centred on (lat,lon) from Esri World Imagery (no key)."""
    try:
        dlat, dlon = 0.00080, 0.00096  # ~90 m box (covers the lot even with street-level geocoding)
        bbox = f"{lon-dlon},{lat-dlat},{lon+dlon},{lat+dlat}"
        url = ("https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export"
               f"?bbox={bbox}&bboxSR=4326&imageSR=4326&size=1000,1000&format=jpg&f=image")
        data = _http_get(url)
        if not data[:2] == b"\xff\xd8":  # not a JPEG (error blob)
            print("[aerial] imagery returned non-JPEG")
            return None
        return base64.b64encode(data).decode()
    except Exception as e:
        print(f"[aerial] imagery failed: {e}")
        return None

AERIAL_SYSTEM = (
    "You are inspecting a high-resolution satellite/aerial image of a residential block. The property of "
    "interest is at the CENTRE — but because geocoding is street-level, the target house may sit slightly "
    "off-centre and its backyard may extend toward the top or bottom edge, so consider the central lot AND "
    "the lot immediately behind/beside the centre as the target property. Look for, on the target property "
    "(house roof + its own yard): a swimming pool (blue/teal rectangle of water), a spa or small plunge pool, "
    "solar panels on the roof (dark uniform rectangular grid), an open lawn/grass area, garden beds / dense "
    "planted vegetation, large trees overhanging the house, and a tennis court. Backyards sit BEHIND houses, "
    "so scan the yards immediately above and below the centre for a pool or spa — these are easy to miss. "
    "Prefer to INCLUDE a feature you are reasonably sure sits on the target lot rather than miss it (the user "
    "will confirm each) — but do not report a feature that clearly belongs to a distant neighbour. Respond with ONLY a JSON object (no "
    "markdown) where each key is one of pool, spa, solar, lawn, garden, large_trees, tennis_court and each "
    "value is {\"present\": true/false, \"confidence\": \"high|medium|low\"}."
)

def aerial_scan(address, client, coords=None):
    """Return a list of DetectedHome feature dicts found from the aerial image (may be empty).
    coords = (lat, lon) if known from the listing (more precise than street-level geocoding)."""
    loc = coords or geocode(address)
    if not loc:
        return []
    b64 = aerial_image_b64(*loc)
    if not b64:
        return []
    try:
        resp = client.messages.create(
            model=AERIAL_MODEL, max_tokens=1024, system=AERIAL_SYSTEM,
            messages=[{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}},
                {"type": "text", "text": "Inspect the central property and return the JSON."},
            ]}])
        text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
        i, j = text.find("{"), text.rfind("}")
        det = json.loads(text[i:j + 1]) if i >= 0 and j >= 0 else {}
    except Exception as e:
        print(f"[aerial] vision failed: {e}")
        return []
    feats, seen = [], set()
    for key, info in det.items():
        if key in AERIAL_MAP and isinstance(info, dict) and info.get("present"):
            label, cat = AERIAL_MAP[key]
            if (cat, label) in seen:   # lawn + garden collapse into one "Gardens & lawn"
                continue
            seen.add((cat, label))
            feats.append({"key": key, "label": label, "category": cat,
                          "source": "aerial (satellite)", "confidence": info.get("confidence", "medium")})
    print(f"[aerial] {address!r}: detected {[f['key'] for f in feats]}")
    return feats

def _merge_features(features, extra):
    """Add aerial features that aren't already covered by the same (category,key) or label."""
    seen_keys = {f.get("key") for f in features}
    seen_pairs = {(f.get("category"), (f.get("label") or "").lower()) for f in features}
    for f in extra:
        if f["key"] in seen_keys or (f["category"], f["label"].lower()) in seen_pairs:
            continue
        features.append(f)
        seen_keys.add(f["key"]); seen_pairs.add((f["category"], f["label"].lower()))
    return features

# ---- live research via Claude ------------------------------------------------
def research(address):
    try:
        import anthropic
    except ImportError:
        return baseline_home(address, "Install the anthropic SDK (pip3 install anthropic) for live research.")
    if not (os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN")):
        return baseline_home(address, "Set ANTHROPIC_API_KEY for live research.")

    client = anthropic.Anthropic(max_retries=1, timeout=200.0)
    # --- 1) listing research via web search (bedrooms/baths/levels + listed features) ---
    # No allowed_domains — some property sites (realestate.com.au) are on the
    # web-search blocklist and would 400 the whole request. Steer via the prompt.
    # No output_config.format — it suppresses the web-search tool loop; instead we
    # instruct JSON-only output and parse it from the final text.
    tools = [{"type": "web_search_20260209", "name": "web_search", "max_uses": 10}]
    messages = [{"role": "user", "content": f"Research this property and return its maintenance profile: {address}"}]
    data = None
    try:
        resp = None
        for _ in range(8):  # resume across web_search pause_turns
            resp = client.messages.create(model=MODEL, max_tokens=8000, system=SYSTEM, tools=tools, messages=messages)
            if resp.stop_reason == "pause_turn":
                messages.append({"role": "assistant", "content": resp.content})
                continue
            break
        text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
        i, j = text.find("{"), text.rfind("}")
        if i >= 0 and j >= 0:
            data = json.loads(text[i:j + 1])
            data.setdefault("address", address)
    except Exception as e:
        print(f"[research] listing search failed: {e}")
    if not data:
        data = baseline_home(address, "No recent listing found — profile from aerial imagery + baseline.")
    data.setdefault("features", [])

    # --- 2) aerial inspection (satellite vision) — enriches EVERY home, listed or not ---
    try:
        lat, lon = data.get("lat"), data.get("lon")
        coords = (lat, lon) if isinstance(lat, (int, float)) and isinstance(lon, (int, float)) else None
        aerial = aerial_scan(address, client, coords)
        if aerial:
            before = len(data["features"])
            _merge_features(data["features"], aerial)
            added = len(data["features"]) - before
            if added:
                kinds = ", ".join(sorted({f["label"] for f in aerial}))
                data["summary"] = (data.get("summary", "") + f" Aerial scan added: {kinds}.").strip()
    except Exception as e:
        print(f"[research] aerial merge failed: {e}")

    return data


# ---- find local service providers, ranked by reviews -------------------------
FIND_SYSTEM = (
    "You find REAL local trade/service businesses near an Australian address and rank them by Google reviews. "
    "Do 3-4 web searches. IMPORTANTLY, run a search that surfaces the GOOGLE MAPS / local-pack results for the "
    "trade in the suburb (e.g. 'gutter cleaning Bondi NSW') — Google's local listings show each business's "
    "STAR RATING, REVIEW COUNT and PHONE NUMBER directly, and you MUST capture those. Also check a directory "
    "(Oneflare/hipages/TrueLocal) for phone numbers. Work from these listing/result pages — do not open each "
    "business's own website hunting for an email. Rank by a mix of star rating and number of reviews (a 4.8 with "
    "200 reviews beats a 5.0 with 3), preferring businesses closest to the address. Return the top 5. For each: "
    "name; Google star rating as a number (e.g. 4.8); number of Google reviews as an integer; phone (dialable "
    "string); email ONLY if it already appears in the results, else null; website domain (no https://) or null; "
    "suburb they are based in; a one-line (max ~12 words) summary of what reviews praise; and services = an "
    "array of up to 4 short service names they offer (e.g. [\"Lawn mowing\",\"Hedging\",\"Garden clean-ups\"]). "
    "A good result has a rating, a review count AND a phone — make a real effort to fill those three. Only "
    "include real businesses you actually found — NEVER invent a name, phone, email, rating or review count; use "
    "null only when genuinely not found. Order best-first. Respond with ONLY a single JSON object (no markdown, "
    "no commentary): {\"providers\":[{\"name\":string,\"rating\":number|null,\"reviews\":integer|null,"
    "\"phone\":string|null,\"email\":string|null,\"website\":string|null,\"suburb\":string|null,"
    "\"blurb\":string|null,\"services\":[string]}]}."
)

FIND_MODEL = os.getenv("KASA_FIND_MODEL", MODEL)  # web-search aggregation (opus, proven path)

def _domain(website):
    if not website:
        return None
    d = website.replace("https://", "").replace("http://", "").split("/")[0].strip()
    return d or None

def _logo_url(website):
    """Relative URL to our logo proxy for a business website (same-origin under ingress)."""
    d = _domain(website)
    return "api/logo?domain=" + urllib.parse.quote(d) if d else None

def fetch_logo(domain):
    """Fetch a business logo/favicon for a domain (keyless). Returns (bytes, content_type) or None.
    Tries Clearbit (real logo) then Google's favicon service (always resolves)."""
    for url, ok_only_image in ((f"https://logo.clearbit.com/{domain}?size=128", True),
                               (f"https://www.google.com/s2/favicons?domain={domain}&sz=128", False)):
        try:
            data = _http_get(url, timeout=10)
            if data and (not ok_only_image or data[:4] in (b"\x89PNG", b"\xff\xd8\xff\xe0", b"GIF8") or data[:2] == b"\xff\xd8"):
                ctype = "image/png" if data[:4] == b"\x89PNG" else ("image/jpeg" if data[:2] == b"\xff\xd8" else "image/png")
                return data, ctype
        except Exception:
            continue
    return None

_BRAND_CACHE = {}   # make (lowercased) -> (bytes, ctype) | None; negatives cached so misses don't refetch
def brand_logo(make):
    """Asset make ('Daikin') -> brand logo bytes. Keyless: Clearbit suggest resolves
    the domain, then the existing fetch_logo chain (Clearbit logo -> Google favicon)."""
    key = (make or "").strip().lower()[:60]
    if not key:
        return None
    if key in _BRAND_CACHE:
        return _BRAND_CACHE[key]
    out = None
    try:
        raw = _http_get("https://autocomplete.clearbit.com/v1/companies/suggest?query=" + urllib.parse.quote(key), timeout=8)
        arr = json.loads(raw or b"[]")
        dom = arr[0].get("domain") if arr else None
        if dom:
            out = fetch_logo(dom)
    except Exception:
        out = None
    if len(_BRAND_CACHE) > 200:   # tiny bound; a household has a handful of brands
        _BRAND_CACHE.clear()
    _BRAND_CACHE[key] = out
    return out

def _provider_score(p):
    r = p.get("rating") or 0
    import math
    n = p.get("reviews") or 0
    return (r or 0) * math.log10((n or 0) + 10)  # rating weighted by review volume

def _http_post_json(url, headers, body, timeout=25):
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={**headers, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as r:
        return json.loads(r.read())

def _google_key():
    # bashio returns the literal "null" for an empty optional option — treat as unset.
    k = (os.getenv("KASA_GOOGLE_API_KEY") or "").strip()
    return k if k and k.lower() != "null" else None

def _validate_anthropic_key(key):
    """Real cheap test call for the setup wizard: models.list costs no tokens
    and fails fast on a bad key. Never persists — the caller decides that."""
    try:
        import anthropic
    except ImportError:
        return False, "anthropic SDK not installed"
    try:
        anthropic.Anthropic(api_key=key, max_retries=0, timeout=15.0).models.list(limit=1)
        return True, None
    except Exception as e:
        return False, _safe_err(e)

def _validate_places_key(key):
    """Real cheap test call: a minimal Autocomplete (New) request — billed at
    its own (tiny) rate, fails fast with a clear error on a bad/unenabled key."""
    try:
        _http_post_json("https://places.googleapis.com/v1/places:autocomplete",
                        {"X-Goog-Api-Key": key}, {"input": "cafe", "regionCodes": ["au"]}, timeout=10)
        return True, None
    except Exception as e:
        return False, _safe_err(e)

def find_services_places(trade, suburb, address):
    """Google Places API (New) Text Search — real ratings, review counts & phone.
    Returns {trade,suburb,providers:[...]} or None when no key / on failure (so we fall back)."""
    key = _google_key()
    if not key:
        return None
    headers = {"X-Goog-Api-Key": key, "X-Goog-FieldMask": (
        "places.displayName,places.rating,places.userRatingCount,places.formattedAddress,"
        "places.nationalPhoneNumber,places.websiteUri,places.location,places.editorialSummary,"
        "places.photos,places.primaryTypeDisplayName,places.types")}
    text_query = f"{trade} near {address or suburb}"
    body = {"textQuery": text_query, "maxResultCount": 10}
    job_stage(f"Google Places: “{text_query}”…")
    loc = geocode(address or suburb)  # bias to businesses near the home
    if loc:
        body["locationBias"] = {"circle": {"center": {"latitude": loc[0], "longitude": loc[1]}, "radius": 20000.0}}
    try:
        resp = _http_post_json("https://places.googleapis.com/v1/places:searchText", headers, body)
    except Exception as e:
        print(f"[find] places api failed: {e}")
        return None
    provs = []
    for p in resp.get("places", []):
        name = (p.get("displayName") or {}).get("text")
        if not name:
            continue
        parts = [x.strip() for x in (p.get("formattedAddress") or "").split(",")]
        sub = parts[-2] if len(parts) >= 2 else (parts[0] if parts else None)  # "12 Smith St, Bondi NSW 2026, Australia" → the suburb part, not the street
        web = _domain(p.get("websiteUri"))
        # services from Google's place types (title-cased, drop generic ones)
        drop = {"point_of_interest", "establishment", "store"}
        svcs = [t.replace("_", " ").title() for t in (p.get("types") or []) if t not in drop][:4]
        prim = (p.get("primaryTypeDisplayName") or {}).get("text")
        if prim and prim not in svcs:
            svcs = ([prim] + svcs)[:4]
        photos = p.get("photos") or []
        photo = "api/place-photo?name=" + urllib.parse.quote(photos[0]["name"]) if photos and photos[0].get("name") else None
        provs.append({"name": name, "rating": p.get("rating"), "reviews": p.get("userRatingCount"),
                      "phone": p.get("nationalPhoneNumber"), "email": None, "website": web,
                      "suburb": sub, "blurb": (p.get("editorialSummary") or {}).get("text"),
                      "services": svcs, "logo": _logo_url(web), "photo": photo})
    provs.sort(key=_provider_score, reverse=True)
    print(f"[find] places returned {len(provs)} for {trade!r}")
    job_stage(f"Ranking {len(provs)} businesses by rating and reviews…")
    return {"trade": trade, "suburb": suburb, "providers": provs[:6],
            "debug": {"query": text_query, "source": "google-places", "found": len(provs)}}

def find_services(trade, suburb, address):
    """Real local providers ranked by reviews. Google Places API first (accurate + fast),
    falling back to keyless Claude web search when no Places key is configured."""
    places = find_services_places(trade, suburb, address)
    if places and places["providers"]:
        return places
    return find_services_web(trade, suburb, address)

def address_suggest(q):
    """Google Places Autocomplete (New) — address suggestions as the user types the
    setup screen's address field. Returns [] when no key / on failure, so the client
    degrades to plain typing (never an error the user sees)."""
    key = _google_key()
    if not key or not q:
        return []
    headers = {"X-Goog-Api-Key": key}
    body = {"input": q, "regionCodes": ["au"]}
    try:
        resp = _http_post_json("https://places.googleapis.com/v1/places:autocomplete", headers, body, timeout=8)
    except Exception as e:
        print(f"[address] autocomplete failed: {e}")
        return []
    out = []
    for s in resp.get("suggestions", []):
        pred = s.get("placePrediction")  # Places API (New) returns one prediction per suggestion, not a list
        if not pred:
            continue
        text = (pred.get("text") or {}).get("text")
        if not text:
            continue
        out.append({"label": text, "placeId": pred.get("placeId")})
    return out

def find_services_web(trade, suburb, address):
    """Return {trade, suburb, providers:[...]} of real local providers ranked by reviews."""
    empty = {"trade": trade, "suburb": suburb, "providers": []}
    try:
        import anthropic
    except ImportError:
        return empty
    if not (os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN")):
        return empty
    client = anthropic.Anthropic(max_retries=1, timeout=200.0)
    tools = [{"type": "web_search_20260209", "name": "web_search", "max_uses": 4}]
    where = address or suburb
    job_stage(f"No Places key — web-searching “{trade}” near {where}…")
    messages = [{"role": "user", "content":
                 f"Find the best-reviewed local '{trade}' businesses closest to {where}. Rank by Google reviews."}]
    data = None
    web_queries = []
    try:
        resp = None
        for _ in range(8):
            # Sonnet is much faster than Opus for web-search aggregation — find-a-service
            # should feel snappy. Override with KASA_FIND_MODEL if needed.
            resp = client.messages.create(model=FIND_MODEL, max_tokens=4000, system=FIND_SYSTEM, tools=tools, messages=messages)
            for b in resp.content:
                if getattr(b, "type", "") == "server_tool_use":
                    q = (getattr(b, "input", None) or {}).get("query")
                    if q:
                        web_queries.append(str(q)[:120])
                        job_stage(f"Searched “{q}”…")
            if resp.stop_reason == "pause_turn":
                messages.append({"role": "assistant", "content": resp.content})
                continue
            break
        text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
        i, j = text.find("{"), text.rfind("}")
        if i >= 0 and j >= 0:
            data = json.loads(text[i:j + 1])
    except Exception as e:
        print(f"[find] search failed: {e}")
    provs = (data or {}).get("providers") or []
    # keep well-formed entries, attach a logo, sort best-first by rating×review-volume
    provs = [p for p in provs if isinstance(p, dict) and p.get("name")]
    for p in provs:
        p["logo"] = _logo_url(p.get("website"))
        if not isinstance(p.get("services"), list):
            p["services"] = []
    provs.sort(key=_provider_score, reverse=True)
    return {"trade": trade, "suburb": suburb, "providers": provs[:6],
            "debug": {"query": f"{trade} near {where}", "source": "claude-web-search",
                      "queries": web_queries[:10], "found": len(provs)}}


# =============================================================================
# Email quote-loop
# -----------------------------------------------------------------------------
# Send trade enquiries from a dedicated Gmail (SMTP) and watch for replies
# (IMAP). Each enquiry subject carries a tracking token [KK-<quoteId>]; the
# background poller finds the reply, has Claude extract the price (AUD) and
# availability, and writes the result back into the shared store so every
# device sees the quote fill in automatically.
#
# SAFETY: outbound sends happen ONLY when the user approves an enquiry in the
# UI (POST /api/enquiry/send). The poller is read-only on the mailbox and only
# mutates quote status in the store — it never sends anything on its own.
# =============================================================================
import smtplib, imaplib, email as emaillib, email.policy, email.utils, re as _re

GMAIL_IMAP, GMAIL_SMTP = "imap.gmail.com", "smtp.gmail.com"
QUOTE_POLL_SEC = int(os.getenv("KASA_QUOTE_POLL_SEC", "120"))

def _gmail_creds():
    """(user, app_password) for the KasaKeeper mailbox, or None if unconfigured.
    App passwords are copied with spaces ('xxxx xxxx xxxx xxxx') — strip them."""
    u = (os.getenv("GMAIL_USER") or "").strip()
    p = (os.getenv("GMAIL_APP_PASSWORD") or "").replace(" ", "").strip()
    if not u or not p or u.lower() == "null" or p.lower() == "null":
        return None
    return u, p

def gmail_available():
    return _gmail_creds() is not None

def _tls_ctx():
    if _SSL_CTX:
        return _SSL_CTX
    import ssl as _ssl
    try:
        import certifi as _certifi
        return _ssl.create_default_context(cafile=_certifi.where())
    except Exception:
        return _ssl.create_default_context()

def _email_addr(s):
    m = _re.search(r"[\w.\-+]+@[\w.\-]+", s or "")
    return m.group(0).lower() if m else ""

def _validate_gmail_creds(user, app_password):
    """Real cheap test call for the setup wizard: an SMTP login, no message sent."""
    try:
        with smtplib.SMTP(GMAIL_SMTP, 587, timeout=15) as s:
            s.starttls(context=_tls_ctx())
            s.login(user, app_password)
        return True, None
    except Exception as e:
        return False, _safe_err(e)

def send_email(to_addr, subject, body_text, reply_to=None, cc=None):
    """SMTP-send a plaintext email from the KasaKeeper Gmail. Returns the Message-ID.
    Raises on failure so the caller can surface it."""
    creds = _gmail_creds()
    if not creds:
        raise RuntimeError("Gmail not configured (set GMAIL_USER / GMAIL_APP_PASSWORD).")
    user, pwd = creds
    msg = emaillib.message.EmailMessage()
    msg["From"] = user
    msg["To"] = to_addr
    msg["Subject"] = subject
    msgid = emaillib.utils.make_msgid(domain=user.split("@")[-1])
    msg["Message-ID"] = msgid
    if reply_to:
        msg["Reply-To"] = reply_to
    if cc:
        msg["Cc"] = cc          # keeps the household copy in their own inbox
    msg.set_content(body_text)
    with smtplib.SMTP(GMAIL_SMTP, 587, timeout=30) as s:
        s.starttls(context=_tls_ctx())
        s.login(user, pwd)
        s.send_message(msg)
    print(f"[enquiry] sent to {to_addr!r} subj={subject!r}")
    return msgid

def _plain_body(msg):
    """Best-effort plaintext of an email.message. Falls back to de-tagged HTML."""
    try:
        part = msg.get_body(preferencelist=("plain",))
        if part:
            return part.get_content()
        part = msg.get_body(preferencelist=("html",))
        if part:
            return _re.sub(r"<[^>]+>", " ", part.get_content())
    except Exception as e:
        print(f"[quote] body extract failed: {e}")
    return ""

QUOTE_PARSE_SYSTEM = (
    "You read ONE email reply from an Australian tradesperson or service business who was asked "
    "for a quote to service or do a job at a home. Extract the commercial details. All money is "
    "Australian dollars (AUD) unless the email explicitly states another currency. If a price is "
    "given as a range, set amount to the LOWER figure and mention the range in summary. Respond "
    "with ONLY a single JSON object (no markdown, no commentary) with exactly these keys: "
    "is_quote (boolean — true only if the email actually states a price or a dollar estimate), "
    "amount (number in AUD, or null if none stated), "
    "amount_is_estimate (boolean — true if it's a rough/'from' estimate rather than a firm quote), "
    "availability (short string for earliest availability e.g. 'week of 18 Aug', or null), "
    "ongoing_plan (boolean — do they mention an ongoing/annual service plan), "
    "needs_site_visit (boolean — do they need to inspect before they can quote), "
    "offered_dates (array of strings — every concrete date and/or time window they OFFER to do the "
    "job, kept short and human e.g. 'Tue 22 Jul morning', '8am Thursday 24th'; [] if none offered), "
    "paid_amount (number in AUD — any deposit or payment the email says has ALREADY been paid, or null), "
    "paid_receipt (short string — receipt/invoice number for that payment if stated, or null), "
    "balance_due (number in AUD — remaining balance if the email states one, or null), "
    "summary (one short sentence, max ~18 words)."
)

def parse_quote_reply(body_text):
    """Claude extracts {is_quote, amount(AUD), availability, ...} from a reply. None on failure."""
    if not body_text or not body_text.strip():
        return None
    try:
        import anthropic
    except ImportError:
        return None
    if not (os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN")):
        return None
    client = anthropic.Anthropic(max_retries=1, timeout=60.0)
    try:
        resp = client.messages.create(model=MODEL, max_tokens=600, system=QUOTE_PARSE_SYSTEM,
                                       messages=[{"role": "user", "content": body_text[:8000]}])
        text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
        i, j = text.find("{"), text.rfind("}")
        return json.loads(text[i:j + 1]) if i >= 0 and j >= 0 else None
    except Exception as e:
        print(f"[quote] parse failed: {e}")
        return None

def state_mutate(mutator, tries=6):
    """Read-modify-write the shared state under the rev-guard, retrying on contention.
    mutator(state) edits in place and returns True if it changed anything (False = no write)."""
    for _ in range(tries):
        doc = state_read()
        st = doc.get("state")
        if st is None:
            return None
        if mutator(st) is False:
            return doc
        ok, newdoc = state_write(doc.get("rev", 0), st)
        if ok:
            return newdoc
        time.sleep(0.2)  # another writer won the rev — retry against the fresh copy
    print("[quote] state_mutate gave up after contention")
    return None

def _imap_replies_for_tokens(tokens):
    """{token: [(uid, msgid, from, ts, body), ...]} for INBOX messages whose subject
    carries a watched [KK-<id>] token (oldest-first). Our own Sent copies live in a
    different folder, so searching INBOX only returns genuine third-party replies."""
    creds = _gmail_creds()
    if not creds or not tokens:
        return {}
    user, pwd = creds
    out = {t: [] for t in tokens}
    m = imaplib.IMAP4_SSL(GMAIL_IMAP, 993, ssl_context=_tls_ctx(), timeout=30)  # a stall here would wedge the poller thread for good
    try:
        m.login(user, pwd)
        m.select("INBOX", readonly=True)
        for tok in tokens:
            typ, data = m.uid("SEARCH", None, "SUBJECT", '"%s"' % tok)
            if typ != "OK" or not data or not data[0]:
                continue
            for uid in data[0].split()[-4:]:  # newest few
                typ, fetched = m.uid("FETCH", uid, "(RFC822)")
                if typ != "OK" or not fetched or not isinstance(fetched[0], tuple):
                    continue
                msg = emaillib.message_from_bytes(fetched[0][1], policy=emaillib.policy.default)
                try:
                    ts = emaillib.utils.parsedate_to_datetime(msg.get("Date")).timestamp()
                except Exception:
                    ts = 0
                out[tok].append((uid.decode(), str(msg.get("Message-ID", "")),
                                 str(msg.get("From", "")), ts, _plain_body(msg)))
            out[tok].sort(key=lambda r: r[3])
    finally:
        try: m.logout()
        except Exception: pass
    return out

def _imap_replies_from(senders):
    """{addr: [(uid, msgid, from, ts, body), ...]} — newest few INBOX messages FROM each
    watched sender. Fallback for follow-ups that dropped the [KK-] subject token
    (a trade composing a fresh email instead of replying is common)."""
    creds = _gmail_creds()
    if not creds or not senders:
        return {}
    user, pwd = creds
    out = {s: [] for s in senders}
    m = imaplib.IMAP4_SSL(GMAIL_IMAP, 993, ssl_context=_tls_ctx(), timeout=30)
    try:
        m.login(user, pwd)
        m.select("INBOX", readonly=True)
        for addr in senders:
            # addr comes from a trade-controlled From: header — allow only plain
            # addr-spec characters so it can't break out of the quoted SEARCH atom.
            if not _re.fullmatch(r"[A-Za-z0-9._%+@-]{3,254}", addr):
                continue
            if addr.startswith("@"):
                # Domain tier searches full text, not just From: — a reply the OWNER
                # forwards into this mailbox carries the trade's address in the body.
                typ, data = m.uid("SEARCH", None, "X-GM-RAW", '"%s"' % addr[1:])
            else:
                typ, data = m.uid("SEARCH", None, "FROM", '"%s"' % addr)
            if typ != "OK" or not data or not data[0]:
                continue
            for uid in data[0].split()[-3:]:  # newest few
                typ, fetched = m.uid("FETCH", uid, "(RFC822)")
                if typ != "OK" or not fetched or not isinstance(fetched[0], tuple):
                    continue
                msg = emaillib.message_from_bytes(fetched[0][1], policy=emaillib.policy.default)
                try:
                    ts = emaillib.utils.parsedate_to_datetime(msg.get("Date")).timestamp()
                except Exception:
                    ts = 0
                out[addr].append((uid.decode(), str(msg.get("Message-ID", "")),
                                  str(msg.get("From", "")), ts, _plain_body(msg)))
            out[addr].sort(key=lambda r: r[3])
    finally:
        try: m.logout()
        except Exception: pass
    return out

def poll_quote_replies():
    """One poll cycle: match INBOX replies to enquiry_sent quotes, parse, update the store."""
    if not gmail_available():
        return
    st = state_read().get("state")
    if not st or not st.get("quotes"):
        return
    # Watch every quote whose conversation is still live — a trade replies more
    # than once (quote, then dates, then payment details). The lastReplyId guard
    # keeps already-processed messages from re-applying.
    watched = {q["token"]: q["id"] for q in st["quotes"]
               if q.get("status") in ("enquiry_sent", "replied", "quoted", "dates_offered") and q.get("token")}
    if not watched:
        return
    replies = _imap_replies_for_tokens(list(watched))
    # newest reply per watched quote
    newest = {}
    for tok, qid in watched.items():
        msgs = replies.get(tok) or []
        if msgs:
            uid, msgid, frm, ts, body = msgs[-1]
            newest[qid] = {"msgid": msgid, "from": frm, "body": body, "ts": ts}
    # Sender fallback: trades drop the [KK-] token constantly (fresh emails, edited
    # subjects, a different mailbox on the same domain). Tiered search per quote:
    # exact replyFrom → the enquiryTo we wrote to → anyone @ that domain. Domain-tier
    # hits must also LOOK like job mail so a newsletter can't hijack the card.
    by_qid = {q["id"]: q for q in st["quotes"]}
    pending = {}
    for tok, qid in watched.items():
        q = by_qid.get(qid) or {}
        cur = newest.get(qid)
        if cur and cur["msgid"] != q.get("lastReplyId"):
            continue  # token search already found something new
        terms = []
        for a in ((q.get("replyFrom") or ""), (q.get("enquiryTo") or "")):
            a = a.strip().lower()
            if a and a not in terms:
                terms.append(a)
        for d in ["@" + a.split("@", 1)[1] for a in list(terms) if "@" in a]:
            if d not in terms:
                terms.append(d)
        if terms:
            pending[qid] = terms
    if pending:
        found = _imap_replies_from(sorted({t for ts_ in pending.values() for t in ts_}))
        for qid, terms in pending.items():
            q = by_qid.get(qid) or {}
            gate_words = [w.lower() for w in ("quote", "booking", "invoice", "job", "deposit",
                          (q.get("provider") or "").split(" ")[0], (q.get("trade") or "").split(" ")[0]) if w]
            best = None
            for t in terms:
                for r in (found.get(t) or []):
                    if not r[1] or r[1] == q.get("lastReplyId"):
                        continue
                    if t.startswith("@") and not any(w in (r[4] or "").lower() for w in gate_words):
                        continue  # domain-wide hit with no job-ish content — ignore
                    if best is None or r[3] > best[3]:
                        best = r
            if best:
                uid, msgid, frm, ts, body = best
                prev = newest.get(qid)
                if not prev or ts >= (prev.get("ts") or 0):
                    newest[qid] = {"msgid": msgid, "from": frm, "body": body, "ts": ts}
    # drop entries that are just the already-processed message again
    newest = {qid: info for qid, info in newest.items()
              if info["msgid"] != (by_qid.get(qid) or {}).get("lastReplyId")}
    # Repair-only cycles must still reach the mutator: a pre-'replied'-era quote
    # whose reply was later archived would otherwise stay "enquiry sent" forever.
    needs_repair = any(q.get("status") == "enquiry_sent" and q.get("replyNote")
                       for q in st["quotes"])
    if not newest and not needs_repair:
        return
    # Claude parse happens OUTSIDE the state lock (slow); apply results in one mutate
    parsed = {qid: (info, parse_quote_reply(info["body"])) for qid, info in newest.items()}
    notify = []  # (title, message, homeId) collected in the mutator, pushed after the write

    def mutator(state):
        changed = False
        for q in state.get("quotes", []):
            if q["id"] not in parsed:
                continue
            info, res = parsed[q["id"]]
            if info["msgid"] and q.get("lastReplyId") == info["msgid"]:
                continue  # this exact reply already processed
            q["lastReplyId"] = info["msgid"]
            q["repliedAt"] = time.strftime("%Y-%m-%d")
            # A forwarded reply arrives FROM the owner — keep the trade's address
            # as the reply-to target, never the household's own.
            _sender = _email_addr(info["from"]) or ""
            _own = {(_gmail_creds() or ("", ""))[0].lower(),
                    str(((state.get("settings") or {}).get("emailCc") or "")).lower()}
            if _sender and _sender.lower() not in _own:
                q["replyFrom"] = _sender
            dates = [str(d).strip() for d in ((res or {}).get("offered_dates") or [])
                     if str(d).strip()][:5]
            if dates:
                q["offeredDates"] = dates
            if res and res.get("is_quote") and res.get("amount") is not None:
                q["amount"] = res["amount"]
                q["currency"] = "AUD"
                q["availability"] = res.get("availability")
                q["status"] = "quoted"
                q["replyNote"] = res.get("summary")
                q["autoParsed"] = True
                q["isEstimate"] = bool(res.get("amount_is_estimate"))
            else:
                q["replyNote"] = (res or {}).get("summary") or "Reply received — no price yet."
                q["needsSiteVisit"] = bool((res or {}).get("needs_site_visit"))
                # A reply that parses to neither price nor dates must still leave
                # "awaiting reply" — the trade answered, the user just has to read it.
                if q.get("status") == "enquiry_sent":
                    q["status"] = "replied"
            # Payments already made (deposits) are facts, not decisions — record the
            # typed fields so the card can show them; nothing books or sends off them.
            if res and res.get("paid_amount") is not None:
                q["paidAmount"] = res["paid_amount"]
                if res.get("paid_receipt"):
                    q["paidReceipt"] = str(res["paid_receipt"])[:40]
            if res and res.get("balance_due") is not None:
                q["balanceDue"] = res["balance_due"]
            if dates and q.get("status") in ("enquiry_sent", "replied", "quoted"):
                q["status"] = "dates_offered"  # dates in hand — user picks one to confirm
            who = q.get("provider") or "A trade"
            if q.get("status") == "dates_offered":
                notify.append(("KasaKeeper — dates offered",
                               f"{who} offered: {' / '.join(dates[:3])}"
                               + (f" · {money_str(q.get('amount'))}" if q.get("amount") else "")
                               + " — open KasaKeeper to confirm one.", q.get("homeId")))
            elif q.get("status") == "quoted":
                # The push must carry the proposed cost — the user confirms or
                # changes it from the card, so lead with the number.
                notify.append(("KasaKeeper — quote in",
                               f"{who} quoted {money_str(q.get('amount'))}"
                               + (f" · {q.get('availability')}" if q.get("availability") else "")
                               + " — open KasaKeeper to book or adjust.", q.get("homeId")))
            else:
                # Every processed reply is worth a push, not just auto-book ones —
                # a disputed invoice or "need a site visit" answer is exactly what
                # the user is waiting on.
                notify.append(("KasaKeeper — reply received",
                               f"{who}: " + (q.get("replyNote") or "replied to the enquiry."), q.get("homeId")))
            changed = True
        # One-time repair for replies processed before the 'replied' state existed:
        # the lastReplyId guard means they will never re-enter the branch above.
        for q in state.get("quotes", []):
            if q.get("status") == "enquiry_sent" and q.get("replyNote"):
                q["status"] = "replied"
                changed = True
        return changed

    res = state_mutate(mutator)
    if res:
        print(f"[quote] processed {len(parsed)} repl(y/ies); rev now {res.get('rev')}")
        for title, msg, home_id in notify:
            ha_notify(title, msg[:250], home_id)

def money_str(v):
    try:
        return f"${float(v):,.0f}"
    except Exception:
        return str(v)

def _quote_poller():
    while True:
        try:
            poll_quote_replies()
        except Exception as e:
            print(f"[quote] poller error: {e}")
        time.sleep(QUOTE_POLL_SEC)


# =============================================================================
# AUTO-BOOK — tasks the user flags "Auto" get their booking enquiry emailed
# automatically once the due date enters the lead window (settings.autoLeadDays,
# default 14). Replies are handled by the quote poller above; offered dates set
# status 'dates_offered' and the user confirms one in the app (the confirmation
# email itself is always user-approved via the composer).
#
# GUARDRAILS on unattended sending:
#   * never runs in 'onetime' Gmail mode — a personal import mailbox stays
#     strictly read-only; only the dedicated KasaKeeper inbox may send
#   * only tasks explicitly toggled autoBook, with a linked provider email
#   * one open quote per task/asset — never re-sends while one is in flight
#   * business hours only (home timezone), and each send pushes an HA
#     notification so the user always knows an email went out
# =============================================================================
AUTOBOOK_POLL_SEC = int(os.getenv("KASA_AUTOBOOK_POLL_SEC", "1800"))

def _task_days_until(task):
    """Mirror of the client's scheduler: lastDone + cadenceDays - today (days)."""
    import datetime
    last, cad = task.get("lastDone"), task.get("cadenceDays")
    if not last or not cad:
        return None
    try:
        due = datetime.date.fromisoformat(str(last)[:10]) + datetime.timedelta(days=int(cad))
        return (due - datetime.date.today()).days
    except Exception:
        return None

def _local_hour():
    import datetime
    tz = _ha_timezone()
    return (datetime.datetime.now(tz) if tz else datetime.datetime.now()).hour

def autobook_scan():
    """One pass: send booking enquiries for auto tasks entering the lead window."""
    if not gmail_available():
        return
    st = state_read().get("state") or {}
    settings = st.get("settings") or {}
    if settings.get("gmailMode") == "onetime":
        return  # personal mailbox — read-only, never send
    if not (9 <= _local_hour() < 18):
        return  # tradie-friendly hours only
    try:
        lead = int(settings.get("autoLeadDays") or 14)
    except Exception:
        lead = 14
    assets = {a.get("id"): a for a in st.get("assets", [])}
    provs = {p.get("id"): p for p in st.get("providers", [])}
    homes = {h.get("id"): h for h in st.get("homes", [])}
    open_tasks = {q.get("taskId") for q in st.get("quotes", []) if q.get("status") not in ("booked", "declined")}
    open_assets = {q.get("assetId") for q in st.get("quotes", []) if q.get("status") not in ("booked", "declined")}
    for t in st.get("tasks", []):
        if not t.get("autoBook") or t.get("snoozed") or t.get("diy"):
            continue  # diy: belt-and-braces — the UI already clears autoBook on DIY jobs
        d = _task_days_until(t)
        if d is None or d > lead:
            continue
        if t.get("id") in open_tasks or t.get("assetId") in open_assets:
            continue  # an enquiry/quote is already in flight for this job
        a = assets.get(t.get("assetId"))
        p = provs.get(t.get("providerId") or (a or {}).get("providerId"))  # task-level provider override wins
        to = _email_addr((p or {}).get("email", ""))
        if not a or not p or not to:
            continue  # auto needs a linked provider with an email
        home = homes.get(a.get("homeId")) or {}
        if home.get("testMode"):
            continue  # a test/demo home — no unattended mail to a friend's real trades
        addr = home.get("address") or settings.get("suburb") or ""
        qid = _uid("q")
        token = "KK-" + qid
        when = "is due now" if d <= 0 else f"comes due in about {d} days"
        subject = f"Booking request — {t.get('title')} ({a.get('name')}) [{token}]"
        body = (f"Hi {p.get('name')},\n\n"
                f"We'd like to book you in for: {t.get('title')} — {a.get('name')}"
                + (f" at {addr}" if addr else "")
                + f". It {when}.\n\n"
                "Could you reply with a quote and two or three dates/times that would suit you? "
                "We'll confirm one by reply.\n\nThanks!\n"
                "(Sent by KasaKeeper, our home-maintenance assistant — just reply to this email.)")
        # Persist the quote BEFORE sending: if the email went first and the contended
        # store write then gave up, nothing recorded the send and the next scan would
        # email the same trade again. Unattended outbound mail must never double-fire —
        # so record first (skip the send entirely if the write loses), and compensate
        # by dropping the record if the send itself then fails.
        quote = {"id": qid, "homeId": a.get("homeId"), "assetId": a.get("id"), "taskId": t.get("id"),
                 "trade": t.get("title"), "provider": p.get("name"), "status": "enquiry_sent",  # the JOB (matches the email subject), not the category bucket
                 "token": token, "channel": "email", "enquiryTo": to,
                 "enquirySentAt": time.strftime("%Y-%m-%d"), "auto": True}
        if not state_mutate(lambda s, _q=quote: bool(s.setdefault("quotes", []).append(_q)) or True):
            print(f"[autobook] store contended — {t.get('title')!r} deferred to next scan (no email sent)")
            continue
        try:
            send_email(to, subject, body)
        except Exception as e:
            print(f"[autobook] send failed for {t.get('title')!r}: {e}")
            def _drop(s, _qid=qid):
                s["quotes"] = [q for q in s.get("quotes", []) if q.get("id") != _qid]
                return True
            state_mutate(_drop)
            continue
        open_tasks.add(t.get("id")); open_assets.add(t.get("assetId"))
        ha_notify("KasaKeeper — auto-book",
                  f"Emailed {p.get('name')} to book “{t.get('title')}” — I'll ping you when dates come back.",
                  a.get("homeId"))
        print(f"[autobook] enquiry sent for {t.get('title')!r} -> {to} token={token}")

def _autobook_loop():
    time.sleep(120)  # let the add-on (and HA proxy) settle after boot
    while True:
        try:
            autobook_scan()
        except Exception as e:
            print(f"[autobook] scan error: {e}")
        time.sleep(AUTOBOOK_POLL_SEC)


# ---- snap-to-add + describe-a-problem (Claude vision, fast synchronous calls) ---
IDENTIFY_SYSTEM = (
    "You read a photo of a household appliance or system — usually its nameplate/rating plate, "
    "sometimes the whole unit. Extract what a home-maintenance app needs. Respond with ONLY a JSON "
    "object: {\"name\": short human name for the asset (e.g. \"Hot water system\", \"Ducted air conditioning\", "
    "\"Pool pump\"), \"category\": exactly one of [" + ", ".join(f'"{c}"' for c in CATEGORIES) + "], "
    "\"make\": brand or null, \"model\": model number or null, \"serial\": serial number or null, "
    "\"notes\": one short spec worth keeping (capacity/size/year) or null, "
    "\"confidence\": \"high\"|\"medium\"|\"low\"}. Read printed barcode digits if visible. "
    "Never invent values — null anything you cannot actually read."
)

TRIAGE_SYSTEM = (
    "A homeowner describes a problem with their house (text, sometimes a photo). Triage it. "
    "Respond with ONLY a JSON object: {\"summary\": one plain line naming the problem, "
    "\"category\": exactly one of [" + ", ".join(f'"{c}"' for c in CATEGORIES) + "], "
    "\"trade\": the search term for the right tradesperson (e.g. \"emergency plumber\", \"air conditioning repair\"), "
    "\"urgency\": \"emergency\"|\"soon\"|\"routine\", "
    "\"advice\": 2-3 practical sentences for right now — include any safety step (mains off, gas off) first, "
    "\"forTradie\": one short paragraph the homeowner can send a tradie describing the job}. "
    "Be honest about urgency — most things are routine."
)

# ---- feature lookup: make/model -> manufacturer schedule + manual link ---------
LOOKUP_SYSTEM = (
    "You research one specific home asset for a maintenance app. When a make+model is "
    "given, use web_search to find the manufacturer's documentation for that exact unit. "
    "When only a name/category is given (a limestone wall, a timber deck, a pond), research "
    "the accepted trade-standard maintenance for that kind of thing at an Australian home. "
    "Respond with ONLY a JSON object (no prose, no code fences): "
    "{\"summary\": one sentence on what this unit is, "
    "\"manualUrl\": direct URL to the official manual/spec PDF or the manufacturer's product-support page, or null, "
    "\"specs\": {2-6 short key facts a home maintainer needs, e.g. \"filter\": \"...\", \"capacity\": \"...\"}, "
    "\"tasks\": [up to 5 of {\"title\": short task name, \"cadenceDays\": number, \"note\": one practical line}] "
    "— the MANUFACTURER-recommended maintenance schedule, "
    "\"usageIntervalHours\": the maker's service interval expressed in RUN-HOURS when the manual states one (else null), "
    "\"tips\": [up to 3 short practical owner tips]}. "
    "Rules: cadenceDays is a NUMBER of days. Prefer the manufacturer's stated intervals; if none found, "
    "use the accepted trade standard for this exact equipment type and say so in the note. "
    "manualUrl must be a URL you actually found — never invented. Null anything you cannot verify."
)

def lookup_features(make, model, name, category):
    empty = {"error": "lookup unavailable"}
    try:
        import anthropic
    except ImportError:
        return {"error": "Install the anthropic SDK for feature lookup."}
    if not (os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN")):
        return {"error": "No Anthropic API key is set — add one in the add-on Configuration."}
    client = anthropic.Anthropic(max_retries=1, timeout=200.0)
    tools = [{"type": "web_search_20260209", "name": "web_search", "max_uses": 6}]
    unit = " ".join(x for x in (make, model) if x)
    ask = (f"Research this unit and return its maintenance profile: {unit} ({name or 'appliance'}, category: {category or 'unknown'})"
           if unit else
           f"What maintenance does this actually need? Return the maintenance profile for: {name} (category: {category or 'unknown'}) at an Australian home.")
    messages = [{"role": "user", "content": ask}]
    job_stage(f"Working out what a {unit or name or 'unit'} needs…")
    queries = []   # the web searches Claude actually ran — surfaced for the debug drawer
    try:
        resp = None
        for _ in range(8):  # resume across web_search pause_turns
            resp = client.messages.create(model=MODEL, max_tokens=3000, system=LOOKUP_SYSTEM, tools=tools, messages=messages)
            for b in resp.content:
                if getattr(b, "type", "") == "server_tool_use":
                    q = (getattr(b, "input", None) or {}).get("query")
                    if q:
                        queries.append(str(q)[:120])
                        job_stage(f"Searched “{q}”…")
            if resp.stop_reason == "pause_turn":
                messages.append({"role": "assistant", "content": resp.content})
                job_stage("Still reading manufacturer pages…")
                continue
            break
        job_stage("Reading what came back…")
        text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
        i, j = text.find("{"), text.rfind("}")
        if i >= 0 and j >= 0:
            data = json.loads(text[i:j + 1])
            # Shape-guard everything the client will render or write into tasks.
            out = {"summary": str(data.get("summary") or "")[:300],
                   "manualUrl": (str(data.get("manualUrl"))[:500] if data.get("manualUrl") else None),
                   "specs": {str(k)[:40]: str(v)[:120] for k, v in (data.get("specs") or {}).items() if v},
                   "tips": [str(t)[:200] for t in (data.get("tips") or [])[:3]],
                   # the data behind the action — what we asked and what was actually searched
                   "debug": {"asked": ask[:300], "queries": queries[:10]},
                   "tasks": []}
            for t in (data.get("tasks") or [])[:5]:
                try:
                    cd = int(t.get("cadenceDays"))
                except Exception:
                    continue
                if t.get("title") and cd > 0:
                    out["tasks"].append({"title": str(t["title"])[:80], "cadenceDays": cd,
                                         "note": str(t.get("note") or "")[:200]})
            try:
                uh = int(data.get("usageIntervalHours") or 0)
                if 0 < uh < 100000:
                    out["usageIntervalHours"] = uh
            except Exception:
                pass
            return out
    except Exception as e:
        print(f"[lookup] error: {e}")
    return empty


# ---- recall & safety check (#4, slice 1): make/model -> ACCC + manufacturer recalls ----
RECALL_SYSTEM = (
    "You check one specific home appliance/asset for product recalls and safety notices, for an "
    "Australian home maintenance app. Use web_search on productsafety.gov.au (the ACCC Product Safety "
    "website) and the manufacturer's own recall/safety-notice pages for this exact make+model (or "
    "product name). Respond with ONLY a JSON object (no prose, no code fences): "
    "{\"status\": \"clear\"|\"recall\"|\"unknown\", "
    "\"summary\": one plain sentence — what you found, or that nothing was found, "
    "\"url\": the source URL for a recall/notice you found, or null, "
    "\"remedy\": what the owner should do about it, or null}. "
    "Use \"recall\" only when you found a genuine, specific recall or safety notice for this exact "
    "product. Use \"unknown\" if the search was inconclusive or there wasn't enough to search from. "
    "Use \"clear\" only when you actually searched and found nothing. Never invent a URL — only "
    "include one you actually found."
)

def recall_check(make, model, name):
    empty = {"error": "recall check unavailable"}
    try:
        import anthropic
    except ImportError:
        return {"error": "Install the anthropic SDK for recall check."}
    if not (os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN")):
        return {"error": "No Anthropic API key is set — add one in the add-on Configuration."}
    client = anthropic.Anthropic(max_retries=1, timeout=200.0)
    tools = [{"type": "web_search_20260209", "name": "web_search", "max_uses": 6}]
    unit = " ".join(x for x in (make, model) if x)
    subject = unit or name
    ask = (f"Check for recalls and safety notices for this exact product: {subject}"
           + (f" ({name})" if name and unit else ""))
    messages = [{"role": "user", "content": ask}]
    try:
        resp = None
        for _ in range(8):  # resume across web_search pause_turns
            resp = client.messages.create(model=MODEL, max_tokens=1500, system=RECALL_SYSTEM, tools=tools, messages=messages)
            if resp.stop_reason == "pause_turn":
                messages.append({"role": "assistant", "content": resp.content})
                continue
            break
        text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
        i, j = text.find("{"), text.rfind("}")
        if i >= 0 and j >= 0:
            data = json.loads(text[i:j + 1])
            status = data.get("status")
            if status not in ("clear", "recall", "unknown"):
                status = "unknown"
            return {
                "status": status,
                "summary": str(data.get("summary") or "")[:300],
                "url": (str(data.get("url"))[:500] if data.get("url") else None),
                "remedy": (str(data.get("remedy"))[:300] if data.get("remedy") else None),
            }
    except Exception as e:
        print(f"[recall] error: {e}")
    return empty


# ---- recall & safety check (#4, slice 2): scheduled monthly sweep + morning brief --
# Piggybacks the existing daily scheduler thread (_digest_pusher) — see
# _maybe_recall_sweep() below. Its own bookkeeping (last-run stamp + a per-asset
# last-checked cursor, for "oldest checked first") lives in kk-recall.json,
# separate from a.recall on the asset itself (the user-visible outcome).
RECALL_SWEEP_FILE = os.path.join(DATA_DIR, "kk-recall.json")
RECALL_SWEEP_CAP = 12
_RECALL_SWEEP_LOCK = threading.Lock()   # the on-demand endpoint + the scheduled tick can
                                         # otherwise overlap and race kk-recall.json's r-m-w

def _recall_sweep_meta():
    try:
        return json.load(open(RECALL_SWEEP_FILE))
    except Exception:
        return {}

def _save_recall_sweep_meta(meta):
    try:
        tmp = RECALL_SWEEP_FILE + ".tmp"
        json.dump(meta, open(tmp, "w"))
        os.replace(tmp, RECALL_SWEEP_FILE)
    except Exception as e:
        print(f"[recall-sweep] meta save failed: {e}")

def recall_sweep(meta=None):
    """One sweep run: recall_check() for every make/model asset across all
    non-testMode homes, capped at RECALL_SWEEP_CAP, oldest-checked first (a
    fresh/never-checked asset sorts first). Anything past the cap is left for
    the next tick — its checked-cursor stays old, so it naturally sorts to the
    front next time. Writes a.recall = {status, summary, url, remedy, at} onto
    the asset via state_mutate, but ONLY when the outcome actually changed (or
    was absent) — an unchanged result is never written, so it can never
    clobber a user's own edits (e.g. an "OK, seen" ack) elsewhere on the row.
    Never raises — a no-key/degraded recall_check() is a per-asset no-op. Never
    overlaps itself — the on-demand endpoint and the scheduled tick can otherwise
    land at the same moment and race the kk-recall.json read-modify-write; a run
    that finds one already in flight declines instead of racing it."""
    if not _RECALL_SWEEP_LOCK.acquire(blocking=False):
        print("[recall-sweep] a run is already in progress — skipping")
        return {"skipped": "already running"}
    try:
        own_meta = meta is None
        if meta is None:
            meta = _recall_sweep_meta()
        st = state_read().get("state")
        if not st:
            if own_meta:
                _save_recall_sweep_meta(meta)
            return {"checked": 0}
        existing_ids = {a.get("id") for a in st.get("assets", []) if a.get("id")}
        checked_at = {aid: at for aid, at in (meta.get("checkedAt") or {}).items()
                      if aid in existing_ids}   # drop the cursor for assets deleted elsewhere
        homes = {h.get("id") for h in st.get("homes", []) if not h.get("testMode")}
        candidates = [a for a in st.get("assets", [])
                      if a.get("id") and a.get("homeId") in homes and (a.get("make") or a.get("model"))]
        candidates.sort(key=lambda a: checked_at.get(a.get("id"), ""))
        batch = candidates[:RECALL_SWEEP_CAP]
        checked = 0
        today = time.strftime("%Y-%m-%d")
        for a in batch:
            aid = a["id"]
            try:
                result = recall_check(a.get("make"), a.get("model"), a.get("name"))
            except Exception as e:
                print(f"[recall-sweep] error checking {aid}: {e}")
                continue
            if result.get("error"):
                print(f"[recall-sweep] {aid}: {result['error']}")
                continue   # friendly no-key/degraded path — writes nothing, sweep carries on
            checked_at[aid] = today
            checked += 1
            new = {"status": result.get("status") or "unknown", "summary": result.get("summary") or "",
                   "url": result.get("url"), "remedy": result.get("remedy"), "at": today}
            def _mut(s, _aid=aid, _new=new):
                for x in s.get("assets", []):
                    if x.get("id") == _aid:
                        cur = x.get("recall") or {}
                        if all(cur.get(k) == _new.get(k) for k in ("status", "summary", "url", "remedy")):
                            return False   # unchanged outcome — nothing to write
                        x["recall"] = dict(_new, ack=False)   # a new/changed notice needs a fresh ack
                        return True
                return False
            state_mutate(_mut)
        meta["checkedAt"] = checked_at
        remaining = len(candidates) - len(batch)
        meta["pendingCount"] = remaining
        if remaining == 0:
            meta["lastRun"] = today
        _save_recall_sweep_meta(meta)
        print(f"[recall-sweep] checked {checked}/{len(candidates)} asset(s), {remaining} pending")
        return {"checked": checked, "total": len(candidates), "pending": remaining}
    except Exception as e:
        print(f"[recall-sweep] run failed: {e}")
        return {"error": str(e)}
    finally:
        _RECALL_SWEEP_LOCK.release()

def _maybe_recall_sweep(now):
    """Called on every _digest_pusher tick. Fires the sweep at most once/day
    (guarded by a stored tick date), when: it's the 1st of the month, OR a
    backlog remains from an incomplete previous run (stagger to the next
    day's tick), OR the last completed sweep is >28 days old (catches an
    add-on that was offline on the 1st). Never a second thread — this runs
    inline on the existing daily scheduler thread."""
    if now.hour != NOTIFY_HOUR:
        return
    try:
        meta = _recall_sweep_meta()
        today = now.date().isoformat()
        if meta.get("tickDate") == today:
            return   # already considered today
        meta["tickDate"] = today
        due = now.day == 1 or bool(meta.get("pendingCount"))
        if not due:
            last_run = meta.get("lastRun")
            if not last_run:
                due = True
            else:
                try:
                    import datetime
                    due = (now.date() - datetime.date.fromisoformat(last_run)).days > 28
                except Exception:
                    due = True
        # Persist the once-per-day guard NOW, before doing any work — so a crash
        # inside recall_sweep() (belt-and-braces; it already guards itself) can
        # never leave tickDate unwritten and cause a retry on every 5-min tick
        # for the rest of this hour.
        _save_recall_sweep_meta(meta)
        if due:
            recall_sweep(meta)
    except Exception as e:
        print(f"[recall-sweep] tick error: {e}")

def _recall_alert_line(state):
    """One 'recall' line for the morning brief naming every asset with a
    genuine, un-acknowledged recall (a.recall.status == 'recall' and not
    a.recall.ack), or None when there's nothing to say."""
    if not isinstance(state, dict):
        return None
    names = [a.get("name") or "an asset" for a in state.get("assets", [])
             if isinstance(a.get("recall"), dict) and a["recall"].get("status") == "recall"
             and not a["recall"].get("ack")]
    if not names:
        return None
    shown = ", ".join(names[:4])
    more = f" +{len(names) - 4} more" if len(names) > 4 else ""
    return f"⚠ Recall: {shown}{more}"

def _digest_push_parts(d, state=None, home_id=None):
    """Builds the ordered line list for the morning-brief push from the saved
    digest dict (client-posted overdue/soon/nudges) plus a recall alert line
    sourced from live shared state. Pulled out of _digest_pusher so it's
    independently testable. home_id (falls back to d['homeId'], then
    state['currentHomeId']) picks which home's HA source the drift nudge reads."""
    parts = []
    if d.get("overdue"):
        parts.append(f"{len(d['overdue'])} overdue: " + ", ".join(d["overdue"][:3]))
    if d.get("soon"):
        parts.append(f"{len(d['soon'])} due soon: " + ", ".join(d["soon"][:3]))
    recall_line = _recall_alert_line(state)
    if recall_line:
        parts.append(recall_line)
    parts += (d.get("nudges") or [])[:2]
    hid = home_id or d.get("homeId") or (state or {}).get("currentHomeId")
    if ha_available(hid):   # one-sentence registry-drift nudge — findings only, never a write
        try:
            drift = ha_drift(hid)
            nc = len(drift.get("drift") or []) + len(drift.get("vanished") or [])
            nn = len(drift.get("newDevices") or [])
            if nc or nn:
                bits = []
                if nc: bits.append(f"{nc} correction{'s' if nc != 1 else ''}")
                if nn: bits.append(f"{nn} new device{'s' if nn != 1 else ''}")
                parts.append("Home Assistant sees " + " · ".join(bits))
        except Exception as e:
            print(f"[push] drift check failed: {e}")
    if not parts and d.get("next"):
        parts.append("All kept. Next: " + d["next"])
    return parts


# ---- inspection report import: PDF -> a ranked defect list -------------------
INSPECT_SYSTEM = (
    "You read an Australian home building/pest inspection report (PDF). Extract every "
    "defect, issue or recommendation it lists. Respond with ONLY a JSON object (no prose, "
    "no code fences): {\"defects\": [{\"title\": short defect name, "
    "\"severity\": \"urgent\"|\"attention\"|\"monitor\", "
    "\"area\": the room/area/system it's in (e.g. \"Roof\", \"Bathroom\", \"Subfloor\"), "
    "\"recommendation\": one practical sentence on what to do about it, "
    "\"cadenceDays\": a recheck interval in days if the report implies ongoing monitoring, else null}]}. "
    "severity: urgent = safety/structural/major and needs prompt action, attention = should be "
    "fixed soon but isn't an emergency, monitor = watch over time. Cap at the 40 most significant "
    "defects, most serious first. Never invent findings that aren't in the report."
)
_INSPECT_SEVERITIES = {"urgent", "attention", "monitor"}

def inspect_report(pdf_b64, filename):
    """One Claude call with the PDF as a document content block. Returns a
    shape-guarded {"defects": [...]} or a friendly {"error": ...}."""
    try:
        import anthropic
    except ImportError:
        return {"error": "Install the anthropic SDK for inspection import."}
    if not (os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN")):
        return {"error": "No Anthropic API key is set — add one in the add-on Configuration."}
    client = anthropic.Anthropic(max_retries=1, timeout=200.0)
    ask = "Extract the defects from this inspection report" + (f" ({filename})." if filename else ".")
    content = [
        {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": pdf_b64}},
        {"type": "text", "text": ask},
    ]
    try:
        resp = client.messages.create(model=MODEL, max_tokens=4000, system=INSPECT_SYSTEM,
                                      messages=[{"role": "user", "content": content}])
        text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
        i, j = text.find("{"), text.rfind("}")
        if i < 0 or j < 0:
            return {"error": "couldn't read that report — try a clearer PDF"}
        data = json.loads(text[i:j + 1])
        out = {"defects": []}
        for d in (data.get("defects") or [])[:40]:
            if not isinstance(d, dict):
                continue
            title = str(d.get("title") or "").strip()[:120]
            if not title:
                continue
            sev = str(d.get("severity") or "monitor").strip().lower()
            if sev not in _INSPECT_SEVERITIES:
                sev = "monitor"
            cd = None
            try:
                cdv = d.get("cadenceDays")
                if cdv is not None:
                    cd = int(cdv)
                    if not (0 < cd < 36600):
                        cd = None
            except Exception:
                cd = None
            out["defects"].append({
                "title": title,
                "severity": sev,
                "area": str(d.get("area") or "").strip()[:60],
                "recommendation": str(d.get("recommendation") or "").strip()[:300],
                "cadenceDays": cd,
            })
        return out
    except Exception as e:
        print(f"[inspect] error: {e}")
        return {"error": "couldn't read that report — try again"}


def _vision_json(system, text, image_b64=None, media_type="image/jpeg"):
    """One fast Claude call (optionally with an image) that must return JSON."""
    import anthropic
    client = anthropic.Anthropic(max_retries=1, timeout=90.0)
    content = []
    if image_b64:
        content.append({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": image_b64}})
    content.append({"type": "text", "text": text})
    resp = client.messages.create(model=MODEL, max_tokens=800, system=system,
                                  messages=[{"role": "user", "content": content}])
    out = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
    i, j = out.find("{"), out.rfind("}")
    return json.loads(out[i:j + 1])

def _data_url_to_b64(data_url):
    """'data:image/jpeg;base64,...' -> (b64str, media_type). Caps at ~2MB decoded."""
    if not data_url or "," not in data_url:
        return None, None
    head, b64 = data_url.split(",", 1)
    media = "image/jpeg"
    if "image/png" in head: media = "image/png"
    if "image/webp" in head: media = "image/webp"
    if len(b64) > 2_800_000:  # ~2MB decoded
        raise ValueError("image too large")
    return b64, media

PHOTO_DIR = os.path.join(DATA_DIR, "photos")
DOC_DIR = os.path.join(DATA_DIR, "docs")

def save_doc(asset_id, url):
    """Document vault: fetch a manual PDF and keep it on /data so it survives
    link-rot and opens inside the ingress. One manual per asset for now."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", asset_id or ""):
        raise ValueError("bad asset id")
    u = (url or "").strip()[:500]
    if not re.match(r"^https?://", u):
        raise ValueError("that isn't a web link")
    # No internal probing: the fetch target is user-supplied; the %PDF magic check
    # below stops exfiltration, this stops the obvious SSRF hosts outright.
    host = (urllib.parse.urlparse(u).hostname or "").lower()
    if host in ("localhost", "supervisor", "homeassistant") or re.fullmatch(r"[0-9.:\[\]]+", host):
        raise ValueError("that isn't a public web link")
    data = _http_get(u, timeout=30)
    if not data or len(data) > 20 * 1024 * 1024:
        raise ValueError("couldn't fetch that (or it's over 20MB)")
    if data[:5] != b"%PDF-":
        raise ValueError("that link isn't a PDF — open the manual page and use its direct PDF link")
    os.makedirs(DOC_DIR, exist_ok=True)
    fp = os.path.join(DOC_DIR, asset_id + "-manual.pdf")
    if not os.path.exists(fp) and len(os.listdir(DOC_DIR)) >= 500:
        raise ValueError("document store full")
    tmp = fp + ".tmp"
    open(tmp, "wb").write(data)
    os.replace(tmp, fp)
    return len(data)

def save_photo(asset_id, data_url):
    import base64 as b64mod
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", asset_id or ""):
        raise ValueError("bad asset id")
    b64, _ = _data_url_to_b64(data_url)
    if not b64:
        raise ValueError("bad image")
    os.makedirs(PHOTO_DIR, exist_ok=True)
    fp = os.path.join(PHOTO_DIR, asset_id + ".jpg")
    # Replacing an existing photo is always fine; NEW ids are capped so a client
    # can't fill the /data volume with ~2MB writes under fabricated asset ids.
    if not os.path.exists(fp) and len(os.listdir(PHOTO_DIR)) >= 500:
        raise ValueError("photo store full")
    open(fp, "wb").write(b64mod.b64decode(b64))

def purge_asset_files(asset_ids):
    # Vaulted files live outside the synced state, so deleteAsset/deleteHome
    # tombstones never reach them — without this they orphan until the 500 cap.
    removed = 0
    for aid in asset_ids[:200]:
        if not isinstance(aid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", aid):
            continue
        for fp in (os.path.join(PHOTO_DIR, aid + ".jpg"),
                   os.path.join(PHOTO_DIR, "home-" + aid + ".jpg"),   # a deleted HOME's vaulted photo
                   os.path.join(DOC_DIR, aid + "-manual.pdf")):
            try:
                os.remove(fp); removed += 1
            except OSError:
                pass
    return removed


# ---- home imagery (test-home picker: Street View + aerial, user chooses) ------
ESRI_EXPORT_BASE = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export"

def esri_export_url(lat, lon, span):
    """Esri World Imagery static crop centred on (lat,lon), keyless. `span` is the
    half-height in degrees — smaller = more zoomed in (mirrors aerial_image_b64's box)."""
    dlat, dlon = span, span * 1.2
    bbox = f"{lon-dlon},{lat-dlat},{lon+dlon},{lat+dlat}"
    return f"{ESRI_EXPORT_BASE}?bbox={bbox}&bboxSR=4326&imageSR=4326&size=640,400&format=jpg&f=image"

def home_imagery(address):
    """Street View (Google, proxied — key stays server-side) + 2-3 keyless Esri aerial
    zoom crops for an address. No key configured -> aerial only. Never raises."""
    try:
        address = (address or "").strip()[:200]
        if not address:
            return {"images": []}
        loc = geocode(address)
        if not loc:
            return {"images": []}
        lat, lon = loc
        images = []
        if _google_key():
            images.append({"url": f"api/streetview?loc={lat},{lon}", "kind": "street"})
        for span in (0.00055, 0.00110, 0.00220):   # close / medium / wide — ~zoom 19 down to ~17
            images.append({"url": esri_export_url(lat, lon, span), "kind": "aerial"})
        return {"images": images}
    except Exception as e:
        print(f"[home-imagery] failed: {e}")
        return {"images": []}

def save_home_photo(home_id, url):
    """Fetch the CHOSEN home image and vault it — only from our own streetview proxy
    (reconstructed server-side from its loc, so the key never round-trips) or the
    whitelisted Esri export host. No arbitrary URL fetch. Atomic write, magic-byte check."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", home_id or ""):
        raise ValueError("bad home id")
    u = (url or "").strip()[:500]
    if u.startswith("api/streetview?"):
        loc = (urllib.parse.parse_qs(urllib.parse.urlparse(u).query).get("loc") or [""])[0]
        key = _google_key()
        if not key or not re.fullmatch(r"-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?", loc):
            raise ValueError("that image isn't available")
        data = _http_get("https://maps.googleapis.com/maps/api/streetview"
                          f"?size=640x400&fov=80&location={urllib.parse.quote(loc)}&key={urllib.parse.quote(key)}",
                          timeout=20)
    else:
        parsed = urllib.parse.urlparse(u)
        if parsed.scheme != "https" or parsed.hostname != "services.arcgisonline.com" or not u.startswith(ESRI_EXPORT_BASE + "?"):
            raise ValueError("that image source isn't allowed")
        data = _http_get(u, timeout=20)
    if not data or len(data) > 5 * 1024 * 1024:
        raise ValueError("couldn't fetch that image (or it's too large)")
    if not (data[:2] == b"\xff\xd8" or data[:8] == b"\x89PNG\r\n\x1a\n"):
        raise ValueError("that isn't a JPEG or PNG image")
    os.makedirs(PHOTO_DIR, exist_ok=True)
    fp = os.path.join(PHOTO_DIR, "home-" + home_id + ".jpg")
    if not os.path.exists(fp) and len([f for f in os.listdir(PHOTO_DIR) if f.startswith("home-")]) >= 200:
        raise ValueError("photo store full")
    tmp = fp + ".tmp"
    open(tmp, "wb").write(data)
    os.replace(tmp, fp)   # atomic — a crash never leaves a truncated photo

# ---- home logbook export: a branded PDF (assets + service history + spend) ----
# Pure-stdlib via pdfkit.py — same brand-tokens-and-hand-built-drawing-helpers idea
# as docs/arch_gen.py, but writing real PDF bytes directly since the add-on has no
# headless browser to print HTML to PDF with.
_LB_SURF = pdfkit.rgb("F6F7F4"); _LB_LINE = pdfkit.rgb("DCE0D8")
_LB_TEXT = pdfkit.rgb("1E2A23"); _LB_MUTED = pdfkit.rgb("586359"); _LB_FAINT = pdfkit.rgb("8B968C")
_LB_ACC = pdfkit.rgb("0F6E56")

def build_logbook_pdf(state, home_id):
    homes = state.get("homes") or []
    home = next((h for h in homes if h.get("id") == home_id), None) or (homes[0] if homes else {})
    assets = [a for a in (state.get("assets") or []) if a.get("homeId") == home.get("id")]
    asset_ids = {a.get("id") for a in assets}
    providers = {p.get("id"): p for p in (state.get("providers") or [])}
    logs = [l for l in (state.get("logs") or []) if l.get("assetId") in asset_ids and not l.get("pending")]
    logs.sort(key=lambda l: str(l.get("date") or ""), reverse=True)

    today = time.strftime("%Y-%m-%d")
    cutoff = time.strftime("%Y-%m-%d", time.localtime(time.time() - 365 * 86400))
    lifetime = sum(float(l.get("cost") or 0) for l in logs)
    last12 = sum(float(l.get("cost") or 0) for l in logs if str(l.get("date") or "") >= cutoff)

    d = pdfkit.Doc()
    W, M = pdfkit.A4_W, pdfkit.MARGIN

    # ---- cover ----
    d.text(M, d.y - 4, "KASAKEEPER", size=10.5, bold=True, color=_LB_ACC)
    d.y -= 34
    d.text(M, d.y, home.get("address") or "Home logbook", size=22, bold=True, color=_LB_TEXT)
    d.y -= 20
    d.text(M, d.y, "Home maintenance logbook", size=12, color=_LB_MUTED)
    d.y -= 16
    d.text(M, d.y, f"Generated {today}", size=9, color=_LB_FAINT)
    d.y -= 22
    d.hline(M, W - M, d.y, color=_LB_LINE)
    d.y -= 26

    # ---- assets table ----
    d.text(M, d.y, "Assets", size=13, bold=True, color=_LB_TEXT)
    d.y -= 20
    if assets:
        rows = []
        for a in sorted(assets, key=lambda a: (a.get("name") or "").lower()):
            mm = " ".join(x for x in (a.get("make"), a.get("model")) if x)
            rows.append([a.get("name") or "—", mm or "—", a.get("serial") or "—",
                         a.get("installedOn") or "—", a.get("warrantyUntil") or "—"])
        d.table(M, ["Name", "Make / model", "Serial", "Installed", "Warranty until"],
                [128, 138, 90, 78, 93], rows,
                header_fill=_LB_SURF, header_color=_LB_TEXT, text_color=_LB_MUTED, line_color=_LB_LINE)
    else:
        d.text(M, d.y, "No assets recorded yet.", size=10, color=_LB_FAINT)
        d.y -= 16
    d.y -= 22

    # ---- service history (newest first) ----
    d.ensure(40)
    d.text(M, d.y, "Service history", size=13, bold=True, color=_LB_TEXT)
    d.y -= 20
    if logs:
        rows = []
        for l in logs:
            asset = next((a for a in assets if a.get("id") == l.get("assetId")), None)
            prov = providers.get(l.get("providerId"))
            cost = l.get("cost") or 0
            rows.append([l.get("date") or "—", l.get("note") or "Service",
                         (asset.get("name") if asset else None) or "—",
                         (prov.get("name") if prov else None) or "—",
                         (f"${cost:,.0f}" if cost else "—")])
        d.table(M, ["Date", "Task", "Asset", "Provider", "Cost"],
                [62, 163, 100, 100, 102], rows,
                header_fill=_LB_SURF, header_color=_LB_TEXT, text_color=_LB_MUTED, line_color=_LB_LINE)
    else:
        d.text(M, d.y, "No service history recorded yet.", size=10, color=_LB_FAINT)
        d.y -= 16
    d.y -= 24

    # ---- totals ----
    d.ensure(70)
    box_w = W - 2 * M
    d.rect(M, d.y - 60, box_w, 60, fill=_LB_SURF, stroke=_LB_LINE, lw=1)
    d.text(M + 16, d.y - 24, "Lifetime spend", size=9, color=_LB_FAINT)
    d.text(M + 16, d.y - 44, f"${lifetime:,.0f}", size=18, bold=True, color=_LB_TEXT)
    half = box_w / 2
    d.text(M + half + 16, d.y - 24, "Spend, last 12 months", size=9, color=_LB_FAINT)
    d.text(M + half + 16, d.y - 44, f"${last12:,.0f}", size=18, bold=True, color=_LB_ACC)
    d.y -= 70

    return d.build()


# ---- Gmail supplier import (read-only IMAP via app password) ------------------
# Two product modes share this engine: a one-time scan of an existing inbox, or a
# dedicated quotes inbox that stays connected. Credentials live in add-on options
# only. We NEVER write to the mailbox: readonly SELECT, no STORE/EXPUNGE, no SMTP.
# NOTE: credential reading lives in the ONE _gmail_creds() defined in the quote-loop
# section above (returns (user, pw) or None). A second definition here once shadowed
# it with a (None, None) return — which is truthy — making gmail_available() report
# email as configured when it wasn't. Keep a single definition.

def gmail_status():
    creds = _gmail_creds()
    if not creds:
        return {"configured": False}
    a, p = creds
    try:
        import imaplib
        m = imaplib.IMAP4_SSL("imap.gmail.com", 993, ssl_context=_tls_ctx(), timeout=30)
        m.login(a, p)
        m.select("INBOX", readonly=True)
        m.logout()
        return {"configured": True, "address": a, "ok": True}
    except Exception as e:
        return {"configured": True, "address": a, "ok": False, "error": str(e)[:200]}

GMAIL_EXTRACT_SYSTEM = (
    "You are given a batch of emails (headers + body snippets) from a homeowner's inbox, pre-filtered "
    "for tradespeople/service businesses (quotes, invoices, bookings — often via ServiceM8/Tradify). "
    "Extract the supplier relationships. Notes: for ServiceM8/Tradify senders the display NAME is the "
    "business; ignore banks, insurers, utilities, subscriptions, retailers, real-estate/strata unless "
    "clearly a maintenance trade. Respond with ONLY JSON: {\"suppliers\":[{\"name\":business name,"
    "\"category\": best fit from [" + ", ".join(f'"{c}"' for c in CATEGORIES) + "],"
    "\"email\": direct business email if visible (not the servicem8 relay) or null,\"phone\": or null,"
    "\"website\": domain or null,\"jobs\":[{\"date\":\"YYYY-MM-DD\",\"what\":short line,\"amount\":number or null}],"
    "\"lastJob\":\"YYYY-MM-DD\" or null}],"
    "\"inferredAssets\":[{\"name\":asset the emails prove the home has (e.g. \"Ducted air conditioning\"),"
    "\"category\": from the same list,\"reason\":one line,\"lastServiced\":\"YYYY-MM-DD\" or null}]}. "
    "Only real businesses actually present in the emails; merge duplicates; never invent."
)

def gmail_scan():
    """Read-only sweep -> {suppliers, inferredAssets, scanned}. Runs as an async job."""
    import imaplib, email
    from email.header import decode_header
    creds = _gmail_creds()
    if not creds:
        return {"error": "Gmail isn't configured — add the address and app password in the add-on options.", "suppliers": [], "inferredAssets": []}
    a, p = creds
    m = imaplib.IMAP4_SSL("imap.gmail.com", 993, ssl_context=_tls_ctx(), timeout=30)
    m.login(a, p)
    m.select("INBOX", readonly=True)               # READ-ONLY — we never modify the mailbox
    since = (__import__("datetime").date.today() - __import__("datetime").timedelta(days=3 * 365)).strftime("%d-%b-%Y")
    queries = ['FROM "servicem8.com"', 'FROM "tradify"', 'SUBJECT "tax invoice"',
               'SUBJECT "quote"', 'SUBJECT "invoice"', 'SUBJECT "booking"']
    uids = []
    for q in queries:
        try:
            ok, data = m.uid("search", None, f'(SINCE {since} {q})')
            if ok == "OK" and data and data[0]:
                uids += data[0].split()
        except Exception:
            continue
    uids = sorted(set(uids), key=lambda u: int(u))[-300:]   # newest 300, deduped
    def hdr(msg, name):
        raw = msg.get(name, "")
        try:
            return " ".join(t.decode(enc or "utf-8", "replace") if isinstance(t, bytes) else t
                            for t, enc in decode_header(raw))
        except Exception:
            return str(raw)
    rows = []
    for u in uids:
        try:
            ok, data = m.uid("fetch", u, "(BODY.PEEK[])")
            if ok != "OK" or not data or not data[0]:
                continue
            msg = email.message_from_bytes(data[0][1])
            body = ""
            for part in msg.walk():
                if part.get_content_type() == "text/plain":
                    try:
                        body = part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", "replace")
                        break
                    except Exception:
                        pass
            rows.append(f"FROM: {hdr(msg,'From')}\nDATE: {hdr(msg,'Date')}\nSUBJECT: {hdr(msg,'Subject')}\nBODY: {' '.join(body.split())[:700]}")
        except Exception:
            continue
    m.logout()
    if not rows:
        return {"suppliers": [], "inferredAssets": [], "scanned": 0}
    # batch through Claude (~40 emails per call), merge by supplier name
    suppliers, assets = {}, {}
    for i in range(0, len(rows), 40):
        try:
            out = _vision_json(GMAIL_EXTRACT_SYSTEM, "EMAILS:\n\n" + "\n\n---\n\n".join(rows[i:i + 40]))
            for s in out.get("suppliers") or []:
                k = (s.get("name") or "").strip().lower()
                if not k: continue
                cur = suppliers.setdefault(k, s)
                if s is not cur:  # merge later batches into the first sighting
                    cur["jobs"] = (cur.get("jobs") or []) + (s.get("jobs") or [])
                    for f in ("email", "phone", "website", "lastJob"):
                        cur[f] = cur.get(f) or s.get(f)
            for x in out.get("inferredAssets") or []:
                k = (x.get("name") or "").strip().lower()
                if k: assets.setdefault(k, x)
        except Exception as e:
            print(f"[gmail] extract batch failed: {e}")
    return {"suppliers": list(suppliers.values()), "inferredAssets": list(assets.values()), "scanned": len(rows)}


# =============================================================================
# House assistant chat — ask anything about the home, and change the data.
# Claude gets a compact snapshot of the current home as context plus a small set
# of write tools; every tool goes through state_mutate so the shared store stays
# rev-guarded and every device sees the change. Deliberately NO delete tools —
# removing an asset/provider stays a deliberate UI action.
# =============================================================================
def _uid(prefix: str) -> str:
    return prefix + os.urandom(3).hex()

def _home_scope(state):
    hid = state.get("currentHomeId")
    assets = [a for a in state.get("assets", []) if a.get("homeId") == hid]
    provs = [p for p in state.get("providers", []) if p.get("homeId") == hid]
    ids = {a["id"] for a in assets}
    tasks = [t for t in state.get("tasks", []) if t.get("assetId") in ids]
    return hid, assets, provs, tasks

def _match(items, name, field="name"):
    """Exact (case-insensitive) match first, then a unique substring match."""
    n = (name or "").strip().lower()
    if not n:
        return None
    exact = [x for x in items if (x.get(field) or "").lower() == n]
    if exact:
        return exact[0]
    part = [x for x in items if n in (x.get(field) or "").lower()]
    return part[0] if len(part) == 1 else None

def _usage_grounding_block(a, home_id=None):
    """Compact grounding block for one usage-tracked asset: config + (if reachable) the
    entity's CURRENT state. Never raises — a dead/unreachable entity just skips the state."""
    u = a.get("usage")
    if not isinstance(u, dict) or not u.get("entity"):
        return None
    mode = u.get("mode") or "runtime"
    g = {"entity": u["entity"], "mode": mode, "threshold": u.get("threshold"),
         "unit": u.get("unit"), "since": u.get("since") or None}
    if mode == "runtime":
        g["note"] = ("run-hours are derived from HA history, not computed here — "
                      "currentState is only a live snapshot of the entity, not accumulated hours")
    if ha_available(home_id):
        try:
            raw = ha_api_get("states/" + u["entity"], home_id)
            if raw:
                g["currentState"] = json.loads(raw).get("state")
        except Exception:
            pass  # entity unreachable/renamed — ground with config only, never break chat
    return g

def _chat_context(state):
    hid, assets, provs, tasks = _home_scope(state)
    home = next((h for h in state.get("homes", []) if h.get("id") == hid), {})
    pname = {p["id"]: p.get("name") for p in provs}
    out_assets = []
    for a in assets:
        entry = {k: v for k, v in {
            "name": a.get("name"), "category": a.get("category"),
            "makeModel": " ".join(x for x in [a.get("make"), a.get("model")] if x) or None,
            "variant": a.get("variant") or None, "location": a.get("location") or None,
            "installedOn": a.get("installedOn") or None, "warrantyUntil": a.get("warrantyUntil") or None,
            "provider": pname.get(a.get("providerId")),
            "tasks": [{"title": t.get("title"), "everyDays": t.get("cadenceDays"),
                       "lastDone": t.get("lastDone"), "estCost": t.get("estCost"),
                       "snoozed": True} if t.get("snoozed") else
                      {"title": t.get("title"), "everyDays": t.get("cadenceDays"),
                       "lastDone": t.get("lastDone"), "estCost": t.get("estCost")}
                      for t in tasks if t.get("assetId") == a["id"]],
        }.items() if v not in (None, [], "")}
        g = _usage_grounding_block(a, hid)
        if g:
            entry["usage"] = g
        out_assets.append(entry)
    out_provs = []
    for p in provs:
        d = {k: p.get(k) for k in ("name", "trade", "contact", "phone", "email", "website", "notes") if p.get(k)}
        if p.get("archived"):
            d["archived"] = True          # past provider — don't recommend for new work
        out_provs.append(d)
    quotes = [{k: q.get(k) for k in ("trade", "provider", "status", "amount", "availability") if q.get(k)}
              for q in state.get("quotes", []) if q.get("homeId") == hid]
    return {"today": time.strftime("%Y-%m-%d"),
            "home": {k: v for k, v in {"address": home.get("address"), "beds": home.get("beds"),
                                       "baths": home.get("baths")}.items() if v},
            "assets": out_assets, "providers": out_provs, "quotes": quotes}

CHAT_SYSTEM = (
    "You are KasaKeeper's house assistant. You know this specific home: its assets, maintenance "
    "schedules, warranties, trades and quotes — the live HOME DATA JSON is given below.\n\n"
    "Answer questions about the house, its systems, service history, trades and costs directly and "
    "concisely from that data. When the user asks you to CHANGE something (add a trade, log a job as "
    "done, change a schedule or a price, link a tradesperson to an asset, snooze or restore a task), "
    "use the tools — actually make the change, don't just describe it.\n\n"
    "Rules:\n"
    "- Australian context: AUD, metric, Australian trade names.\n"
    "- Be brief and practical. After a change, confirm it in one short sentence.\n"
    "- NEVER invent a provider, price, phone number, model or date. If you don't know, ask.\n"
    "- Costs are per visit/occurrence. everyDays is the cadence (7 = weekly, 365 = yearly).\n"
    "- You cannot delete assets or providers — if asked, say it's a deliberate action in the UI "
    "(Trades → tap a provider → Delete, or the asset page).\n"
    "- If a name is ambiguous, ask which one rather than guessing.\n"
    "- Completing a task, snoozing a task, and shrinking/removing a service pack are prepared, not "
    "applied — call the tool as usual, then tell the user it's ready and they need to confirm it below."
)

CHAT_TOOLS = [
    {"name": "add_provider", "description": "Add a trade/service provider to the home's directory.",
     "input_schema": {"type": "object", "required": ["name"], "properties": {
         "name": {"type": "string"}, "trade": {"type": "string"}, "contact": {"type": "string"},
         "phone": {"type": "string"}, "email": {"type": "string"}, "website": {"type": "string"},
         "notes": {"type": "string"}}}},
    {"name": "update_provider", "description": "Update fields on an existing provider (match by name).",
     "input_schema": {"type": "object", "required": ["name"], "properties": {
         "name": {"type": "string"}, "trade": {"type": "string"}, "contact": {"type": "string"},
         "phone": {"type": "string"}, "email": {"type": "string"}, "website": {"type": "string"},
         "notes": {"type": "string"},
         "archived": {"type": "boolean", "description": "true = past provider (kept for history, listed at the bottom); false = active"}}}},
    {"name": "add_asset", "description": "Add a thing to maintain (appliance, system, area).",
     "input_schema": {"type": "object", "required": ["name", "category"], "properties": {
         "name": {"type": "string"},
         "category": {"type": "string", "enum": CATEGORIES},
         "make": {"type": "string"}, "model": {"type": "string"}, "location": {"type": "string"},
         "installedOn": {"type": "string"}, "warrantyUntil": {"type": "string"},
         "provider": {"type": "string", "description": "existing provider name to link"}}}},
    {"name": "set_service_pack", "description": "Record or update a block of prepaid services bought for an asset (e.g. '6 maintenance visits for $900'). Set bought=0 to remove the pack.",
     "input_schema": {"type": "object", "required": ["asset", "bought"], "properties": {
         "asset": {"type": "string"}, "bought": {"type": "integer"},
         "used": {"type": "integer", "description": "how many have been used so far"},
         "cost": {"type": "number", "description": "total paid for the whole block"},
         "purchasedOn": {"type": "string", "description": "YYYY-MM-DD"},
         "unit": {"type": "string", "description": "what one counts as: visit, service, clean"},
         "note": {"type": "string"}}}},
    {"name": "link_provider", "description": "Link an existing provider to an existing asset.",
     "input_schema": {"type": "object", "required": ["asset", "provider"], "properties": {
         "asset": {"type": "string"}, "provider": {"type": "string"}}}},
    {"name": "add_task", "description": "Add a recurring maintenance task to an asset.",
     "input_schema": {"type": "object", "required": ["asset", "title", "everyDays"], "properties": {
         "asset": {"type": "string"}, "title": {"type": "string"},
         "everyDays": {"type": "integer"}, "estCost": {"type": "number"},
         "note": {"type": "string"},
         "lastDone": {"type": "string", "description": "YYYY-MM-DD"}}}},
    {"name": "update_task", "description": "Change a task's cadence, cost, title or last-done date.",
     "input_schema": {"type": "object", "required": ["asset", "title"], "properties": {
         "asset": {"type": "string"}, "title": {"type": "string"}, "newTitle": {"type": "string"},
         "everyDays": {"type": "integer"}, "estCost": {"type": "number"},
         "note": {"type": "string", "description": "a standing reminder shown on the task"},
         "lastDone": {"type": "string", "description": "YYYY-MM-DD"}}}},
    {"name": "complete_task", "description": "Mark a task done (defaults to today) and log the cost.",
     "input_schema": {"type": "object", "required": ["asset", "title"], "properties": {
         "asset": {"type": "string"}, "title": {"type": "string"},
         "date": {"type": "string", "description": "YYYY-MM-DD, defaults to today"},
         "cost": {"type": "number"}}}},
    {"name": "snooze_task", "description": "Disable a task (hidden from schedule/counts, restorable).",
     "input_schema": {"type": "object", "required": ["asset", "title"], "properties": {
         "asset": {"type": "string"}, "title": {"type": "string"}}}},
    {"name": "restore_task", "description": "Un-snooze a previously snoozed task.",
     "input_schema": {"type": "object", "required": ["asset", "title"], "properties": {
         "asset": {"type": "string"}, "title": {"type": "string"}}}},
    {"name": "set_autopilot", "description": "Put a task on autopilot (a standing arrangement that just "
     "happens, e.g. a weekly cleaner) so it stays on the schedule but never flags as overdue — or turn it off.",
     "input_schema": {"type": "object", "required": ["asset", "title", "on"], "properties": {
         "asset": {"type": "string"}, "title": {"type": "string"}, "on": {"type": "boolean"}}}},
]

# Destructive tools don't execute during chat — they come back as a "pending" proposal
# the user must confirm (POST /api/chat/apply). Additive tools (add_asset, add_task, …)
# keep applying immediately: they're reversible and visible, nothing to lose.
DESTRUCTIVE_TOOLS = {"complete_task", "snooze_task", "set_service_pack"}

def _apply_tool(tool: str, args: dict, confirm: bool = False) -> dict:
    """Execute one chat tool against the shared store. Returns a small result dict.
    For a DESTRUCTIVE_TOOLS member, confirm=False (the chat default) returns a "pending"
    proposal instead of mutating; confirm=True (from /api/chat/apply, after the user has
    said yes) runs it for real. Non-destructive tools ignore confirm."""
    out = {"ok": False, "detail": f"unknown tool {tool}"}

    def mut(state):
        nonlocal out
        hid, assets, provs, tasks = _home_scope(state)
        if not hid:
            out = {"ok": False, "detail": "no home is set up yet"}
            return False
        today = time.strftime("%Y-%m-%d")

        def find_asset(n):
            return _match(assets, n)

        def find_task(asset, n):
            return _match([t for t in tasks if t.get("assetId") == asset["id"]], n, "title")

        if tool == "add_provider":
            if not str(args.get("name") or "").strip():
                out = {"ok": False, "detail": "a provider name is required"}
                return False
            if _match(provs, args.get("name")):
                out = {"ok": False, "detail": f"{args.get('name')} is already in the directory"}
                return False
            p = {"id": _uid("p"), "homeId": hid}
            for k in ("name", "trade", "contact", "phone", "email", "website", "notes"):
                if args.get(k):
                    p[k] = str(args[k])
            state.setdefault("providers", []).append(p)
            out = {"ok": True, "detail": f"added provider {p.get('name')}"}
            return True

        if tool == "update_provider":
            p = _match(provs, args.get("name"))
            if not p:
                out = {"ok": False, "detail": f"no provider matching {args.get('name')!r}"}
                return False
            changed = []
            for k in ("trade", "contact", "phone", "email", "website", "notes"):
                if args.get(k):
                    p[k] = str(args[k]); changed.append(k)
            if isinstance(args.get("archived"), bool):
                p["archived"] = args["archived"]
                changed.append("past provider" if args["archived"] else "active again")
            out = {"ok": True, "detail": f"updated {p.get('name')} ({', '.join(changed) or 'no fields'})"}
            return bool(changed)

        if tool == "set_service_pack":
            a = find_asset(args.get("asset"))
            if not a:
                out = {"ok": False, "detail": f"no asset matching {args.get('asset')!r}"}
                return False
            # The schema says integer/number but the model can still hand us "six"
            # or "$900". Fail loudly — a silent fallback to 0 would DELETE the pack.
            try:
                n = int(args.get("bought") or 0)
                used_in = int(args.get("used") or 0)
                cost = float(args.get("cost") or 0)
            except (TypeError, ValueError):
                out = {"ok": False, "detail": "bought/used must be whole numbers and cost a number"}
                return False
            existing_bought = (a.get("pack") or {}).get("bought")
            shrinking = not n or (existing_bought and n < existing_bought)
            if shrinking and not confirm:
                detail = (f"remove the service pack on {a.get('name')}" if not n else
                          f"reduce {a.get('name')}'s service pack from {existing_bought} to {n}")
                out = {"ok": True, "pending": {"tool": tool, "args": dict(args), "detail": detail}}
                return False
            if not n:
                a.pop("pack", None)
                out = {"ok": True, "detail": f"removed the service pack on {a.get('name')}"}
                return True
            used = max(0, min(n, used_in))
            a["pack"] = {"bought": n, "used": used, "cost": cost,
                         "purchasedOn": str(args.get("purchasedOn") or ""),
                         "unit": str(args.get("unit") or "visit"), "note": str(args.get("note") or "")}
            out = {"ok": True, "detail": f"{a.get('name')}: {n - used} of {n} {a['pack']['unit']}s left"}
            return True

        if tool == "add_asset":
            if not str(args.get("name") or "").strip():
                out = {"ok": False, "detail": "an asset name is required"}
                return False
            if _match(assets, args.get("name")):
                out = {"ok": False, "detail": f"{args.get('name')} already exists"}
                return False
            a = {"id": _uid("a"), "homeId": hid, "name": str(args["name"]).strip(),
                 "category": str(args.get("category") or "Appliance"), "providerId": ""}
            for k in ("make", "model", "location"):
                if args.get(k):
                    a[k] = str(args[k])
            # Date-typed in the UI form; the model must not be able to smuggle markup
            # through them (they render into the asset detail view). Strict or dropped.
            for k in ("installedOn", "warrantyUntil"):
                v = str(args.get(k) or "")
                if re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
                    a[k] = v
            if args.get("provider"):
                p = _match(provs, args["provider"])
                if p:
                    a["providerId"] = p["id"]
            state.setdefault("assets", []).append(a)
            out = {"ok": True, "detail": f"added asset {a['name']} ({a['category']})"}
            return True

        if tool == "link_provider":
            a, p = find_asset(args.get("asset")), _match(provs, args.get("provider"))
            if not a or not p:
                out = {"ok": False, "detail": "asset or provider not found"}
                return False
            a["providerId"] = p["id"]
            out = {"ok": True, "detail": f"linked {p.get('name')} to {a.get('name')}"}
            return True

        if tool == "add_task":
            a = find_asset(args.get("asset"))
            if not a:
                out = {"ok": False, "detail": f"no asset matching {args.get('asset')!r}"}
                return False
            if not str(args.get("title") or "").strip():
                out = {"ok": False, "detail": "a task title is required"}
                return False
            t = {"id": _uid("t"), "assetId": a["id"], "title": str(args["title"]),
                 "cadenceDays": int(args.get("everyDays") or 365),
                 "estCost": float(args.get("estCost") or 0),
                 "lastDone": str(args.get("lastDone") or ""), "note": str(args.get("note") or "")}
            state.setdefault("tasks", []).append(t)
            out = {"ok": True, "detail": f"added task '{t['title']}' on {a['name']} every {t['cadenceDays']}d"}
            return True

        if tool in ("update_task", "complete_task", "snooze_task", "restore_task", "set_autopilot"):
            a = find_asset(args.get("asset"))
            if not a:
                out = {"ok": False, "detail": f"no asset matching {args.get('asset')!r}"}
                return False
            t = find_task(a, args.get("title"))
            if not t:
                out = {"ok": False, "detail": f"no task matching {args.get('title')!r} on {a['name']}"}
                return False
            if tool in ("complete_task", "snooze_task") and not confirm:
                if tool == "complete_task":
                    when = str(args.get("date") or today)
                    detail = f"log '{t['title']}' done {when}"
                else:
                    detail = f"snooze '{t['title']}'"
                out = {"ok": True, "pending": {"tool": tool, "args": dict(args), "detail": detail}}
                return False
            if tool == "update_task":
                bits = []
                if args.get("newTitle"): t["title"] = str(args["newTitle"]); bits.append("title")
                if args.get("everyDays"): t["cadenceDays"] = int(args["everyDays"]); bits.append("cadence")
                if args.get("estCost") is not None: t["estCost"] = float(args["estCost"]); bits.append("cost")
                if args.get("lastDone"): t["lastDone"] = str(args["lastDone"]); bits.append("last done")
                if args.get("note") is not None: t["note"] = str(args["note"]); bits.append("note")
                out = {"ok": True, "detail": f"updated {t['title']} ({', '.join(bits) or 'nothing'})"}
                return bool(bits)
            if tool == "complete_task":
                when = str(args.get("date") or today)
                t["lastDone"] = when
                cost = args.get("cost")
                state.setdefault("logs", []).append(
                    {"id": _uid("l"), "assetId": a["id"], "taskId": t.get("id"), "date": when,
                     "cost": float(cost) if cost is not None else float(t.get("estCost") or 0),
                     "note": t.get("title")})
                out = {"ok": True, "detail": f"logged '{t['title']}' done {when}"}
                return True
            if tool == "set_autopilot":
                on = bool(args.get("on"))
                if on:
                    t["autopilot"] = True
                else:
                    t.pop("autopilot", None)
                out = {"ok": True, "detail": f"autopilot {'on' if on else 'off'} for '{t['title']}'"}
                return True
            if tool == "snooze_task":
                t["snoozed"] = True
                out = {"ok": True, "detail": f"snoozed '{t['title']}'"}
                return True
            t.pop("snoozed", None)
            out = {"ok": True, "detail": f"restored '{t['title']}'"}
            return True

        return False

    state_mutate(mut)
    return out

def chat(messages):
    """One chat turn: Claude answers from the home snapshot and may call write tools."""
    try:
        import anthropic
    except ImportError:
        return {"reply": "The Anthropic SDK isn't installed in this add-on.", "changes": [], "proposals": [], "grounded": []}
    if not (os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN")):
        return {"reply": "No Anthropic API key is set — add one in the add-on Configuration.", "changes": [], "proposals": [], "grounded": []}
    state = state_read().get("state") or {}
    context = _chat_context(state)
    # What the reply is grounded in, for the UI to show as chips — the usage-tracked
    # assets' entity + live state that were fed to the model. Capped, matches CHAT_TOOLS' cap style.
    grounded = [{"entity": a["usage"]["entity"], "state": a["usage"].get("currentState"), "asset": a.get("name")}
                for a in context["assets"] if a.get("usage")][:8]
    system = CHAT_SYSTEM + "\n\nHOME DATA (JSON):\n" + json.dumps(context)
    client = anthropic.Anthropic(max_retries=1, timeout=120.0)
    convo = [{"role": m.get("role"), "content": m.get("content")}
             for m in messages if m.get("role") in ("user", "assistant") and m.get("content")][-20:]
    changes, proposals, reply = [], [], ""
    try:
        for _ in range(6):  # tool loop
            resp = client.messages.create(model=MODEL, max_tokens=2000, system=system,
                                          tools=CHAT_TOOLS, messages=convo)
            text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
            uses = [b for b in resp.content if getattr(b, "type", "") == "tool_use"]
            if text:
                reply = text
            if not uses:
                break
            convo.append({"role": "assistant", "content": resp.content})
            results = []
            for u in uses:
                r = _apply_tool(u.name, dict(u.input or {}))
                if r.get("pending"):
                    proposals.append(r["pending"])
                elif r.get("detail"):
                    changes.append(r.get("detail"))
                results.append({"type": "tool_result", "tool_use_id": u.id, "content": json.dumps(r)})
            convo.append({"role": "user", "content": results})
    except Exception as e:  # noqa: BLE001 — a chat failure must never 500 the UI
        print(f"[chat] failed: {e}")
        return {"reply": f"Sorry — that request failed ({e}).", "changes": changes, "proposals": proposals, "grounded": grounded}
    return {"reply": (reply or "Done.").strip(), "changes": [c for c in changes if c],
            "proposals": proposals, "grounded": grounded}


# --- async job store: research runs on a background thread so the POST returns
# instantly. HA's ingress proxy times out slow upstream responses (~90s research
# => 503 => stub fallback), so we never hold the request open. Frontend polls.
JOBS = {}          # job_id -> {"status": "running"|"done"|"error", "stage": progress note, ...}
_JOBS_LOCK = threading.Lock()
_JOB_LOCAL = threading.local()   # lets code deep inside a job report progress without threading ids through


def job_stage(msg):
    """Progress note for the async job running on THIS worker thread. The client
    polls the job record, so the note shows live in the UI ("Searched 'x'…")."""
    job_id = getattr(_JOB_LOCAL, "job_id", None)
    if not job_id:
        return
    with _JOBS_LOCK:
        j = JOBS.get(job_id)
        if j is not None and j.get("status") == "running":
            j["stage"] = str(msg)[:160]


def _run_job(job_id, fn, args, fallback):
    """Run fn(*args) on a worker thread; store the result/error under job_id.
    fallback is stored as the result on failure so the UI always has something.
    CRITICAL: fn() runs OUTSIDE the lock — it takes ~90s (web search), and holding
    the lock that long would block every poll/POST and hang the server under ingress."""
    _JOB_LOCAL.job_id = job_id
    try:
        record = {"status": "done", "result": fn(*args)}
    except Exception as e:  # never crash the worker
        print(f"[job {job_id}] failed: {e}")
        record = {"status": "error", "error": str(e), "result": fallback}
    with _JOBS_LOCK:
        JOBS[job_id] = record
        if len(JOBS) > 40:  # prune so the dict can't grow unbounded
            for k in list(JOBS)[:-20]:
                JOBS.pop(k, None)


def _start_job(fn, args, fallback):
    job_id = os.urandom(6).hex()
    with _JOBS_LOCK:
        JOBS[job_id] = {"status": "running"}
    threading.Thread(target=_run_job, args=(job_id, fn, args, fallback), daemon=True).start()
    return job_id


# --- server-resident re-research sweep: survives the page closing, because it
# runs on the Green rather than in the browser tab. One sweep at a time (the
# module guard below), progress kept on the JOBS record (done/total/current/log)
# so every polling device sees the same feed the old client-side loop rendered,
# and each finished asset's proposal lands on the shared store via state_mutate
# so it shows up (✦ research ready) on every device, not just the one that
# started the sweep.
_SWEEP_LOCK = threading.Lock()
_SWEEP_STATE = {"job_id": None, "skip": False, "stop": False}


def _sweep_pending_assets(state, home_id):
    return [a for a in (state.get("assets") or [])
            if a.get("homeId") == home_id and not a.get("lookupPending")]


def _apply_sweep_pending(state, asset_id, pending, manual_url):
    for aa in state.get("assets", []):
        if aa.get("id") == asset_id:
            aa["lookupPending"] = pending
            if manual_url and not aa.get("manualUrl"):
                aa["manualUrl"] = manual_url
            return True
    return False  # asset deleted mid-sweep — nothing to write


def _sweep_job(job_id, home_id):
    """Runs on its own worker thread (via _run_sweep_job). Reads the assets to
    process ONCE at start (same list the old client loop used) — an asset added
    mid-sweep just waits for the next sweep, same as before."""
    def progress(**kw):
        with _JOBS_LOCK:
            j = JOBS.get(job_id)
            if j is not None:
                j.update(kw)

    def log_line(msg):
        # last 12 outcome lines, same wording the client used to render itself.
        with _JOBS_LOCK:
            j = JOBS.get(job_id)
            if j is not None:
                log = list(j.get("log") or [])
                log.insert(0, str(msg)[:200])
                j["log"] = log[:12]

    doc = state_read()
    state = doc.get("state") or {}
    assets = _sweep_pending_assets(state, home_id)
    total = len(assets)
    done = 0
    progress(total=total, done=0, current="")
    for a in assets:
        with _SWEEP_LOCK:
            if _SWEEP_STATE.get("stop"):
                break
            _SWEEP_STATE["skip"] = False  # a stale skip from a previous asset must not carry over
        aid, name = a.get("id"), a.get("name") or "asset"
        if not aid:
            done += 1
            progress(done=done)
            continue
        # Another device may have deleted this asset since the sweep's initial
        # snapshot — skip it rather than spending a web-search call researching
        # something nobody can apply the proposal to anymore.
        cur = state_read().get("state") or {}
        if not any(x.get("id") == aid for x in (cur.get("assets") or [])):
            log_line(f"— {name} — deleted, skipped")
            done += 1
            progress(done=done)
            continue
        progress(current=name)
        job_stage(f"{done + 1} of {total} · researching {name}…")
        # lookup_features is one blocking call — it can't be interrupted mid-flight,
        # so a skip requested while it's running is applied to its RESULT instead:
        # the proposal it comes back with is discarded and the sweep moves straight on.
        r = lookup_features(a.get("make") or "", a.get("model") or "", name, a.get("category") or "")
        with _SWEEP_LOCK:
            skipped = _SWEEP_STATE.get("skip")
        if skipped:
            log_line(f"— {name} skipped")
            done += 1
            progress(done=done)
            continue
        if r and not r.get("error"):
            pending = {"summary": r.get("summary") or "", "specs": r.get("specs") or {},
                       "tasks": r.get("tasks") or [], "tips": r.get("tips") or [],
                       "manualUrl": r.get("manualUrl"), "usageIntervalHours": r.get("usageIntervalHours"),
                       "debug": r.get("debug"), "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
            manual = r.get("manualUrl")
            # _apply_sweep_pending returns False when the asset was deleted (by
            # another device) mid-lookup — state_mutate's own return doesn't
            # distinguish "wrote" from "no-op", so capture it via the mutator itself.
            # state_mutate can ALSO give up and return None after exhausting its
            # retries under write contention (another writer keeps winning the
            # rev race) — outcome["applied"] alone would still read True from the
            # mutator's last call even though nothing was ever actually persisted,
            # so both must hold before this counts as a real success.
            outcome = {"applied": False}
            def _mut(s, _a=aid, _p=pending, _m=manual, _o=outcome):
                _o["applied"] = _apply_sweep_pending(s, _a, _p, _m)
                return _o["applied"]
            wrote = state_mutate(_mut) is not None
            if outcome["applied"] and wrote:
                nt = len(pending["tasks"])
                log_line(f"✓ {name} — {nt} task{'s' if nt != 1 else ''} proposed"
                          + (f" · {pending['usageIntervalHours']}h interval" if pending.get("usageIntervalHours") else "")
                          + (" · manual found" if pending.get("manualUrl") else ""))
            elif not outcome["applied"]:
                log_line(f"— {name} — deleted elsewhere, discarded")
            else:
                log_line(f"— {name} — couldn't save the proposal (busy), skipped")
            done += 1
            progress(done=done)
            continue
        err = (r or {}).get("error") or "lookup failed"
        log_line(f"✗ {name} — {err}")
        done += 1
        progress(done=done, current="")
        if re.search(r"API key|unavailable", err, re.I):
            raise RuntimeError(err)  # no point grinding through the rest — same bail-out the client used to do
    progress(current="", done=done)
    return {"done": done, "total": total}


def _run_sweep_job(job_id, home_id):
    """Like _run_job, but MERGES the final status into the record instead of
    replacing it — _sweep_job has been updating done/total/current/log on this
    same record throughout the run, and those fields must survive to the poll
    the client reads right after status flips to done/error."""
    _JOB_LOCAL.job_id = job_id
    try:
        result = _sweep_job(job_id, home_id)
        with _JOBS_LOCK:
            j = JOBS.get(job_id) or {}
            j["status"] = "done"
            j["result"] = result
            JOBS[job_id] = j
    except Exception as e:
        print(f"[sweep] job {job_id} failed: {e}")
        with _JOBS_LOCK:
            j = JOBS.get(job_id) or {}
            j["status"] = "error"
            j["error"] = str(e)
            JOBS[job_id] = j
    finally:
        with _SWEEP_LOCK:
            if _SWEEP_STATE.get("job_id") == job_id:
                _SWEEP_STATE["job_id"] = None
                _SWEEP_STATE["skip"] = False
                _SWEEP_STATE["stop"] = False


def _start_sweep(home_id):
    """None if a sweep is already active (module guard) — one at a time."""
    with _SWEEP_LOCK:
        if _SWEEP_STATE.get("job_id"):
            return None
        job_id = os.urandom(6).hex()
        _SWEEP_STATE["job_id"] = job_id
        _SWEEP_STATE["skip"] = False
        _SWEEP_STATE["stop"] = False
    with _JOBS_LOCK:
        JOBS[job_id] = {"status": "running", "done": 0, "total": 0, "current": "", "log": []}
    threading.Thread(target=_run_sweep_job, args=(job_id, home_id), daemon=True).start()
    return job_id

def _secret_flags():
    """Which keys are live right now — same booleans /api/health reports, so the
    setup wizard / Settings can show honest state right after a save with no
    restart. Never the values themselves."""
    return {"anthropic": bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN")),
            "places": bool(_google_key()), "email": gmail_available()}


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # dev: always serve fresh JS/HTML
        super().end_headers()

    def _send_json(self, obj, status=200):
        self._send_raw(json.dumps(obj).encode(), status)

    # No CORS headers anywhere: the PWA is same-origin (ingress or direct) and a
    # wildcard would let any web page read the un-credentialed endpoints.
    def _send_raw(self, body, status=200):  # pass pre-encoded JSON bytes through
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, body, ctype, status=200, disposition=None):  # images, PDFs etc.
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if disposition:
            self.send_header("Content-Disposition", disposition)
        self.end_headers()
        self.wfile.write(body)

    def _serve_file(self, dirpath, fid, suffix, ctype, err, prefix=""):
        # Shared guard for the vault-serving GETs: the RAW id is regex-validated
        # (before any prefix) so path traversal can't reach the join, and misses
        # return the same {"error": ...} 404 shape each route always had.
        fp = os.path.join(dirpath, prefix + fid + suffix)
        if re.fullmatch(r"[A-Za-z0-9_-]{1,40}", fid) and os.path.exists(fp):
            return self._send_bytes(open(fp, "rb").read(), ctype)
        return self._send_json({"error": err}, 404)

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        # SECURITY: ingress (or the loopback dev default) is the ONLY auth boundary.
        # Several routes here spend API credits or send mail from the user's Gmail —
        # never expose this server off-ingress (no ports: mapping, no 0.0.0.0 dev runs).
        route = self.path.rstrip("/")
        # Inspection PDFs are capped at 10MB decoded (~13.3MB base64 + JSON overhead);
        # everything else stays at 4MB — photos are downscaled client-side to ~2MB.
        cap = 15 * 1024 * 1024 if route == "/api/inspect" else 4 * 1024 * 1024
        try:
            n = int(self.headers.get("Content-Length", 0))
            if n > cap:
                return self._send_json({"error": "body too large"}, 413)
            payload = json.loads(self.rfile.read(n) or b"{}") if n else {}
        except Exception:
            payload = {}
        if route == "/api/research":
            address = (payload.get("address") or "").strip()
            job_id = _start_job(research, (address,), baseline_home(address, "Research failed."))
            print(f"[research] start job={job_id} {address!r}")
            return self._send_json({"job_id": job_id, "status": "running"})
        if route == "/api/find-services":
            trade = (payload.get("trade") or "").strip()
            suburb = (payload.get("suburb") or "").strip()
            address = (payload.get("address") or suburb).strip()
            job_id = _start_job(find_services, (trade, suburb, address), {"providers": []})
            print(f"[find] start job={job_id} trade={trade!r} near={address!r}")
            return self._send_json({"job_id": job_id, "status": "running"})
        if route == "/api/lookup":     # make/model -> manufacturer schedule + manual (async)
            make = (str(payload.get("make") or "")).strip()[:80]
            model = (str(payload.get("model") or "")).strip()[:80]
            name = (str(payload.get("name") or "")).strip()[:80]
            if not (make or model or name):
                return self._send_json({"error": "a name or make/model is required"}, 400)
            category = (str(payload.get("category") or "")).strip()[:40]
            job_id = _start_job(lookup_features, (make, model, name, category), {"error": "lookup failed"})
            print(f"[lookup] start job={job_id} {make!r} {model!r}")
            return self._send_json({"job_id": job_id, "status": "running"})
        if route == "/api/sweep":      # server-resident re-research sweep — survives the page closing
            home_id = str(payload.get("homeId") or "").strip()
            if not home_id:
                return self._send_json({"error": "homeId required"}, 400)
            doc = state_read()
            state = doc.get("state") or {}
            if state.get("assets") is None:
                return self._send_json({"error": "no shared store yet"}, 400)
            if not _sweep_pending_assets(state, home_id):
                return self._send_json({"error": "Nothing to re-research — proposals are already waiting"}, 400)
            job_id = _start_sweep(home_id)
            if not job_id:
                return self._send_json({"error": "a re-research sweep is already running"}, 409)
            print(f"[sweep] start job={job_id} home={home_id!r}")
            return self._send_json({"job_id": job_id, "status": "running"})
        if route == "/api/sweep/skip":  # discard the in-flight (or next) asset's result
            with _SWEEP_LOCK:
                active = bool(_SWEEP_STATE.get("job_id"))
                if active:
                    _SWEEP_STATE["skip"] = True
            return self._send_json({"ok": active})
        if route == "/api/sweep/stop":  # stop after the current asset finishes
            with _SWEEP_LOCK:
                active = bool(_SWEEP_STATE.get("job_id"))
                if active:
                    _SWEEP_STATE["stop"] = True
            return self._send_json({"ok": active})
        if route == "/api/recall":     # make/model -> ACCC + manufacturer recall check (async)
            make = (str(payload.get("make") or "")).strip()[:80]
            model = (str(payload.get("model") or "")).strip()[:80]
            name = (str(payload.get("name") or "")).strip()[:80]
            if not (make or model or name):
                return self._send_json({"error": "a name or make/model is required"}, 400)
            job_id = _start_job(recall_check, (make, model, name), {"error": "recall check failed"})
            print(f"[recall] start job={job_id} {make!r} {model!r}")
            return self._send_json({"job_id": job_id, "status": "running"})
        if route == "/api/recall-sweep":   # on-demand trigger (Settings Developer button + tests)
            try:
                threading.Thread(target=recall_sweep, daemon=True).start()
                print("[recall-sweep] on-demand run started")
                return self._send_json({"started": True})
            except Exception as e:
                return self._send_json({"error": str(e)}, 500)
        if route == "/api/inspect":     # inspection report import: PDF -> ranked defects (async)
            pdf_b64 = payload.get("pdf") or ""
            name = str(payload.get("name") or "")[:120]
            try:
                raw = base64.b64decode(pdf_b64, validate=True)
            except Exception:
                return self._send_json({"error": "not a valid PDF upload"}, 400)
            if len(raw) > 10 * 1024 * 1024:
                return self._send_json({"error": "PDF is over 10MB"}, 400)
            if raw[:5] != b"%PDF-":
                return self._send_json({"error": "that doesn't look like a PDF"}, 400)
            job_id = _start_job(inspect_report, (pdf_b64, name), {"error": "inspection import failed"})
            print(f"[inspect] start job={job_id} name={name!r} bytes={len(raw)}")
            return self._send_json({"job_id": job_id, "status": "running"})
        if route == "/api/gmail/scan":   # supplier import — read-only IMAP sweep (async)
            job_id = _start_job(gmail_scan, (), {"suppliers": [], "inferredAssets": [], "error": "scan failed"})
            print(f"[gmail] scan job={job_id}")
            return self._send_json({"job_id": job_id, "status": "running"})
        if route == "/api/identify":   # snap-to-add: photo -> asset fields
            if not os.getenv("ANTHROPIC_API_KEY"):   # same friendly fallback as chat — never a raw SDK error
                return self._send_json({"error": "No Anthropic API key is set — add one in the add-on Configuration."})
            try:
                b64, media = _data_url_to_b64(payload.get("image"))
                if not b64:
                    return self._send_json({"error": "image required"}, 400)
                hint = (payload.get("barcode") or "").strip()
                text = "Identify this appliance for the maintenance app." + (f" A barcode scanner read: {hint}." if hint else "")
                return self._send_json(_vision_json(IDENTIFY_SYSTEM, text, b64, media))
            except Exception as e:
                print(f"[identify] error: {e}")
                return self._send_json({"error": "identify failed — try again"}, 500)
        if route == "/api/triage":     # describe-a-problem
            if not os.getenv("ANTHROPIC_API_KEY"):
                return self._send_json({"error": "No Anthropic API key is set — add one in the add-on Configuration."})
            try:
                desc = (payload.get("text") or "").strip()[:2000]
                if not desc and not payload.get("image"):
                    return self._send_json({"error": "describe the problem"}, 400)
                b64 = media = None
                if payload.get("image"):
                    b64, media = _data_url_to_b64(payload.get("image"))
                return self._send_json(_vision_json(TRIAGE_SYSTEM, desc or "See photo.", b64, media))
            except Exception as e:
                print(f"[triage] error: {e}")
                return self._send_json({"error": "triage failed — try again"}, 500)
        if route == "/api/doc":        # document vault: cache a manual PDF on the Green
            try:
                n = save_doc(str(payload.get("assetId") or ""), str(payload.get("url") or ""))
                return self._send_json({"ok": True, "bytes": n})
            except ValueError as e:
                return self._send_json({"error": str(e)}, 400)
            except Exception as e:
                print(f"[doc] error: {e}")
                return self._send_json({"error": "couldn't fetch the manual — try again"}, 502)
        if route == "/api/photo":      # store an asset photo on the Green
            try:
                save_photo(payload.get("assetId"), payload.get("image"))
                return self._send_json({"ok": True})
            except Exception as e:
                return self._send_json({"error": str(e)}, 400)
        if route == "/api/home-photo":  # save the user's chosen home image (test-home picker)
            try:
                save_home_photo(str(payload.get("homeId") or ""), str(payload.get("url") or ""))
                return self._send_json({"ok": True})
            except Exception as e:
                return self._send_json({"error": str(e)}, 400)
        if route == "/api/vault/delete":  # drop vaulted photo + manual for deleted assets
            ids = payload.get("assetIds")
            if not isinstance(ids, list):
                return self._send_json({"error": "assetIds required"}, 400)
            return self._send_json({"ok": True, "removed": purge_asset_files(ids)})
        if route == "/api/chat":       # house assistant — answers + tool-driven edits (async)
            msgs = payload.get("messages")
            if not isinstance(msgs, list) or not msgs:
                return self._send_json({"error": "messages required"}, 400)
            job_id = _start_job(chat, (msgs,), {"reply": "Chat failed.", "changes": [], "proposals": [], "grounded": []})
            print(f"[chat] start job={job_id} ({len(msgs)} msgs)")
            return self._send_json({"job_id": job_id, "status": "running"})
        if route == "/api/chat/apply":  # user confirmed a proposed destructive tool call
            tool = str(payload.get("tool") or "")
            args = payload.get("args")
            if tool not in DESTRUCTIVE_TOOLS or not isinstance(args, dict):
                return self._send_json({"error": "invalid tool"}, 400)
            r = _apply_tool(tool, args, confirm=True)
            print(f"[chat] apply {tool} -> {r.get('ok')}")
            return self._send_json(r, 200 if r.get("ok") else 400)
        if route == "/api/state":
            state = payload.get("state")
            # Shape-check before persisting: a malformed state makes every background
            # thread (poller / autobook / digest) throw on each cycle until restart.
            if not isinstance(state, dict) or not all(
                    isinstance(state.get(k, []), list)
                    for k in ("homes", "assets", "tasks", "providers", "quotes", "logs", "mail")):
                return self._send_json({"error": "malformed state"}, 400)
            # HA direct-mode creds are device-local; scrub any legacy copy so the
            # long-lived token can never be read back via GET /api/state.
            if isinstance(state.get("settings"), dict):
                state["settings"].pop("haToken", None)
                state["settings"].pop("haUrl", None)
            ok, doc = state_write(int(payload.get("baseRev") or 0), state)
            if ok:
                return self._send_json({"ok": True, "rev": doc["rev"]})
            return self._send_json({"stale": True, "rev": doc.get("rev", 0), "state": doc.get("state")}, 409)
        if route == "/api/ha/notify":
            title = (payload.get("title") or "KasaKeeper").strip()[:80]
            message = (payload.get("message") or "").strip()[:250]
            if not message:
                return self._send_json({"error": "message required"}, 400)
            home_id = str(payload.get("homeId") or "").strip() \
                      or (state_read().get("state") or {}).get("currentHomeId")
            ok, err = ha_notify(title, message, home_id)
            return self._send_json({"ok": ok, "error": err}, 200 if ok else 502)
        if route == "/api/digest":
            # the app posts its current schedule digest; the daily pusher reads it at NOTIFY_HOUR
            try:
                # homeId is optional (older/current clients don't send it yet) — the
                # pusher falls back to the shared store's currentHomeId when absent.
                keep = {k: payload.get(k) for k in ("home", "homeId", "overdue", "soon", "next", "nudges", "pushDaily")}
                keep["saved_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
                json.dump(keep, open(DIGEST_FILE, "w"))
                return self._send_json({"ok": True})
            except Exception as e:
                return self._send_json({"error": str(e)}, 500)
        if route == "/api/enquiry/send":
            # Send a user-approved enquiry/booking email. The app composes & the user
            # approves the text; we just deliver it and stamp the tracking token so the
            # poller can match the reply.
            to = (payload.get("to") or "").strip()
            subject = (payload.get("subject") or "").strip()
            body = (payload.get("body") or "").strip()
            token = (payload.get("token") or "").strip()
            # Normalise the Cc to a bare address: a malformed one would otherwise
            # fail the whole send (losing an email the user already approved), and
            # a raw header value is the wrong place to trust free text.
            cc = _email_addr(payload.get("cc") or "")
            if not _email_addr(to):
                return self._send_json({"error": "a valid recipient email is required"}, 400)
            if not subject or not body:
                return self._send_json({"error": "subject and body are required"}, 400)
            if not gmail_available():
                return self._send_json({"error": "email not configured", "configured": False}, 503)
            if token and ("[" + token + "]") not in subject and token not in subject:
                subject = f"{subject} [{token}]"
            try:
                msgid = send_email(to, subject, body, cc=cc or None)
                return self._send_json({"ok": True, "messageId": msgid, "subject": subject})
            except Exception as e:
                print(f"[enquiry] send failed: {e}")
                return self._send_json({"error": str(e)}, 502)
        # ---- first-run setup wizard / Settings: server-side secret stores ----
        # Write-only — no GET anywhere returns a key or token, and none of these
        # ever land in a print()/log line. Values pass through request bodies
        # only, same as every other /api/* route.
        if route == "/api/keys":       # save one or more general API keys
            if not isinstance(payload, dict):
                return self._send_json({"error": "invalid body"}, 400)
            updates = {}
            for k in _SECRET_ENV_MAP:
                v = payload.get(k)
                if v is None:
                    continue
                if not isinstance(v, str) or not (0 < len(v.strip()) <= 300):
                    return self._send_json({"error": f"invalid {k}"}, 400)
                updates[k] = v.strip()
            if not updates:
                return self._send_json({"error": "no keys provided"}, 400)
            _secrets_update(lambda d: d.update(updates))
            for k, v in updates.items():           # take effect immediately, no restart needed
                if k not in _ENV_PRESET:            # a real env var / add-on option always wins
                    os.environ[_SECRET_ENV_MAP[k]] = v
            print(f"[keys] saved: {', '.join(sorted(updates.keys()))}")   # key NAMES only, never values
            return self._send_json({"ok": True, "flags": _secret_flags()})
        if route == "/api/keys/validate":   # real test call — never persists
            if not isinstance(payload, dict):
                return self._send_json({"error": "invalid body"}, 400)
            which = str(payload.get("which") or "")
            if which == "anthropic":
                key = str(payload.get("value") or "").strip()
                if not key or len(key) > 300:
                    return self._send_json({"ok": False, "error": "key required"}, 400)
                ok, err = _validate_anthropic_key(key)
            elif which == "places":
                key = str(payload.get("value") or "").strip()
                if not key or len(key) > 300:
                    return self._send_json({"ok": False, "error": "key required"}, 400)
                ok, err = _validate_places_key(key)
            elif which == "gmail":
                user = str(payload.get("user") or "").strip()
                pwd = str(payload.get("password") or "").replace(" ", "").strip()
                if not user or not pwd or len(user) > 300 or len(pwd) > 300:
                    return self._send_json({"ok": False, "error": "user and app password required"}, 400)
                ok, err = _validate_gmail_creds(user, pwd)
            else:
                return self._send_json({"error": "unknown 'which'"}, 400)
            print(f"[keys] validate which={which} ok={ok}")   # outcome only, never the value tested
            return self._send_json({"ok": ok, "error": err})
        if route == "/api/ha/token":   # save a per-home REMOTE HA url+token (local mode needs none)
            if not isinstance(payload, dict):
                return self._send_json({"error": "invalid body"}, 400)
            home_id = str(payload.get("homeId") or "").strip()
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", home_id):
                return self._send_json({"error": "invalid homeId"}, 400)
            url = str(payload.get("url") or "").strip()
            token = str(payload.get("token") or "").strip()
            if not url and not token:      # both blank -> disconnect/clear this home's saved token
                _ha_secrets_update(lambda d: d.pop(home_id, None))
                print(f"[ha] token cleared for home={home_id}")
                return self._send_json({"ok": True, "flags": {"homeId": home_id, "configured": False}})
            if not url or not token:
                return self._send_json({"error": "url and token are both required"}, 400)
            if len(url) > 500 or len(token) > 4000:
                return self._send_json({"error": "url or token too long"}, 400)
            ok, err, _ip = _valid_ha_url(url)
            if not ok:
                return self._send_json({"error": err}, 400)
            _ha_secrets_update(lambda d: d.__setitem__(home_id, {"url": url.rstrip("/"), "token": token}))
            print(f"[ha] token saved for home={home_id}")
            return self._send_json({"ok": True, "flags": {"homeId": home_id, "configured": True}})
        if route == "/api/ha/token/validate":   # real test call — never persists
            if not isinstance(payload, dict):
                return self._send_json({"ok": False, "error": "invalid body"}, 400)
            url = str(payload.get("url") or "").strip()
            token = str(payload.get("token") or "").strip()
            if not url or not token:
                return self._send_json({"ok": False, "error": "url and token required"}, 400)
            if len(url) > 500 or len(token) > 4000:
                return self._send_json({"ok": False, "error": "url or token too long"}, 400)
            ok, err, ip = _valid_ha_url(url)
            if not ok:
                return self._send_json({"ok": False, "error": err}, 400)
            ok, err = _validate_ha_remote(url, token, ip)
            print(f"[ha] validate home url ok={ok}")   # outcome only, never the token
            return self._send_json({"ok": ok, "error": err})
        return self._send_json({"error": "not found"}, 404)

    def do_GET(self):
        if self.path.rstrip("/") == "/api/health":
            try:
                import anthropic  # noqa
                sdk = True
            except ImportError:
                sdk = False
            return self._send_json({"ok": True, "sdk": sdk,
                                    "key": bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN")),
                                    "ha_proxy": ha_available(), "places": bool(_google_key()),
                                    "email": gmail_available(), "model": MODEL})
        parsed = urllib.parse.urlparse(self.path)
        p = parsed.path.rstrip("/")
        params = urllib.parse.parse_qs(parsed.query)
        if p == "/api/state":
            return self._send_json(state_read())
        if p == "/api/gmail/status":
            return self._send_json(gmail_status())
        if p == "/api/sweep/active":   # so a reloaded page can reattach to a still-running sweep
            with _SWEEP_LOCK:
                job_id = _SWEEP_STATE.get("job_id")
            return self._send_json({"job_id": job_id})
        if p.startswith("/api/research/") or p.startswith("/api/find-services/") or p.startswith("/api/gmail/scan/") or p.startswith("/api/chat/") or p.startswith("/api/lookup/") or p.startswith("/api/recall/") or p.startswith("/api/inspect/") or p.startswith("/api/sweep/"):  # poll <job_id>
            job_id = p.rsplit("/", 1)[-1]
            with _JOBS_LOCK:
                job = JOBS.get(job_id)
            if not job:
                return self._send_json({"status": "unknown"}, 404)
            return self._send_json(job)
        if p == "/api/logbook":        # branded PDF: assets + service history + spend
            try:
                state = state_read().get("state") or {}
                home_id = (params.get("home") or [""])[0]
                pdf_bytes = build_logbook_pdf(state, home_id)
                return self._send_bytes(pdf_bytes, "application/pdf",
                                        disposition='attachment; filename="kasakeeper-logbook.pdf"')
            except Exception as e:
                print(f"[logbook] error: {e}")
                return self._send_json({"error": "couldn't generate the logbook"}, 500)
        # ---- HA proxy (tokenless live data inside the add-on) ----
        # homeId is an optional query param on every route below — a home not
        # named explicitly falls back to the shared store's currentHomeId, so
        # today's app.js (which doesn't send it yet) keeps working unchanged.
        if p.startswith("/api/ha/"):
            home_id = (params.get("homeId") or [""])[0].strip() \
                      or (state_read().get("state") or {}).get("currentHomeId")
        if p == "/api/ha/available":
            return self._send_json({"available": ha_available(home_id)})
        if p == "/api/ha/devices":
            try:
                return self._send_json(ha_devices(force=(params.get("force") or [""])[0] == "1", home_id=home_id))
            except Exception as e:
                print(f"[ha] devices route failed: {e}")
                return self._send_json({"available": False, "devices": []})
        if p == "/api/ha/drift":
            try:
                return self._send_json(ha_drift(home_id))
            except Exception as e:
                print(f"[ha] drift route failed: {e}")
                return self._send_json({"available": False, "drift": [], "vanished": [], "newDevices": []})
        if p == "/api/enquiry/available":
            creds = _gmail_creds()
            return self._send_json({"available": bool(creds), "from": creds[0] if creds else None})
        if p == "/api/address-suggest":
            q = (params.get("q") or [""])[0].strip()[:120]
            return self._send_json({"suggestions": address_suggest(q)})
        if p == "/api/ha/weather":
            w = ha_weather(home_id)
            return self._send_json(w or {"error": "no weather entity"}, 200 if w else 404)
        if p == "/api/ha/state":
            ent = (params.get("entity") or [""])[0]
            try:
                raw = ha_api_get("states/" + urllib.parse.quote(ent, safe=""), home_id)
                if raw is None:
                    return self._send_json({"error": "ha proxy unavailable"}, 503)
                return self._send_raw(raw)
            except Exception as e:
                return self._send_json({"error": _safe_err(e)}, 502)
        if p == "/api/ha/history":
            ent = (params.get("entity") or [""])[0]
            since = (params.get("since") or [""])[0]
            try:
                path = f"history/period/{urllib.parse.quote(since, safe='')}?filter_entity_id={urllib.parse.quote(ent, safe='')}&minimal_response"
                raw = ha_api_get(path, home_id)
                if raw is None:
                    return self._send_json({"error": "ha proxy unavailable"}, 503)
                return self._send_raw(raw)
            except Exception as e:
                return self._send_json({"error": _safe_err(e)}, 502)
        # ---- vaulted-file serving: same id-regex guard + 404 shape for all three ----
        # NOTE: no function-local `import re` in these branches — a local import would
        # make `re` local to ALL of do_GET, and the place-photo branch below (which
        # doesn't execute it) then dies with UnboundLocalError. Module-level import.
        if p.startswith("/api/doc/"):     # serve a vaulted manual PDF
            return self._serve_file(DOC_DIR, p.rsplit("/", 1)[-1], "-manual.pdf", "application/pdf", "no document")
        if p.startswith("/api/photo/"):   # serve a stored asset photo
            return self._serve_file(PHOTO_DIR, p.rsplit("/", 1)[-1], ".jpg", "image/jpeg", "no photo")
        if p.startswith("/api/home-photo/"):   # serve the chosen home image
            return self._serve_file(PHOTO_DIR, p.rsplit("/", 1)[-1], ".jpg", "image/jpeg", "no photo", prefix="home-")
        if p == "/api/home-imagery":      # candidate photos for the test-home picker
            address = (params.get("address") or [""])[0]
            return self._send_json(home_imagery(address))
        # ---- business logo proxy (keyless; same-origin so no CSP/key exposure) ----
        if p == "/api/logo":
            domain = (params.get("domain") or [""])[0].strip()
            domain = _domain(domain) or domain
            got = fetch_logo(domain) if domain else None
            if not got:
                return self._send_json({"error": "no logo"}, 404)
            return self._send_bytes(got[0], got[1])
        if p == "/api/brand-logo":   # asset make -> brand logo (keyless, cached, emoji fallback client-side)
            name = (params.get("name") or [""])[0].strip()[:60]
            got = brand_logo(name)
            if not got:
                return self._send_json({"error": "no logo"}, 404)
            return self._send_bytes(got[0], got[1])
        # ---- Google Places photo proxy (keeps the API key server-side) ----
        if p == "/api/place-photo":
            name = (params.get("name") or [""])[0]
            key = _google_key()
            # Only a genuine Places photo resource may ride the server's key, and the
            # error path stays generic — the request URL embeds the secret.
            if not name or not key or not re.fullmatch(r"places/[A-Za-z0-9_-]+/photos/[A-Za-z0-9_-]+", name):
                return self._send_json({"error": "unavailable"}, 404)
            try:
                url = (f"https://places.googleapis.com/v1/{name}/media"
                       f"?maxHeightPx=200&maxWidthPx=400&key={urllib.parse.quote(key)}")
                data = _http_get(url, timeout=12)
                return self._send_bytes(data, "image/jpeg")
            except Exception:
                return self._send_json({"error": "photo fetch failed"}, 502)
        # ---- Street View Static proxy (keeps the API key server-side) ----
        if p == "/api/streetview":
            loc = (params.get("loc") or [""])[0]
            key = _google_key()
            if not key or not re.fullmatch(r"-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?", loc):
                return self._send_json({"error": "unavailable"}, 404)
            try:
                url = ("https://maps.googleapis.com/maps/api/streetview"
                       f"?size=640x400&fov=80&location={urllib.parse.quote(loc)}&key={urllib.parse.quote(key)}")
                data = _http_get(url, timeout=12)
                return self._send_bytes(data, "image/jpeg")
            except Exception:
                return self._send_json({"error": "streetview fetch failed"}, 502)
        return super().do_GET()

    def log_message(self, *a):  # quieter
        pass


if __name__ == "__main__":
    handler = functools.partial(Handler, directory=ROOT)
    # Default loopback: the dev server has no auth, and these endpoints spend API
    # credits and can send mail. run.sh exports KASA_HOST=0.0.0.0 inside the add-on,
    # where ingress (and no ports: mapping) is the auth boundary.
    host = os.getenv("KASA_HOST", "127.0.0.1")
    # Always armed, not gated on local HA: _digest_push_parts/ha_notify resolve
    # per-home now (a home can be 'remote'-only with no local Supervisor token
    # at all), and the loop already no-ops cheaply when nothing's connected.
    threading.Thread(target=_digest_pusher, daemon=True).start()
    print(f"[push] daily digest armed for {NOTIFY_HOUR:02d}:00 (home timezone)")
    if gmail_available():  # watch for trade quote replies
        threading.Thread(target=_quote_poller, daemon=True).start()
        print(f"[quote] reply poller armed ({QUOTE_POLL_SEC}s) from {_gmail_creds()[0]}")
        threading.Thread(target=_autobook_loop, daemon=True).start()
        print(f"[autobook] scanner armed ({AUTOBOOK_POLL_SEC}s) — auto tasks email their trade inside the lead window")
    print(f"KasaKeeper on http://{host}:{PORT}  (model={MODEL})")
    ThreadingHTTPServer((host, PORT), handler).serve_forever()
