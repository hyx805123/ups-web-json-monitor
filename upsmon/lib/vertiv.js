'use strict';
// Vertiv ITA2 内建 Web 驱动
// 数据来源全部是设备自身的 JSON 接口，不依赖 SNMP：
//   /_com/home/home.json      概览（供电状态/电压电流频率/负载/电池/温度/机型/告警数）
//   /_com/status/input.json   输入含功率因数与累计电能
//   /_com/status/output.json  输出累计电能
//   /_com/status/load.json    视在功率、峰值因数
//   /_com/status/bypass.json  旁路
//   /_com/status/battery.json 电池组数、柜温、温湿度传感器是否存在
//   /_com/_infor/infor.json   设备 IP 与 UPS 时间
const net = require('net');
const { request } = require('./http10');

const ENUM = {
  supply: { 0: '均不供电', 1: '旁路供电', 2: '逆变供电', 3: '联合供电' },
  battery: {
    0: '无电池', 1: '浮充', 2: '均充', 3: '放电中',
    4: '已充满', 5: '非充非放', 6: '自检中'
  }
};

const SUPPLY_LEVEL = { 0: 'crit', 1: 'warn', 2: 'ok', 3: 'warn' };
const BATT_LEVEL = { 0: 'crit', 1: 'ok', 2: 'ok', 3: 'warn', 4: 'ok', 5: 'ok', 6: 'warn' };

// 判断是不是"本机到该内网段没有路径"——通常意味着 VPN / 零信任隧道掉了，
// 而不是设备本身坏了。区分开能让用户一眼看出该去连 VPN 还是去查设备。
//
// 判定方式：读本机 IPv4 路由表，找出能匹配目标 IP 的最长前缀路由。
// 私有网段(10/8、172.16/12、192.168/16)的流量如果只匹配到默认路由 0.0.0.0/0，
// 说明它会从普通出口(比如无线)发出去，必然到不了内网 —— 判定为隧道未建立。
let ROUTE_CACHE = { ts: 0, list: null };
function routeTable() {
  const now = Date.now();
  if (ROUTE_CACHE.list && now - ROUTE_CACHE.ts < 5000) return ROUTE_CACHE.list;
  const list = [];
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('route', ['print', '-4'], {
      encoding: 'latin1', timeout: 4000, windowsHide: true
    });
    const re = /^\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/;
    for (const line of String(out).split(/\r?\n/)) {
      const m = line.match(re);
      if (m) list.push({ dest: m[1], mask: m[2], gw: m[3], iface: m[4] });
    }
  } catch (_) { /* 读不到路由表就放弃判断，不影响采集 */ }
  ROUTE_CACHE = { ts: now, list };
  return list;
}
function isPrivate(ip) {
  const t = ip.split('.').map(Number);
  if (t.length !== 4 || t.some(n => !Number.isFinite(n))) return false;
  if (t[0] === 10) return true;
  if (t[0] === 172 && t[1] >= 16 && t[1] <= 31) return true;
  if (t[0] === 192 && t[1] === 168) return true;
  return false;
}
function tunnelMissing(host) {
  try {
    const ip = String(host || '');
    if (!isPrivate(ip)) return false;
    const list = routeTable();
    if (!list.length) return false;               // 读不到路由表就不下结论
    const t = ip.split('.').map(Number);
    const target = ((t[0] << 24) | (t[1] << 16) | (t[2] << 8) | t[3]) >>> 0;
    let best = null, bestBits = -1;
    for (const r of list) {
      const d = r.dest.split('.').map(Number);
      const m = r.mask.split('.').map(Number);
      const dv = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
      const mv = ((m[0] << 24) | (m[1] << 16) | (m[2] << 8) | m[3]) >>> 0;
      if ((target & mv) !== (dv & mv)) continue;
      let bits = 0;
      for (let i = 31; i >= 0; i--) { if (mv & (1 << i)) bits++; else break; }
      if (bits > bestBits) { bestBits = bits; best = r; }
    }
    if (!best) return true;                       // 一条路由都匹配不上
    // 只匹配到默认路由 = 会从普通出口发出去，到不了内网
    return best.dest === '0.0.0.0';
  } catch (_) { return false; }
}

