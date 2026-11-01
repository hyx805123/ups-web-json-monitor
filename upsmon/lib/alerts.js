'use strict';
// 告警引擎：规则评估 + 企微 webhook 机器人 + 邮件推送 + 冷却去重
const https = require('https');
const { sendMail } = require('./smtp');

const OPS = {
  eq: (a, b) => String(a) === String(b),
  ne: (a, b) => String(a) !== String(b),
  gt: (a, b) => Number(a) > Number(b),
  ge: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  le: (a, b) => Number(a) <= Number(b)
};

// 从设备运行状态里抽取规则可用的字段
function facts(device, state) {
  const s = state && state.snap;
  const f = {
    status: (state && state.status) || 'offline',
    severity: s ? s.severity.level : 'crit',
    deviceId: device.id,
    deviceName: device.name,
    host: device.host,
    site: device.site || '',
    model: device.model || (s ? s.model : ''),
    supply: s ? s.supply.code : null,
    batteryState: s ? s.battery.stateP : null,
    faultCount: s ? s.alarms.faults : null,
    alarmCount: s ? s.alarms.count : null,
    loadPct: s && s.load.pct ? s.load.pct.a : null,
    batteryCap: s ? s.battery.capPct : null,
    envTemp: s ? s.env.tempC : null,
    backupMin: s ? s.battery.backupMin : null,
    outputV: s && s.output.v ? s.output.v.a : null,
    inputV: s && s.input.v ? s.input.v.a : null
  };
  // 阈值判定结果也作为可告警字段（ok / warn / crit）
  const lv = (s && s.levels) || {};
  const lvlOf = (k) => (lv[k] && lv[k].level) || null;
  f.outputVoltageLevel = lvlOf('outputVoltage');
  f.inputVoltageLevel = lvlOf('inputVoltage');
  f.bypassVoltageLevel = lvlOf('bypassVoltage');
  f.lineVoltageLevel = lvlOf('lineVoltage');
  f.outputCurrentLevel = lvlOf('outputCurrent');
  f.loadPercentLevel = lvlOf('loadPercent');
  f.batteryCapacityLevel = lvlOf('batteryCapacity');
  f.frequencyLevel = lvlOf('frequency');
  f.envTempLevel = lvlOf('envTemp');
  f.phaseImbalanceLevel = lvlOf('phaseImbalance');
  return f;
}

function matchRule(rule, f) {
  const conds = rule.conditions || [];
  if (!conds.length) return false;
  return conds.every(c => {
    const op = OPS[c.op] || OPS.eq;
    const v = f[c.field];
    if (v === null || v === undefined) return false;
    return op(v, c.value);
  });
}

function fmt(v) {
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

function describe(f) {
  const lines = [];
  lines.push('设备名称：' + fmt(f.deviceName));
  lines.push('IP 地址：' + fmt(f.host));
  if (f.site) lines.push('所在场地：' + f.site);
  if (f.model) lines.push('设备型号：' + f.model);
  lines.push('运行状态：' + f.status);
  lines.push('严重级别：' + f.severity);
  if (f.supply !== null) lines.push('供电状态码：' + f.supply);
  if (f.batteryState !== null) lines.push('电池状态码：' + f.batteryState);
  if (f.batteryCap !== null) lines.push('电池容量：' + f.batteryCap + ' %');
  if (f.loadPct !== null) lines.push('负载率：' + f.loadPct + ' %');
  if (f.envTemp !== null) lines.push('环境温度：' + f.envTemp + ' ℃');
  if (f.faultCount !== null) lines.push('当前故障数：' + f.faultCount);
  if (f.alarmCount !== null) lines.push('当前告警数：' + f.alarmCount);
  return lines;
}

function buildMessage(kind, rule, f, detail) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  const title = kind === 'trigger'
    ? 'UPS 告警：' + rule.name
    : 'UPS 恢复：' + rule.name;
  const head = kind === 'trigger'
    ? '规则「' + rule.name + '」触发'
    : '规则「' + rule.name + '」已恢复正常';
  const body = describe(f).join('\n');
  return {
    title,
    text: '【' + ts + '】' + head + (detail ? '（' + detail + '）' : '') + '\n' + body
  };
}

function wecomMarkdown(msg) {
  const lines = msg.text.split('\n');
  const quoted = lines.map(l => '> ' + l).join('\n');
  return '**' + msg.title + '**\n' + quoted;
}

