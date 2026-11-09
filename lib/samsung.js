import { execFile } from 'node:child_process';
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { promisify } from 'node:util';
import WebSocket from 'ws';

const run = promisify(execFile);
const CLIENT_NAME = Buffer.from('Samsung Wall').toString('base64');
const ALLOW_TIMEOUT_MS = 35000;
// Vendor prefixes of the screens seen so far. Asleep they answer ARP but nothing else.
const SAMSUNG_PREFIXES = ['04cb01', '280708', '800d3f'];

export async function getInfo(ip, timeoutMs = 2000) {
  const res = await fetch(`http://${ip}:8001/api/v2/`, { signal: AbortSignal.timeout(timeoutMs) });
  const { device } = await res.json();
  // Screens can report "none" here, so fall back to what the network sees.
  const wifiMac = device.wifiMac?.replace(/:/g, '').toLowerCase();
  const id = /^[0-9a-f]{12}$/.test(wifiMac) ? wifiMac : (await arpTable()).find((entry) => entry.ip === ip)?.mac;
  if (!id) throw new Error(`No MAC address for ${ip}.`);
  return {
    id,
    ip,
    name: device.name.replace(/&quot;/g, '"'),
    model: device.modelName,
    power: device.PowerState,
  };
}

const ipToInt = (ip) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const intToIp = (n) => [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.');

function localSubnets() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map((i) => ({ address: i.address, mask: ipToInt(i.netmask) }));
}

const sameSubnet = (a, b, mask) => (ipToInt(a) & mask) === (ipToInt(b) & mask);

// The address a monitor should use to reach this machine.
export function lanAddressFor(ip) {
  const subnets = localSubnets();
  return (subnets.find((s) => sameSubnet(s.address, ip, s.mask)) ?? subnets[0])?.address;
}

function hostsToScan() {
  const hosts = new Set();
  for (const { address, mask } of localSubnets()) {
    const size = Math.min(2 ** 32 - (mask >>> 0), 1024);
    const base = (ipToInt(address) & mask) >>> 0;
    for (let i = 1; i < size - 1; i++) hosts.add(intToIp(base + i));
  }
  return [...hosts];
}

function ssdpSearch(address, waitMs = 3000) {
  return new Promise((resolve) => {
    const hosts = new Set();
    const socket = dgram.createSocket('udp4');
    const finish = () => { socket.close(); resolve(hosts); };
    socket.on('error', () => resolve(hosts));
    socket.on('message', (raw, { address: from }) => {
      if (/samsung/i.test(raw.toString())) hosts.add(from);
    });
    socket.bind(0, address, () => {
      socket.setMulticastInterface(address);
      const search = 'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n';
      for (const delay of [0, 800]) setTimeout(() => socket.send(search, 1900, '239.255.255.250'), delay);
      setTimeout(finish, waitMs);
    });
  });
}

function portOpen(ip, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port: 8001, timeout: timeoutMs });
    const finish = (open) => { socket.destroy(); resolve(open); };
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
  });
}

async function portSweep() {
  const queue = hostsToScan();
  const open = [];
  const worker = async () => {
    while (queue.length) {
      const ip = queue.pop();
      if (await portOpen(ip)) open.push(ip);
    }
  };
  await Promise.all(Array.from({ length: 96 }, worker));
  return open;
}

async function arpTable() {
  const { stdout } = await run('arp', ['-an']).catch(() => ({ stdout: '' }));
  return [...stdout.matchAll(/\(([\d.]+)\) at ([0-9a-f:]+)/gi)].map(([, ip, mac]) => ({
    ip, mac: mac.split(':').map((part) => part.padStart(2, '0')).join('').toLowerCase(),
  }));
}

export async function findIpByMac(mac) {
  return (await arpTable()).find((entry) => entry.mac === mac)?.ip;
}

export function wake(macs) {
  const packets = macs.map((mac) => Buffer.concat([Buffer.alloc(6, 255), ...Array(16).fill(Buffer.from(mac, 'hex'))]));
  return Promise.all(localSubnets().filter((s) => s.mask !== 0xffffffff).map(({ address, mask }) => new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.on('error', resolve);
    socket.bind(0, address, async () => {
      socket.setBroadcast(true);
      const broadcast = intToIp((ipToInt(address) | ~mask) >>> 0);
      for (const packet of packets) await new Promise((sent) => socket.send(packet, 9, broadcast, sent));
      socket.close();
      resolve();
    });
  })));
}

