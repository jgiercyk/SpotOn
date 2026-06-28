# CLAUDE.md

## Project Goal

Build **Spot On**, a web application that collects, normalizes, deduplicates, searches, and displays amateur radio spot data from multiple sources.

Current goals:

* Manage saved spot sources.
* Support telnet DX Cluster, DX Summit HTTP, POTA API, SOTA API, and RBN telnet as live spot sources.
* Support RBN skimmer filtering by proximity, region, and favorites.
* Support 13 Colonies as a dedicated event tracking tab.
* Support Field Day as a dedicated event tracking tab with per-band section matrices and an All-bands totals view.
* Support Special Events as a dedicated tab, combining scheduled event data from multiple sources (ARRL, VA3RJ, 425 DX News) with live spot feeds.
* Support HRD Logbook dupe checking with a persistent floating panel.
* Allow one or more spot sources to be active simultaneously.
* Parse incoming data from each source independently using separate parsers.
* Normalize source data into common internal objects where practical.
* Deduplicate general DX spots from multiple sources.
* Display parsed spots in live sortable tables with filters.
* Provide a global Search All Sources feature.
* Display UTC and local/configurable clocks.
* Support optional QRZ XML callsign lookups.
* Allow the user to set and persist dashboard tab order.

---

# Development Discipline

When making changes:

* Look for redundant code and remove it.
* Avoid duplicate logic — reuse existing functions.
* Keep configuration simple and centralized.
* Prefer clear, maintainable code over clever code.
* Update this file when project assumptions change.

Claude should learn from the current implementation and avoid repeating earlier mistakes.

---

# Important Source-Format Rule

Every spot source has a completely different format. Do not assume sources look alike.

Each source type must have its own parser:

* Telnet DX Cluster parser
* DX Summit HTTP parser
* POTA API parser
* SOTA API parser
* RBN telnet parser
* Special Events: separate parsers per source (ARRL HTML, VA3RJ HTML, 425 DX HTML)

Do not fix one source by breaking another. Test each source independently.

---

# Architecture

```text
Browser UI
      │
      │ WebSocket
      ▼
Local Backend (Node.js / Express)
      │
      ├── TCP / Telnet       → DX Cluster
      ├── HTTP Polling       → DX Summit
      ├── HTTP / JSON API    → POTA
      ├── HTTP / JSON API    → SOTA
      ├── TCP / Telnet       → RBN
      ├── HTTP Scraping      → ARRL Special Events (HTML)
      ├── HTTP Scraping      → VA3RJ DX Calendar (HTML)
      ├── HTTP Scraping      → 425 DX News Calendar (HTML)
      └── PowerShell / ADODB → HRD Logbook (.mdb)
```

The backend is responsible for: opening telnet connections, polling HTTP/API sources, parsing each source format separately, normalizing and deduplicating spots, logging into telnet clusters, sending structured objects to the browser, performing optional QRZ XML lookups, and querying HRD Logbook for dupe checks.

The frontend must never communicate directly with telnet servers or expose QRZ credentials.

---

# User Interface

Header: Configure | Connect | Disconnect | [Dupe Check ☐] [Dupe Panel] | Connected

Clock bar: UTC clock | Local clock | Search All [input ✕] [Search]

Tabs: Live Spots | POTA | SOTA | RBN | Special Events | 13 Colonies | Field Day | Search | Console | Configuration

Tab order is user-configurable and persisted in localStorage. See **Tab Order** section.

Each tab with a spot table follows the Live Spots pattern: sortable columns, filter bar, time-desc default sort, QRZ links on callsigns/spotters.

## Visual Distinction

* **Search All** input — blue theme (`#7eb8f7`), dark blue background, bold blue label.
* **QRZ ad-hoc lookup** inputs — amber theme (`#d4952a`), warm dark background, label reads "QRZ" (not "Callsign").
* All lookup/search inputs have an inline ✕ clear button that appears when the field has content.

---

# Visual Style

Dark theme. Avoid dark gray text on near-black backgrounds.

```text
Normal text:    #E6E6E6
Secondary text: #BFC7D5
```

Links, clickable callsigns, and interactive elements must be visually obvious.

---

# Clocks

