<div align="center">

# UPS Monitor · ups-monitor

**A self-hosted monitoring console that polls UPS built-in web JSON instead of SNMP**

Single Node.js process · Zero third-party dependencies · Scales to 30–40 devices

[English](README.md) | [中文](README.md)

</div>

---

## What this is

A self-built monitoring platform for **Vertiv Liebert ITA2** UPS units.

Instead of deploying an SNMP collector and hand-writing MIB template mappings, this talks directly to the
JSON endpoints the devices already expose on their built-in web server.
Adding a device means entering **IP + web account + password** — everything else
(supply-state enums, battery state, sensor capabilities) comes from the device itself.

> ⚠️ This is an independent tool that communicates with devices over their built-in web interface.
> It is not affiliated with, endorsed by, or supported by Vertiv.
> Vertiv / Liebert / ITA2 are trademarks of Vertiv Co.

### Screenshots

![UPS Monitor · tile overview](screenshots/01-dashboard-tiles.png)

*(Captured from a live run; device names and IP addresses are masked)*

**Tile overview**: one tile per device showing supply state, load, output voltage, battery capacity and a
load bar; warnings turn yellow, critical faults red, offline grey. The top bar switches between
**tile overview / device cards / list / group panels**, and an "only show abnormal devices" filter
finds problems instantly even at 40-device scale.

The other views and capabilities:

- **Device cards** — full metric grid plus output-voltage and load trend lines, with a hover readout
- **List** — 15-column table, sortable by column header, with a compact mode
- **Groups** — collapsible panels; drag a tile to assign it to a group
- **Device detail** — full input/output/bypass/load/battery metrics, threshold verdicts and
  multi-track charts from 1 hour to 30 days
- **Alert management** — metric thresholds (each with its source cited), alert rules, WeCom and email channels
- **Device registry** — asset fields, bulk assign/enable/disable/delete

---

## Why build this instead of using SNMP?

The project started with **Vertiv Power Insight**, a commercial SNMP collector. Three readings were
wrong out of the box:

| Symptom | Root cause |
|---|---|
| Supply state always showed `1` (other) | The MIB provides **no enum mapping** for this point |
| Temperature showed 6553.5 °C | The OID returns `65535` (0xFFFF) — a **"no sensor" sentinel** parsed as a real reading |
| Firmware version could not be read | **No firmware OID exists** anywhere in the tree |

Walking the entire MIB confirmed it: none of these are SNMP bugs — **SNMP simply cannot carry this data.**
So the project pivoted to the device's built-in web interface, which was already reporting
`upsSupplyState: "2"` and `envTemp: "22.1"` on its own homepage.

Measured on the same device:

| Metric | SNMP | Built-in web JSON |
|---|---|---|
| Supply state | No mapping → always `1` | ✅ Normal / Bypass / Combined (device's own definitions) |
| Ambient temperature | `65535` → 6553.5 °C | ✅ Real value (22.1 °C) |
| Battery temp / humidity | No OID | ✅ Device declares `HasTempSensor=0` → UI shows "not supported" |
| Firmware version | Not in the tree | ❌ Not exposed by the web UI either → **not supported** |
| Input current / line voltage / phase B,C | Missing | ✅ All present |
| Energy counters / apparent power / crest factor | Missing | ✅ All present |

The JSON channel is **measurably more complete**, and because enums come from the device's own
front-end code, there is no template-mapping class of bug at all.

---

## Development story

The full story — including the dead ends — is written up in the
[Chinese README](README.md#开发历程). The short version:

1. **Commercial collector deployed**, three readings wrong → walked the whole MIB tree
2. **Tried patching MongoDB** to inject enum mappings → the engine reads a frozen config snapshot, so
   direct DB writes never take effect → dead end
3. **Pivoted to the device's web JSON** → found the data was there all along, but hit two hard walls:
   - **lwIP 1.3.1 only speaks HTTP/1.0.** Modern HTTP/1.1 clients get RST'd; the symptom
     ("session expired", "page bounced to login") masquerades as a session-table problem.
   - **The web session is scarce and logins are rate-limited** — the login page literally says
     *"Too many users on-line. Please wait"*. Only 1 of 5 consecutive logins yields a usable session.
4. **Built the collector** on a hand-written raw TCP HTTP/1.0 client with long-lived session reuse
5. **Grew it into a platform**: grouping, templates, alert engine (WeCom Work + hand-written SMTP),
   permanent history storage with multi-track charts, threshold engine with colour-coded violations
6. **Rebuilt the UI for 30–40 devices**: four view modes, and moved trend data server-side so the
   dashboard stopped issuing one history request per device every 5 seconds (40 devices → 50 KB / 96 ms)
7. **Added drag & drop** — then debugged three separate causes, including one that only affected the
   card view, and one where my own automated test passed *because it dragged too fast to hit the
   5-second re-render*

**Takeaway:** the turning point wasn't "which protocol" — it was going back to the device and looking
at what it was actually reporting. The MIB is a secondhand translation the vendor didn't even fill in
completely; the device's own JSON is first-hand data. Everything after that was fighting a one-or-two-session
embedded web server that only speaks HTTP/1.0.

---

## Features

- **Zero dependencies** — Node.js standard library only, including a hand-written HTTP/1.0 client and SMTP client
- **Four dashboard modes** — tile overview / device cards / list / group panels, persisted server-side
- **Dynamic + static grouping** — by model, site or status automatically; custom groups support drag-to-assign
- **Alert engine** — 20 fields × 6 operators, with cooldown, repeat reminders and recovery notices
- **Two delivery channels** — WeCom Work group robot (markdown) and email over SMTP (25/587/465)
- **Metric thresholds** — 9 metrics, three levels, sourced from the vendor manual and national standards;
  violations recolour every surface of the UI
- **Permanent history** — daily JSONL shards, multi-track charts from 1 hour to 30 days
- **Asset fields** — site, commissioning date, integrator, model, serial, tags, notes
- **Identity auto-read** — model and serial number are filled in from the device's own overview when left blank; the device form can pre-read them on demand, firmware version included
- **Drag to reorder and to group** — mouse drag, touch long-press, plus ↑/↓ buttons as a fallback
- **Self-healing** — reconnects after a network outage and records a "back online" event
- **Rollback build** — a stripped-down variant that only keeps collection and the dashboard

---

## Quick start

### Requirements

- Node.js ≥ 18 (**no `npm install` needed**)
- Network reachability to the UPS web interface (HTTP port 80)
- Device web account and password

### Run

```bash
# Windows one-click
upsmon/start.bat

# or
node upsmon/server.js
```

Open **http://localhost:8686**

### Add a device

Click **「+ 添加 UPS」** in the top right. Required: name, IP, port, web account, web password.
Optional asset fields: site, commissioning date, integrator, model, serial, tags, notes.
Hit 「测试连接」 to verify, then save — collection starts immediately, no restart needed.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8686` | HTTP port |
| `UPS_DATA_DIR` | `./upsmon/data` | Data directory (useful for running several instances) |

---

## Layout

```
.
├─ README.md / README.en.md
├─ package.json
├─ LICENSE
├─ screenshots/
├─ docs/
│  ├─ AUTH-DESIGN.md         Identity & RBAC design (not yet implemented)
│  └─ CMDB-ROADMAP.md        Extended feature backlog
├─ upsmon/                   Full edition
│  ├─ server.js              HTTP server + collector + config centre + alerting + REST API
│  ├─ lib/
│  │  ├─ http10.js           Raw HTTP/1.0 client (lwIP compatibility)
│  │  ├─ vertiv.js           ITA2 driver: login, fetch, normalise
│  │  ├─ store.js            Device registry persistence
│  │  ├─ settings.js         Config centre: groups / templates / alerts / thresholds
│  │  ├─ grouping.js         Grouping engine
│  │  ├─ alerts.js           Rule engine + WeCom + email
│  │  ├─ smtp.js             Minimal SMTP client
│  │  ├─ thresholds.js       Threshold definitions and evaluation
│  │  └─ history.js          Sharded history storage and downsampling
│  ├─ public/index.html      Front end (single file, all styles and scripts inline)
│  ├─ tools/                 Load-test data generator
│  └─ data/                  Runtime data (git-ignored, contains passwords)
└─ upsmon-v1-minimal/        Minimal edition (rollback build)
```

---

## Implementation notes

**① HTTP/1.0 only.** The ITA2 web server runs on lwIP 1.3.1 and rejects HTTP/1.1 keep-alive
connections. `lib/http10.js` writes the request line by hand and always sends `Connection: close`.

**② Sessions are scarce and logins are rate-limited.** The device login page says
*"Too many users on-line. Please wait"*. Strategy: log in once and reuse the SID, call
`/SignOut.cgi` before re-authenticating, 30-second login cooldown, exponential backoff on failure.

> Side effect: opening the UPS web page by hand evicts the collector's session (it recovers
> automatically). Also don't run two instances against the same UPS — they fight over the session.

**③ Sensor support is declared by the device.** `/_com/status/battery.json` carries
`HasTempSensor` / `HasHumiSensor` flags. The UI shows "not supported" rather than rendering
sentinel values like `-100.0` as real readings.

**④ Voltage semantics.** `L_N_Volt` is the **phase-to-neutral** voltage (220 V in both single- and
three-phase systems); the line voltage lives in `L_L_Volt` (380 V). Threshold evaluation must be
consistent about this.

---

## Default thresholds

| Metric | Green → Yellow | Yellow → Red | Basis |
|---|---|---|---|
| Output voltage | ±5% | ±10% | GB/T 7260 UPS ±1%; GB 50174 ±7%; GB/T 12325 |
| Input voltage | ±10% | outside 176–288 V | ITA2 manual input range |
| Bypass voltage | ±20% | outside device range | ITA2 manual bypass −40%~+20% |
| Line voltage (AB) | ±5% | ±10% | 380 V three-phase nominal; N/A single-phase |
| Output current | 85% rated | 100% rated | manual overload 105–125% for 10 min |
| Load | 70% | 85% | optimal sustained load 40–70% |
| Battery capacity | 50% | 20% | deep discharge shortens battery life |
| Output frequency | ±0.5 Hz | ±2 Hz | GB 50174 50 Hz ±0.5 Hz |
| Ambient temperature | 30 °C | 35 °C | ITA2 0–40 °C no derating, 50 °C derated |
| Phase imbalance | 1% | 2% | GB/T 15543 ≤2% |

Thresholds are editable under **Alert Management → Metric Thresholds** and can be reset to defaults.

---

## REST API

| Method | Path | Description |
|---|---|---|
| GET | `/api/state?groupBy=` | All device state (with trend series) + events + grouped views |
| GET | `/api/settings` | Full config centre (credentials redacted) |
| GET/PUT | `/api/thresholds` | Read / update metric thresholds |
| POST | `/api/thresholds/reset` | Restore default thresholds |
| GET/POST | `/api/devices` | List / create devices |
| PUT/DELETE | `/api/devices/:id` | Update / delete (also drops that device's history) |
| POST | `/api/devices/batch` | Bulk assign / enable / disable / delete |
| POST | `/api/devices/reorder` | Persist drag order (optional `targetGroupId` also assigns a group) |
| POST | `/api/devices/:id/poll` | Trigger an immediate poll |
| POST | `/api/devices/:id/alert-test` | Evaluate rules as if "offline" and push |
| GET | `/api/history/:id?range=1h\|6h\|24h\|7d\|30d` | History series |
| GET | `/api/events?limit=` | Persisted event log |
| GET/POST | `/api/groups` | Groups |
| GET/POST | `/api/templates` | Config templates |
| GET/POST | `/api/channels` | Notification channels (`POST /api/channels/:id/test` sends a test) |
| GET/POST | `/api/rules` | Alert rules |
| POST | `/api/test` | Test a connection without saving |

---

## Device endpoints (ITA2)

| Endpoint | Content |
|---|---|
| `POST /SignIn.cgi` | Form `UserName` / `Pswd` → `Set-Cookie: SID=<hex>` |
| `GET /SignOut.cgi` | Log out; invalidates the previous SID immediately |
| `GET /_com/home/home.json` | Overview: supply state / V, I, f / load / battery / ambient temp / model / alarm counts |
| `GET /_com/status/input.json` | + input power factor, energy counter |
| `GET /_com/status/output.json` | + output energy counter |
| `GET /_com/status/load.json` | + apparent power, crest factor |
| `GET /_com/status/bypass.json` | Bypass |
| `GET /_com/status/battery.json` | Battery groups / cabinet temp / sensor presence flags |
| `GET /_com/_infor/infor.json` | Device IP and UPS time |

Enum meanings come from the device's own front-end code:
supply state `0` none / `1` bypass / `2` inverter / `3` combined;
battery state `0` no battery / `1` float / `2` equalise / `3` discharging / `4` full / `5` idle / `6` self-test.

---

## Known limitations

- **Firmware version is unavailable** — neither SNMP nor the web UI exposes it; the UI says so explicitly
- **Battery temperature / humidity need optional sensors** — shown as "not supported" when absent
- **No authentication yet** — the console is open on the LAN; see [`docs/AUTH-DESIGN.md`](docs/AUTH-DESIGN.md)
- **No service install / EXE packaging** — must be started manually
- **Plain HTTP** to the devices, and credentials sit in `data/devices.json` (redacted in API output); LAN use only

---

## Roadmap

See [`docs/CMDB-ROADMAP.md`](docs/CMDB-ROADMAP.md) for the full backlog across seven categories,
prioritised into three tiers: service install & backups & bulk import & basic auth first,
then contracts, reporting, battery health and ticketing, then inspections, energy analytics and
predictive maintenance.

---

## License

[MIT](LICENSE) © 2026 UPS Monitor contributors