// 把网络层错误翻译成可读提示，方便在界面上区分"设备掉线"和"会话问题"
function classifyNet(err, host) {
  if (!err) return err;
  const msg = err.message || String(err);
if (/timeout/i.test(msg)) {
      const down = tunnelMissing(host);
      const e = new Error(down
        ? '网络不通：本机未建立到 10.x 内网的隧道（VPN / 零信任未连接）—— ' + host
        : '连接超时：设备无响应或网络不通（' + host + '）');
      e.code = down ? 'TUNNEL_DOWN' : 'UNREACHABLE';
      return e;
    }
  if (/ECONNREFUSED/i.test(msg)) {
    const e = new Error('连接被拒绝：设备 Web 服务未开启');
    e.code = 'UNREACHABLE';
    return e;
  }
  if (/ENETUNREACH|EHOSTUNREACH|EHOSTDOWN|ENETDOWN/i.test(msg)) {
    const e = new Error('网络不可达：设备不在当前网段');
    e.code = 'UNREACHABLE';
    return e;
  }
  err.code = err.code || 'NET_ERROR';
  return err;
}

function num(v) {  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 设备用 -100.0 / 65535 / 0 表示"无传感器或无此数据"，必须识别并转为 null
function sensorNum(v, hasFlag) {
  if (hasFlag === false) return null;
  const n = num(v);
  if (n === null) return null;
  if (n <= -99.9) return null;
  if (n >= 6553.5) return null;
  return n;
}

function phaseTriple(obj) {
  if (!obj) return { a: null, b: null, c: null };
  return { a: num(obj.A), b: num(obj.B), c: num(obj.C) };
}

class VertivITA2 {
  constructor(cfg) {
    this.host = cfg.host;
    this.port = cfg.port || 80;
    this.username = cfg.username || 'user';
    // 不内置默认口令：必须显式配置，避免把出厂弱口令写进代码库
    this.password = cfg.password || '';
    this.sid = null;
    this.lastLoginAt = 0;
    this.loginFails = 0;
    this.lastExtra = {};
    this._loggingIn = null;
  }

  _opts(extra) {
    return Object.assign({ host: this.host, port: this.port, timeout: 8000 }, extra || {});
  }

  async login() {
    if (this._loggingIn) return this._loggingIn;
    // 设备侧对登录有严格限流（并发会话极少），短时间内绝不重复登录
    const gap = Date.now() - this.lastLoginAt;
    if (this.lastLoginAt && gap < 30000) {
      const e = new Error('登录冷却中，' + Math.ceil((30000 - gap) / 1000) + 's 后重试');
      e.code = 'LOGIN_THROTTLED';
      throw e;
    }
    this._loggingIn = (async () => {
      // 先尽力释放旧会话，避免占用设备唯一/极少数的网页会话槽
      if (this.sid) { await this.logout().catch(() => {}); }
      const r = await request(this._opts({
        method: 'POST',
        path: '/SignIn.cgi',
        timeout: 12000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: 'http://' + this.host + '/SignIn_CH.shtml'
        },
        body: 'UserName=' + encodeURIComponent(this.username) +
              '&Pswd=' + encodeURIComponent(this.password)
      })).catch((err) => { throw classifyNet(err, this.host); });
      const m = (r.headers['set-cookie'] || '').match(/SID=([0-9a-zA-Z]+)/);
      this.lastLoginAt = Date.now();
      if (!m) {
        this.loginFails++;
        const e = new Error('登录被拒绝：设备网页会话已占满或被限流（提示语 "Too many users on-line"）');
        e.code = 'SESSION_FULL';
        throw e;
      }
      this.sid = m[1];
      return this.sid;
    })();
    try { return await this._loggingIn; }
    finally { this._loggingIn = null; }
  }

  // 轻量连通性探测：只做 TCP 握手，不发 HTTP、不登录，
  // 因此不会占用设备仅有的网页会话槽，也不会触发登录限流。
  // 用于"网络恢复探测"——端口一通就立刻重新采集，而不是干等退避。
  async probePort(timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      let done = false;
      const sock = net.connect({ host: this.host, port: this.port });
      const fin = (ok) => {
        if (done) return;
        done = true;
        try { sock.destroy(); } catch (_) { /* ignore */ }
        resolve({ ok, ms: Date.now() - t0 });
      };
      sock.setTimeout(timeoutMs || 2000);
      sock.on('connect', () => fin(true));
      sock.on('timeout', () => fin(false));
      sock.on('error', () => fin(false));
    });
  }

  async logout() {
    if (!this.sid) return;
    const sid = this.sid;
    this.sid = null;
    await request(this._opts({ path: '/SignOut.cgi', headers: { Cookie: 'SID=' + sid }, timeout: 5000 })).catch(() => {});
  }

  async _getJson(path) {
    const r = await request(this._opts({ path, headers: this.sid ? { Cookie: 'SID=' + this.sid } : {} }))
      .catch((err) => { throw classifyNet(err, this.host); });
    const text = r.body.trimStart();
    if (!text.startsWith('{')) {
      const e = new Error('会话失效或路径不存在 (status ' + r.status + ')');
      e.code = r.status === 404 ? 'NOT_FOUND' : 'SESSION_LOST';
      throw e;
    }
    try {
      return JSON.parse(r.body);
    } catch (err) {
      const e = new Error('JSON 解析失败');
      e.code = 'BAD_JSON';
      throw e;
    }
  }

  // detail=false 时只拉概览，detail=true 时补齐 5 个明细接口
  async poll(opts) {
    const detail = !!(opts && opts.detail);
    const t0 = Date.now();

    if (!this.sid) await this.login();

    let home;
    try {
      home = await this._getJson('/_com/home/home.json?t=' + Date.now());
    } catch (e) {
      if (e.code === 'SESSION_LOST' || e.code === 'NOT_FOUND') {
        this.sid = null;
        await this.login();
        home = await this._getJson('/_com/home/home.json?t=' + Date.now());
      } else { throw e; }
    }

    // 留一份原始概览，供身份信息提取（型号 / 序列号 / 固件版本）使用
    this.lastHome = home;

    const extra = {};
    if (detail) {
      const paths = {
        input: '/_com/status/input.json',
        output: '/_com/status/output.json',
        load: '/_com/status/load.json',
        bypass: '/_com/status/bypass.json',
        battery: '/_com/status/battery.json'
      };
      // 逐个接口增量更新：某个接口这次失败不影响其它接口，
      // 且旧值保留，界面上不会出现"这一轮突然缺项"
      for (const k of Object.keys(paths)) {
        try { this.lastExtra[k] = await this._getJson(paths[k] + '?t=' + Date.now()); }
        catch (_) { /* 保留上一次的值 */ }
      }
    }
    for (const k of Object.keys(this.lastExtra)) extra[k] = this.lastExtra[k];

    const snap = normalize(home, extra);
    snap.pollMs = Date.now() - t0;
    return snap;
  }
}

