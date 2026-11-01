'use strict';
const fs = require('fs');
const crypto = require('crypto');

const DEVICE_FIELDS = [
  'name', 'host', 'port', 'username', 'password', 'vendor', 'model',
  'site', 'commissionDate', 'integrator', 'serial', 'note', 'tags',
  'groupIds', 'intervalMs', 'enabled'
];

class Store {
  constructor(file) {
    this.file = file;
    this.data = { devices: [] };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.devices)) {
          this.data = parsed;
          this.data.devices.forEach(d => this._migrate(d));
        }
      }
    } catch (e) {
      try { fs.renameSync(this.file, this.file + '.corrupt-' + Date.now()); } catch (_) {}
      this.data = { devices: [] };
    }
  }

  _migrate(d) {
    if (!Array.isArray(d.groupIds)) d.groupIds = [];
    if (!Array.isArray(d.tags)) d.tags = [];
    if (d.model === undefined) d.model = '';
    if (d.site === undefined) d.site = '';
    if (d.integrator === undefined) d.integrator = '';
    if (d.commissionDate === undefined) d.commissionDate = '';
    if (d.serial === undefined) d.serial = '';
    if (d.note === undefined) d.note = '';
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  list() { return this.data.devices; }

  get(id) { return this.data.devices.find(d => d.id === id) || null; }

  findByHost(host, port) {
    return this.data.devices.find(d => d.host === host && (d.port || 80) === (port || 80)) || null;
  }

  add(input) {
    const dev = {
      id: crypto.randomUUID(),
      name: String(input.name || input.host || '未命名').slice(0, 60),
      host: String(input.host || '').trim(),
      port: Number(input.port) || 80,
      username: String(input.username || 'user'),
      password: String(input.password || ''),
      vendor: 'vertiv-ita2',
      model: String(input.model || '').slice(0, 60),
      site: String(input.site || '').slice(0, 80),
      commissionDate: String(input.commissionDate || '').slice(0, 20),
      integrator: String(input.integrator || '').slice(0, 80),
      serial: String(input.serial || '').slice(0, 60),
      note: String(input.note || '').slice(0, 500),
      tags: Array.isArray(input.tags) ? input.tags.map(String).slice(0, 20) : [],
      groupIds: Array.isArray(input.groupIds) ? input.groupIds.slice(0, 20) : [],
      intervalMs: Math.max(5000, Math.min(300000, Number(input.intervalMs) || 10000)),
      enabled: input.enabled !== false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.data.devices.push(dev);
    this.save();
    return dev;
  }

  update(id, patch) {
    const d = this.get(id);
    if (!d) return null;
    for (const k of DEVICE_FIELDS) {
      if (patch[k] === undefined) continue;
      if (k === 'intervalMs') d[k] = Math.max(5000, Math.min(300000, Number(patch[k]) || 10000));
      else if (k === 'port') d[k] = Number(patch[k]) || 80;
      else if (k === 'enabled') d[k] = !!patch[k];
      else if (k === 'groupIds' || k === 'tags') d[k] = Array.isArray(patch[k]) ? patch[k].slice(0, 20) : [];
      else if (k === 'password') { if (patch[k] !== '') d[k] = String(patch[k]); }
      else d[k] = String(patch[k]).slice(0, 500);
    }
    d.updatedAt = Date.now();
    this.save();
    return d;
  }

  remove(id) {
    const i = this.data.devices.findIndex(d => d.id === id);
    if (i < 0) return false;
    this.data.devices.splice(i, 1);
    this.save();
    return true;
  }

  // 对外输出时隐藏密码明文
  publicView(d) {
    const o = Object.assign({}, d);
    o.hasPassword = !!d.password;
    o.password = d.password ? '********' : '';
    return o;
  }
}

module.exports = { Store, DEVICE_FIELDS };
