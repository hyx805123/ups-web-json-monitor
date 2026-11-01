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

// 把网络层错误翻译成可读提示，方便在界面上区分"设备掉线"和"会话问题"
function classifyNet(err, host) {
  if (!err) return err;
  const msg = err.message || String(err);
  if (/timeout/i.test(msg)) {
    const e = new Error('连接超时：设备无响应或网络不通（' + host + '）');
    e.code = 'UNREACHABLE';
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

module.exports = { VertivITA2, normalize, ENUM };
