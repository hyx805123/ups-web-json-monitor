'use strict';
// ============================================================
//  UPS 监控台 · 最简版本（回退备用）
//  功能：采集 + 看板 + 设备增删 + 内存历史趋势
//  与完整版（upsmon/）互不干扰，各自独立目录与端口
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store } = require('./lib/store');
const { VertivITA2 } = require('./lib/vertiv');

const PORT = Number(process.env.PORT || 8686);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const store = new Store(path.join(DATA_DIR, 'devices.json'));
const HISTORY_MAX = 1440;
const EVENTS_MAX = 200;
const DETAIL_EVERY = 3;

const events = [];
const runners = new Map();

function pushEvent(deviceId, level, msg) {
  events.unshift({ ts: Date.now(), deviceId, level, msg });
  if (events.length > EVENTS_MAX) events.length = EVENTS_MAX;
}

function avgOf(tr) {
  if (!tr) return null;
  const vals = [tr.a, tr.b, tr.c].filter(v => v !== null && v !== undefined);
  return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null;
}
function sumOf(tr) {
  if (!tr) return null;
  const vals = [tr.a, tr.b, tr.c].filter(v => v !== null && v !== undefined);
  return vals.length ? vals.reduce((x, y) => x + y, 0) : null;
}
function pick(tr) {
  if (!tr) return null;
  return tr.a !== null && tr.a !== undefined ? tr.a : avgOf(tr);
}

class Runner {
  constructor(dev) {
    this.dev = dev;
    this.client = new VertivITA2(dev);
    this.snap = null;
    this.history = [];
    this.status = dev.enabled === false ? 'disabled' : 'starting';
    this.error = null;
    this.failCount = 0;
    this.lastOkAt = 0;
    this.cycle = 0;
    this.timer = null;
    this.stopped = true;
    this.prevSeverity = null;
  }
  start(delay) { this.stopped = false; this.schedule(delay === undefined ? Math.random() * 2000 : delay); }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
  schedule(ms) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), Math.max(500, ms));
  }
  async tick() {
    if (this.stopped) return;
    if (this.dev.enabled === false) { this.status = 'disabled'; this.schedule(5000); return; }
    this.cycle++;
    const detail = this.cycle % DETAIL_EVERY === 1;
    const t0 = Date.now();
    try {
      const snap = await this.client.poll({ detail });
      const wasDown = this.status === 'offline' || this.status === 'degraded' || this.status === 'starting';
      this.snap = snap;
      this.status = 'online';
      this.error = null;
      this.failCount = 0;
      this.lastOkAt = snap.ts;
      this.record(snap);
      if (wasDown) pushEvent(this.dev.id, 'ok', this.dev.name + '：已恢复在线');
      this.schedule(Math.max(1000, this.dev.intervalMs - (Date.now() - t0)));
    } catch (e) {
      this.failCount++;
      this.status = this.snap ? 'degraded' : 'offline';
      this.error = e.message || String(e);
      if (this.failCount === 1) pushEvent(this.dev.id, 'crit', this.dev.name + '：' + this.error);
      const base = (e.code === 'SESSION_FULL' || e.code === 'UNREACHABLE') ? 60000 : this.dev.intervalMs;
      this.schedule(Math.min(base * Math.pow(2, Math.min(this.failCount - 1, 5)), 300000));
    }
  }
  record(snap) {
    this.history.push({
      ts: snap.ts, supply: snap.supply.code,
      vOut: pick(snap.output.v), iOut: pick(snap.output.i), fOut: pick(snap.output.f),
      vIn: pick(snap.input.v), kw: sumOf(snap.load.kw), loadPct: avgOf(snap.load.pct),
      battCap: snap.battery.capPct, battV: snap.battery.vP, envTemp: snap.env.tempC
    });
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
  }
  toJSON() {
    return {
      cfg: store.publicView(this.dev),
      status: this.status, error: this.error, failCount: this.failCount,
      lastOkAt: this.lastOkAt, snap: this.snap, historyCount: this.history.length
    };
  }
}

function syncRunners() {
  const devs = store.list();
  const ids = new Set(devs.map(d => d.id));
  for (const [id, r] of runners) if (!ids.has(id)) { r.stop(); runners.delete(id); }
  for (const d of devs) {
    if (!runners.has(d.id)) { const r = new Runner(d); runners.set(d.id, r); r.start(); }
    else runners.get(d.id).dev = d;
  }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname, m = req.method;
  try {
    if (p === '/api/state' && m === 'GET') {
      syncRunners();
      const devices = [];
      for (const d of store.list()) { const r = runners.get(d.id); if (r) devices.push(r.toJSON()); }
      return json(res, 200, { serverTime: Date.now(), devices, events: events.slice(0, 60) });
    }
    if (p === '/api/devices' && m === 'POST') {
      const b = await readBody(req);
      if (!b.host) return json(res, 400, { error: '缺少 IP 地址' });
      if (store.findByHost(b.host, b.port)) return json(res, 409, { error: '该 IP 已存在' });
      const dev = store.add(b);
      syncRunners();
      return json(res, 200, { device: store.publicView(dev) });
    }
    const mDev = p.match(/^\/api\/devices\/([0-9a-fA-F-]{36})$/);
    if (mDev && m === 'DELETE') {
      const ok = store.remove(mDev[1]);
      syncRunners();
      return json(res, ok ? 200 : 404, { ok });
    }
    const mHist = p.match(/^\/api\/history\/([0-9a-fA-F-]{36})$/);
    if (mHist && m === 'GET') {
      const r = runners.get(mHist[1]);
      if (!r) return json(res, 404, { error: '设备不存在' });
      const limit = Math.max(1, Math.min(HISTORY_MAX, Number(url.searchParams.get('limit')) || 360));
      return json(res, 200, { history: r.history.slice(-limit) });
    }
    if (p === '/api/test' && m === 'POST') {
      const b = await readBody(req);
      const client = new VertivITA2({ host: String(b.host || '').trim(), port: Number(b.port) || 80, username: b.username || 'user', password: b.password || '' });
      try {
        const snap = await client.poll({ detail: true });
        return json(res, 200, { ok: true, snap });
      } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }
    let rel = p === '/' ? '/index.html' : p;
    if (rel.includes('..')) return json(res, 400, { error: 'bad path' });
    const file = path.join(ROOT, 'public', rel);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file).toLowerCase();
      const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  } catch (e) { json(res, 500, { error: e.message }); }
});

syncRunners();
server.listen(PORT, () => {
  console.log('UPS 监控（最简版）已启动: http://localhost:' + PORT);
  console.log('设备数: ' + store.list().length);
});
