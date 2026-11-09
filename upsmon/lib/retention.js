'use strict';
// 历史数据回收：按「整天、跨全部设备」淘汰最旧分片，控制 data/history 总体积。
//
// 为什么按整天删而不是按单台设备删：
//   历史查询按文件名裁剪（day 是 YYYY-MM-DD，字典序即时间序），半天文件会在区间里留空洞；
//   只删某几台设备的分片，会让"同一时刻多台横向对比"缺边。整天全设备一起删，
//   每台设备的覆盖天数始终一致，界面上的覆盖概览不会出现锯齿。
//
// 为什么今天永不删：
//   采集器正在往当天的分片里追加，删掉会立刻被重新创建，还会丢掉已写入的半天数据。
//   因此 dayKey(now) 及之后的日期一律排除。
//
// 触发条件（二选一，可同时开）：
//   容量：totalBytes >= limitGB → 从最旧一天删起，直到 <= limitGB * targetPct% 或只剩 minKeepDays 天
//   天数：keepDays > 0 时，晚于 today-keepDays 的保留，更早的删除（同样受 minKeepDays 兜底）
const fs = require('fs');
const path = require('path');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REMOVE_DAYS = 500;   // 单次回收上限，防止配置写错把库删光
const EVENTS_MAX_BYTES = 32 * 1024 ** 2;   // events.jsonl 上限，超出只保留最近的约 60%

