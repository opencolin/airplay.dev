import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ensureLive, getLive, hasClient, liveKey, stopUnused } from './lib/live.js';
import { discover, findIpByMac, getInfo, lanAddressFor, loadMedia, playbackState, playMedia, pressPcKey, receiverReady, stopMedia, wake } from './lib/samsung.js';

const PORT = Number(process.env.PORT ?? 8787);
const PASSWORD = process.env.DASHBOARD_PASSWORD;
const ROOT = import.meta.dirname;
const DATA = path.join(ROOT, 'data');
const MEDIA = path.join(DATA, 'media');
const STATE_FILE = path.join(DATA, 'state.json');
const MAX_UPLOAD = 500 * 1024 * 1024;
const CHECK_MS = 5000;
const CAST_GRACE_MS = 15000;
const MAX_RETRY_MS = 5 * 60000;
const RESCAN_MS = 5 * 60000;
const WAKE_ATTEMPTS = 5;
const IDENTIFY_MS = 8000;
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIDEO_TARGET_SECONDS = 8 * 3600;
const VIDEO_MAX_BYTES = 1e9;
const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const UPLOAD_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4' };
const MEDIA_TYPES = Object.fromEntries(Object.entries(UPLOAD_TYPES).map(([type, ext]) => [ext, type]));
const MEDIA_FILE = /^\/media\/[a-f0-9]{32}\.(png|jpg|gif|webp|mp4)$/;
const LIVE_PATH = /^\/live\/([a-f0-9]{24})\.ts$/;
const liveOptions = { chromePath: CHROME, dataDir: DATA };

fs.mkdirSync(MEDIA, { recursive: true });

const newId = () => crypto.randomBytes(8).toString('hex');

// Older versions saved only the monitors, and rendered websites to still frames.
function loadState() {
  const saved = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  const loaded = saved.monitors ? saved : { monitors: saved, groups: [], library: [] };
  for (const m of Object.values(loaded.monitors)) {
    if (m.content?.type === 'site') m.content = { type: 'live', src: m.content.src };
    if (m.content && !loaded.library.some((asset) => asset.src === m.content.src)) {
      const type = m.content.type === 'live' ? 'url' : m.content.type;
      loaded.library.push({ id: newId(), name: m.content.src, type, src: m.content.src });
    }
  }
  return loaded;
}

const state = loadState();
const { monitors } = state;
const runtime = new Map(); // monitor id -> { busy, status, error, failures, nextTry, castAt }
let scanning = null;
let lastScan = 0;
let rollout = 0; // A new send cancels any one-by-one send still in progress.

function save() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function statusOf(monitor) {
  if (!runtime.has(monitor.id)) runtime.set(monitor.id, { busy: false, status: 'checking', error: null, failures: 0, nextTry: 0, castAt: 0 });
  return runtime.get(monitor.id);
}

function publicMonitor(m) {
  const { status, error } = statusOf(m);
  const asset = state.library.find((a) => a.src === m.content?.src);
  return {
    id: m.id, ip: m.ip, name: m.name, label: m.label, model: m.model, status, error,
    content: m.content ? { type: m.content.type, name: asset?.name ?? m.content.src } : null,
  };
}

const publicState = () => ({
  scanning: !!scanning, monitors: Object.values(monitors).map(publicMonitor), groups: state.groups, library: state.library,
});

function scan({ wakeSleepers = false } = {}) {
  lastScan = Date.now();
  const known = Object.values(monitors);
  scanning ??= discover(known.map((m) => m.ip), wakeSleepers ? known.map((m) => m.id) : null).then((found) => {
    for (const info of found) {
      monitors[info.id] = { label: info.name, ...monitors[info.id], ...info };
    }
    save();
  }).finally(() => { scanning = null; });
  return scanning;
}

// Sleeping screens drop off the network, and DHCP can move them while they're gone.
async function ensureAwake(monitor, { needsReceiver = true } = {}) {
  for (let attempt = 0; attempt < WAKE_ATTEMPTS; attempt++) {
    const info = await getInfo(monitor.ip, 1500).catch(() => null);
    if (info?.id === monitor.id && info.power !== 'standby' && (!needsReceiver || await receiverReady(monitor.ip))) return;
    await wake([monitor.id]);
    const ip = await findIpByMac(monitor.id);
    if (ip && ip !== monitor.ip) {
      monitor.ip = ip;
      save();
    }
    await sleep(1500);
  }
  throw new Error('The screen did not wake. Is it plugged in and on this network?');
}

function mediaFor(monitor, content) {
  const base = `http://${lanAddressFor(monitor.ip)}:${PORT}`;
  if (content.type === 'live') return [`${base}/live/${liveKey(content.src)}.ts`, 'video/mp2t'];
  return [`${base}${content.src}`, MEDIA_TYPES[content.src.split('.')[1]]];
}

