'use strict';
// UPS 监控服务 —— 采集调度 + 配置中心 + 告警引擎 + REST API
// 不依赖 SNMP、不依赖任何第三方 npm 包
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store } = require('./lib/store');
const { Settings } = require('./lib/settings');
const { VertivITA2, tunnelMissing, identityOf, ENUM } = require('./lib/vertiv');
const { AlertEngine } = require('./lib/alerts');
const { HistoryStore } = require('./lib/history');
const thresholds = require('./lib/thresholds');
const grouping = require('./lib/grouping');

const PORT = Number(process.env.PORT || 8686);
const ROOT = __dirname;
const DATA_DIR = process.env.UPS_DATA_DIR || path.join(ROOT, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const store = new Store(path.join(DATA_DIR, 'devices.json'));
const settings = new Settings(path.join(DATA_DIR, 'settings.json'));
settings.devices = store.list();
const alertEngine = new AlertEngine(settings);
const history = new HistoryStore(path.join(DATA_DIR, 'history'));

const HISTORY_MAX = 3600;      // 内存环形缓冲：10s 间隔下约 10 小时（完整历史在磁盘）
// 三相机型额外落盘的分相字段；单相机型不写，降采样时按这个列表逐桶平均
const PHASE_KEYS = ['vInA', 'vInB', 'vInC', 'vOutA', 'vOutB', 'vOutC', 'iOutA', 'iOutB', 'iOutC'];
const SPARK_POINTS = 120;      // 随 /api/state 下发的趋势点数
const EVENTS_MAX = 400;
const DETAIL_EVERY = 3;        // 每 3 个周期拉一次明细接口 ≈ 30s
let HIST_OVERVIEW_CACHE = null; // 历史覆盖概览缓存（30 秒）

const events = [];
const runners = new Map();

function pushEvent(deviceId, level, msg) {
  const e = { ts: Date.now(), deviceId, level, msg };
  events.unshift(e);
  if (events.length > EVENTS_MAX) events.length = EVENTS_MAX;
  history.appendEvent(e);
}

function avgOf(tr) {
  if (!tr) return null;
  const vals = [tr.a, tr.b, tr.c].filter(v => v !== null && v !== undefined);
  if (!vals.length) return null;
  return vals.reduce((x, y) => x + y, 0) / vals.length;
}
function sumOf(tr) {
  if (!tr) return null;
  const vals = [tr.a, tr.b, tr.c].filter(v => v !== null && v !== undefined);
  if (!vals.length) return null;
  return vals.reduce((x, y) => x + y, 0);
}
// 按错误类型分级的退避策略
// 关键点：网络不通（VPN 掉线、网线松了）与设备限流是两回事，
// 前者要"快速恢复"，后者要"别再刺激设备"。
function backoffMs(code, failCount, intervalMs) {
  const n = Math.min(Math.max(failCount - 1, 0), 6);
  switch (code) {
    case 'TUNNEL_DOWN':
      // VPN / 零信任隧道未建立：固定 12 秒一探，隧道一恢复马上重新采集
      return 12000;
    case 'UNREACHABLE':
      // 网络不通：短退避，配合 TCP 快速探测，VPN 一恢复 15 秒内就能重新采集
      return Math.min(15000 * Math.pow(1.6, n), 60000);
    case 'SESSION_FULL':
    case 'SESSION_LOST':
      // 设备网页会话被限流：退避要长，别再去撞它的登录接口
      return Math.min(60000 * Math.pow(2, n), 300000);
    case 'LOGIN_THROTTLED':
      return Math.min(30000 * Math.pow(1.5, n), 120000);
    case 'AUTH_FAILED':
      // 账号密码不对，重试没有意义，5 分钟后再试
      return 300000;
    default:
      return Math.min(Math.max(intervalMs, 10000) * Math.pow(2, n), 120000);
  }
}

function pick(tr) {
  if (!tr) return null;
  return tr.a !== null && tr.a !== undefined ? tr.a : avgOf(tr);
}

// 阈值判定：给每个指标打绿/黄/红，并并入设备严重级别
function applyThresholds(snap) {
  const cfg = settings.thresholds();
  const levels = thresholds.evaluate(snap, cfg);
  snap.levels = levels;
  const issues = (snap.severity && snap.severity.issues ? snap.severity.issues.slice() : []);
  let lv = (snap.severity && snap.severity.level) || 'ok';
  for (const key of Object.keys(levels)) {
    const L = levels[key];
    if (!L || L.level === 'ok') continue;
    const label = (cfg[key] && cfg[key].label) || key;
    issues.push({ lvl: L.level, msg: label + ' ' + (L.text || '') });
    if (L.level === 'crit') lv = 'crit';
    else if (lv !== 'crit') lv = 'warn';
  }
  snap.severity = { level: lv, issues };
  return snap;
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
    this.lastTryAt = 0;
    this.lastErrorCode = null;   // 最近一次错误分类，用于选择退避策略
    this.nextRetryAt = 0;        // 下次重试时间戳，界面用来显示倒计时
    this.cycle = 0;
    this.timer = null;
    this.stopped = true;
    this.prevSeverity = null;
    this.identFilled = false;
    this.identTries = 0;         // 铭牌读取失败次数，用于指数退避
    this.identNextAt = 0;        // 下次尝试读取铭牌的时间戳
  }

  start(delay) {
    this.stopped = false;
    this.schedule(delay === undefined ? Math.random() * 2500 : delay);
  }

  stop() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  schedule(ms) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), Math.max(500, ms));
  }

  async tick() {
    if (this.stopped) return;
    if (this.dev.enabled === false) {
      this.status = 'disabled';
      this.schedule(5000);
      this.evalAlerts();
      return;
    }
    this.lastTryAt = Date.now();
    this.cycle++;
    const detail = this.cycle % DETAIL_EVERY === 1;
    const started = Date.now();
    try {
      // 上一轮是"网络不通"：先做一次纯 TCP 探测（不登录、不占设备会话）。
      // 端口一通就立刻重新采集——VPN 恢复后不再干等退避计时。
      if (this.lastErrorCode === 'UNREACHABLE' || this.lastErrorCode === 'TUNNEL_DOWN') {
        const p = await this.client.probePort(2000);
        if (!p.ok) {
          this.failCount++;
          // 隧道没建立时固定 12 秒一探——隧道恢复是瞬时的，指数退避反而拖慢恢复
          this.lastErrorCode = tunnelMissing(this.dev.host) ? 'TUNNEL_DOWN' : 'UNREACHABLE';
          if (this.lastErrorCode === 'TUNNEL_DOWN') {
            this.error = '网络不通：本机未建立到 10.x 内网的隧道（VPN / 零信任未连接）—— ' + this.dev.host;
          }
          this.scheduleRetry(this.lastErrorCode);
          this.evalAlerts();
          return;
        }
        this.lastErrorCode = null;   // 网络已恢复，继续走正常采集流程
      }
      const snap = await this.client.poll({ detail });
      applyThresholds(snap);
      const wasDown = this.status === 'offline' || this.status === 'degraded' || this.status === 'starting';
      this.snap = snap;
      this.status = 'online';
      this.error = null;
      this.lastErrorCode = null;
      this.failCount = 0;
      this.nextRetryAt = 0;
      this.lastOkAt = snap.ts;
      this.record(snap, detail);
      this.checkTransitions(snap, detail);
      if (wasDown) pushEvent(this.dev.id, 'ok', this.dev.name + '：已恢复在线');
      await this.autoFillModel(snap, this.client);
      const spent = Date.now() - started;
      this.schedule(Math.max(1000, this.dev.intervalMs - spent));
    } catch (e) {
      this.failCount++;
      this.status = this.snap ? 'degraded' : 'offline';
      this.error = e.message || String(e);
      this.lastErrorCode = e.code || 'UNKNOWN';
      if (this.failCount === 1) pushEvent(this.dev.id, 'crit', this.dev.name + '：' + this.error);
      this.scheduleRetry(this.lastErrorCode);
    }
    this.evalAlerts();
  }

  // 按错误类型计算下一次重试，并把时间暴露给界面
  // （让用户看到"X 秒后重试"，而不是以为系统挂了就干等）
  scheduleRetry(code) {
    const delay = backoffMs(code, this.failCount, this.dev.intervalMs);
    this.nextRetryAt = Date.now() + delay;
    this.schedule(delay);
  }

  // 型号 / 序列号留空时，用设备自报的信息自动补全（只补空字段，不覆盖手工填写的值）
  // 注意：序列号不在概览 JSON 里，只在「关于」页的 HTML 表格中，需要单独取一次。
  async autoFillModel(snap, client) {
    if (this.identFilled || !snap) return;
    const ip = client || this.client;
    const patch = {};

    // 型号：概览接口的 Other.PrdType 就够用，先填上，避免分组缺值
    if (!this.dev.model && snap.model) patch.model = snap.model;

    if (!this.dev.serial && Date.now() >= this.identNextAt) {
      let about = null;
      try {
        about = ip && typeof ip.readAbout === 'function' ? await ip.readAbout() : null;
      } catch (_) { /* 读不到就走退避，不打断采集 */ }
      if (about) {
        if (!this.dev.model && about.model) patch.model = about.model;
        if (!this.dev.serial && about.serial) patch.serial = about.serial;
      }
    }

    if (Object.keys(patch).length) {
      for (const k of Object.keys(patch)) this.dev[k] = patch[k];
      this.identFilled = !!(this.dev.serial || this.dev.model);
      try { store.save(); } catch (_) {}
      if (patch.serial) {
        pushEvent(this.dev.id, 'info', this.dev.name + '：已从设备读取序列号 ' + patch.serial);
      }
      return;
    }

    if (this.dev.serial) { this.identFilled = true; return; }

    // 没读到：设备可能确实不提供该字段，指数退避，最长 30 分钟再试一次，
    // 避免每 10 秒去翻一次设备网页
    this.identTries++;
    const delay = Math.min(60000 * Math.pow(2, this.identTries - 1), 30 * 60000);
    this.identNextAt = Date.now() + delay;
  }

  record(snap, detail) {
    const h = this.history;
    const point = {
      ts: snap.ts,
      supply: snap.supply.code,
      vOut: pick(snap.output.v),
      iOut: pick(snap.output.i),
      fOut: pick(snap.output.f),
      vIn: pick(snap.input.v),
      kw: sumOf(snap.load.kw),
      kva: sumOf(snap.load.kva),
      loadPct: avgOf(snap.load.pct),
      battCap: snap.battery.capPct,
      battV: snap.battery.vP,
      battI: snap.battery.iP,
      battState: snap.battery.stateP,
      backupMin: snap.battery.backupMin,
      envTemp: snap.env.tempC,
      battTemp: snap.battery.tempC,
      alarms: snap.alarms.count,
      faults: snap.alarms.faults
    };
    // 上面的 vOut / iOut / vIn 走 pick()，口径是"取 A 相"，B/C 相会丢。
    // 三相机型另外把三相分别落盘，历史才能画出三条线；单相机型不写，
    // 免得每点白占 9 个字段的体积。
    if (snap.phases >= 3) {
      const put = (prefix, tr) => {
        point[prefix + 'A'] = tr ? tr.a : null;
        point[prefix + 'B'] = tr ? tr.b : null;
        point[prefix + 'C'] = tr ? tr.c : null;
      };
      put('vIn', snap.input.v);
      put('vOut', snap.output.v);
      put('iOut', snap.output.i);
    }
    h.push(point);
    if (h.length > HISTORY_MAX) h.splice(0, h.length - HISTORY_MAX);
    // 完整历史落盘，永久保留
    try { history.append(this.dev.id, h[h.length - 1]); } catch (e) {}
  }

  checkTransitions(snap, detail) {
    const lvl = snap.severity.level;
    if (this.prevSeverity && this.prevSeverity !== lvl) {
      const msg = snap.severity.issues.length
        ? snap.severity.issues.map(i => i.msg).join('；')
        : '恢复正常';
      const map = { ok: 'ok', warn: 'warn', crit: 'crit' };
      pushEvent(this.dev.id, map[lvl] || 'warn', this.dev.name + '：' + msg);
    }
    this.prevSeverity = lvl;
    if (detail) {
      const caps = snap.caps;
      const sig = [caps.batteryTemp, caps.humidity, caps.envTemp].join(',');
      if (this.capsSig && this.capsSig !== sig) {
        pushEvent(this.dev.id, 'info', this.dev.name + '：传感器能力配置发生变化');
      }
      this.capsSig = sig;
    }
  }

  evalAlerts() {
    let items;
    try {
      items = alertEngine.evaluate(this.dev, { status: this.status, snap: this.snap });
    } catch (e) { return; }
    if (!items || !items.length) return;
    const devName = this.dev.name;
    alertEngine.dispatch(items).then((res) => {
      for (const r of res) {
        const ok = r.targets.filter(t => t.ok).length;
        const bad = r.targets.length - ok;
        const kindText = r.kind === 'recover' ? '恢复' : (r.kind === 'repeat' ? '持续' : '触发');
        pushEvent(this.dev.id, r.kind === 'recover' ? 'ok' : 'crit',
          devName + '：' + kindText + '告警「' + r.rule + '」' +
          (r.targets.length ? ('，已推送 ' + ok + ' 个通道' + (bad ? '，失败 ' + bad + ' 个' : '')) : '，无启用通道'));
      }
    }).catch(() => {});
  }

  toJSON(includeHistory) {
    const cfg = store.publicView(this.dev);
    return {
      cfg,
      status: this.status,
      error: this.error,
      failCount: this.failCount,
      lastOkAt: this.lastOkAt,
      lastTryAt: this.lastTryAt,
      lastErrorCode: this.lastErrorCode,
      nextRetryAt: this.nextRetryAt,
      snap: this.snap,
      history: includeHistory ? this.history : undefined,
      historyCount: this.history.length
    };
  }
}

