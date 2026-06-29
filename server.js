'use strict';

const net    = require('net');
const http   = require('http');
const https  = require('https');
const path   = require('path');
const fs     = require('fs');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

// --- Constants ---

const PORT = 3000;
const DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000; // 2-hour dedup window covers full HTTP backlog

const RE_LIVE     = /^DX de ([\w\d/\-]+):\s+([\d.]+)\s+([\w\d/\-]+)\s+(.*?)\s+(\d{4}Z)\s*$/;
const RE_HIST     = /^([\d.]+)\s+([\w\d/\-]+)\s+(\d{2}-[A-Za-z]{3}-\d{4})\s+(\d{4}Z)\s+(.*?)\s*<([\w\d/\-]+)>\s*$/;
const RE_HIST_ALT = /^([\d.]+)\s+([\w\d/\-]+)\s+(\d{2}-[A-Za-z]{3}-\d{4})\s+(\d{4}Z)\s+(.*?)\s*\[([\w\d/\-]+)\]\s*$/;
// DX Summit: SPOTTER  FREQ  DXCALL  COMMENT  HHMM  DD  MON  (no year, no Z on time)
const RE_DXSUMMIT = /^(\S+)\s+([\d.]+)\s+(\S+)(.*?)\s+(\d{4})\s+(\d{1,2})\s+([A-Za-z]{3})\s*$/;
// RBN: DX de SKIMMER:  FREQ  HEARDCALL  MODE  SIGNAL dB [SPEED UNIT]  [TYPE]  HHMMZ
// Skimmer callsigns may include -# or -@ suffixes; TYPE (CQ/NCDXF/etc.) is absent on FT8 spots
const RE_RBN = /^DX de ([\w\d\/\-#@]+):\s+([\d.]+)\s+([\w\d\/\-]+)\s+(\w+)\s+(-?\d+)\s+dB(?:\s+(\d+)\s+\w+)?(?:\s+(\w+))?\s+(\d{4}Z)/;
// sh/skimmer response line: CALLSIGN GRID [other fields] — grid is 4- or 6-char Maidenhead
const RE_SKIMMER_LINE = /^([\w\d\/\-#@]+)\s+([A-R][A-R]\d\d(?:[A-X][A-X])?)\b/i;

const BANDS = [
  [1800,   2000,   '160m'],
  [3500,   4000,   '80m'],
  [5330,   5405,   '60m'],
  [7000,   7300,   '40m'],
  [10100,  10150,  '30m'],
  [14000,  14350,  '20m'],
  [18068,  18168,  '17m'],
  [21000,  21450,  '15m'],
  [24890,  24990,  '12m'],
  [28000,  29700,  '10m'],
  [50000,  54000,  '6m'],
  [144000, 148000, '2m'],
  [420000, 450000, '70cm'],
];

const FT8_FREQS = [1840, 3573, 5357, 7074, 10136, 14074, 18100, 21074, 24915, 28074, 50313, 144174, 432174];
const FT4_FREQS = [3575, 7047, 10140, 14080, 18104, 21140, 24919, 28180, 50318, 144170, 432170];
const DIG_TOL   = 3;

const CW_RANGES = [
  [1800,   1840],   [3500,   3600],   [7000,   7125],
  [10100,  10150],  [14000,  14150],  [18068,  18110],
  [21000,  21200],  [24890,  24930],  [28000,  28300],
  [50000,  50100],  [144000, 144100], [420000, 432100],
];

const PHONE_RANGES = [
  [1840,   2000],   [3600,   4000],   [5330,   5405],
  [7125,   7300],   [14150,  14350],  [18110,  18168],
  [21200,  21450],  [24930,  24990],  [28300,  29700],
  [50100,  54000],  [144200, 148000], [432200, 450000],
];

// --- Pure utilities ---

function stripTelnetIAC(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] === 0xFF && i + 2 < buf.length) { i += 3; }
    else { out.push(buf[i]); i++; }
  }
  return Buffer.from(out);
}

function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function freqToBand(freqKhz) {
  const f = parseFloat(freqKhz);
  for (const [lo, hi, name] of BANDS) {
    if (f >= lo && f <= hi) return name;
  }
  return 'unknown';
}

function detectMode(comment, freqKhz) {
  if (comment) {
    const c = comment.toUpperCase();
    if (/\bFT8\b/.test(c))           return 'FT8';
    if (/\bFT4\b/.test(c))           return 'FT4';
    if (/RTTY|PSK|JS8|DIGI/.test(c)) return 'Digital';
    if (/\bCW\b/.test(c))            return 'CW';
    if (/SSB|USB|LSB|PHONE/.test(c)) return 'Voice';
  }
  const f = parseFloat(freqKhz);
  if (isNaN(f)) return 'Unknown';
  if (FT8_FREQS.some(wh => Math.abs(f - wh) <= DIG_TOL)) return 'FT8';
  if (FT4_FREQS.some(wh => Math.abs(f - wh) <= DIG_TOL)) return 'FT4';
  if (CW_RANGES.some(([lo, hi]) => f >= lo && f <= hi))   return 'CW';
  if (PHONE_RANGES.some(([lo, hi]) => f >= lo && f <= hi)) return 'Voice';
  return 'Unknown';
}

// --- Spot parsing ---

function buildSpot(freq, call, date, time, comment, spotter, raw) {
  return {
    freq,
    call:    call.trim(),
    date:    date || '',
    time:    time || '',
    comment: (comment || '').trim(),
    spotter: (spotter || '').trim(),
    band:    freqToBand(freq),
    mode:    detectMode(comment, freq),
    raw:     raw.trim(),
  };
}

function tryParseSpot(line) {
  try {
    let m = RE_LIVE.exec(line);
    if (m) {
      const [, spotter, freq, call, comment, time] = m;
      return buildSpot(freq, call, '', time, comment, spotter, line);
    }
    m = RE_HIST.exec(line);
    if (m) {
      const [, freq, call, date, time, comment, spotter] = m;
      return buildSpot(freq, call, date, time, comment, spotter, line);
    }
    m = RE_HIST_ALT.exec(line);
    if (m) {
      const [, freq, call, date, time, comment, spotter] = m;
      return buildSpot(freq, call, date, time, comment, spotter, line);
    }
    m = RE_DXSUMMIT.exec(line);
    if (m) {
      const [, spotter, freq, call, comment, time, day, mon] = m;
      const year = new Date().getUTCFullYear();
      const date = `${day.padStart(2, '0')}-${mon}-${year}`;
      return buildSpot(freq, call, date, time + 'Z', comment.trim(), spotter, line);
    }
  } catch (_) {}
  return null;
}

// --- Multi-source state ---

// sourceStates: name -> { type, config, socket?, buffer?, loginTimer?, pollTimer?, status }
const sourceStates = new Map();

// recentSpots: dedupeKey -> spot (for cross-source dedup within DEDUP_WINDOW_MS)
const recentSpots = new Map();
let spotSeq = 0;
let rbnSeq  = 0;

// Special Events cache — one entry per source, merged for broadcast
const specialEventsBySource = new Map(); // srcName -> normalized event[]
let specialEvents = [];
let specialEventsLastRefresh = 0;

// Propagation data cache (HamQSL solar XML)
let propData = null;
let propLastFetch = 0;
const PROP_POLL_MS = 15 * 60 * 1000; // 15 minutes

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_IDX   = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};

// Convert DD/MM date (425DX format) to "Mon D" string (client-compatible)
function dmToMonDay(ddmm) {
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec((ddmm || '').trim());
  if (!m) return '';
  const day = parseInt(m[1], 10);
  const mo  = parseInt(m[2], 10) - 1;
  if (mo < 0 || mo > 11 || day < 1 || day > 31) return '';
  return `${MONTH_ABBR[mo]} ${day}`;
}

// Convert "Mon D" display date to an ISO date string for sorting.
// Bumps to next year if the date is more than 6 months in the past.
function isoFromDisplayDate(str) {
  const m = /([A-Za-z]{3})\s+(\d+)/i.exec(String(str || '').trim());
  if (!m) return null;
  const mo = MONTH_IDX[m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()];
  if (mo === undefined) return null;
  const now  = new Date();
  const year = now.getUTCFullYear();
  const day  = parseInt(m[2], 10);
  let d = new Date(Date.UTC(year, mo, day));
  if (d < new Date(now.getTime() - 180 * 86400000)) d = new Date(Date.UTC(year + 1, mo, day));
  return d.toISOString().slice(0, 10);
}

// Compute date quality metadata for a normalized event record
function computeDateFields(startDate, endDate) {
  const hasStart = !!isoFromDisplayDate(startDate);
  const hasEnd   = !!isoFromDisplayDate(endDate);
  let dateQuality, dateWarning, sortStartUtc;
  if (hasStart && hasEnd) {
    dateQuality  = 'Exact';
    dateWarning  = '';
    sortStartUtc = isoFromDisplayDate(startDate);
  } else if (!hasStart && hasEnd) {
    dateQuality  = 'Partial';
    dateWarning  = 'Start date not listed';
    sortStartUtc = isoFromDisplayDate(endDate);
  } else if (hasStart && !hasEnd) {
    dateQuality  = 'Partial';
    dateWarning  = 'End date not listed';
    sortStartUtc = isoFromDisplayDate(startDate);
  } else {
    dateQuality  = 'Unknown';
    dateWarning  = 'No dates listed';
    sortStartUtc = '9999-12-31';
  }
  return { dateQuality, dateWarning, sortStartUtc };
}

// Merge events from all sources, deduplicate by callSign+startDate key.
// Source priority: Manual (1.00) → ARRL (0.95) → VA3RJ (0.90) → 425DX (0.85) → 1x1 (0.75)
// Higher confidence wins; lower-confidence sources kept as supplemental only.
function mergeAllSpecialEvents() {
  const seen = new Map();
  // Sort sources by descending confidence so highest-quality record wins
  const ordered = [];
  for (const [name, evs] of specialEventsBySource) {
    const conf = evs.length ? (evs[0].confidence || 0) : 0;
    ordered.push({ evs, conf });
  }
  ordered.sort((a, b) => b.conf - a.conf);
  for (const { evs } of ordered) {
    for (const ev of evs) {
      const key = `${(ev.callSign || '').toUpperCase()}:${ev.startDate || ev.endDate || ''}`;
      if (!seen.has(key)) seen.set(key, ev);
    }
  }
  // Sort by sortStartUtc ascending so clients receive a predictable order
  return [...seen.values()].sort((a, b) =>
    (a.sortStartUtc || '9999-12-31').localeCompare(b.sortStartUtc || '9999-12-31')
  );
}

// Purge stale dedup entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  for (const [key, spot] of recentSpots) {
    if (spot._receivedAt < cutoff) recentSpots.delete(key);
  }
}, 5 * 60 * 1000);

function makeDedupeKey(call, spotter, freq) {
  const bucket = Math.round(parseFloat(freq) / 0.5) * 0.5;
  return `${call.toUpperCase()}:${spotter.toUpperCase()}:${bucket}`;
}

// --- WebSocket broadcast ---

let wss = null;

function broadcast(obj) {
  if (!wss) return;
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch (_) {}
    }
  }
}

// --- Spot handling (dedup + broadcast) ---