Two clocks always visible. UTC clock (always UTC). Configurable clock (user-selectable time zone, 12/24-hour format, default America/New_York 12-hour). Clock settings saved to localStorage.

---

# Spot Sources

Supported types for live spots: Telnet DX Cluster, HTTP feed, POTA API, SOTA API, RBN telnet.

Special Events sources are separate (see Special Events Tab section).

## Defaults

```json
[
  { "name": "IK4PKL",       "type": "telnet",     "host": "ik4pkl.ddns.net",                         "port": 7300, "enabled": true  },
  { "name": "WA9PIE-2",     "type": "telnet",     "host": "134.122.7.227",                           "port": 8000, "enabled": false },
  { "name": "DX Summit 100","type": "http",       "url": "http://www.dxsummit.fi/text/dx100.html",   "pollSeconds": 60, "enabled": true  },
  { "name": "POTA Spots",   "type": "pota-api",   "url": "https://api.pota.app/spot/",               "pollSeconds": 60, "enabled": true  },
  { "name": "SOTA Spots",   "type": "sota-api",   "url": "https://api2.sota.org.uk/api/spots/50/all","pollSeconds": 60, "enabled": true  },
  { "name": "RBN CW/RTTY",  "type": "rbn-telnet", "host": "telnet.reversebeacon.net",                "port": 7000, "enabled": false },
  { "name": "RBN FT8",      "type": "rbn-telnet", "host": "telnet.reversebeacon.net",                "port": 7001, "enabled": false }
]
```

RBN is disabled by default (high volume) and does not auto-start on Connect. Operator starts RBN manually from the RBN tab Start/Stop buttons.

---

# Connection Behavior

On Connect: start each enabled non-RBN source. Telnet DX Clusters log in and issue `sh/dx 100`. DX Summit, POTA, SOTA poll at configured intervals. RBN started manually from its tab. All sources deduplicate general spots; POTA/SOTA/RBN are not deduplicated against cluster data.

Connection status colors: Gray=Disconnected, Yellow=Connecting, Green=Connected, Orange=Partial, Red=Error.

---

# Data Objects

## Common Spot
`time, date, band, mode, frequency, dxCall, comment, spotter, sources[], rawLines[]`

## POTA Spot
`activator, frequency, band, mode, park, parkName, location, spotTime, spotAge, comments, spotter, source, rawJson`

## SOTA Spot
`activator, frequency, band, mode, summit, summitName, association, region, location, spotTime, spotAge, comments, spotter, source, rawJson`

**SOTA API:** `summitCode` is bare (e.g. `BW-348`). Full ref = `associationCode + "/" + summitCode`. `summitDetails` is a plain string.

## RBN Spot
`heardCall, frequency, band, mode, signalDb, speed, skimmerCall, skimmerGrid, spotTime, spotAge, source, rawLine`

RBN spots are not shown in Live Spots. Useful for propagation analysis.

## Normalized Special Event

All Special Events sources normalize to this shape:

```json
{
  "eventId": "",
  "source": "",
  "sourceUrl": "",
  "title": "",
  "callSign": "",
  "callSigns": [],
  "startDate": "",
  "endDate": "",
  "startTimeUtc": "",
  "endTimeUtc": "",
  "city": "",
  "state": "",
  "locationText": "",
  "entity": "",
  "frequencies": [],
  "bands": [],
  "modes": [],
  "qslInfo": "",
  "certificateInfo": "",
  "website": "",
  "description": "",
  "confidence": 1.0,
  "tags": [],
  "rawText": "",
  "lastUpdated": 0
}
```

`callSigns[]` must always be an array (some events have multiple callsigns). `confidence` represents how certain we are that this is a true special-event station. `rawText` is preserved for troubleshooting.

---

# Deduplication

## Live Spots
Likely duplicate: same DX Call + same Spotter + frequency within 0.5 kHz + time within 10 minutes. On match: merge `sources[]`, preserve `rawLines[]`, show one row. POTA, SOTA, and RBN are never deduplicated against cluster data.

## Special Events
Merge events from different sources when callsign and date range match. When merging: keep all source URLs, use the highest confidence value, combine frequencies. Prefer ARRL for U.S. event details; prefer VA3RJ or 425 DX for international event details. Never show the same callsign/event twice.

