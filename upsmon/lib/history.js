'use strict';
// 历史数据持久化：采样点与告警事件全量落盘，按天分片 JSONL
// 目录结构： data/history/<deviceId>/<YYYY-MM-DD>.jsonl
const fs = require('fs');
const path = require('path');

function dayKey(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

class HistoryStore {
  constructor(dir) {
    this.dir = dir;
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    this.buffers = new Map();   // deviceId -> {file, lines:[]}
    this.eventBuf = [];
    this.eventsFile = path.join(this.dir, 'events.jsonl');
  }

  _deviceDir(deviceId) {
    const d = path.join(this.dir, deviceId);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    return d;
  }

  // 采样点写入（内存缓冲，1 秒批量刷盘）
  append(deviceId, point) {
    let b = this.buffers.get(deviceId);
    if (!b) { b = { file: null, lines: [] }; this.buffers.set(deviceId, b); }
    const file = path.join(this._deviceDir(deviceId), dayKey(point.ts) + '.jsonl');
    if (b.file !== file) {
      this.flushDevice(deviceId);
      b.file = file;
    }
    b.lines.push(JSON.stringify(point));
  }

  flushDevice(deviceId) {
    const b = this.buffers.get(deviceId);
    if (!b || !b.lines.length || !b.file) return;
    const data = b.lines.join('\n') + '\n';
    b.lines = [];
    try { fs.appendFileSync(b.file, data, 'utf8'); } catch (e) { /* 磁盘异常时丢弃该批 */ }
  }

  flushAll() {
    for (const id of Array.from(this.buffers.keys())) this.flushDevice(id);
    if (this.eventBuf.length) {
      const data = this.eventBuf.join('\n') + '\n';
      this.eventBuf = [];
      try { fs.appendFileSync(this.eventsFile, data, 'utf8'); } catch (e) { /* ignore */ }
    }
  }

  appendEvent(evt) {
    this.eventBuf.push(JSON.stringify(evt));
    if (this.eventBuf.length >= 50) this.flushAll();
  }

  // 列出该设备已有的日期分片（升序）
  listDays(deviceId) {
    const dir = path.join(this.dir, deviceId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''))
      .sort();
  }

  // 读取时间区间内的采样点；maxPoints 超过时按桶降采样（取桶内平均值）
  read(deviceId, fromTs, toTs, maxPoints) {
    const days = this.listDays(deviceId);
    const pts = [];
    for (const day of days) {
      const file = path.join(this.dir, deviceId, day + '.jsonl');
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
      const lines = raw.split('\n');
      for (const line of lines) {
        if (!line) continue;
        let o;
        try { o = JSON.parse(line); } catch (e) { continue; }
        if (o.ts < fromTs) continue;
        if (o.ts > toTs) continue;
        pts.push(o);
      }
    }
    pts.sort((a, b) => a.ts - b.ts);
    if (maxPoints && pts.length > maxPoints) {
      const bucket = Math.ceil(pts.length / maxPoints);
      const out = [];
      for (let i = 0; i < pts.length; i += bucket) {
        const slice = pts.slice(i, i + bucket);
        const avg = (key) => {
          const vals = slice.map(s => s[key]).filter(v => v !== null && v !== undefined && v !== '');
          if (!vals.length) return null;
          return vals.reduce((x, y) => x + Number(y), 0) / vals.length;
        };
        out.push(Object.assign({}, slice[0], {
          ts: slice[Math.floor(slice.length / 2)].ts,
          vOut: avg('vOut'), vIn: avg('vIn'), iOut: avg('iOut'), fOut: avg('fOut'),
          kw: avg('kw'), kva: avg('kva'), loadPct: avg('loadPct'),
          battCap: avg('battCap'), battV: avg('battV'), battI: avg('battI'),
          battState: slice[slice.length - 1].battState,
          backupMin: avg('backupMin'), envTemp: avg('envTemp'), battTemp: avg('battTemp'),
          alarms: slice[slice.length - 1].alarms, faults: slice[slice.length - 1].faults
        }));
      }
      return out;
    }
    return pts;
  }

  readEvents(limit) {
    let raw = '';
    try { raw = fs.readFileSync(this.eventsFile, 'utf8'); } catch (e) { return []; }
    const lines = raw.split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < (limit || 200); i--) {
      try { out.push(JSON.parse(lines[i])); } catch (e) { /* skip */ }
    }
    return out;
  }

  removeDevice(deviceId) {
    const dir = path.join(this.dir, deviceId);
    try {
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
        }
        fs.rmdirSync(dir);
      }
    } catch (e) {}
    this.buffers.delete(deviceId);
  }
}

module.exports = { HistoryStore, dayKey };