// Returns: 'new' | 'merged' | 'dup' | null
function handleRawSpot(rawLine, sourceName) {
  const parsed = tryParseSpot(rawLine);
  if (!parsed) return null;

  const key = makeDedupeKey(parsed.call, parsed.spotter, parsed.freq);
  const now = Date.now();
  const existing = recentSpots.get(key);

  if (existing && now - existing._receivedAt < DEDUP_WINDOW_MS) {
    if (!existing.sources.includes(sourceName)) {
      existing.sources.push(sourceName);
      existing.rawLines.push(rawLine.trim());
      broadcast({ type: 'spot_update', data: { id: existing.id, sources: existing.sources } });
      return 'merged';
    }
    return 'dup';
  }

  const spot = {
    id:          ++spotSeq,
    ...parsed,
    sources:     [sourceName],
    rawLines:    [rawLine.trim()],
    _receivedAt: now,
  };
  recentSpots.set(key, spot);

  const { _receivedAt, ...publicSpot } = spot;
  broadcast({ type: 'spot', data: publicSpot });
  return 'new';
}

// --- Composite status ---

function getCompositeStatus() {
  if (sourceStates.size === 0) {
    return { status: 'disconnected', connected: [], running: [] };
  }

  const connected = [];
  const errored   = [];
  let hasLive = false, hasError = false, hasConnecting = false;

  for (const [name, src] of sourceStates) {
    if (src.status === 'live')                                              { hasLive = true; connected.push(name); }
    if (src.status === 'error')                                             { hasError = true; errored.push(name); }
    if (['connecting', 'logging_in', 'polling'].includes(src.status))        hasConnecting = true;
  }

  let status;
  if      (hasLive && !hasError) status = 'connected';
  else if (hasLive && hasError)  status = 'partial';
  else if (hasError && !hasLive) status = 'error';
  else if (hasConnecting)        status = 'connecting';
  else                           status = 'disconnected';

  return { status, connected, errored, running: [...sourceStates.keys()] };
}

function broadcastCompositeStatus() {
  broadcast({ type: 'status', data: getCompositeStatus() });
}

// --- Stop all sources ---

function stopAllSources() {
  for (const [, src] of sourceStates) {
    if (src.type === 'telnet') {
      if (src.loginTimer) { clearTimeout(src.loginTimer); src.loginTimer = null; }
      if (src.socket)     { src.socket.destroy(); src.socket = null; }
    } else if (src.type === 'http' || src.type === 'pota-api' || src.type === 'sota-api' || src.type === 'special-events-html' || src.type === '425dx-se') {
      if (src.pollTimer)  { clearTimeout(src.pollTimer); src.pollTimer = null; }
    } else if (src.type === 'rbn-telnet') {
      if (src.loginTimer)      { clearTimeout(src.loginTimer); src.loginTimer = null; }
      if (src.skimmerTimeout)  { clearTimeout(src.skimmerTimeout); src.skimmerTimeout = null; }
      if (src.skimmerInterval) { clearInterval(src.skimmerInterval); src.skimmerInterval = null; }
      if (src.socket)          { src.socket.destroy(); src.socket = null; }
    }
  }
  sourceStates.clear();
  broadcastCompositeStatus();
}

// --- Telnet source ---

function sendHistoryCommandFor(srcName) {
  const src = sourceStates.get(srcName);
  if (!src || src.status !== 'logging_in') return;
  src.status = 'live';
  broadcastCompositeStatus();
  if (src.socket) src.socket.write('sh/dx 100\r\n');
}

function advanceLoginStateFor(srcName, line) {
  const src = sourceStates.get(srcName);
  if (!src || src.status !== 'logging_in') return;
  if (/login:|call\s*sign:|Please enter your call/i.test(line)) {
    src.socket.write(src.callsign + '\r\n');
    return;
  }
  if (/dxspider\s*>|de\s+\w+-\d+/i.test(line)) {
    if (src.loginTimer) { clearTimeout(src.loginTimer); src.loginTimer = null; }
    sendHistoryCommandFor(srcName);
  }
}

function onTelnetData(srcName, chunk) {
  const src = sourceStates.get(srcName);
  if (!src) return;

  const clean = stripTelnetIAC(chunk);
  src.buffer += clean.toString('latin1');

  const lines = src.buffer.split('\n');
  src.buffer = lines.pop();

  for (const rawLine of lines) {
    const trimmed = stripAnsi(rawLine.replace(/\r/g, '')).trim();
    if (!trimmed) continue;

    let parsed = false;
    if (src.status === 'logging_in') {
      advanceLoginStateFor(srcName, trimmed);
    } else if (src.status === 'live') {
      const spot = tryParseSpot(trimmed);
      if (spot) {
        parsed = true;
        handleRawSpot(trimmed, srcName);
      }
    }
    broadcast({ type: 'console', data: { line: trimmed, parsed, source: srcName } });
  }
}

function openTelnetSource(config, callsign) {
  const srcName = config.name;
  sourceStates.set(srcName, {
    type: 'telnet', config, callsign,
    socket: null, buffer: '', loginTimer: null, status: 'connecting',
  });
  broadcastCompositeStatus();

  const sock = net.createConnection({ host: config.host, port: config.port }, () => {
    const src = sourceStates.get(srcName);
    if (!src) return;
    src.status = 'logging_in';
    src.loginTimer = setTimeout(() => {
      src.loginTimer = null;
      if (src && src.status === 'logging_in') {
        sock.write(callsign + '\r\n');
        setTimeout(() => sendHistoryCommandFor(srcName), 1500);
      }
    }, 3000);
  });

  sock.on('data', (chunk) => onTelnetData(srcName, chunk));

  sock.on('error', (err) => {
    broadcast({ type: 'error', data: { message: `${srcName}: ${err.message}` } });
    const src = sourceStates.get(srcName);
    if (src) {
      if (src.loginTimer) { clearTimeout(src.loginTimer); src.loginTimer = null; }
      src.socket = null;
      src.status = 'error';
    }
    broadcastCompositeStatus();
  });

  sock.on('close', () => {
    const src = sourceStates.get(srcName);
    if (src && src.status !== 'idle') {
      if (src.loginTimer) { clearTimeout(src.loginTimer); src.loginTimer = null; }
      src.socket = null;
      src.status = 'error';
      broadcastCompositeStatus();
    }
  });

  sourceStates.get(srcName).socket = sock;
}

// --- HTTP source ---

function httpGet(url, extraHeaders = {}) {
  const mod = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const opts = {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DXSpots/1.0)', ...extraHeaders },
    };
    const req = mod.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, extraHeaders).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP request timed out')); });
  });
}

function httpLog(srcName, text) {
  broadcast({ type: 'console', data: { line: text, parsed: false, source: srcName, http: true } });
}

async function pollHttpSource(srcName) {
  const src = sourceStates.get(srcName);
  if (!src || src.type !== 'http') return;

  try {
    const body = await httpGet(src.config.url);
    const text = stripHtml(body);
    const candidates = text.split('\n').map(l => l.trim()).filter(l => l.length > 8);

    httpLog(srcName, `Fetched ${body.length} bytes → ${candidates.length} candidate lines`);

    // Show first 8 raw lines so format is visible in Console tab
    for (const line of candidates.slice(0, 8)) {
      httpLog(srcName, `  ${line}`);
    }
    if (candidates.length > 8) httpLog(srcName, `  … (${candidates.length - 8} more lines)`);

    let newCount = 0, mergedCount = 0, unparsed = 0;
    for (const line of candidates) {
      const result = handleRawSpot(line, srcName);
      if      (result === 'new')    newCount++;
      else if (result === 'merged') mergedCount++;
      else if (result === null)     unparsed++;
    }

    httpLog(srcName, `Poll done: ${newCount} new, ${mergedCount} merged, ${unparsed} unparsed/dup`);
    src.status = 'live';
    broadcastCompositeStatus();
  } catch (e) {
    src.status = 'error';
    broadcast({ type: 'error', data: { message: `${srcName}: ${e.message}` } });
    broadcastCompositeStatus();
  }
}

function scheduleHttpPoll(srcName) {
  const src = sourceStates.get(srcName);
  if (!src || src.type !== 'http') return;
  const intervalMs = (src.config.pollSeconds || 60) * 1000;
  src.pollTimer = setTimeout(async () => {
    await pollHttpSource(srcName);
    scheduleHttpPoll(srcName);
  }, intervalMs);
}

function startHttpSource(config) {
  const srcName = config.name;
  sourceStates.set(srcName, {
    type: 'http', config,
    pollTimer: null, status: 'polling',
  });
  broadcastCompositeStatus();
  pollHttpSource(srcName).then(() => scheduleHttpPoll(srcName));
}

// --- POTA API source ---

function parsePotaSpot(raw, srcName) {
  try {
    const freqNum = parseFloat(raw.frequency);   // POTA API returns kHz
    if (isNaN(freqNum) || freqNum <= 0) return null;
    const freqKhz = String(freqNum.toFixed(1));
    const months  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const rawTime = raw.spotTime || '';
    const dt      = rawTime ? new Date(rawTime.endsWith('Z') ? rawTime : rawTime + 'Z') : new Date();
    const time    = `${String(dt.getUTCHours()).padStart(2,'0')}${String(dt.getUTCMinutes()).padStart(2,'0')}Z`;
    const date    = `${String(dt.getUTCDate()).padStart(2,'0')}-${months[dt.getUTCMonth()]}-${dt.getUTCFullYear()}`;

    return {
      spotId:   raw.spotId,
      activator:(raw.activator  || '').trim(),
      frequency: raw.frequency  || '',
      freq:      freqKhz,
      band:      freqToBand(freqKhz),
      mode:      detectMode(raw.mode || raw.comments || '', freqKhz),
      reference:(raw.reference  || '').trim(),
      parkName: (raw.name || raw.parkName || '').trim(),
      location: (raw.locationDesc || '').trim(),
      spotTime:  rawTime,
      time,
      date,
      comments: (raw.comments   || '').trim(),
      spotter:  (raw.spotter    || '').trim(),
      source:    srcName,
    };
  } catch (_) {
    return null;
  }
}

async function pollPotaSource(srcName) {
  const src = sourceStates.get(srcName);
  if (!src || src.type !== 'pota-api') return;
  try {
    const body     = await httpGet(src.config.url);
    const rawSpots = JSON.parse(body);
    if (!Array.isArray(rawSpots)) throw new Error('POTA API did not return an array');
    httpLog(srcName, `Fetched ${rawSpots.length} active POTA spots`);
    if (rawSpots.length > 0) httpLog(srcName, `  RAW[0]: ${JSON.stringify(rawSpots[0])}`);
    const parsed = rawSpots.map(r => parsePotaSpot(r, srcName)).filter(Boolean);
    httpLog(srcName, `Parsed ${parsed.length} valid POTA spots`);
    broadcast({ type: 'pota_refresh', data: parsed });
    src.status = 'live';
    broadcastCompositeStatus();
  } catch (e) {
    src.status = 'error';
    broadcast({ type: 'error', data: { message: `${srcName}: ${e.message}` } });
    broadcastCompositeStatus();
  }
}

function schedulePotaPoll(srcName) {
  const src = sourceStates.get(srcName);
  if (!src || src.type !== 'pota-api') return;
  const intervalMs = (src.config.pollSeconds || 60) * 1000;
  src.pollTimer = setTimeout(async () => {
    await pollPotaSource(srcName);
    schedulePotaPoll(srcName);
  }, intervalMs);
}