---

# Band Detection

| Range kHz | Band | | Range kHz | Band |
|---:|---|---|---:|---|
| 1800–2000 | 160m | | 28000–29700 | 10m |
| 3500–4000 | 80m  | | 50000–54000 | 6m  |
| 5330–5405 | 60m  | | 144000–148000 | 2m |
| 7000–7300 | 40m  | | 420000–450000 | 70cm |
| 10100–10150 | 30m | | | |
| 14000–14350 | 20m | | | |
| 18068–18168 | 17m | | | |
| 21000–21450 | 15m | | | |
| 24890–24990 | 12m | | | |

---

# Mode Detection

Comment text has priority. FT8/FT4 watering holes use ±3 kHz tolerance.

| Mode | Trigger |
|---|---|
| FT8 | Comment contains FT8, or near FT8 watering hole |
| FT4 | Comment contains FT4, or near FT4 watering hole |
| Digital | Comment contains RTTY, PSK, JS8, or DIGI |
| CW | Comment contains CW, or in CW sub-band |
| Voice | Comment contains SSB, USB, LSB, PHONE, or in phone sub-band |
| Unknown | None of the above |

FT8 watering holes (kHz): 1840, 3573, 5357, 7074, 10136, 14074, 18100, 21074, 24915, 28074, 50313, 144174, 432174.
FT4 watering holes (kHz): 3575, 7047, 10140, 14080, 18104, 21140, 24919, 28180, 50318, 144170, 432170.

CW sub-bands: 1800–1840, 3500–3600, 7000–7125, 10100–10150, 14000–14150, 18068–18110, 21000–21200, 24890–24930, 28000–28300, 50000–50100, 144000–144100, 420000–432100.

Voice sub-bands: 1840–2000, 3600–4000, 5330–5405, 7125–7300, 14150–14350, 18110–18168, 21200–21450, 24930–24990, 28300–29700, 50100–54000, 144200–148000, 432200–450000.

---

# Filters

**Live Spots:** Band, Mode, Source, Freeform Search, US Spotters Only (K/N/W/A prefix).

**POTA:** Band, Mode, Activator, Park, Location, Freeform Search.

**SOTA:** Band, Mode, Activator, Summit, Association, Region, Freeform Search.

**RBN:** Two layers:
1. Skimmer filter: All Skimmers, Nearest (5/10/25), Within Distance (100/250/500/1000 mi), Region, Favorites, Individual.
2. Row filters: Band, Mode, Heard Call, Skimmer, Skimmer Grid, Freeform Search.

RBN Start/Stop buttons live in a dedicated `#rbnControlBar` between the filter bar and the table. They must never be placed inside the filter bar — the filter bar uses `flex-wrap: wrap` and extra skimmer controls can cause the bar to grow, pushing off elements at the end.

**Special Events:** Status (Active+Upcoming default; Active Only, Upcoming Only, All), State, Band, Freeform Search.

---

# RBN Skimmer Database

Each entry: Callsign, Grid Square, Latitude, Longitude, Country, Region.

Distance calculated from Home Grid Square. Skimmers with unknown grids are shown but excluded from distance filters.

Skimmer regions: Northeast US, Southeast US, Midwest US, Southwest US, Northwest US, Canada, Europe, South America, Africa, Asia, Oceania.

---

# Home Station Configuration

Home Callsign and Home Grid Square (Maidenhead). Used for RBN distance-based filters.

---

# QRZ XML Lookup

Optional. Triggered by user action only — never automatic. Credentials stored as backend environment variables (`QRZ_USERNAME`, `QRZ_PASSWORD`, `QRZ_ENABLED`). Never exposed to browser.

Popup shows: Callsign, Name, City, State, Country, Grid, County, CQ Zone, ITU Zone, QRZ URL.

When dupe check is enabled, QRZ info appears inside the dupe panel instead of a standalone popup.

---

# HRD Logbook Dupe Check

Optional read-only check against the HRD Logbook `.mdb` file. Windows only.

## Database Access

Uses PowerShell 5.1+ with ADODB COM objects. **Do not use cscript.exe** — the old JScript engine lacks `JSON.stringify`.