function postJson(url, obj) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('webhook 地址不合法')); }
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': data.length
      },
      timeout: 12000
    }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch (_) {}
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (parsed && parsed.errcode !== undefined && parsed.errcode !== 0) {
            return reject(new Error('企微返回错误 ' + parsed.errcode + '：' + (parsed.errmsg || '')));
          }
          return resolve({ ok: true, resp: parsed });
        }
        reject(new Error('HTTP ' + res.statusCode + '：' + buf.slice(0, 200)));
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('企微 webhook 请求超时')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

class AlertEngine {
  constructor(settings) {
    this.settings = settings;
    this.state = new Map();   // key: ruleId|deviceId -> { firing:bool, lastFired:ts, lastRepeat:ts }
    this.history = [];        // 最近告警投递记录
  }

  _key(ruleId, deviceId) { return ruleId + '|' + deviceId; }

  // 评估一台设备的全部规则，返回需要投递的消息
  evaluate(device, state) {
    const out = [];
    const f = facts(device, state);
    const rules = this.settings.rules();
    const now = Date.now();

    for (const rule of rules) {
      if (rule.enabled === false) continue;
      const key = this._key(rule.id, device.id);
      const st = this.state.get(key) || { firing: false, lastFired: 0, lastRepeat: 0 };
      const hit = matchRule(rule, f);

      if (hit && !st.firing) {
        st.firing = true;
        st.lastFired = now;
        st.lastRepeat = now;
        this.state.set(key, st);
        out.push({ rule, kind: 'trigger', msg: buildMessage('trigger', rule, f), facts: f });
      } else if (hit && st.firing) {
        // 持续中：按 repeatSec 重复提醒
        if (rule.repeatSec > 0 && now - st.lastRepeat >= rule.repeatSec * 1000) {
          st.lastRepeat = now;
          out.push({ rule, kind: 'repeat', msg: buildMessage('trigger', rule, f, '持续中'), facts: f });
        }
      } else if (!hit && st.firing) {
        st.firing = false;
        this.state.set(key, st);
        if (rule.notifyRecover) {
          out.push({ rule, kind: 'recover', msg: buildMessage('recover', rule, f), facts: f });
        }
      }
    }
    return out;
  }

  // 冷却只影响"重复触发"，恢复消息立即发
  async dispatch(items) {
    const results = [];
    for (const it of items) {
      const rule = it.rule;
      const channels = (rule.channels && rule.channels.length)
        ? this.settings.channels().filter(c => rule.channels.includes(c.id))
        : this.settings.channels().filter(c => c.enabled);
      const active = channels.filter(c => c.enabled !== false);
      const res = { rule: rule.name, kind: it.kind, device: it.facts.deviceName, targets: [] };
      for (const ch of active) {
        try {
          await this.send(ch, it.msg);
          res.targets.push({ channel: ch.name, ok: true });
        } catch (e) {
          res.targets.push({ channel: ch.name, ok: false, error: e.message });
        }
      }
      this.history.unshift({ ts: Date.now(), rule: rule.name, kind: it.kind, device: it.facts.deviceName, result: res.targets });
      if (this.history.length > 200) this.history.length = 200;
      results.push(res);
    }
    return results;
  }

  async send(channel, msg) {
    if (channel.type === 'wecom') {
      const cfg = channel.config || {};
      if (!cfg.webhook) throw new Error('未配置 webhook 地址');
      const text = msg.text + '\n';
      await postJson(cfg.webhook, { msgtype: 'markdown', markdown: { content: wecomMarkdown(msg) } });
      return;
    }
    if (channel.type === 'email') {
      const cfg = channel.config || {};
      if (!cfg.host) throw new Error('未配置 SMTP 服务器');
      const prefix = cfg.subjectPrefix || '[UPS监控]';
      const to = Array.isArray(cfg.to) ? cfg.to : String(cfg.to || '').split(/[,;]/).filter(Boolean);
      await sendMail({
        host: cfg.host,
        port: Number(cfg.port) || 465,
        secure: cfg.secure !== false,
        user: cfg.user || '',
        pass: cfg.pass || '',
        from: cfg.from || cfg.user || '',
        to,
        subject: prefix + msg.title,
        text: msg.text
      });
      return;
    }
    throw new Error('未知通道类型：' + channel.type);
  }

  async testChannel(channel) {
    const msg = {
      title: 'UPS 监控 通道测试',
      text: '这是一条来自 UPS 监控台的测试消息。\n如果你收到它，说明通道配置正确。\n时间：' + new Date().toLocaleString('zh-CN', { hour12: false })
    };
    await this.send(channel, msg);
    return { ok: true };
  }

  recentHistory() { return this.history.slice(0, 50); }
}

module.exports = { AlertEngine, matchRule, facts, OPS };