function startPotaSource(config) {
  const srcName = config.name;
  sourceStates.set(srcName, { type: 'pota-api', config, pollTimer: null, status: 'polling' });
  broadcastCompositeStatus();
  pollPotaSource(srcName).then(() => schedulePotaPoll(srcName));
}

// --- SOTA API source ---

function parseSotaSpot(raw, srcName) {
  try {
    const freqMhz = parseFloat(raw.frequency);
    if (isNaN(freqMhz) || freqMhz <= 0) return null;
    const freqKhz  = String((freqMhz * 1000).toFixed(1));
    const months   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const rawTime  = raw.timeStamp || raw.timestamp || '';
    const dt       = rawTime ? new Date(rawTime.endsWith('Z') ? rawTime : rawTime + 'Z') : new Date();
    const time     = `${String(dt.getUTCHours()).padStart(2,'0')}${String(dt.getUTCMinutes()).padStart(2,'0')}Z`;
    const date     = `${String(dt.getUTCDate()).padStart(2,'0')}-${months[dt.getUTCMonth()]}-${dt.getUTCFullYear()}`;
    const summitShort = (raw.summitCode || '').trim();
    const assoc       = (raw.associationCode || '').trim();
    const summit      = assoc && summitShort ? `${assoc}/${summitShort}` : summitShort;
    // summitDetails is a plain string like "Gehrenberg, 754m, 8 points"
    const summitDetailsStr = typeof raw.summitDetails === 'string' ? raw.summitDetails : '';
    const summitName  = (raw.summitName || summitDetailsStr.split(',')[0] || '').trim();
    const region      = (raw.regionCode || '').trim();
    return {
      spotId:      raw.id,
      activator:   (raw.activatorCallsign || raw.callsign || '').trim(),
      spotter:     (raw.callsign || '').trim(),
      frequency:   raw.frequency || '',
      freq:        freqKhz,
      band:        freqToBand(freqKhz),
      mode:        detectMode(raw.mode || raw.comments || '', freqKhz),
      summit,
      summitName,
      association: assoc,
      region,
      spotTime:    rawTime,
      time,
      date,
      comments:    (raw.comments || '').trim(),
      source:      srcName,
    };
  } catch (_) { return null; }
}

async function pollSotaSource(srcName) {
  const src = sourceStates.get(srcName);
  if (!src || src.type !== 'sota-api') return;
  httpLog(srcName, `Polling ${src.config.url}…`);
  try {
    const body     = await httpGet(src.config.url);
    const rawSpots = JSON.parse(body);
    if (!Array.isArray(rawSpots)) throw new Error('SOTA API did not return an array');
    httpLog(srcName, `Fetched ${rawSpots.length} SOTA spots`);
    if (rawSpots.length > 0) httpLog(srcName, `  RAW[0]: ${JSON.stringify(rawSpots[0])}`);
    const parsed = rawSpots.map(r => parseSotaSpot(r, srcName)).filter(Boolean);
    httpLog(srcName, `Parsed ${parsed.length} valid SOTA spots`);
    broadcast({ type: 'sota_refresh', data: parsed });
    src.status = 'live';
    broadcastCompositeStatus();
  } catch (e) {
    src.status = 'error';
    broadcast({ type: 'error', data: { message: `${srcName}: ${e.message}` } });
    broadcastCompositeStatus();
  }
}

function scheduleSotaPoll(srcName) {
  const src = sourceStates.get(srcName);
  if (!src || src.type !== 'sota-api') return;
  const intervalMs = (src.config.pollSeconds || 60) * 1000;
  src.pollTimer = setTimeout(async () => { await pollSotaSource(srcName); scheduleSotaPoll(srcName); }, intervalMs);
}

function startSotaSource(config) {
  const srcName = config.name;
  sourceStates.set(srcName, { type: 'sota-api', config, pollTimer: null, status: 'polling' });
  broadcastCompositeStatus();
  pollSotaSource(srcName).then(() => scheduleSotaPoll(srcName));
}

// --- RBN telnet source ---

function parseRbnSpot(line, srcName) {
  const m = RE_RBN.exec(line);
  if (!m) return null;
  const [, skimmer, freq, heardCall, mode, signalDb, speed, type, time] = m;
  const now = new Date();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return {
    id:          ++rbnSeq,
    heardCall:   heardCall.trim(),
    freq,
    band:        freqToBand(freq),
    mode:        detectMode(mode, freq),
    signalDb:    parseInt(signalDb, 10),
    speed:       speed ? parseInt(speed, 10) : null,
    type:        (type || '').trim(),
    skimmerCall: skimmer.replace(/-[#@]\d*$/, '').trim(),
    time,
    spotTime:    now.toISOString(),
    source:      srcName || '',
    raw:         line.trim(),
  };
}

function advanceRbnLoginFor(srcName, line) {
  const src = sourceStates.get(srcName);
  if (!src || src.status !== 'logging_in') return;
  if (/login:|call\s*sign:|please enter your call/i.test(line)) {
    src.socket.write(src.callsign + '\r\n');
    setTimeout(() => {
      const s = sourceStates.get(srcName);
      if (s && s.status === 'logging_in') setRbnLive(srcName);
    }, 1500);
  }
}

function setRbnLive(srcName) {
  const src = sourceStates.get(srcName);
  if (!src || src.status === 'live') return;
  src.status = 'live';
  broadcastCompositeStatus();
  setTimeout(() => issueShSkimmer(srcName), 2000);
  src.skimmerInterval = setInterval(() => issueShSkimmer(srcName), 3600000);
}

function issueShSkimmer(srcName) {
  const src = sourceStates.get(srcName);
  if (!src || !src.socket || src.status !== 'live') return;
  src.inSkimmerList = true;
  src.skimmerBuf = [];
  if (src.skimmerTimeout) { clearTimeout(src.skimmerTimeout); src.skimmerTimeout = null; }
  src.socket.write('sh/skimmer\r\n');
  broadcast({ type: 'console', data: { line: 'Issuing sh/skimmer…', parsed: false, source: srcName } });
  src.skimmerTimeout = setTimeout(() => {
    const s = sourceStates.get(srcName);
    if (s && s.inSkimmerList) {
      s.inSkimmerList = false;
      s.skimmerTimeout = null;
      processSkimmerList(srcName, s.skimmerBuf || []);
      s.skimmerBuf = [];
    }
  }, 10000);
}

function processSkimmerList(srcName, entries) {
  if (!entries.length) return;
  httpLog(srcName, `sh/skimmer: received ${entries.length} skimmer entries`);
  broadcast({ type: 'skimmer_list', data: entries });
}

function onRbnData(srcName, chunk) {
  const src = sourceStates.get(srcName);
  if (!src) return;
  const clean = stripTelnetIAC(chunk);
  src.buffer += clean.toString('latin1');
  const lines = src.buffer.split('\n');
  src.buffer  = lines.pop();
  for (const rawLine of lines) {
    const trimmed = stripAnsi(rawLine.replace(/\r/g, '')).trim();
    if (!trimmed) continue;
    if (src.status === 'logging_in') advanceRbnLoginFor(srcName, trimmed);
    if (src.inSkimmerList) {
      const sm = RE_SKIMMER_LINE.exec(trimmed);
      if (sm) {
        src.skimmerBuf.push({ call: sm[1].toUpperCase(), grid: sm[2].toUpperCase() });
      } else if (RE_RBN.test(trimmed)) {
        if (src.skimmerTimeout) { clearTimeout(src.skimmerTimeout); src.skimmerTimeout = null; }
        src.inSkimmerList = false;
        processSkimmerList(srcName, src.skimmerBuf || []);
        src.skimmerBuf = [];
      }
    }
    const spot = parseRbnSpot(trimmed, srcName);
    if (spot) {
      if (src.status === 'logging_in') setRbnLive(srcName);
      broadcast({ type: 'rbn_spot', data: spot });
    }
    broadcast({ type: 'console', data: { line: trimmed, parsed: !!spot, source: srcName } });
  }
}

function openRbnSource(config, callsign) {
  const srcName = config.name;
  sourceStates.set(srcName, {
    type: 'rbn-telnet', config, callsign,
    socket: null, buffer: '', loginTimer: null, status: 'connecting',
    inSkimmerList: false, skimmerBuf: [], skimmerTimeout: null, skimmerInterval: null,
  });
  broadcastCompositeStatus();
  broadcast({ type: 'console', data: { line: `Connecting to ${config.host}:${config.port}…`, parsed: false, source: srcName } });

  const sock = net.createConnection({ host: config.host, port: config.port }, () => {
    const src = sourceStates.get(srcName);
    if (!src) return;
    src.status = 'logging_in';
    broadcast({ type: 'console', data: { line: `TCP connected — waiting for login prompt…`, parsed: false, source: srcName } });
    src.loginTimer = setTimeout(() => {
      src.loginTimer = null;
      if (src && src.status === 'logging_in') {
        broadcast({ type: 'console', data: { line: `No prompt received — sending callsign ${callsign}`, parsed: false, source: srcName } });
        sock.write(callsign + '\r\n');
        setTimeout(() => {
          const s = sourceStates.get(srcName);
          if (s && s.status === 'logging_in') setRbnLive(srcName);
        }, 1500);
      }
    }, 3000);
  });

  sock.setTimeout(30000);
  sock.on('timeout', () => {
    broadcast({ type: 'console', data: { line: `Connection timed out`, parsed: false, source: srcName } });
    sock.destroy();
  });
  sock.on('data', (chunk) => onRbnData(srcName, chunk));
  sock.on('error', (err) => {
    broadcast({ type: 'error', data: { message: `${srcName}: ${err.message}` } });
    const src = sourceStates.get(srcName);
    if (src) { if (src.loginTimer) { clearTimeout(src.loginTimer); src.loginTimer = null; } src.socket = null; src.status = 'error'; }
    broadcastCompositeStatus();
  });
  sock.on('close', () => {
    const src = sourceStates.get(srcName);
    if (src && src.status !== 'idle') {
      if (src.loginTimer) { clearTimeout(src.loginTimer); src.loginTimer = null; }
      src.socket = null; src.status = 'error';
      broadcastCompositeStatus();
    }
  });
  sourceStates.get(srcName).socket = sock;
}

// --- Special Events (ARRL HTML) ---

const ARRL_BASE_URL = 'https://www.arrl.org/special_events/search/page:PAGENUM/model:Event';

function parseSingleSpecialEvent(liHtml, srcName) {
  try {
    // Title from <h3>
    const h3m = /<h3>([\s\S]*?)<\/h3>/i.exec(liHtml);
    if (!h3m) return null;
    const titleClean = h3m[1]
      .replace(/<span>[^<]*<\/span>/gi, '')
      .replace(/<[^>]+>/g, '')
      .trim();

    // <p> body
    const pm = /<p>([\s\S]*?)<\/p>/i.exec(liHtml);
    if (!pm) return null;
    const pHtml = pm[1];

    // Bold section: "Jun 6-Jun 7, 1400Z-1830Z, K8E"
    const boldM = /<[Bb]>([\s\S]*?)<\/[Bb]>/i.exec(pHtml);
    let startDate = '', endDate = '', startTimeUtc = '', endTimeUtc = '', callSign = '';
    if (boldM) {
      const bParts = boldM[1].split(',').map(s => s.trim());
      // Date range: "Jun 6-Jun 7" — split at digit-dash-letter boundary
      if (bParts[0]) {
        const di = bParts[0].search(/\d-[A-Za-z]/);
        startDate = di >= 0 ? bParts[0].slice(0, di + 1).trim() : bParts[0].trim();
        endDate   = di >= 0 ? bParts[0].slice(di + 2).trim()    : bParts[0].trim();
      }
      // Time range: "1400Z-1830Z"
      if (bParts[1]) {
        const tp = bParts[1].split('-');
        startTimeUtc = tp[0] ? tp[0].trim() : '';
        endTimeUtc   = tp[1] ? tp[1].trim() : '';
      }
      callSign = bParts[2] ? bParts[2].trim().toUpperCase() : '';
    }

    // Website from anchor
    const ancM = /<[Aa]\s[^>]*[Hh][Rr][Ee][Ff]="([^"]*)"[^>]*>([\s\S]*?)<\/[Aa]>/i.exec(pHtml);
    let website = '';
    if (ancM) {
      const href = ancM[1].trim();
      if (!href.startsWith('mailto:') && href.length > 0) website = href;
      if (!website) {
        const vis = ancM[2].replace(/<[^>]+>/g, '').trim();
        if (vis && !/^mailto:/i.test(vis) && /\.\w{2,4}/.test(vis)) website = vis;
      }
    }

    // Plain text after </B>
    const afterBoldHtml = pHtml.replace(/^[\s\S]*?<\/[Bb]>/i, '');
    const bodyText = afterBoldHtml
      .replace(/<[Aa][^>]*>[\s\S]*?<\/[Aa]>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
      .replace(/\s+/g, ' ').trim()
      .replace(/^,\s*/, '');

    // Location: first sentence (first '. ' boundary, not a decimal in a number)
    let city = '', state = '', locationText = '';
    let dotIdx = -1;
    for (let i = 0; i < bodyText.length - 1; i++) {
      if (bodyText[i] === '.' && bodyText[i + 1] === ' ') {
        const prev = bodyText[i - 1] || '';
        const next = bodyText[i + 2] || '';
        if (/\d/.test(prev) && /\d/.test(next)) continue; // decimal in number
        dotIdx = i; break;
      }
    }
    if (dotIdx > 0) {
      locationText = bodyText.slice(0, dotIdx).trim();
      const lp = locationText.split(',').map(s => s.trim());
      city  = lp[0] || '';
      state = lp[1] || '';
    }

    // Frequencies (MHz-format decimals in plausible ham range 1–2999 MHz)
    const freqMs = bodyText.match(/\b\d{1,4}\.\d{2,4}\b/g) || [];
    const frequencies = freqMs.filter(f => {
      const mhz = parseFloat(f);
      return mhz >= 1 && mhz <= 2999;
    });
    const bands = [...new Set(
      frequencies.map(f => freqToBand(parseFloat(f) * 1000)).filter(b => b !== 'unknown')
    )];

    const qslInfo         = /\bQSL\b/i.test(bodyText)         ? 'QSL'         : '';
    const certificateInfo = /\bCertificate\b/i.test(bodyText) ? 'Certificate' : '';

    const rawText = liHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const eventId = ([callSign, startDate, endDate].filter(Boolean).join('_') ||
                    `se_${Date.now()}_${Math.random().toString(36).slice(2)}`).replace(/\s+/g, '_');

    const { dateQuality, dateWarning, sortStartUtc } = computeDateFields(startDate, endDate);
    return {
      eventId, title: titleClean, callSign,
      startDate, endDate, startTimeUtc, endTimeUtc,
      city, state, locationText,
      frequencies, bands,
      qslInfo, certificateInfo,
      website, description: bodyText,
      source: srcName, rawText,
      confidence: 0.95,
      dateQuality, dateWarning, sortStartUtc,
      lastUpdated: Date.now(),
    };
  } catch (_) { return null; }
}

function parseArrlSpecialEventsPage(html, srcName) {
  const events = [];
  // Use index-based extraction to avoid lazy regex stopping at first nested </div>
  const list2Idx = html.indexOf('class="list2"');
  if (list2Idx < 0) return events;
  const ulStart = html.indexOf('<ul>', list2Idx);
  if (ulStart < 0) return events;
  const ulEnd = html.indexOf('</ul>', ulStart);
  if (ulEnd < 0) return events;
  const ulHtml = html.slice(ulStart + 4, ulEnd);
  const liRe = /<li>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(ulHtml)) !== null) {
    const ev = parseSingleSpecialEvent(m[1], srcName);
    if (ev && ev.callSign) events.push(ev);
  }
  return events;
}

