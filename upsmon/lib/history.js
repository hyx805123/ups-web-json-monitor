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

// 统计口径：区间内的极值 / 均值 / 放电次数与时长
const STAT_METRICS = ['vOut', 'vIn', 'iOut', 'fOut', 'kw', 'kva', 'loadPct',
  'battCap', 'battV', 'battI', 'backupMin', 'envTemp', 'battTemp'];

function accNew() {
  return {
    count: 0, firstTs: null, lastTs: null, metrics: {},
    discharge: { episodes: 0, ms: 0 },
    bypassSamples: 0, alarmSamples: 0, faultSamples: 0, onlineMissing: 0,
    _prevTs: null, _inDis: false
  };
}

function accAdd(st, o) {
  st.count++;
  if (st.firstTs === null || o.ts < st.firstTs) st.firstTs = o.ts;
  if (st.lastTs === null || o.ts > st.lastTs) st.lastTs = o.ts;
  for (let i = 0; i < STAT_METRICS.length; i++) {
    const k = STAT_METRICS[i];
    const v = o[k];
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (!isFinite(n)) continue;
    let m = st.metrics[k];
    if (!m) { m = st.metrics[k] = { min: n, max: n, sum: 0, n: 0 }; }
    if (n < m.min) m.min = n;
    if (n > m.max) m.max = n;
    m.sum += n; m.n++;
  }
  if (o.supply === 1) st.bypassSamples++;
  if (o.alarms > 0) st.alarmSamples++;
  if (o.faults > 0) st.faultSamples++;
  const discharging = o.battState === 3;   // 3 = 放电中
  if (discharging) {
    if (!st._inDis) { st.discharge.episodes++; st._inDis = true; }
    if (st._prevTs !== null) {
      const dt = o.ts - st._prevTs;
      // 采集中断（重启 / VPN 掉线）时不要把整段空档算成放电时长
      if (dt > 0 && dt <= 60000) st.discharge.ms += dt;
    }
  } else {
    if (o.battState == null) st.onlineMissing++;
    st._inDis = false;
  }
  st._prevTs = o.ts;
}

function accDone(st) {
  const out = {
    count: st.count, firstTs: st.firstTs, lastTs: st.lastTs,
    discharge: st.discharge, bypassSamples: st.bypassSamples,
    alarmSamples: st.alarmSamples, faultSamples: st.faultSamples,
    onlineMissing: st.onlineMissing, metrics: {}
  };
  for (const k of Object.keys(st.metrics)) {
    const m = st.metrics[k];
    out.metrics[k] = { min: m.min, max: m.max, avg: m.n ? m.sum / m.n : null, n: m.n };
  }
  return out;
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
  // 给了时间区间就按文件名裁剪：day 是 YYYY-MM-DD，定长零填充，字典序即时间序，
  // 可以直接字符串比较，不需要把文件读进来才知道该不该读。
  listDays(deviceId, fromTs, toTs) {
    const dir = path.join(this.dir, deviceId);
    if (!fs.existsSync(dir)) return [];
    let days = fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''))
      .sort();
    if (fromTs != null) {
      const from = dayKey(fromTs);
      days = days.filter(d => d >= from);
    }
    if (toTs != null) {
      const to = dayKey(toTs);
      days = days.filter(d => d <= to);
    }
    return days;
  }

  // 遍历区间内的采样点：只打开与区间相交的日分片，逐行喂给 onPoint
  // onPoint 返回 false 可提前结束（导出时用于限制条数）
  _scan(deviceId, fromTs, toTs, onPoint) {
    const days = this.listDays(deviceId, fromTs, toTs);
    for (const day of days) {
      const file = path.join(this.dir, deviceId, day + '.jsonl');
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
      const lines = raw.split('\n');
      let over = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        let o;
        try { o = JSON.parse(line); } catch (e) { continue; }
        if (o.ts < fromTs) continue;
        if (o.ts > toTs) {
          // 分片按写入顺序追加，ts 基本单调，越过右边界后剩下的基本都没用；
          // 保留 50 行容错，避免时钟回拨导致整段被跳过。
          if (++over > 50) return;
          continue;
        }
        over = 0;
        if (onPoint(o) === false) return;
      }
    }
  }

  // 读取时间区间内的采样点；maxPoints 超过时按桶降采样（取桶内平均值）
  read(deviceId, fromTs, toTs, maxPoints) {
    const pts = [];
    this._scan(deviceId, fromTs, toTs, (o) => { pts.push(o); });
    pts.sort((a, b) => a.ts - b.ts);
    return this._downsample(pts, maxPoints);
  }

  // 超过 maxPoints 时按桶降采样：桶内数值取平均，时间戳取桶中点
  _downsample(pts, maxPoints) {
    if (!maxPoints || pts.length <= maxPoints) return pts;
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

  // 区间统计：一次顺序扫描，产出极值、均值、放电次数与时长
  // 用于「历史查询」页的汇总卡片，不必把全量点返回给前端
  stats(deviceId, fromTs, toTs) {
    const st = accNew();
    this._scan(deviceId, fromTs, toTs, (o) => { accAdd(st, o); });
    return accDone(st);
  }

  // 取点 + 统计走同一遍扫描：30 天这种大区间能省掉一次全量解析
  readWithStats(deviceId, fromTs, toTs, maxPoints, wantStats) {
    const pts = [];
    const st = wantStats === false ? null : accNew();
    this._scan(deviceId, fromTs, toTs, (o) => {
      pts.push(o);
      if (st) accAdd(st, o);
    });
    const points = this._downsample(pts, maxPoints);
    return { points, stats: st ? accDone(st) : null };
  }

  // 导出用：不降采样，按上限截断
  exportRows(deviceId, fromTs, toTs, limit) {
    const max = Math.max(1, Math.min(limit || 200000, 500000));
    const rows = [];
    this._scan(deviceId, fromTs, toTs, (o) => {
      rows.push(o);
      return rows.length < max;
    });
    rows.sort((a, b) => a.ts - b.ts);
    return { rows, truncated: rows.length >= max };
  }

  // 从文件尾部读一块，避免事件文件变大后每次都全量解析
  _readTail(file, maxBytes) {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - (maxBytes || 512 * 1024));
      const len = size - start;
      if (len <= 0) return '';
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, start);
      let s = buf.toString('utf8');
      // 起点可能落在半行中间，丢掉第一段残缺内容
      if (start > 0) {
        const nl = s.indexOf('\n');
        s = nl >= 0 ? s.slice(nl + 1) : '';
      }
      return s;
    } finally {
      fs.closeSync(fd);
    }
  }

  // 事件读取：默认取最近 limit 条；给了 fromTs/toTs 则按区间过滤
  // 从尾部往前扫，遇到早于 fromTs 的即可停止，不必全文件解析
  readEvents(limit, fromTs, toTs) {
    const n = Math.max(1, Math.min(limit || 200, 5000));
    const hasRange = (fromTs != null && isFinite(fromTs)) || (toTs != null && isFinite(toTs));
    let raw;
    try {
      raw = hasRange ? this._readTail(this.eventsFile, 4 * 1024 * 1024)
                     : this._readTail(this.eventsFile, 512 * 1024);
    } catch (e) { return []; }
    if (!raw) return [];
    const lines = raw.split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      let o;
      try { o = JSON.parse(lines[i]); } catch (e) { continue; }
      if (fromTs != null && isFinite(fromTs) && o.ts < fromTs) break;   // 文件按时间追加
      if (toTs != null && isFinite(toTs) && o.ts > toTs) continue;
      out.push(o);
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
