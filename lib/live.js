import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
const START_TIMEOUT_MS = 30000;
const NAVIGATE_RETRY_MS = 30000;
const MAX_CLIENT_BACKLOG = 32 * 1024 * 1024;
const ENCODER = process.platform === 'darwin'
  ? ['-c:v', 'h264_videotoolbox', '-realtime', '1', '-profile:v', 'high']
  : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency'];

const streams = new Map(); // key -> stream
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const liveKey = (url) => crypto.createHash('sha256').update(url).digest('hex').slice(0, 24);

async function devtoolsTarget(profile) {
  for (let attempt = 0; attempt < 80; attempt++) {
    await sleep(250);
    try {
      const [port] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* Chrome is still starting */ }
  }
  throw new Error('Chrome did not start.');
}

// A page runs in headless Chrome, its frames are encoded once, and every screen shares that stream.
function startStream(url, key, { chromePath, dataDir }) {
  const profile = path.join(dataDir, 'chrome', key);
  fs.mkdirSync(profile, { recursive: true });
  fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });

  const stream = { url, clients: new Set(), stopped: false };
  let frame = null;
  let pump = null;
  let devtools = null;

  const chrome = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=0', `--window-size=${WIDTH},${HEIGHT}`, `--user-data-dir=${profile}`,
    '--hide-scrollbars', '--no-first-run', '--autoplay-policy=no-user-gesture-required', 'about:blank',
  ], { stdio: 'ignore' });
  const ffmpeg = spawn('ffmpeg', [
    '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', 'pipe:0',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-vf', `scale=${WIDTH}:${HEIGHT},format=yuv420p`,
    ...ENCODER, '-b:v', '8M', '-g', String(FPS), '-c:a', 'aac', '-b:a', '96k',
    '-f', 'mpegts', '-mpegts_flags', 'resend_headers', '-pat_period', '0.5', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'inherit'] });

  stream.stop = () => {
    if (stream.stopped) return;
    stream.stopped = true;
    streams.delete(key);
    clearInterval(pump);
    devtools?.terminate();
    chrome.kill('SIGKILL');
    ffmpeg.kill('SIGKILL');
    for (const client of stream.clients) client.res.destroy();
  };

  stream.attach = (res, ip) => {
    const client = { res, ip };
    stream.clients.add(client);
    res.on('close', () => stream.clients.delete(client));
  };

  stream.ready = new Promise((resolve, reject) => {
    const fail = (err) => { reject(err); stream.stop(); };
    const timeout = setTimeout(() => fail(new Error('The page did not start streaming.')), START_TIMEOUT_MS);

    for (const child of [chrome, ffmpeg]) {
      child.on('error', fail);
      child.on('exit', () => fail(new Error('The live stream stopped.')));
    }
    ffmpeg.stdin.on('error', () => stream.stop());
    ffmpeg.stdout.on('data', (data) => {
      clearTimeout(timeout);
      resolve();
      for (const client of stream.clients) {
        if (client.res.writableLength > MAX_CLIENT_BACKLOG) client.res.destroy();
        else client.res.write(data);
      }
    });

    (async () => {
      devtools = new WebSocket(await devtoolsTarget(profile));
      await new Promise((open) => devtools.once('open', open));
      devtools.on('close', () => stream.stop());
      let nextId = 0;
      const replies = new Map();
      const send = (method, params = {}) => new Promise((reply) => {
        replies.set(++nextId, reply);
        devtools.send(JSON.stringify({ id: nextId, method, params }));
      });
      devtools.on('message', (raw) => {
        const message = JSON.parse(raw);
        replies.get(message.id)?.(message.result ?? {});
        replies.delete(message.id);
        if (message.method === 'Page.screencastFrame') {
          frame = Buffer.from(message.params.data, 'base64');
          send('Page.screencastFrameAck', { sessionId: message.params.sessionId });
        }
      });

      await send('Page.enable');
      await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
      let { errorText } = await send('Page.navigate', { url });
      await sleep(2000);
      send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });

      // Chrome only sends a frame when the page changes, so repeat the last one to keep a steady rate.
      const started = Date.now();
      let sent = 0;
      pump = setInterval(() => {
        if (!frame || ffmpeg.stdin.writableNeedDrain) return;
        const due = Math.floor((Date.now() - started) * FPS / 1000);
        sent = Math.max(sent, due - FPS);
        for (; sent < due; sent++) ffmpeg.stdin.write(frame);
      }, 10);

      while (errorText && !stream.stopped) {
        await sleep(NAVIGATE_RETRY_MS);
        if (!stream.stopped) ({ errorText } = await send('Page.navigate', { url }));
      }
    })().catch(fail);
  });
  stream.ready.catch((err) => console.error(`Live stream of ${url}:`, err.message));
  return stream;
}

export function ensureLive(url, options) {
  const key = liveKey(url);
  if (!streams.has(key)) streams.set(key, startStream(url, key, options));
  return streams.get(key).ready;
}

export const getLive = (key) => streams.get(key);

export const hasClient = (url, ip) => [...(streams.get(liveKey(url))?.clients ?? [])].some((c) => c.ip === ip);

export function stopUnused(wantedUrls) {
  for (const stream of [...streams.values()]) {
    if (!wantedUrls.has(stream.url)) stream.stop();
  }
}
