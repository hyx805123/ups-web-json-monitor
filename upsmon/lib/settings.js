'use strict';
// 统一设置中心：分组 / 配置模板 / 告警渠道 / 告警规则 / 界面偏好 / 认证预留
const fs = require('fs');
const crypto = require('crypto');
const { DEFAULT_THRESHOLDS } = require('./thresholds');

const GROUP_TYPES = ['model', 'site', 'status', 'custom'];
const STATUS_BUCKETS = ['ok', 'warn', 'crit', 'offline'];
const STATUS_LABELS = { ok: '正常', warn: '告警', crit: '严重', offline: '离线' };

function defaults() {
  return {
    groups: [
      { id: 'g_status_ok', name: '运行正常', type: 'status', value: 'ok', color: '#2fbf71', order: 0, enabled: true },
      { id: 'g_status_warn', name: '存在告警', type: 'status', value: 'warn', color: '#e8a33d', order: 1, enabled: true },
      { id: 'g_status_crit', name: '严重故障', type: 'status', value: 'crit', color: '#e2564d', order: 2, enabled: true },
      { id: 'g_status_offline', name: '失联离线', type: 'status', value: 'offline', color: '#78899a', order: 3, enabled: true }
    ],
    templates: [
      {
        id: 'tpl_ita2_std',
        name: 'ITA2 标准模板',
        vendor: 'vertiv-ita2',
        note: 'ITA2 系列通用参数：10 秒采集，默认启用',
        defaults: { intervalMs: 10000, enabled: true, site: '', integrator: '', username: 'user', port: 80 }
      }
    ],
    alerts: {
      channels: [
        {
          id: 'ch_wecom',
          type: 'wecom',
          name: '企微群机器人',
          enabled: false,
          config: { webhook: '', mentionedList: [] }
        },
        {
          id: 'ch_email',
          type: 'email',
          name: '运维邮箱',
          enabled: false,
          config: {
            host: '', port: 465, secure: true, user: '', pass: '', from: '',
            to: [], subjectPrefix: '[UPS监控]'
          }
        }
      ],
      rules: [
        {
          id: 'rl_offline',
          name: '设备失联',
          enabled: true,
          severity: 'crit',
          conditions: [{ field: 'status', op: 'eq', value: 'offline' }],
          channels: [],
          cooldownSec: 300,
          repeatSec: 0,
          notifyRecover: true
        },
        {
          id: 'rl_fault',
          name: '设备故障',
          enabled: true,
          severity: 'crit',
          conditions: [{ field: 'faultCount', op: 'gt', value: 0 }],
          channels: [],
          cooldownSec: 600,
          repeatSec: 0,
          notifyRecover: true
        },
        {
          id: 'rl_batt',
          name: '电池放电中',
          enabled: true,
          severity: 'crit',
          conditions: [{ field: 'batteryState', op: 'eq', value: 3 }],
          channels: [],
          cooldownSec: 300,
          repeatSec: 0,
          notifyRecover: true
        },
        {
          id: 'rl_bypass',
          name: '转旁路供电',
          enabled: true,
          severity: 'warn',
          conditions: [{ field: 'supply', op: 'eq', value: 1 }],
          channels: [],
          cooldownSec: 600,
          repeatSec: 0,
          notifyRecover: true
        },
        {
          id: 'rl_load',
          name: '负载率过高',
          enabled: true,
          severity: 'warn',
          conditions: [{ field: 'loadPct', op: 'ge', value: 80 }],
          channels: [],
          cooldownSec: 900,
          repeatSec: 0,
          notifyRecover: false
        }
      ]
    },
    ui: { groupBy: 'none', viewMode: 'tiles', groupBySite: false, groupByModel: false, groupByStatus: false, compact: false },
    thresholds: JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS)),
    auth: { enabled: false, users: [], note: '身份认证与权限管理尚未启用，设计方案见 docs/AUTH-DESIGN.md' }
  };
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch;
  if (patch && typeof patch === 'object') {
    const out = Object.assign({}, base);
    for (const k of Object.keys(patch)) {
      out[k] = (k in base && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]))
        ? deepMerge(base[k], patch[k])
        : patch[k];
    }
    return out;
  }
  return patch === undefined ? base : patch;
}