function normalize(home, extra) {
  const O = home.Other || {};
  const In = home.Input || {};
  const Out = home.Output || {};
  const By = home.Bypass || {};
  const Ld = home.Load || {};
  const Bt = home.Battery || {};

  const phases = num(In.PhaseNum) || num(Out.PhaseNum) || 1;
  const is3 = phases >= 3;

  const supplyCode = num(O.upsSupplyState);
  const battCodeP = num(O.batteryState_P);
  const battCodeN = num(O.batteryState_N);

  // ---- 明细接口（可选）----
  const dIn = (extra.input && extra.input.Input) || {};
  const dOut = (extra.output && extra.output.Output) || {};
  const dLd = extra.load || {};
  const dBt = (extra.battery && extra.battery.Battery) || {};

  const hasTempSensor = dBt.HasTempSensor !== undefined ? num(dBt.HasTempSensor) === 1 : null;
  const hasHumiSensor = dBt.HasHumiSensor !== undefined ? num(dBt.HasHumiSensor) === 1 : null;

  const prd = String(O.PrdType || '');
  const kwFromModel = (function () {
    const m = prd.match(/ITA-(\d+)K/i);
    if (m) return parseInt(m[1], 10);
    return num(O.ModuleType) === 1 ? 5 : 20;
  })();

  const snap = {
    ts: Date.now(),
    online: true,
    model: prd,
    ratedKw: kwFromModel,
    phases,
    supply: {
      code: supplyCode,
      text: ENUM.supply[supplyCode] || ('未知(' + supplyCode + ')'),
      level: SUPPLY_LEVEL[supplyCode] || 'warn'
    },
    eco: num(O.runMode) === 1,
    input: {
      v: phaseTriple(In.L_N_Volt),
      vll: phaseTriple(In.L_L_Volt),
      i: phaseTriple(In.L_N_Curr),
      f: phaseTriple(In.Freq),
      pf: phaseTriple(dIn.PwrFactor),
      energy: dIn.Pwr && dIn.Pwr.Value !== undefined
        ? { value: num(dIn.Pwr.Value), unit: dIn.Pwr.Unit || '' } : null
    },
    bypass: {
      v: phaseTriple(By.L_N_Volt),
      vll: phaseTriple(By.L_L_Volt),
      f: phaseTriple(By.Freq)
    },
    output: {
      v: phaseTriple(Out.L_N_Volt),
      vll: phaseTriple(Out.L_L_Volt),
      i: phaseTriple(Out.L_N_Curr),
      f: phaseTriple(Out.Freq),
      energy: dOut.Pwr && dOut.Pwr.Value !== undefined
        ? { value: num(dOut.Pwr.Value), unit: dOut.Pwr.Unit || '' } : null
    },
    load: {
      kw: phaseTriple(Ld.Pout),
      kva: phaseTriple((dLd.Load && dLd.Load.Sout) || null),
      pf: phaseTriple(Ld.PwrFactor),
      crest: phaseTriple((dLd.Load && dLd.Load.CrstFactor) || null),
      pct: phaseTriple(Ld.LoadPercnt)
    },
    battery: {
      vP: num(Bt.Volt && Bt.Volt.P),
      iP: num(Bt.Curr && Bt.Curr.P),
      vN: num(Bt.Volt && Bt.Volt.N),
      iN: num(Bt.Curr && Bt.Curr.N),
      stateP: battCodeP,
      statePText: ENUM.battery[battCodeP] || ('未知(' + battCodeP + ')'),
      stateN: battCodeN,
      stateNText: ENUM.battery[battCodeN] || ('未知(' + battCodeN + ')'),
      level: BATT_LEVEL[battCodeP] || 'ok',
      backupMin: num(Bt.BkupTime),
      capPct: num(Bt.Cap),
      groups: num(Bt.GroupNum),
      cabinetC: sensorNum(dBt.Cabinet, true),
      tempC: sensorNum(dBt.Temp, hasTempSensor),
      humiPct: sensorNum(dBt.Humi, hasHumiSensor)
    },
    env: { tempC: sensorNum(O.envTemp, true) },
    alarms: { count: num(O.Log_CurAlarmCnt) || 0, faults: num(O.Log_CurFaultCnt) || 0 },
    flags: {
      mainOk: num(O.isMainOK) === 1,
      invOk: num(O.isInvOK) === 1,
      bypassNormal: num(O.isBypassNormal) === 1,
      bypassEnable: num(O.isBypassEnable) === 1
    },
    // 能力声明：设备自己说有没有这个传感器/字段，前端据此显示"设备不支持"
    caps: {
      envTemp: num(O.envTemp) !== null && sensorNum(O.envTemp, true) !== null,
      batteryTemp: hasTempSensor === true,
      humidity: hasHumiSensor === true,
      energyCounter: !!(dIn.Pwr || dOut.Pwr)
    }
  };

  if (!is3) {
    for (const grp of ['input', 'output', 'bypass']) {
      for (const k of ['v', 'vll', 'i', 'f', 'pf']) {
        if (snap[grp][k]) { snap[grp][k].b = null; snap[grp][k].c = null; }
      }
      // 单相机型没有"线电压"概念，设备回 0，直接置空避免误导
      snap[grp].vll = null;
    }
    for (const k of ['kw', 'kva', 'pf', 'crest', 'pct']) {
      if (snap.load[k]) { snap.load[k].b = null; snap.load[k].c = null; }
    }
  }

  snap.severity = evaluate(snap);
  return snap;
}