function getArrlPageCount(html, maxPages) {
  const totM = /Results\s+\d+\s+to\s+\d+\s+of\s+(\d+)/i.exec(html);
  if (!totM) return 1;
  return Math.min(Math.ceil(parseInt(totM[1], 10) / 8), maxPages);
}

async function pollSpecialEventsSource(srcName) {
  const src = sourceStates.get(srcName);
  if (!src || src.type !== 'special-events-html') return;

  const maxPages = src.config.maxPages || 10;
  const page1Url = (src.config.url || ARRL_BASE_URL).replace('PAGENUM', '1');

  try {
    httpLog(srcName, `Fetching ARRL Special Events page 1…`);
    const page1Html = await httpGet(page1Url);
    const totalPages = getArrlPageCount(page1Html, maxPages);
    httpLog(srcName, `${totalPages} page(s) to fetch`);

    let allEvents = parseArrlSpecialEventsPage(page1Html, srcName);
    httpLog(srcName, `Page 1: ${allEvents.length} events`);

    for (let p = 2; p <= totalPages; p++) {
      try {
        await new Promise(r => setTimeout(r, 1500)); // polite delay
        const pageUrl = ARRL_BASE_URL.replace('PAGENUM', p);
        httpLog(srcName, `Fetching page ${p}…`);
        const pageHtml = await httpGet(pageUrl);
        const pageEvents = parseArrlSpecialEventsPage(pageHtml, srcName);
        httpLog(srcName, `Page ${p}: ${pageEvents.length} events`);
        allEvents = allEvents.concat(pageEvents);
      } catch (e) {
        httpLog(srcName, `Page ${p} error: ${e.message}`);
      }
    }

    // Deduplicate by eventId
    const seen = new Set();
    const deduped = allEvents.filter(e => {
      if (seen.has(e.eventId)) return false;
      seen.add(e.eventId); return true;
    });

    httpLog(srcName, `Total: ${deduped.length} events`);
    specialEventsBySource.set(srcName, deduped);
    specialEvents = mergeAllSpecialEvents();
    specialEventsLastRefresh = Date.now();
    broadcast({ type: 'special_events_refresh', data: { events: specialEvents, lastRefresh: specialEventsLastRefresh } });
    src.status = 'live';
    broadcastCompositeStatus();
  } catch (e) {
    src.status = 'error';
    broadcast({ type: 'error', data: { message: `${srcName}: ${e.message}` } });
    broadcastCompositeStatus();
  }
}

function scheduleSpecialEventsPoll(srcName) {
  const src = sourceStates.get(srcName);
  if (!src || src.type !== 'special-events-html') return;
  const intervalMs = (src.config.pollSeconds || 21600) * 1000;
  src.pollTimer = setTimeout(async () => {
    await pollSpecialEventsSource(srcName);
    scheduleSpecialEventsPoll(srcName);
  }, intervalMs);
}

function startSpecialEventsSource(config) {
  const srcName = config.name;
  sourceStates.set(srcName, { type: 'special-events-html', config, pollTimer: null, status: 'polling' });
  broadcast({ type: 'se_loading', data: { source: srcName } });
  broadcastCompositeStatus();
  pollSpecialEventsSource(srcName).then(() => scheduleSpecialEventsPoll(srcName));
}

// --- Special Events: 425 DX News ---

const SE_KEYWORDS_425 = ['special event','special callsign','anniversary','celebrat','commemorat','award',' ses ','certificate'];
const ONE_BY_ONE_RE = /^[AKNW]\d[A-Z]$/i;

// Matches most valid amateur callsigns (prefix + digit + suffix)
const CALL_EXTRACT_RE = /\b([A-Z]{1,3}[0-9][A-Z]{1,4}(?:\/[A-Z0-9]{1,4})?)\b/g;

function stripHtml(s) {
  return s.replace(/<[^>]+>/g, ' ')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ').trim();
}

function parse425DxPage(html, srcName) {
  const events = [];
  const seen = new Set();
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRe.exec(html)) !== null) {
    const rowHtml = trMatch[1];
    if (/<th[^>]*>/i.test(rowHtml)) continue;

    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let tdMatch;
    while ((tdMatch = tdRe.exec(rowHtml)) !== null) cells.push(tdMatch[1]);
    if (cells.length < 2) continue;

    const periodRaw = cells[0].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    const opHtml    = cells[1];

    // All content lives in a <code> block: "ENTITY   -   description with callsigns"
    const codeM = /<code[^>]*>([\s\S]*?)<\/code>/i.exec(opHtml);
    if (!codeM) continue;
    const codeText = stripHtml(codeM[1]);

    const dashIdx = codeText.indexOf(' - ');
    if (dashIdx < 0) continue;
    const entity      = codeText.slice(0, dashIdx).trim();
    const description = codeText.slice(dashIdx + 3).trim();

    // SE classification — skip regular DXpeditions without SE language or 1x1 calls
    const textLower = description.toLowerCase();
    let confidence = 0.5;
    for (const kw of SE_KEYWORDS_425) {
      if (textLower.includes(kw)) { confidence = 0.85; break; }
    }

    // Extract callsigns from description
    const callSigns = [];
    CALL_EXTRACT_RE.lastIndex = 0;
    let cm;
    while ((cm = CALL_EXTRACT_RE.exec(description)) !== null) {
      const c = cm[1].toUpperCase();
      if (!callSigns.includes(c)) callSigns.push(c);
    }
    // 1x1 US calls (e.g. W1A) are SE by nature
    if (confidence < 0.85 && callSigns.some(c => ONE_BY_ONE_RE.test(c))) confidence = 0.75;

    if (confidence < 0.75) continue;
    if (callSigns.length === 0) continue; // no callsign → can't populate SE badge

    // Prefer "active as CALL" pattern; otherwise use last extracted callsign
    const activeAsM = /active as\s+([A-Z]{1,3}[0-9][A-Z]{1,4}(?:\/[A-Z0-9]{1,4})?)/i.exec(description);
    const primaryCall = activeAsM
      ? activeAsM[1].toUpperCase()
      : callSigns[callSigns.length - 1];

    // Parse date period: "till 27/06", "28/06-04/07", "28/06"
    let startDate = '', endDate = '';
    const rangeM  = /(\d{1,2}\/\d{1,2})\s*[-–]\s*(\d{1,2}\/\d{1,2})/.exec(periodRaw);
    const tillM   = /till\s+(\d{1,2}\/\d{1,2})/i.exec(periodRaw);
    const singleM = /^(\d{1,2}\/\d{1,2})$/.exec(periodRaw.trim());
    if (rangeM)       { startDate = dmToMonDay(rangeM[1]); endDate = dmToMonDay(rangeM[2]); }
    else if (tillM)   { endDate = dmToMonDay(tillM[1]); }
    else if (singleM) { startDate = endDate = dmToMonDay(singleM[1]); }

    const freqMs = description.match(/\b\d{1,2}\.\d{3}\b/g) || [];
    const frequencies = freqMs.filter(f => { const mhz = parseFloat(f); return mhz >= 1 && mhz <= 30; });
    const bands = [...new Set(frequencies.map(f => freqToBand(parseFloat(f) * 1000)).filter(b => b !== 'unknown'))];
    const rawText = `${periodRaw} ${entity} ${description}`.replace(/\s+/g, ' ').trim();
    const eventId = `425dx-${primaryCall}-${(startDate || endDate || String(Date.now())).replace(/[\/\s]/g, '-')}`;
    if (seen.has(eventId)) continue;
    seen.add(eventId);

    const { dateQuality, dateWarning, sortStartUtc } = computeDateFields(startDate, endDate);
    events.push({
      eventId, source: srcName,
      title: `${entity}: ${description.slice(0, 80)}`,
      callSign: primaryCall, callSigns,
      startDate, endDate, startTimeUtc: '', endTimeUtc: '',
      city: '', state: '', locationText: entity,
      frequencies, bands,
      qslInfo: /\bQSL\b/i.test(rawText) ? 'QSL' : '',
      certificateInfo: /\bCertificate\b/i.test(rawText) ? 'Certificate' : '',
      website: '', description, rawText, confidence,
      dateQuality, dateWarning, sortStartUtc,
      lastUpdated: Date.now(),
    });
  }
  return events;
}