class Settings {
  constructor(file) {
    this.file = file;
    this.data = defaults();
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = deepMerge(defaults(), parsed);
        // 分组类型补全
        this.data.groups.forEach(g => { if (!GROUP_TYPES.includes(g.type)) g.type = 'custom'; });
      }
    } catch (e) {
      try { fs.renameSync(this.file, this.file + '.corrupt-' + Date.now()); } catch (_) {}
      this.data = defaults();
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  all() { return this.data; }

  // ---------- 分组 ----------
  groups() { return this.data.groups.slice().sort((a, b) => (a.order || 0) - (b.order || 0)); }

  addGroup(g) {
    const item = {
      id: g.id || crypto.randomUUID(),
      name: String(g.name || '新分组').slice(0, 60),
      type: GROUP_TYPES.includes(g.type) ? g.type : 'custom',
      value: String(g.value || '').slice(0, 80),
      color: String(g.color || '#4ea8de'),
      order: Number(g.order) || this.data.groups.length,
      enabled: g.enabled !== false
    };
    this.data.groups.push(item);
    this.save();
    return item;
  }

  updateGroup(id, patch) {
    const g = this.data.groups.find(x => x.id === id);
    if (!g) return null;
    if (patch.name !== undefined) g.name = String(patch.name).slice(0, 60);
    if (patch.type !== undefined && GROUP_TYPES.includes(patch.type)) g.type = patch.type;
    if (patch.value !== undefined) g.value = String(patch.value).slice(0, 80);
    if (patch.color !== undefined) g.color = String(patch.color).slice(0, 20);
    if (patch.order !== undefined) g.order = Number(patch.order) || 0;
    if (patch.enabled !== undefined) g.enabled = !!patch.enabled;
    this.save();
    return g;
  }

  removeGroup(id) {
    const i = this.data.groups.findIndex(x => x.id === id);
    if (i < 0) return false;
    this.data.groups.splice(i, 1);
    // 同步清理设备上的引用
    for (const d of this._devices) {
      if (Array.isArray(d.groupIds) && d.groupIds.includes(id)) {
        d.groupIds = d.groupIds.filter(x => x !== id);
      }
    }
    this.save();
    return true;
  }

  // ---------- 模板 ----------
  templates() { return this.data.templates; }

  addTemplate(t) {
    const item = {
      id: t.id || crypto.randomUUID(),
      name: String(t.name || '新模板').slice(0, 60),
      vendor: String(t.vendor || 'vertiv-ita2').slice(0, 40),
      note: String(t.note || '').slice(0, 300),
      defaults: t.defaults && typeof t.defaults === 'object' ? t.defaults : {}
    };
    this.data.templates.push(item);
    this.save();
    return item;
  }

  updateTemplate(id, patch) {
    const t = this.data.templates.find(x => x.id === id);
    if (!t) return null;
    if (patch.name !== undefined) t.name = String(patch.name).slice(0, 60);
    if (patch.vendor !== undefined) t.vendor = String(patch.vendor).slice(0, 40);
    if (patch.note !== undefined) t.note = String(patch.note).slice(0, 300);
    if (patch.defaults !== undefined && typeof patch.defaults === 'object') t.defaults = patch.defaults;
    this.save();
    return t;
  }

  removeTemplate(id) {
    const i = this.data.templates.findIndex(x => x.id === id);
    if (i < 0) return false;
    this.data.templates.splice(i, 1);
    this.save();
    return true;
  }

  // ---------- 告警 ----------
  channels() { return this.data.alerts.channels; }

  addChannel(c) {
    const type = c.type === 'email' ? 'email' : 'wecom';
    const item = {
      id: c.id || crypto.randomUUID(),
      type,
      name: String(c.name || (type === 'wecom' ? '企微群机器人' : '邮件通道')).slice(0, 60),
      enabled: c.enabled !== false,
      config: c.config && typeof c.config === 'object' ? c.config : {}
    };
    this.data.alerts.channels.push(item);
    this.save();
    return item;
  }

  updateChannel(id, patch) {
    const c = this.data.alerts.channels.find(x => x.id === id);
    if (!c) return null;
    if (patch.name !== undefined) c.name = String(patch.name).slice(0, 60);
    if (patch.enabled !== undefined) c.enabled = !!patch.enabled;
    if (patch.config !== undefined && typeof patch.config === 'object') {
      // 密码类字段留空表示不修改
      const merged = Object.assign({}, c.config, patch.config);
      if (merged.pass === '********' || merged.pass === '') merged.pass = c.config.pass;
      c.config = merged;
    }
    this.save();
    return c;
  }

  removeChannel(id) {
    const i = this.data.alerts.channels.findIndex(x => x.id === id);
    if (i < 0) return false;
    this.data.alerts.channels.splice(i, 1);
    this.data.alerts.rules.forEach(r => {
      r.channels = (r.channels || []).filter(x => x !== id);
    });
    this.save();
    return true;
  }

  rules() { return this.data.alerts.rules; }

  addRule(r) {
    const item = {
      id: r.id || crypto.randomUUID(),
      name: String(r.name || '新规则').slice(0, 60),
      enabled: r.enabled !== false,
      severity: ['ok', 'warn', 'crit'].includes(r.severity) ? r.severity : 'warn',
      conditions: Array.isArray(r.conditions) ? r.conditions : [],
      channels: Array.isArray(r.channels) ? r.channels : [],
      cooldownSec: Math.max(0, Number(r.cooldownSec) || 300),
      repeatSec: Math.max(0, Number(r.repeatSec) || 0),
      notifyRecover: r.notifyRecover !== false
    };
    this.data.alerts.rules.push(item);
    this.save();
    return item;
  }

  updateRule(id, patch) {
    const r = this.data.alerts.rules.find(x => x.id === id);
    if (!r) return null;
    if (patch.name !== undefined) r.name = String(patch.name).slice(0, 60);
    if (patch.enabled !== undefined) r.enabled = !!patch.enabled;
    if (patch.severity !== undefined) r.severity = patch.severity;
    if (patch.conditions !== undefined && Array.isArray(patch.conditions)) r.conditions = patch.conditions;
    if (patch.channels !== undefined && Array.isArray(patch.channels)) r.channels = patch.channels;
    if (patch.cooldownSec !== undefined) r.cooldownSec = Math.max(0, Number(patch.cooldownSec) || 0);
    if (patch.repeatSec !== undefined) r.repeatSec = Math.max(0, Number(patch.repeatSec) || 0);
    if (patch.notifyRecover !== undefined) r.notifyRecover = !!patch.notifyRecover;
    this.save();
    return r;
  }

  removeRule(id) {
    const i = this.data.alerts.rules.findIndex(x => x.id === id);
    if (i < 0) return false;
    this.data.alerts.rules.splice(i, 1);
    this.save();
    return true;
  }

  // ---------- 界面偏好 ----------
  updateUi(patch) {
    this.data.ui = Object.assign({}, this.data.ui, patch);
    this.save();
    return this.data.ui;
  }

  // ---------- 阈值 ----------
  thresholds() { return this.data.thresholds; }

  updateThresholds(patch) {
    const cur = this.data.thresholds;
    for (const key of Object.keys(patch || {})) {
      if (!cur[key]) continue;
      const src = patch[key];
      const dst = cur[key];
      for (const k of Object.keys(src)) {
        if (k === 'deviceRange') { dst[k] = src[k]; continue; }
        if (k === 'enabled') { dst[k] = !!src[k]; continue; }
        const n = Number(src[k]);
        if (!Number.isFinite(n)) continue;
        dst[k] = n;
      }
    }
    this.save();
    return this.data.thresholds;
  }

  // 分组删除时清理设备引用（需要访问设备表）
  set devices(list) { this._devices = list || []; }
  get devices() { return this._devices || []; }
}

module.exports = { Settings, GROUP_TYPES, STATUS_BUCKETS, STATUS_LABELS, defaults };