// 告警分级：crit 断供/故障/放电，warn 非逆变供电/容量低，ok 正常
function evaluate(s) {
  const issues = [];
  if (s.alarms.faults > 0) issues.push({ lvl: 'crit', msg: '设备有 ' + s.alarms.faults + ' 条当前故障' });
  if (s.alarms.count > 0) issues.push({ lvl: 'warn', msg: '设备有 ' + s.alarms.count + ' 条当前告警' });
  if (s.supply.code === 0) issues.push({ lvl: 'crit', msg: '整机不供电' });
  else if (s.supply.code === 1) issues.push({ lvl: 'warn', msg: '市电异常，已转旁路供电' });
  else if (s.supply.code === 3) issues.push({ lvl: 'warn', msg: '联合供电（过载或旁路协助）' });
  if (s.battery.stateP === 3) issues.push({ lvl: 'crit', msg: '电池放电中，市电可能中断' });
  if (s.battery.capPct !== null && s.battery.capPct < 50) issues.push({ lvl: 'warn', msg: '电池容量 ' + s.battery.capPct + '%' });
  if (s.env.tempC !== null && s.env.tempC >= 30) issues.push({ lvl: 'warn', msg: '环境温度偏高 ' + s.env.tempC + '℃' });
  const lp = s.load.pct && s.load.pct.a;
  if (lp !== null && lp >= 80) issues.push({ lvl: 'warn', msg: '负载率 ' + lp + '%' });
  if (!s.flags.mainOk) issues.push({ lvl: 'crit', msg: '市电输入异常' });
  if (!s.flags.invOk) issues.push({ lvl: 'crit', msg: '逆变器异常' });

  let sev = 'ok';
  for (const i of issues) if (i.lvl === 'crit') sev = 'crit';
  if (sev !== 'crit' && issues.some(i => i.lvl === 'warn')) sev = 'warn';
  return { level: sev, issues };
}