async function load(monitor, content) {
  if (content.type === 'live') await ensureLive(content.src, liveOptions);
  await ensureAwake(monitor);
  await loadMedia(monitor.ip, ...mediaFor(monitor, content));
}

async function start(monitor) {
  await playMedia(monitor.ip);
  Object.assign(statusOf(monitor), { status: 'playing', error: null, failures: 0, nextTry: 0, castAt: Date.now() });
}

function failed(monitor, err) {
  const status = statusOf(monitor);
  status.failures++;
  Object.assign(status, {
    status: 'error', error: err.message, castAt: Date.now(),
    nextTry: Date.now() + Math.min(CHECK_MS * 2 ** status.failures, MAX_RETRY_MS),
  });
}

const stopUnusedStreams = () => stopUnused(new Set(
  Object.values(monitors).filter((m) => m.content?.type === 'live').map((m) => m.content.src),
));

const hasPcSource = (monitor) => /smart monitor/i.test(monitor.name);

async function switchToPc(monitor) {
  const status = statusOf(monitor);
  status.busy = true;
  try {
    await stopMedia(monitor.ip).catch(() => null);
    monitor.token = await pressPcKey(monitor.ip, monitor.token);
    save();
  } catch (err) {
    if (err.denied) {
      delete monitor.token;
      save();
    }
    throw err;
  } finally {
    status.busy = false;
  }
}

async function forEachScreen(list, action) {
  const failures = [];
  await Promise.all(list.map((m) => action(m).catch((err) => failures.push(`${m.label} (${m.ip}): ${err.message}`))));
  return failures.join('\n');
}

function releaseScreens(list) {
  rollout++;
  for (const m of list) m.content = null;
  save();
  stopUnusedStreams();
}

// Load every screen first, then start them together so they begin as close as possible.
async function sendTogether(list, content) {
  for (const m of list) {
    m.content = content;
    Object.assign(statusOf(m), { busy: true, status: 'sending' });
  }
  save();
  stopUnusedStreams();
  const loaded = await Promise.all(list.map((m) => load(m, content).then(() => null, (err) => err)));
  await Promise.all(list.map(async (m, i) => {
    try {
      if (loaded[i]) throw loaded[i];
      await start(m);
    } catch (err) {
      failed(m, err);
    } finally {
      statusOf(m).busy = false;
    }
  }));
}

async function sendOneByOne(list, content, delayMs) {
  const current = ++rollout;
  for (const [i, m] of list.entries()) {
    if (i) await sleep(delayMs);
    if (current !== rollout) return;
    await sendTogether([m], content);
  }
}

function targets(ids) {
  const list = (ids ?? []).map((id) => monitors[id]).filter(Boolean);
  if (!list.length) throw new Error('Select at least one screen.');
  return list;
}

const healthyStates = new Set(['PLAYING', 'TRANSITIONING']);

// Content is sent once. If the screen stops playing it (someone picked another input, turned it
// off, or the stream dropped) the hub lets go rather than pushing it back, so people can use the screen.
async function check(monitor) {
  const status = statusOf(monitor);
  if (status.busy) return;
  const transport = await playbackState(monitor.ip).catch(() => null);
  const { content } = monitor;
  if (status.busy) return;
  if (!content) {
    Object.assign(status, { status: transport ? 'idle' : 'asleep', error: null });
    return;
  }
  const now = Date.now();
  const streaming = content.type !== 'live' || hasClient(content.src, monitor.ip);
  if (healthyStates.has(transport) && (streaming || now - status.castAt < CAST_GRACE_MS)) {
    if (transport === 'PLAYING' && streaming) Object.assign(status, { status: 'playing', error: null, failures: 0 });
    return;
  }
  if (now - status.castAt < CAST_GRACE_MS) return;
  monitor.content = null;
  save();
  stopUnusedStreams();
  if (status.status !== 'error') Object.assign(status, { status: transport ? 'idle' : 'asleep', error: null });
}

async function checkScreens() {
  await Promise.all(Object.values(monitors).map((m) => check(m).catch((err) => console.error(m.ip, err.message))));
  setTimeout(checkScreens, CHECK_MS);
}