async function poll425DxSource(srcName) {
  const src = sourceStates.get(srcName);
  if (!src || src.type !== '425dx-se') return;
  const url = src.config.url || 'https://www.425dxn.org/index.php?op=wcal';
  try {
    httpLog(srcName, `Fetching 425 DX News calendar…`);
    const html   = await httpGet(url);
    const events = parse425DxPage(html, srcName);
    httpLog(srcName, `${events.length} special events found`);
    specialEventsBySource.set(srcName, events);
    specialEvents = mergeAllSpecialEvents();
    specialEventsLastRefresh = Date.now();
    broadcast({ type: 'special_events_refresh', data: { events: specialEvents, lastRefresh: specialEventsLastRefresh } });
    src.status = 'live';
    broadcastCompositeStatus();
  } catch (e) {
    httpLog(srcName, `Error: ${e.message}`);
    src.status = 'error';
    broadcast({ type: 'error', data: { message: `${srcName}: ${e.message}` } });
    broadcastCompositeStatus();
  }
}

function schedule425DxPoll(srcName) {
  const src = sourceStates.get(srcName);
  if (!src || src.type !== '425dx-se') return;
  const intervalMs = (src.config.pollSeconds || 21600) * 1000;
  src.pollTimer = setTimeout(async () => {
    await poll425DxSource(srcName);
    schedule425DxPoll(srcName);
  }, intervalMs);
}

function start425DxSource(config) {
  const srcName = config.name;
  sourceStates.set(srcName, { type: '425dx-se', config, pollTimer: null, status: 'polling' });
  broadcast({ type: 'se_loading', data: { source: srcName } });
  broadcastCompositeStatus();
  poll425DxSource(srcName).then(() => schedule425DxPoll(srcName));
}

// --- QRZ XML Lookup ---

const ENV_FILE = path.join(__dirname, '.env');

const qrz = {
  username:   '',
  password:   '',
  enabled:    false,
  sessionKey: null,
  cache:      new Map(),
};

function loadEnvFile() {
  try {
    const text = fs.readFileSync(ENV_FILE, 'utf8');
    for (const line of text.split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) process.env[m[1]] = m[2];
    }
  } catch (_) {}
  qrz.username = process.env.QRZ_USERNAME || '';
  qrz.password = process.env.QRZ_PASSWORD || '';
  qrz.enabled  = process.env.QRZ_ENABLED === 'true';
}

function saveEnvFile(username, password, enabled) {
  const content = [
    `QRZ_USERNAME=${username}`,
    `QRZ_PASSWORD=${password}`,
    `QRZ_ENABLED=${enabled ? 'true' : 'false'}`,
  ].join('\n') + '\n';
  fs.writeFileSync(ENV_FILE, content, 'utf8');
  qrz.username   = username;
  qrz.password   = password;
  qrz.enabled    = enabled;
  qrz.sessionKey = null;
}

function xmlVal(xml, tag) {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m ? m[1].trim() : '';
}

async function qrzLogin() {
  const xml = await httpGet(
    `https://xmldata.qrz.com/xml/current/?username=${encodeURIComponent(qrz.username)};password=${encodeURIComponent(qrz.password)};agent=dxspots-1.0`
  );
  const key = xmlVal(xml, 'Key');
  const err = xmlVal(xml, 'Error');
  if (err) throw new Error(err);
  if (!key) throw new Error('No session key returned');
  qrz.sessionKey = key;
}

async function qrzLookup(call) {
  if (qrz.cache.has(call)) return qrz.cache.get(call);
  if (!qrz.sessionKey) await qrzLogin();

  const doFetch = () => httpGet(
    `https://xmldata.qrz.com/xml/current/?s=${qrz.sessionKey};callsign=${encodeURIComponent(call)}`
  );

  let xml = await doFetch();
  if (/Session Timeout|Invalid session/i.test(xml)) {
    await qrzLogin();
    xml = await doFetch();
  }

  const err = xmlVal(xml, 'Error');
  if (err) throw new Error(err);

  const data = {
    call:    xmlVal(xml, 'call') || call,
    fname:   xmlVal(xml, 'fname'),
    name:    xmlVal(xml, 'name'),
    city:    xmlVal(xml, 'addr2'),
    state:   xmlVal(xml, 'state'),
    country: xmlVal(xml, 'country'),
    grid:    xmlVal(xml, 'grid'),
    county:  xmlVal(xml, 'county'),
    cqzone:  xmlVal(xml, 'cqzone'),
    ituzone: xmlVal(xml, 'ituzone'),
    url:     `https://www.qrz.com/db/${encodeURIComponent(call)}`,
  };

  qrz.cache.set(call, data);
  return data;
}

// --- HRD Logbook Dupe Check ---

const { exec } = require('child_process');
const os       = require('os');

const DUPE_CONFIG_PATH = path.join(__dirname, 'dupe-config.json');

let dupeConfig = {
  enabled:     false,
  mdbPath:     'C:\\Users\\jim\\AppData\\Roaming\\HRDLLC\\HRD Logbook\\HRD My Logbook.mdb',
  windowType:  '24h',
  customValue: 7,
  customUnit:  'days',
};

function loadDupeConfig() {
  try {
    if (fs.existsSync(DUPE_CONFIG_PATH)) {
      Object.assign(dupeConfig, JSON.parse(fs.readFileSync(DUPE_CONFIG_PATH, 'utf8')));
    }
  } catch (_) {}
}

function saveDupeConfig(cfg) {
  Object.assign(dupeConfig, cfg);
  try { fs.writeFileSync(DUPE_CONFIG_PATH, JSON.stringify(dupeConfig, null, 2)); } catch (_) {}
}

function dupeWindowMs(cfg) {
  switch (cfg.windowType) {
    case '24h':   return 24 * 3600000;
    case '48h':   return 48 * 3600000;
    case '72h':   return 72 * 3600000;
    case '1w':    return 7 * 86400000;
    case 'ever':  return Infinity;
    case 'custom': {
      const v = Number(cfg.customValue) || 7;
      if (cfg.customUnit === 'hours') return v * 3600000;
      if (cfg.customUnit === 'weeks') return v * 7 * 86400000;
      return v * 86400000;
    }
    default: return 24 * 3600000;
  }
}

function dupeWindowLabel(cfg) {
  switch (cfg.windowType) {
    case '24h':  return 'last 24 hours';
    case '48h':  return 'last 48 hours';
    case '72h':  return 'last 72 hours';
    case '1w':   return 'last 1 week';
    case 'ever': return 'ever';
    case 'custom': return `last ${cfg.customValue} ${cfg.customUnit}`;
    default:     return 'last 24 hours';
  }
}

const HRD_MODE_MAP = {
  'CW':     'CW',
  'SSB':    'Voice', 'USB':    'Voice', 'LSB':    'Voice',
  'AM':     'Voice', 'FM':     'Voice', 'DSTAR':  'Voice', 'D-STAR': 'Voice',
  'FT8':    'Digital', 'FT4':  'Digital', 'RTTY':  'Digital',
  'PSK':    'Digital', 'JS8':  'Digital', 'DIGITAL':'Digital',
};

function normalizeHrdMode(mode) {
  if (!mode) return 'Digital';
  const upper = String(mode).trim().toUpperCase();
  return HRD_MODE_MAP[upper] || 'Digital';
}

function normalizeIssMode(mode) {
  if (!mode) return 'Digital';
  const upper = String(mode).trim().toUpperCase();
  if (upper === 'CW') return 'CW';
  if (['VOICE','SSB','USB','LSB','AM','FM','PHONE'].includes(upper)) return 'Voice';
  return 'Digital';
}

async function queryHrdContacts(call) {
  const mdbPath = dupeConfig.mdbPath;
  if (!mdbPath) throw new Error('HRD log path not configured');

  // Sanitize inputs for embedding in a PowerShell script string
  const safeCall  = call.toUpperCase().replace(/[^A-Z0-9/\-]/g, '');
  // Single-quote the path for PowerShell — escape any embedded single quotes
  const psPath    = mdbPath.replace(/'/g, "''");

  // PowerShell script — uses ADODB COM object + ConvertTo-Json (PS 5.1+)
  // Table is TABLE_HRD_CONTACTS_V01; COL_TIME_ON holds full datetime; COL_FREQ is in Hz.
  const ps1 = `
$ErrorActionPreference = 'Stop'
try {
  $conn = New-Object -ComObject ADODB.Connection
  # Mode=17 = adModeRead(1) | adModeShareDenyNone(16)
  # Opens read-only without holding any locks, so HRD can keep writing concurrently.
  $opened = $false
  try { $conn.Open('Provider=Microsoft.ACE.OLEDB.12.0;Data Source=${psPath};Mode=17;Jet OLEDB:Database Locking Mode=0'); $opened = $true } catch {}
  if (-not $opened) { $conn.Open('Provider=Microsoft.Jet.OLEDB.4.0;Data Source=${psPath};Mode=17;Jet OLEDB:Database Locking Mode=0') }
  $sql = "SELECT COL_CALL,COL_BAND,COL_MODE,COL_FREQ,COL_TIME_ON FROM TABLE_HRD_CONTACTS_V01 WHERE COL_CALL='${safeCall}' ORDER BY COL_TIME_ON DESC"
  $rs = $conn.Execute($sql)
  $rows = [System.Collections.Generic.List[object]]::new()
  while (-not $rs.EOF) {
    $freqHz = [double]"$($rs.Fields('COL_FREQ').Value)"
    $rows.Add([PSCustomObject]@{
      call   = [string]$rs.Fields('COL_CALL').Value
      band   = [string]$rs.Fields('COL_BAND').Value
      mode   = [string]$rs.Fields('COL_MODE').Value
      timeOn = [string]$rs.Fields('COL_TIME_ON').Value
      freqMhz = [string][math]::Round($freqHz / 1000000, 4)
    })
    $rs.MoveNext()
  }
  $rs.Close(); $conn.Close()
  Write-Output (ConvertTo-Json @{contacts=$rows.ToArray()} -Compress -Depth 3)
} catch {
  Write-Output (ConvertTo-Json @{error=$_.Exception.Message} -Compress)
}
`;

  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `hrd_${Date.now()}.ps1`);
    try { fs.writeFileSync(tmp, ps1, 'utf8'); } catch (e) { return reject(new Error('Cannot write temp file: ' + e.message)); }

    exec(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmp}"`, { timeout: 20000, encoding: 'utf8' }, (err, stdout, stderr) => {
      fs.unlink(tmp, () => {});
      if (stderr && stderr.trim()) console.log('[HRD] stderr:', stderr.trim());
      const out = (stdout || '').trim();
      if (!out) {
        const detail = err ? (stderr || '').trim() || err.message : 'no output from PowerShell';
        return reject(new Error('HRD query produced no output: ' + detail));
      }
      try {
        const result = JSON.parse(out);
        if (result.error) return reject(new Error(result.error));
        resolve(result.contacts || []);
      } catch (_) {
        reject(new Error('Unexpected database response: ' + out.slice(0, 300)));
      }
    });
  });
}