function syncRunners() {
  const devs = store.list();
  settings.devices = devs;
  const ids = new Set(devs.map(d => d.id));
  for (const [id, r] of runners) {
    if (!ids.has(id)) { r.stop(); runners.delete(id); }
  }
  for (const d of devs) {
    const existing = runners.get(d.id);
    if (!existing) {
      const r = new Runner(d);
      runners.set(d.id, r);
      r.start();
    } else {
      existing.dev = d;
      existing.client.host = d.host;
      existing.client.port = d.port;
      existing.client.username = d.username;
      existing.client.password = d.password;
      if (d.enabled === false && existing.status !== 'disabled') {
        existing.stop();
        existing.status = 'disabled';
        existing.start(5000);
      }
    }
  }
}

// ---------------- HTTP ----------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function statePayload(groupBy) {
  syncRunners();
  const devs = store.list().slice().sort((a, b) => {
    const oa = Number(a.order) || 0, ob = Number(b.order) || 0;
    if (oa !== ob) return oa - ob;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
  const list = [];
  const stateById = {};
  for (const d of devs) {
    const r = runners.get(d.id);
    if (!r) continue;
    const j = r.toJSON(false);
    // 趋势序列随状态一起下发，前端不再逐台请求历史（30+ 台时这是关键）
    const h = r.history;
    const tail = h.length > SPARK_POINTS ? h.slice(-SPARK_POINTS) : h;
    j.spark = {
      vOut: tail.map(x => x.vOut),
      loadPct: tail.map(x => x.loadPct),
      vIn: tail.map(x => x.vIn),
      battCap: tail.map(x => x.battCap),
      envTemp: tail.map(x => x.envTemp)
    };
    list.push(j);
    stateById[d.id] = j;
  }
  const groups = settings.groups();
  const gb = groupBy || settings.all().ui.groupBy || 'none';
  const grouped = grouping.buildGroups(devs, groups, stateById, gb);
  return {
    serverTime: Date.now(),
    events: events.slice(0, 100),
    devices: list,
    groups,
    groupBy: gb,
    groupOptions: grouping.groupOptions(groups),
    grouped: grouped.map(g => ({
      group: g.group,
      deviceIds: g.items.map(it => it.dev.id)
    })),
    ui: settings.all().ui,
    auth: { enabled: settings.all().auth.enabled },
    alertHistory: alertEngine.recentHistory()
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;
  const m = req.method;

  try {
    // ---------- 持久化事件 ----------
    if (p === '/api/events' && m === 'GET') {
      const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 300));
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      return json(res, 200, {
        events: history.readEvents(limit,
          isFinite(from) && from > 0 ? from : null,
          isFinite(to) && to > 0 ? to : null)
      });
    }

    // ---------- 状态 ----------
    if (p === '/api/state' && m === 'GET') {
      return json(res, 200, statePayload(url.searchParams.get('groupBy')));
    }

    // ---------- 本地品牌 / 版权信息 ----------
    // 从 brand.local.json 读取，该文件被 .gitignore 排除，不会随仓库分发
    if (p === '/api/brand' && m === 'GET') {
      let brand = {};
      try {
        const bf = path.join(ROOT, 'brand.local.json');
        if (fs.existsSync(bf)) brand = JSON.parse(fs.readFileSync(bf, 'utf8')) || {};
      } catch (_) { brand = {}; }
      return json(res, 200, {
        org: String(brand.org || ''),
        contact: String(brand.contact || ''),
        year: String(brand.year || new Date().getFullYear())
      });
    }

    // ---------- 设置中心 ----------
    if (p === '/api/settings' && m === 'GET') {
      const s = settings.all();
      const channels = s.alerts.channels.map(c => {
        const cfg = Object.assign({}, c.config);
        if (cfg.pass) cfg.pass = '********';
        return Object.assign({}, c, { config: cfg });
      });
      return json(res, 200, {
        groups: s.groups,
        templates: s.templates,
        channels,
        rules: s.alerts.rules,
        ui: s.ui,
        thresholds: s.thresholds,
        auth: { enabled: s.auth.enabled, note: s.auth.note, userCount: (s.auth.users || []).length }
      });
    }
    if (p === '/api/settings/ui' && m === 'PUT') {
      const body = await readBody(req);
      return json(res, 200, { ui: settings.updateUi(body) });
    }

    // ---------- 指标阈值 ----------
    if (p === '/api/thresholds' && m === 'GET') {
      return json(res, 200, { thresholds: settings.thresholds() });
    }
    if (p === '/api/thresholds' && m === 'PUT') {
      const body = await readBody(req);
      const t = settings.updateThresholds(body);
      // 立刻用新阈值重算已有快照，下一次刷新即可看到颜色变化
      for (const r of runners.values()) if (r.snap) applyThresholds(r.snap);
      return json(res, 200, { thresholds: t });
    }
    if (p === '/api/thresholds/default' && m === 'GET') {
      return json(res, 200, { thresholds: thresholds.DEFAULT_THRESHOLDS });
    }
    if (p === '/api/thresholds/reset' && m === 'POST') {
      const t = settings.updateThresholds(thresholds.DEFAULT_THRESHOLDS);
      for (const r of runners.values()) if (r.snap) applyThresholds(r.snap);
      return json(res, 200, { thresholds: t });
    }

    // ---------- 分组 ----------
    if (p === '/api/groups' && m === 'GET') return json(res, 200, { groups: settings.groups() });
    if (p === '/api/groups' && m === 'POST') {
      const body = await readBody(req);
      return json(res, 200, { group: settings.addGroup(body) });
    }
    const mGroup = p.match(/^\/api\/groups\/([\w-]+)$/);
    if (mGroup) {
      if (m === 'PUT') {
        const body = await readBody(req);
        const g = settings.updateGroup(mGroup[1], body);
        return g ? json(res, 200, { group: g }) : json(res, 404, { error: '分组不存在' });
      }
      if (m === 'DELETE') {
        settings.devices = store.list();
        const ok = settings.removeGroup(mGroup[1]);
        if (ok) { store.save(); syncRunners(); }
        return json(res, ok ? 200 : 404, { ok });
      }
    }

    // ---------- 模板 ----------
    if (p === '/api/templates' && m === 'GET') return json(res, 200, { templates: settings.templates() });
    if (p === '/api/templates' && m === 'POST') {
      const body = await readBody(req);
      return json(res, 200, { template: settings.addTemplate(body) });
    }
    const mTpl = p.match(/^\/api\/templates\/([\w-]+)$/);
    if (mTpl) {
      if (m === 'PUT') {
        const body = await readBody(req);
        const t = settings.updateTemplate(mTpl[1], body);
        return t ? json(res, 200, { template: t }) : json(res, 404, { error: '模板不存在' });
      }
      if (m === 'DELETE') {
        const ok = settings.removeTemplate(mTpl[1]);
        return json(res, ok ? 200 : 404, { ok });
      }
    }

    // ---------- 告警渠道 ----------
    if (p === '/api/channels' && m === 'GET') return json(res, 200, { channels: settings.channels() });
    if (p === '/api/channels' && m === 'POST') {
      const body = await readBody(req);
      return json(res, 200, { channel: settings.addChannel(body) });
    }
    const mCh = p.match(/^\/api\/channels\/([\w-]+)$/);
    if (mCh) {
      if (m === 'PUT') {
        const body = await readBody(req);
        const c = settings.updateChannel(mCh[1], body);
        return c ? json(res, 200, { channel: c }) : json(res, 404, { error: '通道不存在' });
      }
      if (m === 'DELETE') {
        const ok = settings.removeChannel(mCh[1]);
        return json(res, ok ? 200 : 404, { ok });
      }
    }
    const mChTest = p.match(/^\/api\/channels\/([\w-]+)\/test$/);
    if (mChTest && m === 'POST') {
      const ch = settings.channels().find(c => c.id === mChTest[1]);
      if (!ch) return json(res, 404, { error: '通道不存在' });
      try {
        await alertEngine.testChannel(ch);
        return json(res, 200, { ok: true, msg: '测试消息已发送' });
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message });
      }
    }

    // ---------- 告警规则 ----------
    if (p === '/api/rules' && m === 'GET') return json(res, 200, { rules: settings.rules() });
    if (p === '/api/rules' && m === 'POST') {
      const body = await readBody(req);
      return json(res, 200, { rule: settings.addRule(body) });
    }
    const mRule = p.match(/^\/api\/rules\/([\w-]+)$/);
    if (mRule) {
      if (m === 'PUT') {
        const body = await readBody(req);
        const r = settings.updateRule(mRule[1], body);
        return r ? json(res, 200, { rule: r }) : json(res, 404, { error: '规则不存在' });
      }
      if (m === 'DELETE') {
        const ok = settings.removeRule(mRule[1]);
        return json(res, ok ? 200 : 404, { ok });
      }
    }

    // ---------- 设备 ----------
    if (p === '/api/devices' && m === 'GET') {
      return json(res, 200, { devices: store.list().map(d => store.publicView(d)) });
    }
    if (p === '/api/devices' && m === 'POST') {
      const body = await readBody(req);
      if (!body.host) return json(res, 400, { error: '缺少 IP 地址' });
      if (store.findByHost(body.host, body.port)) return json(res, 409, { error: '该 IP 已存在' });
      const dev = store.add(body);
      syncRunners();
      return json(res, 200, { device: store.publicView(dev) });
    }
    if (p === '/api/devices/reorder' && m === 'POST') {
      const body = await readBody(req);
      const n = store.reorder(body.ids || [], body.targetGroupId || null);
      syncRunners();
      return json(res, 200, { ok: true, affected: n });
    }
    if (p === '/api/devices/batch' && m === 'POST') {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const action = body.action;
      let n = 0;
      for (const id of ids) {
        const d = store.get(id);
        if (!d) continue;
        if (action === 'delete') { store.remove(id); history.removeDevice(id); n++; }
        else if (action === 'enable') { store.update(id, { enabled: true }); n++; }
        else if (action === 'disable') { store.update(id, { enabled: false }); n++; }
        else if (action === 'group') { store.update(id, { groupIds: body.groupIds || [] }); n++; }
        else if (action === 'site') { store.update(id, { site: body.site || '' }); n++; }
      }
      syncRunners();
      return json(res, 200, { ok: true, affected: n });
    }

    const mDev = p.match(/^\/api\/devices\/([0-9a-fA-F-]{36})$/);
    if (mDev) {
      const id = mDev[1];
      if (m === 'PUT') {
        const body = await readBody(req);
        const dev = store.update(id, body);
        if (!dev) return json(res, 404, { error: '设备不存在' });
        syncRunners();
        return json(res, 200, { device: store.publicView(dev) });
      }
      if (m === 'DELETE') {
        const ok = store.remove(id);
        history.removeDevice(id);
        syncRunners();
        return json(res, ok ? 200 : 404, { ok });
      }
    }

    // ---------- 历史数据覆盖概览（给「历史查询」页的设备下拉做提示） ----------
    if (p === '/api/history' && m === 'GET') {
      const now = Date.now();
      if (!HIST_OVERVIEW_CACHE || now - HIST_OVERVIEW_CACHE.ts > 30000) {
        const items = [];
        for (const d of store.list()) {
          const days = history.listDays(d.id);
          let bytes = 0;
          for (const day of days) {
            try { bytes += fs.statSync(path.join(DATA_DIR, 'history', d.id, day + '.jsonl')).size; } catch (e) {}
          }
          items.push({
            id: d.id, name: d.name, model: d.model || '', site: d.site || '',
            days: days.length, firstDay: days[0] || null, lastDay: days[days.length - 1] || null,
            bytes
          });
        }
        HIST_OVERVIEW_CACHE = { ts: now, items };
      }
      return json(res, 200, {
        devices: HIST_OVERVIEW_CACHE.items,
        totalBytes: HIST_OVERVIEW_CACHE.items.reduce((s, x) => s + x.bytes, 0)
      });
    }

    const mHist = p.match(/^\/api\/history\/([0-9a-fA-F-]{36})(\/export)?$/);
    if (mHist) {
      const id = mHist[1];
      const isExport = !!mHist[2];
      const r = runners.get(id);
      const range = url.searchParams.get('range') || '1h';
      const points = Math.max(50, Math.min(5000, Number(url.searchParams.get('points')) || 600));
      const now = Date.now();
      const span = {
        '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3,
        '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3,
        '90d': 90 * 24 * 3600e3, '365d': 365 * 24 * 3600e3
      }[range] || 3600e3;
      const toParam = Number(url.searchParams.get('to'));
      const fromParam = Number(url.searchParams.get('from'));
      const hasTo = isFinite(toParam) && toParam > 0;
      const hasFrom = isFinite(fromParam) && fromParam > 0;
      // 用户显式给了起止且颠倒，属于参数错误；只是被"不能超过当前时间"夹紧导致颠倒的，按空结果处理
      if (hasFrom && hasTo && fromParam >= toParam) {
        return json(res, 400, { error: '起始时间必须早于结束时间' });
      }
      const toTs = hasTo ? Math.min(toParam, now) : now;
      const fromTs = hasFrom ? fromParam : (toTs - span);
      if (fromTs >= toTs) {
        return json(res, 200, {
          history: [], range, from: Math.min(fromTs, toTs), to: toTs,
          device: (() => { const d = store.get(id); return d ? { id: d.id, name: d.name } : null; })(),
          days: [], allDays: history.listDays(id).length,
          stats: history.stats(id, fromTs, toTs),
          elapsedMs: 0, source: 'empty', note: '所选时段在未来，暂无可查数据'
        });
      }

      // ---------- CSV 导出：不降采样，全量落表 ----------
      if (isExport) {
        const maxRows = Math.max(100, Math.min(500000, Number(url.searchParams.get('max')) || 200000));
        const { rows, truncated } = history.exportRows(id, fromTs, toTs, maxRows);
        const dev = store.get(id);
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = (ts) => {
          const d = new Date(ts);
          return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
            pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        };
        const head = ['时间', '供电状态', '输入电压V', '输出电压V', '输出电流A', '输出频率Hz',
          '有功功率kW', '视在功率kVA', '负载率%', '电池容量%', '电池电压V', '电池电流A',
          '电池状态', '备电时长min', '环境温度℃', '电池温度℃', '告警数', '故障数',
          // 三相机型的相明细追加在最后 9 列，前 18 列顺序不变，旧的表格模板不用改
          '输入电压A相(V)', '输入电压B相(V)', '输入电压C相(V)',
          '输出电压A相(V)', '输出电压B相(V)', '输出电压C相(V)',
          '输出电流A相(A)', '输出电流B相(A)', '输出电流C相(A)'];
        const cell = (v) => {
          if (v === null || v === undefined) return '';
          const s = String(v);
          return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        };
        const lines = [head.join(',')];
        for (const o of rows) {
          lines.push([
            stamp(o.ts),
            (ENUM.supply[o.supply] || o.supply || ''),
            o.vIn, o.vOut, o.iOut, o.fOut, o.kw, o.kva, o.loadPct,
            o.battCap, o.battV, o.battI,
            (ENUM.battery[o.battState] || o.battState || ''),
            o.backupMin, o.envTemp, o.battTemp, o.alarms, o.faults,
            o.vInA, o.vInB, o.vInC, o.vOutA, o.vOutB, o.vOutC, o.iOutA, o.iOutB, o.iOutC
          ].map(cell).join(','));
        }
        // BOM：让 Excel 直接按 UTF-8 打开，中文表头不乱码
        const body = '\ufeff' + lines.join('\r\n') + '\r\n';
        const d0 = new Date(fromTs), d1 = new Date(toTs);
        const fname = (dev ? dev.name : id).replace(/[\\/:*?"<>|]/g, '_') + '_' +
          stamp(fromTs).replace(/[-: ]/g, '') + '-' + stamp(toTs).replace(/[-: ]/g, '') + '.csv';
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="history.csv"; filename*=UTF-8\'\'' + encodeURIComponent(fname),
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
          'X-Row-Count': String(rows.length),
          'X-Truncated': truncated ? '1' : '0'
        });
        return res.end(body);
      }

      // ---------- JSON 查询：内存优先，磁盘补齐 ----------
      const tStart = Date.now();
      const mem = r ? r.history.filter(h => h.ts >= fromTs && h.ts <= toTs) : [];
      let rows = mem.slice();
      const wantStats = url.searchParams.get('stats') !== '0';
      let stat = null;
      // 内存只是最近 HISTORY_MAX 点的滚动窗口（10s 间隔约 10 小时），点数够不代表覆盖得住
      // 整个区间。只有「点数够」且「内存起点不晚于查询左边界」时才能只靠内存，
      // 否则 7 天/30 天这类大区间会退化成最后那 10 小时。左边留 60s 容差，
      // 避免恰好在采样间隙上多读一次磁盘。
      const memCoversFrom = mem.length > 0 && mem[0].ts <= fromTs + 60000;
      if (mem.length < points || !memCoversFrom) {
        // 取点与统计合并为一次扫描，30 天这类大区间可省掉一遍全量解析
        const disk = history.readWithStats(id, fromTs, toTs, points, wantStats);
        const seen = new Set(mem.map(m => m.ts));
        for (const d of disk.points) if (!seen.has(d.ts)) rows.push(d);
        rows.sort((a, b) => a.ts - b.ts);
        stat = disk.stats;
      }
      if (!stat && wantStats) stat = history.stats(id, fromTs, toTs);
      if (rows.length > points) {
        const bucket = Math.ceil(rows.length / points);
        const out = [];
        for (let i = 0; i < rows.length; i += bucket) {
          const sl = rows.slice(i, i + bucket);
          const avg = (k) => {
            const vals = sl.map(s => s[k]).filter(v => v !== null && v !== undefined && v !== '');
            if (!vals.length) return null;
            return vals.reduce((x, y) => x + Number(y), 0) / vals.length;
          };
          const rec = Object.assign({}, sl[sl.length - 1], {
            ts: sl[Math.floor(sl.length / 2)].ts,
            vOut: avg('vOut'), vIn: avg('vIn'), iOut: avg('iOut'), fOut: avg('fOut'),
            kw: avg('kw'), kva: avg('kva'), loadPct: avg('loadPct'),
            battCap: avg('battCap'), battV: avg('battV'), battI: avg('battI'),
            backupMin: avg('backupMin'), envTemp: avg('envTemp'), battTemp: avg('battTemp')
          });
          // 分相字段同样要按桶取平均，否则降采样后三相曲线会退化成"桶内最后一条"
          for (const k of PHASE_KEYS) if (sl[0][k] !== undefined) rec[k] = avg(k);
          out.push(rec);
        }
        rows = out;
      }
      const days = history.listDays(id, fromTs, toTs);
      const dev = store.get(id);
      return json(res, 200, {
        history: rows, range, from: fromTs, to: toTs,
        device: dev ? { id: dev.id, name: dev.name, model: dev.model || '', site: dev.site || '' } : null,
        days,
        allDays: history.listDays(id).length,
        stats: stat,
        elapsedMs: Date.now() - tStart,
        source: rows.length ? (mem.length >= points && memCoversFrom ? 'mem' : 'mem+disk') : 'empty'
      });
    }

    const mPoll = p.match(/^\/api\/devices\/([0-9a-fA-F-]{36})\/poll$/);
    if (mPoll && m === 'POST') {
      const r = runners.get(mPoll[1]);
      if (!r) return json(res, 404, { error: '设备不存在' });
      r.client.sid = null;
      r.client.lastLoginAt = 0;
      r.failCount = 0;
      r.tick();
      return json(res, 200, { ok: true });
    }

    const mAlertTest = p.match(/^\/api\/devices\/([0-9a-fA-F-]{36})\/alert-test$/);
    if (mAlertTest && m === 'POST') {
      const d = store.get(mAlertTest[1]);
      if (!d) return json(res, 404, { error: '设备不存在' });
      const items = alertEngine.evaluate(d, { status: 'offline', snap: null });
      if (!items.length) return json(res, 200, { ok: false, msg: '当前规则未触发（已按"离线"状态模拟评估）' });
      const res = await alertEngine.dispatch(items);
      return json(res, 200, { ok: true, result: res });
    }

    if (p === '/api/test' && m === 'POST') {
      const body = await readBody(req);
      if (!body.host) return json(res, 400, { error: '缺少 IP 地址' });

      // 编辑已有设备时优先复用该设备已登录的会话：
      // ITA2 的网页会话槽极少，另起一个会话大概率被设备拒绝（"Too many users on-line"）
      if (body.deviceId) {
        const r = runners.get(String(body.deviceId));
        if (r && r.client && r.client.sid) {
          const t0 = Date.now();
          try {
            const about = await r.client.readAbout().catch(() => null);
            const identity = identityOf(r.client.lastHome);
            if (about) {
              if (about.serial) { identity.serial = about.serial; identity.serialKey = 'about.SerlNo'; }
              if (!identity.model && about.model) identity.model = about.model;
              if (!identity.firmware && about.firmware) identity.firmware = about.firmware;
              identity.about = about;
            }
            return json(res, 200, { ok: true, ms: Date.now() - t0, snap: r.snap, identity, reused: true });
          } catch (e) {
            return json(res, 200, { ok: false, error: e.message, code: e.code || null, ms: Date.now() - t0 });
          }
        }
      }

      // 编辑已有设备时允许不重填密码：从库里取用已保存的凭据
      let password = body.password || '';
      let username = body.username || 'user';
      if (!password && body.deviceId) {
        const cur = store.get(String(body.deviceId));
        if (cur) { password = cur.password || ''; username = cur.username || username; }
      }
      const client = new VertivITA2({
        host: String(body.host).trim(),
        port: Number(body.port) || 80,
        username: username,
        password: password
      });
      const t0 = Date.now();
      try {
        const snap = await client.poll({ detail: true });
        // 序列号只在「关于」页（HTML 表格）里，JSON 概览没有，单独取一次
        let about = null;
        try { about = await client.readAbout(); } catch (_) {}
        const ms = Date.now() - t0;
        // 顺带把设备自报的型号 / 序列号 / 固件回给前端，供表单自动填充
        const identity = identityOf(client.lastHome);
        if (about) {
          if (about.serial) { identity.serial = about.serial; identity.serialKey = 'about.SerlNo'; }
          if (!identity.model && about.model) identity.model = about.model;
          if (!identity.firmware && about.firmware) identity.firmware = about.firmware;
          identity.about = about;
        }
        // 测试连接是一次性会话，用完即释放，别占设备那点可怜的会话槽
        await client.logout().catch(() => {});
        return json(res, 200, { ok: true, ms, snap, identity });
      } catch (e) {
        await client.logout().catch(() => {});
        return json(res, 200, { ok: false, error: e.message, code: e.code || null, ms: Date.now() - t0 });
      }
    }

    // ---------- 静态文件 ----------
    let rel = p === '/' ? '/index.html' : p;
    if (rel.includes('..')) return json(res, 400, { error: 'bad path' });
    const file = path.join(ROOT, 'public', rel);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(file).pipe(res);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

syncRunners();
const flushTimer = setInterval(() => { try { history.flushAll(); } catch (e) {} }, 1000);
function shutdown() {
  try { clearInterval(flushTimer); history.flushAll(); } catch (e) {}
  try { server.close(); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log('UPS 监控已启动: http://localhost:' + PORT);
  console.log('设备数: ' + store.list().length + '  分组数: ' + settings.groups().length);
  console.log('历史数据目录: ' + path.join(DATA_DIR, 'history'));
});