Provider: `Microsoft.ACE.OLEDB.12.0` with fallback to `Microsoft.Jet.OLEDB.4.0`.

**Actual HRD schema:**
* Table: `TABLE_HRD_CONTACTS_V01` (not `HRD_CONTACTS_V01`)
* `COL_TIME_ON`: full datetime string `MM/DD/YYYY HH:MM:SS` (not separate date/time columns)
* `COL_FREQ`: frequency in **Hz** (e.g. `28181263` = 28.181 MHz) — divide by 1,000,000
* `COL_CALL`, `COL_BAND`, `COL_MODE`: as expected

## Configuration

Stored in `dupe-config.json` on the backend (not localStorage, not .env).

* Enable/disable (boolean)
* HRD Logbook path
* Dupe time window: 24h / 48h / 72h / 1 week / Ever / Custom (value + unit)

The header has a **Dupe Check** checkbox to toggle enable/disable without opening Configure. A **Dupe Panel** button opens the panel standalone. Both sync with the Configure dialog checkbox.

## Dupe Check Panel

Persistent floating panel, draggable, always-on-top. Opened by clicking a callsign (when dupe enabled) or via the Dupe Panel header button.

**Panel controls:**
* Callsign input with ✕ clear button — Enter or Check button triggers lookup
* Band dropdown (Any Band + all bands)
* Mode dropdown (Any Mode / CW / Voice / Digital)
* Time window dropdown (24h / 48h / 72h / 1 week / Ever)
* Filter selections are saved to localStorage and restored on page load

**Behavior:**
* When opened from a spot click, band and mode pre-fill from the spot context.
* When opened standalone, user sets band/mode/window manually.
* All QSOs for the callsign are returned regardless of filter parameters.
* Contacts that match band + mode + time window are highlighted red (dupe).
* Contacts matching band + mode but outside the time window are highlighted yellow (worked before).
* Non-matching contacts are shown unformatted.
* Status badge: DUPE / NOT A DUPE / WORKED BEFORE — reflects the active filter parameters.
* "Any Band" or "Any Mode" selections match all contacts for that dimension.
* QRZ info (if enabled) is shown inside the panel.

## Mode Normalization

| HRD Mode | Spot On Group |
|---|---|
| CW | CW |
| SSB / USB / LSB / AM / FM / DSTAR / D-STAR | Voice |
| FT8 / FT4 / RTTY / PSK / JS8 / DIGITAL | Digital |

## Safety

Read-only. Never modify the HRD database. Handle missing file and locked database gracefully.

---

# 13 Colonies Tab

Specialized view — qualifying spots forwarded from Live Spot Engine. No direct external connection.

Stations: K2A–K2M (13 colonies), WM3PEN (Philadelphia), GB13COL (Great Britain), TM13COL (France).

Award modes: Voice, Digital, CW (same mapping as Field Day).

Worked Matrix: station × mode, toggleable, persisted in localStorage.

Spot Table: shows only wanted (not-yet-worked) station/mode combos. Columns: Time, Station, Location, Mode, Band, Frequency, Spotter, Source, Comment.

---

# Field Day Tab

Qualifying spots: comment contains `FD` (word boundary) or `Field Day` (case-insensitive).

## Band Sub-Tabs

Bands: 160m, 80m, 40m, 20m, 15m, 10m, 6m — each with an independent section matrix.

**All tab:** Aggregate totals across all bands. A section/mode light is green if worked on any band. Read-only — switch to a specific band to toggle individual lights.

## Award Modes

| Spot Mode | Award Mode |
|---|---|
| CW | CW |
| Voice / SSB / USB / LSB / Phone | Voice |
| All others (FT8, FT4, Digital, etc.) | Digital |

## Section Matrix

85 official ARRL W/VE sections displayed as a 5-column grid, sorted alphabetically by section code. Each cell: section code (bold), full name (muted), Voice / Digital / CW lights. Red = not worked, Green = worked. Click to toggle. Worked state persisted in localStorage per band/section/mode.

On startup, a one-time migration removes any localStorage entries for obsolete section codes (e.g. CFL, NJ) without clearing valid worked state.

## Clear Button