async function labelImage(text) {
  const name = `${crypto.createHash('md5').update(text).digest('hex')}.png`;
  const file = path.join(MEDIA, name);
  if (!fs.existsSync(file)) {
    const safe = text.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
    const page = `<body style="margin:0;height:100vh;display:grid;place-items:center;background:#111;color:#fff;font:bold 150px system-ui;text-align:center">${safe}</body>`;
    await run(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${path.join(DATA, 'chrome', 'label')}`,
      '--window-size=1920,1080', `--screenshot=${file}`, `data:text/html;charset=utf-8,${encodeURIComponent(page)}`,
    ], { timeout: 30000 });
  }
  return `/media/${name}`;
}

async function identify(monitor) {
  const status = statusOf(monitor);
  if (status.busy) return;
  status.busy = true;
  try {
    await load(monitor, { type: 'image', src: await labelImage(`${monitor.label}\n${monitor.ip}`) });
    await playMedia(monitor.ip);
    await sleep(IDENTIFY_MS);
    if (monitor.content) {
      await load(monitor, monitor.content);
      await start(monitor);
    } else {
      await stopMedia(monitor.ip);
    }
  } catch (err) {
    failed(monitor, err);
  } finally {
    status.busy = false;
  }
}

// Each restart brings up the screen's player controls, so repeat short videos into one long file.
async function extendVideo(src) {
  const file = path.join(DATA, src);
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    const loops = Math.floor(Math.min(VIDEO_TARGET_SECONDS / Number(stdout), VIDEO_MAX_BYTES / fs.statSync(file).size));
    if (!(loops > 1)) return src;
    const name = `/media/${crypto.randomBytes(16).toString('hex')}.mp4`;
    await run('ffmpeg', ['-y', '-v', 'error', '-stream_loop', String(loops - 1), '-i', file, '-c', 'copy', '-movflags', '+faststart', path.join(DATA, name)], { timeout: 300000 });
    fs.rmSync(file);
    return name;
  } catch (err) {
    console.error('Could not extend video:', err.message);
    return src;
  }
}

function saveMedia(type, data) {
  const name = `${crypto.randomBytes(16).toString('hex')}.${UPLOAD_TYPES[type]}`;
  fs.writeFileSync(path.join(MEDIA, name), data);
  return `/media/${name}`;
}

function addAsset(name, type, src) {
  const asset = { id: newId(), name: name.slice(0, 80), type, src };
  state.library.push(asset);
  save();
  return asset;
}

function deleteAsset(id) {
  const asset = state.library.find((a) => a.id === id);
  if (!asset) throw new Error('Unknown item.');
  if (Object.values(monitors).some((m) => m.content?.src === asset.src)) throw new Error('A screen is showing this. Send something else first.');
  state.library.splice(state.library.indexOf(asset), 1);
  if (MEDIA_FILE.test(asset.src)) fs.rmSync(path.join(DATA, asset.src), { force: true });
  save();
}

function contentFor(assetId) {
  const asset = state.library.find((a) => a.id === assetId);
  if (!asset) throw new Error('Choose something from the library.');
  return { type: asset.type === 'url' ? 'live' : asset.type, src: asset.src };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('File too large.'), { status: 413 }));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const readJson = async (req) => JSON.parse((await readBody(req, 100000)).toString() || '{}');

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Media receivers read video in byte ranges.
function streamMedia(req, res, file, type) {
  const size = fs.statSync(file, { throwIfNoEntry: false })?.size;
  if (size === undefined) return sendJson(res, 404, { error: 'Not found' });
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  const start = range?.[1] ? Number(range[1]) : range?.[2] ? Math.max(size - Number(range[2]), 0) : 0;
  const end = range?.[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(range ? 206 : 200, {
    'Content-Type': type,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'transferMode.dlna.org': 'Streaming',
    'contentFeatures.dlna.org': 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000',
    ...(range && { 'Content-Range': `bytes ${start}-${end}/${size}` }),
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}

function streamLive(req, res, key) {
  const stream = getLive(key);
  if (!stream) return sendJson(res, 404, { error: 'Not found' });
  res.writeHead(200, {
    'Content-Type': 'video/mp2t',
    'Cache-Control': 'no-store',
    'transferMode.dlna.org': 'Streaming',
    'contentFeatures.dlna.org': 'DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000',
  });
  if (req.method === 'HEAD') return res.end();
  stream.attach(res, clientIp(req));
}

function sendFile(res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
}

const clientIp = (req) => req.socket.remoteAddress.replace(/^::ffff:/, '');

function passwordMatches(req) {
  const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Basic' || !encoded || !PASSWORD) return false;
  const given = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':');
  const hash = (text) => crypto.createHash('sha256').update(text).digest();
  return crypto.timingSafeEqual(hash(given), hash(PASSWORD));
}

// Screens only need the media routes. Everything else needs this machine or the password,
// and the Origin check stops other websites from driving it through a browser.
function authorize(req, res) {
  const { host = '', origin } = req.headers;
  if (origin && origin !== `http://${host}`) {
    sendJson(res, 403, { error: 'Cross-site request refused.' });
    return false;
  }
  const local = ['127.0.0.1', '::1'].includes(clientIp(req)) && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  if (local || passwordMatches(req)) return true;
  if (!PASSWORD) {
    sendJson(res, 403, { error: 'Set DASHBOARD_PASSWORD to open the dashboard from other devices.' });
    return false;
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="airplay.dev"', 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Password required.' }));
  return false;
}