// Parse HRD COL_TIME_ON: "MM/DD/YYYY HH:MM:SS" (stored as UTC)
function parseHrdDate(timeOn) {
  try {
    const s = String(timeOn || '').trim();
    // MM/DD/YYYY HH:MM:SS
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
    if (!m) return 0;
    return new Date(`${m[3]}-${m[1]}-${m[2]}T${m[4]}:${m[5]}:${m[6]}Z`).getTime();
  } catch (_) { return 0; }
}

// --- Express app ---

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/connect', (req, res) => {
  const { callsign, sources } = req.body || {};
  if (!callsign || !Array.isArray(sources) || !sources.length) {
    return res.status(400).json({ error: 'callsign and sources are required' });
  }
  stopAllSources();
  broadcast({ type: 'console', data: { line: `Starting: ${sources.map(s => `${s.name}(${s.type})`).join(', ')}`, parsed: false, source: '' } });
  for (const src of sources) {
    if (src.type === 'telnet' && src.host && src.port) {
      openTelnetSource(src, callsign.trim());
    } else if (src.type === 'http' && src.url) {
      startHttpSource(src);
    } else if (src.type === 'pota-api' && src.url) {
      startPotaSource(src);
    } else if (src.type === 'sota-api' && src.url) {
      startSotaSource(src);
    } else if (src.type === 'rbn-telnet' && src.host && src.port) {
      openRbnSource(src, callsign.trim());
    } else if (src.type === 'special-events-html' && src.url) {
      startSpecialEventsSource(src);
    } else if (src.type === '425dx-se' && src.url) {
      start425DxSource(src);
    }
  }
  res.json({ status: 'connecting' });
});

app.post('/api/disconnect', (_req, res) => {
  stopAllSources();
  res.json({ status: 'disconnected' });
});

app.post('/api/source/start', (req, res) => {
  const { source, callsign } = req.body || {};
  if (!source || !source.name || !callsign) {
    return res.status(400).json({ error: 'source and callsign required' });
  }
  if (sourceStates.has(source.name)) {
    return res.json({ status: 'already_running' });
  }
  if (source.type === 'rbn-telnet' && source.host && source.port) {
    openRbnSource(source, callsign.trim());
    return res.json({ status: 'starting' });
  }
  res.status(400).json({ error: 'Unsupported source type for individual start' });
});

app.post('/api/source/stop', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const src = sourceStates.get(name);
  if (!src) return res.json({ status: 'not_running' });
  if (src.type === 'rbn-telnet') {
    if (src.loginTimer)      { clearTimeout(src.loginTimer); src.loginTimer = null; }
    if (src.skimmerTimeout)  { clearTimeout(src.skimmerTimeout); src.skimmerTimeout = null; }
    if (src.skimmerInterval) { clearInterval(src.skimmerInterval); src.skimmerInterval = null; }
    if (src.socket)          { src.socket.destroy(); src.socket = null; }
  } else if (src.type === 'telnet') {
    if (src.loginTimer) { clearTimeout(src.loginTimer); src.loginTimer = null; }
    if (src.socket)     { src.socket.destroy(); src.socket = null; }
  } else if (src.pollTimer) {
    clearTimeout(src.pollTimer);
  }
  sourceStates.delete(name);
  broadcastCompositeStatus();
  res.json({ status: 'stopped' });
});

app.get('/api/qrz/status', (_req, res) => {
  res.json({ enabled: qrz.enabled, configured: !!(qrz.username && qrz.password) });
});

app.post('/api/qrz/credentials', (req, res) => {
  const { username = '', password = '', enabled = false } = req.body || {};
  const finalUser = String(username).trim() || qrz.username;
  const finalPass = String(password)        || qrz.password;
  saveEnvFile(finalUser, finalPass, Boolean(enabled));
  res.json({ ok: true, enabled: qrz.enabled, configured: !!(qrz.username && qrz.password) });
});