Every band tab (including All) has a Clear button. Clicking shows a confirmation dialog warning that worked state will be lost. Clearing a band tab resets only that band. Clearing the All tab resets all bands.

## Spot Table

Shows only unworked section/mode spots for the current band. Columns: Time, Age, Mode, Band, Freq, DX Call, Comment, Spotter, Source. A section/mode turning green immediately hides matching spots.

---

# Special Events Tab

Combines scheduled special-event data from multiple sources with live spot feeds. Not a static calendar — shows what's active and what's coming.

## Data Sources and Priority

| Priority | Source | Confidence | Notes |
|---|---|---|---|
| 1 | Manual / built-in | 1.00 | Known recurring events (13 Colonies callsigns, etc.). |
| 2 | ARRL Special Events | 0.95 | U.S. primary. Multi-page; slow — see performance note. |
| 3 | VA3RJ DX Calendar | 0.90 | International. Not yet implemented. |
| 4 | 425 DX News Calendar | 0.85 | Supplemental international. Filter for SE language. |
| 5 | 1x1 Callsign DB | 0.75 | Validation only. Non-fatal if unavailable. |

When the same callsign+date appears in multiple sources, the higher-confidence source wins. Lower-confidence source kept as a supplemental note only. Show events with confidence ≥ 0.75.

### 425 DX Classification

Not every 425 DX item is a special event. Treat as likely SE if text contains: special callsign, special event, anniversary, celebrating, commemorating, award, SES, or QSL/certificate language tied to an event.

425 DX entries parsed from `<code>` blocks: format is `"ENTITY - description with callsigns"`. No `<strong>` tags exist in data rows. Callsigns extracted by regex from description text. "active as CALL" pattern preferred for identifying the special callsign.

## Normalized Event Object

Every source normalizes to this shape. New date-quality fields are required:

```json
{
  "eventId": "",
  "source": "",
  "title": "",
  "callSign": "",
  "callSigns": [],
  "startDate": "",
  "endDate": "",
  "startTimeUtc": "",
  "endTimeUtc": "",
  "city": "",
  "state": "",
  "locationText": "",
  "frequencies": [],
  "bands": [],
  "qslInfo": "",
  "certificateInfo": "",
  "website": "",
  "description": "",
  "confidence": 1.0,
  "rawText": "",
  "dateQuality": "Exact",
  "dateWarning": "",
  "sortStartUtc": "2026-08-29",
  "lastUpdated": 0
}
```

### Date Quality Values

| Value | Meaning |
|---|---|
| Exact | Both start and end dates known |
| Partial | Only one date side known |
| Unknown | No usable date |

`sortStartUtc` rules:
- If startDate known: `sortStartUtc` = parsed ISO date of startDate
- If only endDate known: `sortStartUtc` = parsed ISO date of endDate (DateQuality = Partial)
- If neither known: `sortStartUtc` = `"9999-12-31"` (DateQuality = Unknown)

Never leave `sortStartUtc` null. Use `"9999-12-31"` as the far-future sentinel.

## Status Computation

Computed client-side. Returns one of 7 status codes:

| Status | Condition | UI Label | Color |
|---|---|---|---|
| active | start ≤ now ≤ end | ACTIVE | Green |
| upcoming | now < start | UPCOMING | Blue |
| expired | now > end | EXPIRED | Gray |
| active_unknown_start | no start, now ≤ end | ACTIVE? | Amber |
| upcoming_unknown_end | has start, now < start, no end | UPCOMING? | Amber |
| active_unknown_end | has start, now ≥ start, no end | ACTIVE? | Amber |
| date_unknown | neither date known | DATE UNKNOWN | Dark gray |

Year inference: cross-year end dates bump end to next year. Events whose start is >6 months in the past roll to next year.

## Default Filter Behavior

The default view ("Active + Upcoming") shows only high-confidence, clean records:

**Shown:** active, upcoming (exact dates, any confidence ≥ 0.85)  
**Hidden:** expired, date_unknown, active_unknown_start, upcoming_unknown_end, active_unknown_end

Uncertain-date records remain in the cache. They become visible when the user selects "All (incl. uncertain)" from the Status filter. They can also appear in a future "Heard Today" section if spotted live.

