'use strict';
// 历史数据持久化：采样点与告警事件全量落盘，按天分片 JSONL
// 目录结构： data/history/<deviceId>/<YYYY-MM-DD>.jsonl
//           归档后为 <YYYY-MM-DD>.jsonl.gz（内容与明文分片完全相同，只是压缩过）
//           读取端两种都认：查询、统计、导出对外表现一致，调用方不需要关心是否归档。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DAY_GZ_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/;
const GZ_CACHE_MAX = 8;   // 解压后的日分片缓存条数（单个 1.8 MB 左右，8 条 ≈ 15 MB 上限）

function dayKey(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// 三相机型额外落盘的分相字段（单相机型不写）。降采样时要逐桶平均，
// 否则分相曲线会退化成"桶内第一条/最后一条"，尖峰被抹平。
const PHASE_KEYS = ['vInA', 'vInB', 'vInC', 'vOutA', 'vOutB', 'vOutC', 'iOutA', 'iOutB', 'iOutC'];

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
    this._gzCache = new Map();  // gz 文件路径 -> {mtimeMs, size, text}
  }

  // 归档分片解压（带小容量缓存，避免同一次查询里反复解压同一个文件）
  _readGz(file) {
    let st;
    try { st = fs.statSync(file); } catch (e) { return null; }
    const hit = this._gzCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text;
    let text;
    try { text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'); }
    catch (e) { return null; }     // 损坏的归档当缺失处理，不让整个查询报错
    this._gzCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, text });
    if (this._gzCache.size > GZ_CACHE_MAX) {
      const first = this._gzCache.keys().next().value;
      this._gzCache.delete(first);
    }
    return text;
  }

  // 某天分片的实际文件路径：优先明文（正在写），其次归档
  dayFile(deviceId, day) {
    const dir = path.join(this.dir, deviceId);
    const plain = path.join(dir, day + '.jsonl');
    if (fs.existsSync(plain)) return plain;
    const gz = plain + '.gz';
    if (fs.existsSync(gz)) return gz;
    return null;
  }

  // 某天分片在磁盘上的字节数（归档后是压缩后的大小）
  dayBytes(deviceId, day) {
    const f = this.dayFile(deviceId, day);
    if (!f) return 0;
    try { return fs.statSync(f).size; } catch (e) { return 0; }
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
    const seen = new Set();
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.jsonl.gz')) { const m = DAY_GZ_RE.exec(f); if (m) seen.add(m[1]); }
      else if (f.endsWith('.jsonl')) seen.add(f.slice(0, -6));
    }
    let days = Array.from(seen).sort();
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
      const file = this.dayFile(deviceId, day);
      if (!file) continue;
      let raw;
      if (file.endsWith('.gz')) {
        raw = this._readGz(file);
        if (raw == null) continue;
      } else {
        try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
      }
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
      const rec = Object.assign({}, slice[0], {
        ts: slice[Math.floor(slice.length / 2)].ts,
        vOut: avg('vOut'), vIn: avg('vIn'), iOut: avg('iOut'), fOut: avg('fOut'),
        kw: avg('kw'), kva: avg('kva'), loadPct: avg('loadPct'),
        battCap: avg('battCap'), battV: avg('battV'), battI: avg('battI'),
        battState: slice[slice.length - 1].battState,
        backupMin: avg('backupMin'), envTemp: avg('envTemp'), battTemp: avg('battTemp'),
        alarms: slice[slice.length - 1].alarms, faults: slice[slice.length - 1].faults
      });
      for (const k of PHASE_KEYS) if (slice[0][k] !== undefined) rec[k] = avg(k);
      out.push(rec);
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
    for (const k of Array.from(this._gzCache.keys())) {
      if (path.dirname(k) === dir) this._gzCache.delete(k);
    }
    this.buffers.delete(deviceId);
  }
}

module.exports = { HistoryStore, dayKey };