// SSDP is quick but lossy on Wi-Fi and the sweep misses slow responders, so use both.
// Sleeping screens answer neither, so waking them needs a second look. The sweep fills the ARP table.
export async function discover(knownIps = [], wakeMacs = null) {
  const [ssdp, swept] = await Promise.all([
    Promise.all(localSubnets().map((s) => ssdpSearch(s.address))),
    portSweep(),
  ]);
  const candidates = new Set([...knownIps, ...swept, ...ssdp.flatMap((hosts) => [...hosts])]);
  if (wakeMacs) {
    const sleepers = (await arpTable()).filter((e) => !candidates.has(e.ip) && SAMSUNG_PREFIXES.includes(e.mac.slice(0, 6)));
    await wake([...new Set([...wakeMacs, ...sleepers.map((e) => e.mac)])]);
    for (const { ip } of sleepers) candidates.add(ip);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  const infos = await Promise.all([...candidates].map((ip) => getInfo(ip, 5000).catch(() => null)));
  return infos.filter(Boolean);
}

async function avTransport(ip, action, args = '') {
  const res = await fetch(`http://${ip}:9197/upnp/control/AVTransport1`, {
    method: 'POST',
    signal: AbortSignal.timeout(6000),
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPACTION: `"urn:schemas-upnp-org:service:AVTransport:1#${action}"`,
    },
    body: `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID>${args}</u:${action}></s:Body></s:Envelope>`,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(/<errorDescription>(.*?)</.exec(text)?.[1] ?? `Media receiver error ${res.status}.`);
  return text;
}

const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function didl(url, mimeType) {
  const itemClass = mimeType.startsWith('video/') ? 'object.item.videoItem' : 'object.item.imageItem.photo';
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>Samsung Wall</dc:title><upnp:class>${itemClass}</upnp:class><res protocolInfo="http-get:*:${mimeType}:*">${escapeXml(url)}</res></item></DIDL-Lite>`;
}

// Images and video go through the screen's DLNA receiver, which fetches the URL itself.
export async function loadMedia(ip, url, mimeType) {
  await stopMedia(ip).catch(() => null);
  await avTransport(ip, 'SetAVTransportURI', `<CurrentURI>${escapeXml(url)}</CurrentURI><CurrentURIMetaData>${escapeXml(didl(url, mimeType))}</CurrentURIMetaData>`);
}

export const playMedia = (ip) => avTransport(ip, 'Play', '<Speed>1</Speed>');
export const stopMedia = (ip) => avTransport(ip, 'Stop');

function pressKeyOnce(ip, token, key) {
  return new Promise((resolve, reject) => {
    const auth = token ? `&token=${token}` : '';
    const ws = new WebSocket(`wss://${ip}:8002/api/v2/channels/samsung.remote.control?name=${CLIENT_NAME}${auth}`, { rejectUnauthorized: false });
    const fail = (err) => { clearTimeout(timer); ws.terminate(); reject(err); };
    const timer = setTimeout(() => fail(new Error('Press Allow on the screen, then try again.')), ALLOW_TIMEOUT_MS);
    ws.on('error', fail);
    ws.on('message', (raw) => {
      const { event, data } = JSON.parse(raw);
      if (event === 'ms.channel.connect') {
        clearTimeout(timer);
        ws.send(JSON.stringify({ method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' } }));
        setTimeout(() => { ws.close(); resolve(data?.token ?? token); }, 500);
      } else if (event === 'ms.channel.unauthorized') {
        fail(Object.assign(new Error('Denied on the screen.'), { denied: true }));
      } else if (event === 'ms.channel.timeOut') {
        fail(new Error('The Allow prompt timed out on the screen.'));
      }
    });
  });
}

// The first press shows an Allow prompt, and the token it returns skips that next time.
// Screens sometimes reset the first TLS connection, so retry those.
export async function pressPcKey(ip, token) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await pressKeyOnce(ip, token, 'KEY_PCMODE');
    } catch (err) {
      if (attempt === 3 || !/ECONNRESET|socket hang up/.test(err.message)) throw err;
    }
  }
}

export async function receiverReady(ip) {
  const res = await fetch(`http://${ip}:9197/dmr`, { signal: AbortSignal.timeout(1500) }).catch(() => null);
  return !!res?.ok;
}

export async function playbackState(ip) {
  const reply = await avTransport(ip, 'GetTransportInfo');
  return /<CurrentTransportState>([^<]*)/.exec(reply)?.[1];
}