## ARRL HTML Parsing

URL pattern: `https://www.arrl.org/special_events/search/page:PAGENUM/model:Event`

Each event is a `<li>` inside `<ul>` inside `<div class="list2">`. The `<h3>` contains the event title (strip the `<span>` date prefix). The `<p>` bold section holds `Mon D-Mon D, HHMMz-HHMMz, CALLSIGN`. The rest of the `<p>` is free text with city/state, organization, frequencies (MHz), QSL info, contact, and website.

**Critical parser rule:** Use `indexOf('class="list2"')` then `indexOf('<ul>')` to locate the event list. Do NOT use a lazy regex like `/([\s\S]*?)<\/div>/` — it stops at the first nested `</div>` (the nav/pagination div) and finds nothing.

Pagination: detect total from "Results X to Y of N" header, fetch pages with 1500 ms courtesy delay between requests.

**Performance note:** ARRL pagination with up to 10 pages × 1.5 s delay = potentially 15+ seconds per refresh. Always serve cached data immediately; refresh in background. Never block the UI on an ARRL fetch. Cached events are sent to new WebSocket clients on connect.

## Callsign Index

After collecting and normalizing events from all sources, maintain a fast in-memory callsign lookup. Keyed by callsign, used to attach an **SE badge** to matching live spots.

**SE badge** (`<span class="se-event-badge">SE</span>`) appears inline with the callsign in the Live Spots table.

## Live Spot Integration

Reuse existing DX Cluster, DX Summit, and RBN feeds. No separate connection for Special Events. Enrich spots on ingest if the callsign is in the SE callsign index.

## Tab UI

Single sortable table. Filters: Status (Active+Upcoming default; Active Only, Upcoming Only, Expired Only, All), State, Band, Freeform Search.

Default sort: status group first (active < upcoming), then by `sortStartUtc` ascending (date order within group).

Missing start dates display as **Unknown** (italic, muted). Missing end dates display as **Unknown**.  
Partial/Unknown date quality shown as a small badge on the Start cell.  
Source column is sortable.

Manual Refresh button (throttled — 60 s minimum between manual refreshes).

## Fault Tolerance

If any source fails, continue with cached data. Never crash the dashboard because one SE source failed.

## API Endpoints

- `GET /api/special-events` — returns cached `{ events, lastRefresh }`
- `POST /api/special-events/refresh` — triggers a fresh fetch (throttled 60 s); returns `{ status: 'refreshing' }` or 429

## Search All

Special events are included in Search All Sources. Query matches against callsign, title, location, description, frequencies, QSL info, and website.

---

# Tab Order

Tab order is user-configurable and persisted in localStorage key `dxspots_taborder`.

## Tab Identity

Each tab has a stable internal ID (`TAB_DEFS` in index.html) distinct from its visible label:

| ID | Label |
|---|---|
| spots | Live Spots |
| pota | POTA |
| sota | SOTA |
| rbn | RBN |
| se | Special Events |
| colonies | 13 Colonies |
| fd | Field Day |
| search | Search |
| console | Console |
| config | Layout |

## Behavior

On startup:
1. Load saved tab order from localStorage.
2. Validate against existing tab IDs — drop unknown IDs, append missing ones at the end.
3. Render tabs in the resulting order via `renderTabBar()`.

Tab bar is rebuilt dynamically by `renderTabBar()` — do not add static event listeners to individual tab buttons. The tab bar uses a single delegated click listener on `#tabBar`.

Default order: spots → pota → sota → rbn → se → colonies → fd → search → console → config.

## Layout Tab

The **Layout** tab (`data-tab="config"`, `id="configWrapper"`) contains the tab ordering UI:

- List of all tabs in current order with ▲/▼ Move Up / Move Down buttons
- **Save Order** button — persists to localStorage and re-renders the tab bar
- **Reset to Default** button — restores default order, saves, and re-renders
- Confirmation message fades after 2 seconds

Moving a tab up/down re-renders the list immediately for preview; order is not written to localStorage until Save is clicked.

---

# Search All Sources

Global search from toolbar and Search tab. Searches Live Spots, POTA, SOTA, RBN, Special Events (and QRZ cache). Supports callsign, park ref, summit ref, frequency, band, mode, spotter/skimmer, freeform text.