app.post('/api/qrz/test', async (_req, res) => {
  if (!qrz.username || !qrz.password) {
    return res.status(400).json({ error: 'QRZ credentials not configured' });
  }
  try { await qrzLogin(); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/qrz/lookup', async (req, res) => {
  const call = String(req.query.call || '').trim().toUpperCase();
  if (!call) return res.status(400).json({ error: 'call is required' });
  if (!qrz.enabled) return res.status(403).json({ error: 'QRZ lookup is disabled' });
  if (!qrz.username || !qrz.password) return res.status(403).json({ error: 'QRZ credentials not configured' });
  try { res.json(await qrzLookup(call)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

const potaParkCache  = new Map();
const sotaSummitCache = new Map();

app.get('/api/pota/park', async (req, res) => {
  const ref = String(req.query.ref || '').trim().toUpperCase();
  if (!ref) return res.status(400).json({ error: 'ref is required' });
  if (potaParkCache.has(ref)) return res.json(potaParkCache.get(ref));
  try {
    const body = await httpGet(`https://api.pota.app/park/${encodeURIComponent(ref)}`);
    const data = JSON.parse(body);
    potaParkCache.set(ref, data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sota/summit', async (req, res) => {
  const ref = String(req.query.ref || '').trim().toUpperCase();
  if (!ref) return res.status(400).json({ error: 'ref is required' });
  // Validate format: ASSOCIATION/REGION-NUMBER  e.g. W4/TN-001
  if (!/^[A-Z0-9]+\/[A-Z0-9\-]+$/.test(ref)) return res.status(400).json({ error: 'Invalid summit reference' });
  if (sotaSummitCache.has(ref)) return res.json(sotaSummitCache.get(ref));
  try {
    const body = await httpGet(`https://api2.sota.org.uk/api/summits/${ref}`);
    const data = JSON.parse(body);
    sotaSummitCache.set(ref, data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/dupe-config', (_req, res) => {
  const { enabled, mdbPath, windowType, customValue, customUnit } = dupeConfig;
  res.json({ enabled, mdbPath, windowType, customValue, customUnit });
});

app.post('/api/dupe-config', (req, res) => {
  const { enabled, mdbPath, windowType, customValue, customUnit } = req.body || {};
  saveDupeConfig({
    enabled:     Boolean(enabled),
    mdbPath:     String(mdbPath     ?? dupeConfig.mdbPath),
    windowType:  String(windowType  ?? dupeConfig.windowType),
    customValue: Number(customValue ?? dupeConfig.customValue) || 1,
    customUnit:  String(customUnit  ?? dupeConfig.customUnit),
  });
  res.json({ ok: true });
});

app.post('/api/dupe-check', async (req, res) => {
  const { call, band, mode, windowType } = req.body || {};
  if (!call) return res.status(400).json({ error: 'call is required' });
  if (!dupeConfig.enabled) return res.status(403).json({ error: 'Dupe check is disabled' });

  try {
    const contacts = await queryHrdContacts(call.toUpperCase().trim());
    const nowMs    = Date.now();
    const effCfg   = windowType ? { ...dupeConfig, windowType } : dupeConfig;
    const windowMs = dupeWindowMs(effCfg);
    const spotMode = mode ? normalizeIssMode(mode) : '';  // '' = any mode

    const results = contacts.map(c => {
      const hrdNorm      = normalizeHrdMode(c.mode);
      const bandMatch    = !band    || (c.band && c.band.toLowerCase() === band.toLowerCase());
      const modeMatch    = !spotMode || hrdNorm === spotMode;
      const qsoMs        = parseHrdDate(c.timeOn);
      const withinWindow = windowMs === Infinity ? true : (nowMs - qsoMs) <= windowMs;
      const isDupe       = bandMatch && modeMatch && withinWindow;
      const workedBefore = bandMatch && modeMatch && !withinWindow;
      return { ...c, hrdNorm, bandMatch, modeMatch, withinWindow, isDupe, workedBefore, qsoMs };
    });

    const hasDupe      = results.some(r => r.isDupe);
    const workedBefore = !hasDupe && results.some(r => r.bandMatch && r.modeMatch);
    const label        = dupeWindowLabel(effCfg);
    const callUpper    = call.toUpperCase();
    const bandStr      = band     || 'any band';
    const modeStr      = spotMode || 'any mode';

    let statusMsg;
    if      (hasDupe)      statusMsg = `DUPE: Worked ${callUpper} on ${bandStr} ${modeStr} within ${label}`;
    else if (workedBefore) statusMsg = `WORKED BEFORE: ${callUpper} worked on ${bandStr} ${modeStr}, but not within ${label}`;
    else                   statusMsg = `NOT A DUPE: No ${callUpper} contact on ${bandStr} ${modeStr} within ${label}`;

    res.json({ call: callUpper, band, mode: spotMode, windowLabel: label, hasDupe, workedBefore, statusMsg, contacts: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/special-events', (_req, res) => {
  res.json({ events: specialEvents, lastRefresh: specialEventsLastRefresh });
});

app.get('/api/propagation', (_req, res) => {
  res.json(propData || {});
});

let seManualThrottleAt = 0;

app.post('/api/special-events/refresh', async (_req, res) => {
  const now = Date.now();
  if (now - seManualThrottleAt < 60000) {
    return res.status(429).json({ error: 'Wait at least 60 seconds between manual refreshes' });
  }
  seManualThrottleAt = now;
  let found = false;
  for (const [name, src] of sourceStates) {
    if (src.type === 'special-events-html') { pollSpecialEventsSource(name); found = true; }
    else if (src.type === '425dx-se')       { poll425DxSource(name); found = true; }
  }
  if (!found) return res.status(400).json({ error: 'No active special events source — connect first' });
  res.json({ status: 'refreshing' });
});

app.post('/api/rbn/refresh-skimmers', (_req, res) => {
  let count = 0;
  for (const [name, src] of sourceStates) {
    if (src.type === 'rbn-telnet' && src.status === 'live') {
      issueShSkimmer(name);
      count++;
    }
  }
  res.json({ issued: count });
});

app.get('/api/debug/http', async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    const body = await httpGet(url);
    const text = stripHtml(body);
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 8);
    const sample = lines.slice(0, 30).map(line => ({
      line,
      parsed: tryParseSpot(line) ? true : false,
    }));
    res.json({ rawLength: body.length, rawSample: body.slice(0, 1000), candidateLines: lines.length, sample });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Propagation data (HamQSL solar XML) ---

function fetchPropXml() {
  return new Promise((resolve, reject) => {
    https.get('https://www.hamqsl.com/solarxml.php', { timeout: 10000 }, res => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => resolve(raw));
    }).on('error', reject).on('timeout', function() { this.destroy(new Error('timeout')); });
  });
}

function parsePropXml(xml) {
  function tag(name) {
    const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
    return m ? m[1].trim() : null;
  }
  const ssn   = tag('sunspots');
  const sfi   = tag('solarflux');
  const aIdx  = tag('aindex');
  const kIdx  = tag('kindex');
  const xray  = tag('xray');
  if (!sfi && !ssn) return null;
  return {
    ssn:   ssn  !== null ? parseInt(ssn,  10) : null,
    sfi:   sfi  !== null ? parseInt(sfi,  10) : null,
    aIndex: aIdx !== null ? parseInt(aIdx, 10) : null,
    kIndex: kIdx !== null ? parseFloat(kIdx)   : null,
    xRay:  xray || null,
    fetched: Date.now(),
  };
}

async function pollPropData() {
  try {
    const xml = await fetchPropXml();
    const parsed = parsePropXml(xml);
    if (parsed) {
      propData = parsed;
      propLastFetch = parsed.fetched;
      broadcast({ type: 'propagation', data: propData });
    }
  } catch (e) {
    console.error('[prop] fetch error:', e.message);
  }
}

setInterval(pollPropData, PROP_POLL_MS);
pollPropData(); // fetch immediately on startup

// --- Active Nets ---

const NETS_CONFIG_FILE = path.join(__dirname, 'nets-config.json');
const DEFAULT_NETS_CONFIG = {
  enabled: true,
  netloggerEnabled: true,
  netfinderEnabled: true,
  refreshNetloggerMinutes: 15,
  refreshNetfinderMinutes: 15,
  upcomingWindowMinutes: 120,
  minimumConfidence: 0.70,
};

let netsConfig = { ...DEFAULT_NETS_CONFIG };
let netloggerCache = [];        // last good NetLogger parse
let netfinderCache = [];        // last good NetFinder parse
let netsCombined  = [];         // merged result broadcast to clients
let netsFavorites = [];         // user-defined favorites (from nets-config.json)
let netloggerPollTimer = null;
let netfinderPollTimer = null;

const netSourceHealth = {
  netlogger: { status: 'DISABLED', lastRefresh: null, parsed: 0, accepted: 0, rejected: 0, error: null },
  netfinder: { status: 'DISABLED', lastRefresh: null, parsed: 0, accepted: 0, rejected: 0, error: null },
};

const NETS_CONFIG_STALE_NETLOGGER = 10 * 60 * 1000; // 10 min
const NETS_CONFIG_STALE_NETFINDER = 2 * 60 * 60 * 1000; // 2 hr

function loadNetsConfig() {
  try {
    if (fs.existsSync(NETS_CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(NETS_CONFIG_FILE, 'utf8'));
      netsConfig   = { ...DEFAULT_NETS_CONFIG, ...(raw.settings || {}) };
      netsFavorites = Array.isArray(raw.favorites) ? raw.favorites : [];
    }
  } catch (e) {
    console.error('[nets] config load error:', e.message);
  }
}

function saveNetsConfig() {
  try {
    fs.writeFileSync(NETS_CONFIG_FILE, JSON.stringify({ settings: netsConfig, favorites: netsFavorites }, null, 2));
  } catch (e) {
    console.error('[nets] config save error:', e.message);
  }
}

// Detect band from frequency (kHz)
function freqToBandNets(khz) {
  if (!khz) return '';
  return freqToBand(String(khz)); // reuse existing freqToBand
}

// Detect mode from text
function modeFromText(text) {
  if (!text) return '';
  const t = String(text).toUpperCase();
  if (/\bFT8\b/.test(t))  return 'FT8';
  if (/\bFT4\b/.test(t))  return 'FT4';
  if (/\bRTTY\b/.test(t)) return 'Digital';
  if (/\bPSK\b/.test(t))  return 'Digital';
  if (/\bSSB\b|\bUSB\b|\bLSB\b|\bPHONE\b/.test(t)) return 'SSB';
  if (/\bCW\b/.test(t))   return 'CW';
  if (/\bFM\b/.test(t))   return 'FM';
  if (/\bAM\b/.test(t))   return 'AM';
  if (/\bC4FM\b|\bFUSION\b/.test(t)) return 'C4FM';
  if (/\bDMR\b/.test(t))  return 'DMR';
  if (/\bDSTAR\b|D-STAR/.test(t)) return 'D-STAR';
  if (/\bECHO\b|\bECHOLINK\b/.test(t)) return 'Echolink';
  if (/\bDIGI\b|\bDIGITAL\b|\bJS8\b/.test(t)) return 'Digital';
  return '';
}

function parseFreqKhz(text) {
  if (!text) return null;
  const s = String(text).replace(/[, ]/g, '').trim();
  const n = parseFloat(s);
  if (isNaN(n) || n <= 0) return null;
  // Convert MHz to kHz if < 100 (all ham freqs in MHz are < 500)
  if (n < 100) return Math.round(n * 1000 * 10) / 10;
  return n; // already kHz
}

function makeNetId(source, name, freq) {
  return `${source}-${String(name).toLowerCase().replace(/\s+/g, '-')}-${String(freq).replace(/[^0-9.]/g, '')}`;
}

// --- NetLogger parser ---
// Tries JSON API first, falls back to HTML table scraping
function parseNetLoggerHtml(html) {
  const nets = [];
  const seen = new Set();

  // Try JSON in a <pre> or script tag first
  try {
    const jsonM = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(html) ||
                  /\[(\s*\{[\s\S]*?\})\s*\]/m.exec(html);
    if (jsonM) {
      const arr = JSON.parse('[' + jsonM[1].replace(/^\[/, '').replace(/\]$/, '') + ']');
      if (Array.isArray(arr) && arr.length) {
        for (const r of arr) {
          const name = (r.NetName || r.net_name || r.name || '').trim();
          if (!name) continue;
          const freqText = String(r.Frequency || r.frequency || r.freq || '');
          const freqKhz  = parseFreqKhz(freqText);
          const mode     = modeFromText(r.Mode || r.mode || r.NetMode || '');
          const key      = `${name}-${freqText}`;
          if (seen.has(key)) continue;
          seen.add(key);
          nets.push({
            netId:        makeNetId('netlogger', name, freqKhz || freqText),
            source:       'NetLogger',
            sourceUrl:    'https://www.netlogger.org/',
            name,
            frequency:    freqText,
            frequencyKhz: freqKhz,
            band:         freqKhz ? freqToBandNets(freqKhz) : (r.Band || r.band || ''),
            mode:         mode || modeFromText(r.Band || ''),
            status:       'ACTIVE',
            startUtc:     r.StartTime || r.start_time || r.StartUTC || null,
            elapsed:      r.Elapsed || r.elapsed || '',
            subscribers:  parseInt(r.Subscribers || r.subscribers || 0, 10) || null,
            openedBy:     (r.OpenedBy || r.opened_by || r.NetControl || '').trim(),
            location:     (r.Server || r.server || r.Location || '').trim(),
            description:  (r.Description || r.description || '').trim(),
            favorite:     false,
            confidence:   1.00,
            lastUpdatedUtc: new Date().toISOString(),
          });
        }
        if (nets.length) return nets;
      }
    }
  } catch (_) {}

  // HTML table scraping fallback
  const tableM = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tableM.exec(html)) !== null) {
    const tableHtml = tableMatch[1];
    // Skip tables with no data rows
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    const headers = [];
    let headerFound = false;

    while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[1];
      const isHeader = /<th[^>]*>/i.test(rowHtml);

      if (isHeader && !headerFound) {
        const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
        let thM;
        while ((thM = thRe.exec(rowHtml)) !== null) {
          headers.push(stripHtml(thM[1]).toLowerCase().replace(/\s+/g, ' ').trim());
        }
        headerFound = true;
        continue;
      }

      if (!headerFound) continue;
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const cells = [];
      let tdM;
      while ((tdM = tdRe.exec(rowHtml)) !== null) {
        cells.push(stripHtml(tdM[1]).trim());
      }
      if (cells.length < 2) continue;

      const get = (...keys) => {
        for (const k of keys) {
          const idx = headers.findIndex(h => h.includes(k));
          if (idx >= 0 && idx < cells.length) return cells[idx];
        }
        return cells[keys[0]] || '';
      };

      const name    = get('net', 'name') || cells[0];
      if (!name || name.length < 2) continue;
      const freqText = get('freq', 'frequency', 'khz') || cells[1] || '';
      const freqKhz  = parseFreqKhz(freqText);
      const key      = `${name}-${freqText}`;
      if (seen.has(key)) continue;
      seen.add(key);

      nets.push({
        netId:        makeNetId('netlogger', name, freqKhz || freqText),
        source:       'NetLogger',
        sourceUrl:    'https://www.netlogger.org/',
        name:         name.trim(),
        frequency:    freqText,
        frequencyKhz: freqKhz,
        band:         freqKhz ? freqToBandNets(freqKhz) : '',
        mode:         modeFromText(get('mode') || ''),
        status:       'ACTIVE',
        startUtc:     get('start', 'time', 'utc') || null,
        elapsed:      get('elapsed') || '',
        subscribers:  parseInt(get('sub', 'member', 'count') || 0, 10) || null,
        openedBy:     (get('opened', 'control', 'by') || '').trim(),
        location:     (get('server', 'location', 'cluster') || '').trim(),
        description:  '',
        favorite:     false,
        confidence:   1.00,
        lastUpdatedUtc: new Date().toISOString(),
      });
    }
    if (nets.length > 0) break;
  }
  return nets;
}

// --- NetFinder parser ---
function parseNetFinderHtml(html, upcomingWindowMs) {
  const nets = [];
  const now  = Date.now();
  const seen = new Set();

  // NetFinder page sections: "Happening Now" and "Upcoming"
  // Try to detect section headings and classify rows accordingly
  const sectionRe = /<h[23][^>]*>([\s\S]*?)<\/h[23]>|<div[^>]*class="[^"]*section[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  const tableRe   = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch;

  // Just parse all tables; classify by row content
  while ((tableMatch = tableRe.exec(html)) !== null) {
    const tableHtml = tableMatch[1];
    const rowRe     = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const headers   = [];
    let headerFound = false;
    let rowMatch;

    while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[1];
      if (/<th[^>]*>/i.test(rowHtml) && !headerFound) {
        const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
        let thM;
        while ((thM = thRe.exec(rowHtml)) !== null) {
          headers.push(stripHtml(thM[1]).toLowerCase().replace(/\s+/g, ' ').trim());
        }
        headerFound = true;
        continue;
      }
      if (!headerFound) continue;
      const tdRe  = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const cells = [];
      let tdM;
      while ((tdM = tdRe.exec(rowHtml)) !== null) cells.push(stripHtml(tdM[1]).trim());
      if (cells.length < 2) continue;

      const get = (...keys) => {
        for (const k of keys) {
          const idx = headers.findIndex(h => h.includes(k));
          if (idx >= 0 && idx < cells.length) return cells[idx];
        }
        return '';
      };

      const name     = get('net', 'name') || cells[0];
      if (!name || name.length < 2) continue;
      const freqText = get('freq', 'frequency', 'khz') || '';
      const freqKhz  = parseFreqKhz(freqText);
      const startStr = get('start', 'time', 'utc') || '';
      const key      = `nf-${name}-${freqText}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Determine status from start time if parseable
      let status = 'HAPPENING_NOW';
      let startMs = null;
      if (startStr) {
        try {
          const d = new Date(startStr.endsWith('Z') ? startStr : startStr + 'Z');
          startMs = d.getTime();
          if (!isNaN(startMs)) {
            const diffMs = startMs - now;
            if (diffMs > 5 * 60 * 1000) status = 'UPCOMING';
            else if (diffMs > -60 * 60 * 1000) status = 'HAPPENING_NOW';
            else status = 'SCHEDULED';
          }
        } catch (_) {}
      }

      nets.push({
        netId:        makeNetId('netfinder', name, freqKhz || freqText),
        source:       'NetFinder',
        sourceUrl:    'https://netfinder.radio/',
        name:         name.trim(),
        frequency:    freqText,
        frequencyKhz: freqKhz,
        band:         freqKhz ? freqToBandNets(freqKhz) : (get('band') || ''),
        mode:         modeFromText(get('mode') || ''),
        status,
        startUtc:     startStr || null,
        elapsed:      '',
        subscribers:  null,
        openedBy:     (get('control', 'ncs', 'opened') || '').trim(),
        location:     (get('location', 'region', 'repeater') || '').trim(),
        description:  (get('desc', 'info', 'notes') || '').trim(),
        favorite:     false,
        confidence:   status === 'HAPPENING_NOW' ? 0.80 : 0.75,
        lastUpdatedUtc: new Date().toISOString(),
      });
    }
  }
  return nets;
}

// Merge NetLogger + NetFinder + Favorites, dedup by name+freq proximity
function mergeNets(nlNets, nfNets, favNets) {
  const result = [];
  const usedNf = new Set();

  // Start with NetLogger (highest confidence)
  for (const nl of nlNets) {
    const merged = { ...nl, sources: ['NetLogger'] };
    // Look for a matching NetFinder entry
    for (let i = 0; i < nfNets.length; i++) {
      if (usedNf.has(i)) continue;
      const nf = nfNets[i];
      const nameMatch = nl.name.toLowerCase().includes(nf.name.toLowerCase().slice(0, 8)) ||
                        nf.name.toLowerCase().includes(nl.name.toLowerCase().slice(0, 8));
      const freqMatch = nl.frequencyKhz && nf.frequencyKhz &&
                        Math.abs(nl.frequencyKhz - nf.frequencyKhz) < 2;
      if (nameMatch && (freqMatch || !nf.frequencyKhz)) {
        merged.sources.push('NetFinder');
        merged.location = merged.location || nf.location;
        merged.description = merged.description || nf.description;
        usedNf.add(i);
        break;
      }
    }
    result.push(merged);
  }

  // Add unmatched NetFinder entries
  for (let i = 0; i < nfNets.length; i++) {
    if (usedNf.has(i)) continue;
    result.push({ ...nfNets[i], sources: ['NetFinder'] });
  }

  // Mark favorites on any matching net
  for (const fav of favNets) {
    const existing = result.find(n => {
      const nameMatch = n.name.toLowerCase().includes(fav.name.toLowerCase().slice(0, 6)) ||
                        fav.name.toLowerCase().includes(n.name.toLowerCase().slice(0, 6));
      const freqKhz = parseFreqKhz(fav.frequency);
      const freqMatch = !freqKhz || !n.frequencyKhz || Math.abs(n.frequencyKhz - freqKhz) < 5;
      return nameMatch && freqMatch;
    });
    if (existing) {
      existing.favorite = true;
    } else {
      // Add standalone favorite
      const freqKhz = parseFreqKhz(fav.frequency);
      result.push({
        netId:        makeNetId('favorite', fav.name, fav.frequency),
        source:       'Favorite',
        sourceUrl:    '',
        sources:      ['Favorite'],
        name:         fav.name,
        frequency:    fav.frequency || '',
        frequencyKhz: freqKhz,
        band:         fav.band || (freqKhz ? freqToBandNets(freqKhz) : ''),
        mode:         fav.mode || '',
        status:       'FAVORITE',
        startUtc:     null,
        elapsed:      '',
        subscribers:  null,
        openedBy:     '',
        location:     '',
        description:  fav.notes || '',
        favorite:     true,
        schedule:     fav.schedule || '',
        confidence:   0.70,
        lastUpdatedUtc: new Date().toISOString(),
      });
    }
  }

  return result;
}

function broadcastNets() {
  netsCombined = mergeNets(netloggerCache, netfinderCache, netsFavorites);
  broadcast({ type: 'nets_refresh', data: {
    nets: netsCombined,
    favorites: netsFavorites,
    sourceHealth: {
      netlogger: { ...netSourceHealth.netlogger },
      netfinder: { ...netSourceHealth.netfinder },
    },
  }});
}

async function pollNetLogger() {
  if (!netsConfig.netloggerEnabled) return;
  const urls = ['https://www.netlogger.org/', 'https://netlogger.org/'];
  let html = null;
  let lastErr = null;
  for (const url of urls) {
    try {
      html = await httpGet(url);
      break;
    } catch (e) {
      lastErr = e;
      console.warn(`[nets] NetLogger fetch failed for ${url}: ${e.message}`);
    }
  }
  if (!html) {
    netSourceHealth.netlogger.status = 'FAILED';
    netSourceHealth.netlogger.error  = lastErr ? lastErr.message : 'All URLs failed';
    console.error('[nets] NetLogger: all URLs failed');
    if (netloggerCache.length) {
      netloggerCache = netloggerCache.map(n => ({ ...n, status: 'STALE', confidence: 0.60 }));
    }
    broadcastNets();
    return;
  }
  const nets = parseNetLoggerHtml(html);
  netSourceHealth.netlogger.parsed   = nets.length;
  netSourceHealth.netlogger.accepted = nets.length;
  netSourceHealth.netlogger.rejected = 0;
  netSourceHealth.netlogger.error    = null;
  netSourceHealth.netlogger.status   = 'OK';
  netSourceHealth.netlogger.lastRefresh = Date.now();
  if (nets.length > 0) {
    netloggerCache = nets;
  } else {
    console.log('[nets] NetLogger: 0 nets parsed (possibly no active nets)');
  }
  broadcastNets();
}

async function pollNetFinder() {
  if (!netsConfig.netfinderEnabled) return;
  const url = 'https://netfinder.radio/';
  try {
    const html = await httpGet(url);
    const upcomingWindow = (netsConfig.upcomingWindowMinutes || 120) * 60 * 1000;
    const nets = parseNetFinderHtml(html, upcomingWindow);
    netSourceHealth.netfinder.parsed   = nets.length;
    netSourceHealth.netfinder.accepted = nets.length;
    netSourceHealth.netfinder.rejected = 0;
    netSourceHealth.netfinder.error    = null;
    netSourceHealth.netfinder.status   = 'OK';
    netSourceHealth.netfinder.lastRefresh = Date.now();
    netfinderCache = nets;
  } catch (e) {
    netSourceHealth.netfinder.status = 'FAILED';
    netSourceHealth.netfinder.error  = e.message;
    console.error('[nets] NetFinder fetch error:', e.message);
    if (netfinderCache.length) {
      netfinderCache = netfinderCache.map(n => ({ ...n, status: 'STALE', confidence: Math.max(0.50, n.confidence - 0.10) }));
    }
  }
  broadcastNets();
}

function scheduleNetLoggerPoll() {
  clearTimeout(netloggerPollTimer);
  netloggerPollTimer = setTimeout(async () => {
    await pollNetLogger();
    scheduleNetLoggerPoll();
  }, (netsConfig.refreshNetloggerMinutes || 2) * 60 * 1000);
}

function scheduleNetFinderPoll() {
  clearTimeout(netfinderPollTimer);
  netfinderPollTimer = setTimeout(async () => {
    await pollNetFinder();
    scheduleNetFinderPoll();
  }, (netsConfig.refreshNetfinderMinutes || 30) * 60 * 1000);
}

function startNetsPolling() {
  if (!netsConfig.enabled) return;
  netSourceHealth.netlogger.status = netsConfig.netloggerEnabled ? 'OK' : 'DISABLED';
  netSourceHealth.netfinder.status = netsConfig.netfinderEnabled ? 'OK' : 'DISABLED';
  if (netsConfig.netloggerEnabled) {
    pollNetLogger().then(() => scheduleNetLoggerPoll());
  }
  if (netsConfig.netfinderEnabled) {
    // Delay NetFinder slightly to not hammer at startup
    setTimeout(() => pollNetFinder().then(() => scheduleNetFinderPoll()), 5000);
  }
}

// REST endpoints for Active Nets
app.get('/api/nets', (_req, res) => {
  res.json({
    nets: netsCombined,
    favorites: netsFavorites,
    sourceHealth: {
      netlogger: { ...netSourceHealth.netlogger },
      netfinder: { ...netSourceHealth.netfinder },
    },
  });
});

app.post('/api/nets/favorites', (req, res) => {
  try {
    const { favorites } = req.body || {};
    if (!Array.isArray(favorites)) return res.status(400).json({ error: 'favorites must be an array' });
    netsFavorites = favorites;
    saveNetsConfig();
    broadcastNets();
    res.json({ status: 'ok', count: netsFavorites.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/nets/refresh', (_req, res) => {
  if (!netsConfig.enabled) return res.status(400).json({ error: 'Active Nets disabled' });
  Promise.all([
    netsConfig.netloggerEnabled ? pollNetLogger() : Promise.resolve(),
    netsConfig.netfinderEnabled ? pollNetFinder() : Promise.resolve(),
  ]).catch(() => {});
  res.json({ status: 'refreshing' });
});

// --- Auto-shutdown when all browser tabs close ---

const SHUTDOWN_DELAY = 15000;
let shutdownTimer = null;
let everHadClient = false;

function cancelShutdown() {
  if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
}

function scheduleShutdown() {
  cancelShutdown();
  shutdownTimer = setTimeout(() => { stopAllSources(); process.exit(0); }, SHUTDOWN_DELAY);
}

// --- Start server ---

const server = http.createServer(app);
wss = new WebSocketServer({ server });

const PING_INTERVAL = 30000;
setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) { client.terminate(); continue; }
    client.isAlive = false;
    client.ping();
  }
}, PING_INTERVAL);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  everHadClient = true;
  cancelShutdown();

  ws.send(JSON.stringify({ type: 'status', data: getCompositeStatus() }));

  // Send cached special events immediately so the tab is populated before a full poll completes
  if (specialEvents.length) {
    ws.send(JSON.stringify({ type: 'special_events_refresh', data: { events: specialEvents, lastRefresh: specialEventsLastRefresh } }));
  }

  // Send cached propagation data if available
  if (propData) {
    ws.send(JSON.stringify({ type: 'propagation', data: propData }));
  }

  // Send cached nets data if available
  if (netsCombined.length || netsFavorites.length) {
    ws.send(JSON.stringify({ type: 'nets_refresh', data: {
      nets: netsCombined,
      favorites: netsFavorites,
      sourceHealth: {
        netlogger: { ...netSourceHealth.netlogger },
        netfinder: { ...netSourceHealth.netfinder },
      },
    }}));
  }

  ws.on('close', () => {
    if (everHadClient && wss.clients.size === 0) scheduleShutdown();
  });
});

loadEnvFile();
loadDupeConfig();
loadNetsConfig();
startNetsPolling();

server.listen(PORT, () => {
  console.log(`DX Spots server running at http://localhost:${PORT}`);
});