// ---- 身份信息提取：型号 / 序列号 / 固件版本 ----
// 设备自报字段名在不同固件版本间不统一（SN / SerialNo / PrdSN …），
// 所以这里先用候选键精确匹配，再对整棵 JSON 做深度扫描兜底，
// 并把命中的候选键一起返回，方便定位真实字段名。
const SN_KEY_RE = /(^|_|\b)(sn|serial|serialno|serialnum|serialnumber|devicesn|prdsn|sncode|deviceserial)($|_|\b)/i;
const FW_KEY_RE = /(firmware|fwversion|fwver|swversion|softwareversion|^version$)/i;

function normKey(k) {
  return String(k || '').toLowerCase().replace(/[\s_-]/g, '');
}

function looksLikeSerial(v) {
  const s = String(v == null ? '' : v).trim();
  if (s.length < 4 || s.length > 48) return false;
  if (!/\d/.test(s)) return false;          // 序列号一定含数字
  if (/^\d{10,13}$/.test(s)) return false;  // 纯时间戳不算
  return true;
}

function deepScan(obj, path, out, depth) {
  if (!obj || typeof obj !== 'object' || depth > 6) return;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const p = path ? path + '.' + k : k;
    if (v && typeof v === 'object') { deepScan(v, p, out, depth + 1); continue; }
    if (v === null || v === undefined) continue;
    const nk = normKey(k);
    if (SN_KEY_RE.test(k) && looksLikeSerial(v)) out.serial.push({ key: p, value: String(v).trim(), rawKey: k });
    if (FW_KEY_RE.test(nk) && String(v).length <= 24) out.firmware.push({ key: p, value: String(v).trim(), rawKey: k });
  }
}

function identityOf(home) {
  const res = { model: '', serial: '', serialKey: '', firmware: '', firmwareKey: '', candidates: { serial: [], firmware: [] } };
  if (!home || typeof home !== 'object') return res;
  const O = home.Other || {};
  res.model = String(O.PrdType || O.Model || O.ProductType || '').trim();
  const out = { serial: [], firmware: [] };
  deepScan(home, '', out, 0);
  res.candidates.serial = out.serial.slice(0, 12);
  res.candidates.firmware = out.firmware.slice(0, 8);
  // 优先取 Other 段下的命中项（机型铭牌信息都在这一层）
  const pickFrom = (list) => list.find(c => /^Other\./.test(c.key)) || list[0];
  const s = pickFrom(out.serial);
  if (s) { res.serial = s.value; res.serialKey = s.key; }
  const f = pickFrom(out.firmware);
  if (f) { res.firmware = f.value; res.firmwareKey = f.key; }
  // 没找到序列号时，把概览接口里出现过的字段名回传，便于定位真实字段
  if (!res.serial) {
    const keys = [];
    (function collect(obj, path, depth) {
      if (!obj || typeof obj !== 'object' || depth > 3 || keys.length > 120) return;
      for (const k of Object.keys(obj)) {
        const p = path ? path + '.' + k : k;
        keys.push(p);
        if (obj[k] && typeof obj[k] === 'object') collect(obj[k], p, depth + 1);
      }
    })(home, '', 0);
    res.diag = { keys: keys.slice(0, 120) };
  }
  return res;
}

module.exports = { VertivITA2, normalize, ENUM, classifyNet, tunnelMissing, identityOf };