---

# Spot Parsing

Must tolerate variable spacing, missing comments, and formatting differences. Malformed lines must never crash the application.

---

# Not In Scope Yet

* Wanted-call alerts or audio alerts
* 13 Colonies certificate progress, completion percentage, or one-click export
* Award tracking beyond 13 Colonies and Field Day
* Multiple radio support
* User authentication
* Statistics or historical playback
* Bulk QRZ lookup
* Advanced source comparison or complex query language
* Automatic RBN skimmer database download/update
* Skimmer map, heat map, or propagation history
* Skimmer uptime or activity statistics
* ADIF import fallback for dupe check
* Automatic HRD log refresh or file-watch
* Support for logging programs other than HRD in dupe check
* Contest or Field Day-specific dupe logic
* Export dupe-check results
* HRD / JTAlert integration for 13 Colonies or Field Day (beyond dupe check)
* SE sources: QRZ forums, RSS feeds, social media, generic web search
* Special Events drag-and-drop tab reordering in the Layout tab (Move Up/Down is sufficient for v1)
* 1x1 callsign DB if impractical to scrape (non-fatal)

---

# Current Milestone

All items below are implemented in the working prototype:

1. Loads and manages saved spot sources (add/edit/delete/enable/disable).
2. Supports telnet, HTTP, POTA API, SOTA API, and RBN telnet source types.
3. IK4PKL, DX Summit, POTA, and SOTA enabled by default.
4. RBN available but disabled by default; started manually from RBN tab.
5. Connects to enabled sources on Connect; polls HTTP/API sources at configured intervals.
6. Each source parsed independently with its own parser.
7. General spots deduplicated across sources.
8. Live Spots table: sortable, Band/Mode/Source/Freeform/US-only filters, time-desc default.
9. POTA tab: sortable, Band/Mode/Activator/Park/Location/Freeform filters.
10. SOTA tab: sortable, Band/Mode/Activator/Summit/Association/Region/Freeform filters.
11. RBN tab: two-layer filtering (skimmer filter + row filters); Start/Stop buttons in dedicated control bar independent of filter layout.
12. Global Search All Sources from toolbar and Search tab.
13. 13 Colonies tab with 16 stations, worked matrix, spot forwarding, and localStorage persistence.
14. Field Day tab with 7 band sub-tabs + All totals tab, 85-section matrix (official ARRL W/VE list, alpha by code), spot forwarding, Clear button with confirmation, and localStorage persistence.
15. HRD Logbook dupe check: floating panel with manual callsign entry, band/mode/window filter controls (persistent), all-contacts display with selective dupe/worked highlighting, QRZ info integration.
16. Header Dupe Check toggle and Dupe Panel button for quick access.
17. UTC and configurable local clock.
18. QRZ XML lookup (click or ad hoc) with credentials stored server-side.
19. Search All and QRZ lookup inputs visually distinct (blue vs amber themes with ✕ clear buttons).
20. 6m, 2m, and 70cm band/sub-band detection.
21. Source-aware connection status (Gray/Yellow/Green/Orange/Red).
22. Special Events tab: ARRL HTML polling + 425 DX News polling, 7-status classification with date-quality tracking, partial/unknown dates displayed as "Unknown" (never as normal upcoming/active), sortable table with Source column, SE badge in Live Spots, Search All integration, QRZ click support, manual Refresh button (throttled), cached events sent to new WS clients on connect.
23. Layout tab: user-configurable tab order with Move Up/Down buttons, Save Order, and Reset to Default; persisted in localStorage; tab bar rebuilt dynamically on startup and on save.

## Next Milestone

Items not yet implemented:

* VA3RJ DX Calendar source and parser.
* 1x1 callsign DB validation adapter (non-fatal if impractical).
* Multi-source SE deduplication (ARRL vs 425DX by callsign+date).
* Special Events tab: Heard Today section (SE callsigns spotted live today).
* Special Events tab: Source Health section (per-source parse/accept/reject counts).
* HRD worked status integrated into Special Events tab.

The emphasis is on clean, maintainable code that can be expanded in future versions.