function dayKey(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function fmtBytes(n) {
  if (n >= 1024 ** 4) return (n / 1024 ** 4).toFixed(2) + ' TB';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

class Retention {
  constructor(opts) {
    this.dir = opts.dir;                 // .../data/history
    this.getConfig = opts.getConfig;     // () => settings.retention()
    this.onEvent = opts.onEvent || (() => {});     // (level, msg) => void
    this.onPruned = opts.onPruned || (() => {});   // 删除后通知上层清理缓存
    this.timer = null;
    this.last = null;                    // 最近一次回收结果
    this._cache = null;                  // { at, data }
  }

  config() {
    const c = this.getConfig() || {};
    return {
      enabled: c.enabled !== false,
      // 下限 0.05 GB 是最后一道护栏：即使 settings.json 被手改成 0，也不会把库一次删空
      limitGB: Math.max(0.05, Number(c.limitGB) || 60),
      targetPct: Math.min(99, Math.max(10, Number(c.targetPct) || 90)),
      minKeepDays: Math.max(1, Number(c.minKeepDays) || 7),
      keepDays: Math.max(0, Number(c.keepDays) || 0),
      checkEveryMin: Math.min(1440, Math.max(1, Number(c.checkEveryMin) || 10))
    };
  }

  // 扫描 history 目录：按天汇总字节数与分片数
  // 结构固定为 history/<deviceId>/<YYYY-MM-DD>.jsonl + history/events.jsonl，
  // 40 台 × 365 天 ≈ 1.5 万个文件，statSync 一遍是毫秒级
  scan(useCache) {
    if (useCache && this._cache && Date.now() - this._cache.at < 60000) return this._cache.data;
    const days = new Map();      // day -> { bytes, files, devices:Set }
    let eventsBytes = 0;
    let deviceCount = 0;
    let entries = [];
    try { entries = fs.readdirSync(this.dir, { withFileTypes: true }); } catch (_) { entries = []; }
    for (const ent of entries) {
      if (!ent.isDirectory()) {
        if (ent.name === 'events.jsonl') {
          try { eventsBytes = fs.statSync(path.join(this.dir, ent.name)).size; } catch (_) {}
        }
        continue;
      }
      deviceCount++;
      const devDir = path.join(this.dir, ent.name);
      let files = [];
      try { files = fs.readdirSync(devDir); } catch (_) { continue; }
      for (const f of files) {
        let day = null;
        if (f.endsWith('.jsonl.gz')) day = f.slice(0, -9);      // 归档分片也要计入总量
        else if (f.endsWith('.jsonl')) day = f.slice(0, -6);
        if (!day || !DAY_RE.test(day)) continue;      // 非法文件名不参与回收，避免误删
        let size = 0;
        try { size = fs.statSync(path.join(devDir, f)).size; } catch (_) { continue; }
        let rec = days.get(day);
        if (!rec) { rec = { bytes: 0, files: 0, devices: 0 }; days.set(day, rec); }
        rec.bytes += size; rec.files++; rec.devices++;
      }
    }
    const list = Array.from(days.entries())
      .map(([day, r]) => ({ day, bytes: r.bytes, files: r.files, devices: r.devices }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const totalBytes = list.reduce((s, d) => s + d.bytes, eventsBytes);
    const data = {
      days: list,
      totalBytes,
      eventsBytes,
      dayCount: list.length,
      deviceCount,
      firstDay: list.length ? list[0].day : null,
      lastDay: list.length ? list[list.length - 1].day : null
    };
    this._cache = { at: Date.now(), data };
    return data;
  }

  // 计算本次该删哪些天（纯函数，不落盘，便于 dry-run 直接复用）
  plan() {
    const cfg = this.config();
    const s = this.scan(true);
    const today = dayKey(Date.now());
    const candidates = s.days.filter(d => d.day < today);   // 今天及以后永不删

    // minKeepDays 兜底：最新的 N 天受保护（按实际存在的天数算，不按日历天）
    const protectedDays = new Set(candidates.slice(Math.max(0, candidates.length - cfg.minKeepDays)).map(d => d.day));
    const removable = candidates.filter(d => !protectedDays.has(d.day));

    const limitBytes = cfg.limitGB * 1024 ** 3;
    const targetBytes = Math.floor(limitBytes * cfg.targetPct / 100);
    const overLimit = s.totalBytes >= limitBytes;
    const expiredCutoff = cfg.keepDays > 0
      ? dayKey(Date.now() - cfg.keepDays * 86400000)
      : null;

    const picked = [];
    let cursor = s.totalBytes;
    for (const d of removable) {
      if (picked.length >= MAX_REMOVE_DAYS) break;
      const expired = expiredCutoff && d.day < expiredCutoff;
      // 只删到目标线以下；天数模式下超期的一律删
      if (overLimit && cursor > targetBytes) {
        picked.push(d); cursor -= d.bytes;
        continue;
      }
      if (expired) { picked.push(d); cursor -= d.bytes; continue; }
      if (overLimit && cursor <= targetBytes) break;
      if (!overLimit) break;
    }

    return {
      cfg,
      scan: s,
      today,
      limitBytes,
      targetBytes,
      overLimit,
      expiredCutoff,
      removableDays: removable.length,
      picked,
      willFree: picked.reduce((a, d) => a + d.bytes, 0)
    };
  }

  status() {
    const p = this.plan();
    const s = p.scan;
    return {
      config: p.cfg,
      usage: {
        totalBytes: s.totalBytes,
        totalText: fmtBytes(s.totalBytes),
        limitBytes: p.limitBytes,
        limitText: fmtBytes(p.limitBytes),
        percent: p.limitBytes ? Math.min(100, Math.round(s.totalBytes / p.limitBytes * 1000) / 10) : 0,
        eventsBytes: s.eventsBytes,
        dayCount: s.dayCount,
        deviceCount: s.deviceCount,
        firstDay: s.firstDay,
        lastDay: s.lastDay
      },
      plan: {
        overLimit: p.overLimit,
        expiredCutoff: p.expiredCutoff,
        removableDays: p.removableDays,
        willRemove: p.picked.map(d => d.day),
        willFreeBytes: p.willFree,
        willFreeText: fmtBytes(p.willFree)
      },
      last: this.last
    };
  }

  // dry=true 只算不删
  run(opts) {
    const dry = !!(opts && opts.dry);
    const cfg = this.config();
    if (!cfg.enabled && !dry) {
      return { skipped: true, reason: '回收未启用', config: cfg };
    }
    const p = this.plan();
    if (!p.picked.length) {
      return {
        skipped: true,
        reason: p.overLimit ? '没有可删的历史（已触及保留天数下限）' : '未达到回收条件',
        usage: { totalText: fmtBytes(p.scan.totalBytes), limitText: fmtBytes(p.limitBytes) },
        config: cfg
      };
    }
    if (dry) {
      return {
        dry: true,
        beforeBytes: p.scan.totalBytes,
        willRemove: p.picked.map(d => d.day),
        willFreeBytes: p.willFree,
        willFreeText: fmtBytes(p.willFree),
        afterText: fmtBytes(p.scan.totalBytes - p.willFree)
      };
    }

    const root = path.resolve(this.dir);
    const removed = [];
    const warnings = [];
    let freed = 0;
    for (const d of p.picked) {
      let files = 0, bytes = 0;
      const leftover = [];
      const kill = (file) => {
        try {
          const st = fs.statSync(file);
          fs.unlinkSync(file);
          files++; bytes += st.size;
          return true;
        } catch (_) { return false; }
      };
      for (const dev of fs.readdirSync(root)) {
        if (dev === 'events.jsonl') continue;
        const devDir = path.join(root, dev);
        let isDir = false;
        try { isDir = fs.statSync(devDir).isDirectory(); } catch (_) { continue; }
        if (!isDir) continue;
        // 一天可能有明文分片、也可能已归档成 .jsonl.gz，两种都要删干净
        for (const name of [d.day + '.jsonl', d.day + '.jsonl.gz']) {
          const file = path.join(devDir, name);
          // 越界保护：确保最终路径仍在本设备的 history 子目录内
          if (path.dirname(path.resolve(file)) !== path.resolve(devDir)) continue;
          if (!fs.existsSync(file)) continue;
          if (!kill(file)) leftover.push(file);      // Windows 上被读占用时会失败
        }
      }
      // 正有人在查这一天时 unlink 会失败，等一轮再来一次；仍失败就留着，下次回收再处理
      for (const file of leftover) {
        if (!kill(file)) warnings.push(path.basename(file));
      }
      if (files) { removed.push({ day: d.day, files, bytes }); freed += bytes; }
    }
    this._cache = null;
    try { this.onPruned(); } catch (_) {}

    const after = this.scan(false).totalBytes;
    const evTrimmed = this.trimEvents(EVENTS_MAX_BYTES);
    const result = {
      ok: true,
      beforeBytes: p.scan.totalBytes,
      beforeText: fmtBytes(p.scan.totalBytes),
      afterBytes: after,
      afterText: fmtBytes(after),
      freedBytes: freed,
      freedText: fmtBytes(freed),
      removedDays: removed.length,
      removed,
      warnings: warnings.length ? warnings : undefined,
      eventsTrimmed: evTrimmed
    };
    this.last = { at: Date.now(), ...result };
    if (removed.length) {
      this.onEvent('warn', '历史数据回收：删除 ' + removed.length + ' 天（' +
        removed[0].day + ' ~ ' + removed[removed.length - 1].day + '），释放 ' +
        fmtBytes(freed) + '，当前 ' + fmtBytes(after));
    }
    if (evTrimmed) {
      this.onEvent('warn', '事件日志瘦身：保留最近 ' + fmtBytes(evTrimmed.keptBytes) +
        '，释放 ' + fmtBytes(evTrimmed.freedBytes));
    }
    return result;
  }

  // events.jsonl 只增不减，也是"数据文件"的一部分。超过上限时从尾部保留一段整行，
  // 原子替换原文件；首行可能被截断成半行，直接丢弃该行。
  trimEvents(maxBytes) {
    const file = path.join(this.dir, 'events.jsonl');
    let st;
    try { st = fs.statSync(file); } catch (_) { return null; }
    if (st.size <= maxBytes) return null;
    const keepBytes = Math.floor(maxBytes * 0.6);
    const start = Math.max(0, st.size - keepBytes);
    let buf;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        buf = Buffer.alloc(st.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
      } finally { fs.closeSync(fd); }
    } catch (_) { return null; }
    let text = buf.toString('utf8');
    const nl = text.indexOf('\n');
    if (start > 0 && nl >= 0) text = text.slice(nl + 1);   // 丢掉可能被截断的首行
    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      return null;
    }
    const keptBytes = Buffer.byteLength(text, 'utf8');
    this._cache = null;
    return { freedBytes: st.size - keptBytes, keptBytes };
  }

  // 定时检查；启动时先跑一次（启动即超限才删，正常情况只更新缓存）
  start() {
    this.stop();
    const cfg = this.config();
    const tick = () => {
      try {
        const r = this.run({ dry: false });
        if (r && r.ok) console.log('[retention] ' + r.afterText + ' / ' + fmtBytes(this.config().limitGB * 1024 ** 3) +
          '，删除 ' + r.removedDays + ' 天，释放 ' + r.freedText);
      } catch (e) {
        console.log('[retention] 检查失败: ' + e.message);
      }
    };
    // 启动后 60 秒再检查，避开启动瞬间的采集与读盘高峰
    setTimeout(tick, 60000).unref();
    this.timer = setInterval(tick, cfg.checkEveryMin * 60000);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // 归档压缩会改变磁盘占用（总量下降），让统计缓存立即失效
  invalidate() { this._cache = null; }
}

module.exports = { Retention, dayKey, fmtBytes };