async function handleControl(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /') return sendFile(res, path.join(ROOT, 'public/index.html'), 'text/html');
  if (route === 'GET /api/state') return sendJson(res, 200, publicState());
  if (route === 'POST /api/scan') {
    await scanning?.catch(() => null);
    await scan({ wakeSleepers: true });
    return sendJson(res, 200, publicState());
  }
  if (route === 'POST /api/show') {
    const { ids, assetId, mode, delaySeconds } = await readJson(req);
    const list = targets(ids);
    const content = contentFor(assetId);
    if (mode === 'sequence') {
      sendOneByOne(list, content, Math.max(Number(delaySeconds) || 0, 0) * 1000);
    } else {
      rollout++;
      await sendTogether(list, content);
    }
    return sendJson(res, 200, publicState());
  }
  if (route === 'POST /api/clear') {
    const list = targets((await readJson(req)).ids);
    releaseScreens(list);
    const message = await forEachScreen(list, async (m) => {
      const awake = (await getInfo(m.ip).catch(() => null))?.power === 'on';
      if (awake && hasPcSource(m)) await switchToPc(m);
      else await stopMedia(m.ip).catch(() => null);
    });
    return sendJson(res, 200, { ...publicState(), message });
  }
  if (route === 'POST /api/pc') {
    const list = targets((await readJson(req)).ids).filter(hasPcSource);
    if (!list.length) return sendJson(res, 400, { error: 'Only the monitors have a PC source.' });
    releaseScreens(list);
    const message = await forEachScreen(list, async (m) => {
      await ensureAwake(m, { needsReceiver: false });
      await switchToPc(m);
    });
    return sendJson(res, 200, { ...publicState(), message });
  }
  if (route === 'POST /api/identify') {
    for (const m of targets((await readJson(req)).ids)) identify(m);
    return sendJson(res, 200, publicState());
  }
  if (route === 'POST /api/rename') {
    const { id, label } = await readJson(req);
    if (!monitors[id] || !label?.trim()) return sendJson(res, 400, { error: 'Invalid name.' });
    monitors[id].label = label.trim().slice(0, 40);
    save();
    return sendJson(res, 200, publicState());
  }
  if (route === 'POST /api/groups') {
    const { name, ids } = await readJson(req);
    if (!name?.trim()) return sendJson(res, 400, { error: 'Name the group.' });
    state.groups.push({ id: newId(), name: name.trim().slice(0, 40), ids: targets(ids).map((m) => m.id) });
    save();
    return sendJson(res, 200, publicState());
  }
  if (route === 'POST /api/groups/delete') {
    const { id } = await readJson(req);
    state.groups = state.groups.filter((g) => g.id !== id);
    save();
    return sendJson(res, 200, publicState());
  }
  if (route === 'POST /api/library') {
    const { src } = await readJson(req);
    const page = URL.canParse(src) ? new URL(src) : null;
    if (!page || !['http:', 'https:'].includes(page.protocol)) return sendJson(res, 400, { error: 'Enter a full http(s) URL.' });
    addAsset(page.href, 'url', page.href);
    return sendJson(res, 200, publicState());
  }
  if (route === 'POST /api/library/delete') {
    deleteAsset((await readJson(req)).id);
    return sendJson(res, 200, publicState());
  }
  if (route === 'POST /api/upload') {
    const type = req.headers['content-type'];
    if (!UPLOAD_TYPES[type]) return sendJson(res, 415, { error: 'Use a PNG, JPEG, GIF, WebP, or MP4 file.' });
    const saved = saveMedia(type, await readBody(req, MAX_UPLOAD));
    const video = saved.endsWith('.mp4');
    const name = decodeURIComponent(req.headers['x-file-name'] ?? '') || 'Upload';
    addAsset(name, video ? 'video' : 'image', video ? await extendVideo(saved) : saved);
    return sendJson(res, 200, publicState());
  }
  sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (['GET', 'HEAD'].includes(req.method)) {
      if (MEDIA_FILE.test(url.pathname)) return streamMedia(req, res, path.join(DATA, url.pathname), MEDIA_TYPES[url.pathname.split('.')[1]]);
      const live = LIVE_PATH.exec(url.pathname);
      if (live) return streamLive(req, res, live[1]);
      // The onboarding page holds no secrets, so anyone on the network can read it.
      if (url.pathname === '/start') return sendFile(res, path.join(ROOT, 'site/index.html'), 'text/html');
    }
    if (authorize(req, res)) await handleControl(req, res, url);
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status ?? 400, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
  scan().catch((err) => console.error('Scan failed:', err.message));
  checkScreens();
});
