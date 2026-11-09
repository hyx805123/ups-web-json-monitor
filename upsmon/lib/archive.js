'use strict';
// 历史数据归档压缩：把「已经不会再写」的日分片压缩成 .jsonl.gz，原文件校验一致后删除。
//
// 为什么值得做：
//   采样点 JSONL 的 gzip 压缩比实测约 18:1（143 MB → 8 MB）。压缩不改变任何取值，
//   只是把冷数据的存储密度提高一个数量级，等于把 60 GB 的容量上限放大到 1 TB 量级。
//
// 为什么安全：
//   1. 只处理 < 今天 的分片。当天的分片采集器还在追加，永不触碰。
//   2. 先写 <file>.gz.tmp，把 tmp 解压出来与原文逐字节比对，一致才 rename 成 .jsonl.gz，
//      最后才删原文件。任何一步失败都保留原文件，最坏情况只是「没压成」。
//   3. 读取端（lib/history.js）同时认 .jsonl 与 .jsonl.gz，归档对查询、统计、导出透明。
//
// 为什么不阻塞采集：
//   gzipSync 单个 1.8 MB 分片约 20~40 ms。每处理完一个文件就让出事件循环（setImmediate），
//   单次最多处理 maxFilesPerRun 个，宁可多跑几轮也不长时间卡住 HTTP 与采集。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const GZ_EXT = '.gz';              // 归档文件名：<YYYY-MM-DD>.jsonl.gz
const GZ_SUFFIX = '.jsonl.gz';     // 识别归档用的完整后缀

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

// gzip 文件尾 4 字节是小端存放的原始长度（ISIZE），不用解压就能算压缩比
function gzOriginalSize(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < 18) return 0;
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, size - 4);
    return b.readUInt32LE(0);
  } catch (e) {
    return 0;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} }
  }
}

class Archive {
  constructor(opts) {
    this.dir = opts.dir;                 // .../data/history
    this.getConfig = opts.getConfig;     // () => settings.archive()
    this.onEvent = opts.onEvent || (() => {});
    this.onArchived = opts.onArchived || (() => {});
    this.beforeRun = opts.beforeRun || (() => {});   // 跑之前先 flush 采集缓冲
    this.maxFilesPerRun = opts.maxFilesPerRun || 400;
    this.timer = null;
    this.last = null;
    this._busy = false;
  }

  config() {
    const c = this.getConfig() || {};
    return {
      enabled: c.enabled !== false,
      // 至少留 1 天：今天永远不压，所以 1 天等价于「只压昨天及更早」
      afterDays: Math.min(3650, Math.max(1, Math.round(Number(c.afterDays) || 3))),
      checkEveryMin: Math.min(1440, Math.max(5, Math.round(Number(c.checkEveryMin) || 60))),
      level: Math.min(9, Math.max(1, Math.round(Number(c.level) || 6)))
    };
  }

  // 扫描：分成「待压缩」与「已归档」两类
  scan() {
    const cfg = this.config();
    const today = dayKey(Date.now());
    const cutoff = dayKey(Date.now() - cfg.afterDays * 86400000);  // 早于此日期的才压
    const pending = [];
    let archivedFiles = 0, archivedBytes = 0, archivedRaw = 0;
    const archivedDays = new Set();
    let deviceCount = 0;

    let entries = [];
    try { entries = fs.readdirSync(this.dir, { withFileTypes: true }); } catch (e) { entries = []; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      deviceCount++;
      const devDir = path.join(this.dir, ent.name);
      let files = [];
      try { files = fs.readdirSync(devDir); } catch (e) { continue; }
      for (const f of files) {
        if (f.endsWith(GZ_SUFFIX)) {
          const day = f.slice(0, -GZ_SUFFIX.length);
          if (!DAY_RE.test(day)) continue;
          const full = path.join(devDir, f);
          let size = 0;
          try { size = fs.statSync(full).size; } catch (e) { continue; }
          archivedFiles++; archivedBytes += size;
          archivedRaw += gzOriginalSize(full) || 0;
          archivedDays.add(day);
          continue;
        }
        if (!f.endsWith('.jsonl')) continue;
        const day = f.slice(0, -6);
        if (!DAY_RE.test(day)) continue;
        // 今天的、以及还在保留窗口内的明文分片都不压：这些是热数据，查询最频繁
        if (day >= today || day >= cutoff) continue;
        const full = path.join(devDir, f);
        if (fs.existsSync(full + GZ_EXT)) continue;   // 已有归档，保守跳过，不覆盖
        let size = 0;
        try { size = fs.statSync(full).size; } catch (e) { continue; }
        pending.push({ device: ent.name, day, file: full, bytes: size });
      }
    }

    pending.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.device < b.device ? -1 : 1));
    const pendingDays = new Set(pending.map(p => p.day));
    return {
      today,
      cutoff,
      deviceCount,
      pending,
      pendingFiles: pending.length,
      pendingBytes: pending.reduce((s, p) => s + p.bytes, 0),
      pendingDays: pendingDays.size,
      earliestPending: pending.length ? pending[0].day : null,
      archivedFiles,
      archivedBytes,
      archivedRaw,
      archivedDays: archivedDays.size,
      ratio: archivedBytes > 0 && archivedRaw > 0 ? archivedRaw / archivedBytes : 0
    };
  }

  status() {
    const cfg = this.config();
    const s = this.scan();
    return {
      config: cfg,
      usage: {
        pendingFiles: s.pendingFiles,
        pendingBytes: s.pendingBytes,
        pendingText: fmtBytes(s.pendingBytes),
        pendingDays: s.pendingDays,
        earliestPending: s.earliestPending,
        cutoff: s.cutoff,
        archivedFiles: s.archivedFiles,
        archivedDays: s.archivedDays,
        archivedBytes: s.archivedBytes,
        archivedText: fmtBytes(s.archivedBytes),
        archivedRaw: s.archivedRaw,
        archivedRawText: fmtBytes(s.archivedRaw),
        ratio: Math.round(s.ratio * 10) / 10,
        savedBytes: Math.max(0, s.archivedRaw - s.archivedBytes),
        savedText: fmtBytes(Math.max(0, s.archivedRaw - s.archivedBytes)),
        deviceCount: s.deviceCount
      },
      last: this.last
    };
  }

  _archiveOne(item, cfg) {
    const raw = fs.readFileSync(item.file);
    const gz = zlib.gzipSync(raw, { level: cfg.level });
    const gzPath = item.file + GZ_EXT;
    const tmp = gzPath + '.tmp';
    fs.writeFileSync(tmp, gz);
    // 逐字节校验：解压结果必须与原文完全一致，否则宁可放弃
    let ok = false;
    try { ok = zlib.gunzipSync(fs.readFileSync(tmp)).equals(raw); } catch (e) { ok = false; }
    if (!ok) {
      try { fs.unlinkSync(tmp); } catch (e) {}
      throw new Error('解压校验不一致，已保留原文件');
    }
    fs.renameSync(tmp, gzPath);
    fs.unlinkSync(item.file);
    return { rawBytes: raw.length, gzBytes: gz.length };
  }

  // dry=true 只列清单，不动文件
  async run(opts) {
    const dry = !!(opts && opts.dry);
    const cfg = this.config();
    if (!dry && !cfg.enabled) return { skipped: true, reason: '归档未启用', config: cfg };
    if (this._busy) return { skipped: true, reason: '已有归档任务在执行', config: cfg };

    this._busy = true;
    const started = Date.now();
    try {
      this.beforeRun();
      const s = this.scan();
      if (!s.pending.length) {
        return {
          skipped: true,
          reason: '没有需要压缩的分片（' + cfg.afterDays + ' 天内的数据保持明文）',
          config: cfg,
          usage: { archivedFiles: s.archivedFiles, archivedText: fmtBytes(s.archivedBytes) }
        };
      }
      if (dry) {
        const preview = s.pending.slice(0, 20).map(p => p.day + ' ' + p.device.slice(0, 8));
        return {
          dry: true,
          files: s.pendingFiles,
          days: s.pendingDays,
          bytes: s.pendingBytes,
          bytesText: fmtBytes(s.pendingBytes),
          earliest: s.earliestPending,
          latest: s.pending[s.pending.length - 1].day,
          preview
        };
      }

      const batch = s.pending.slice(0, this.maxFilesPerRun);
      const done = [];
      const failed = [];
      let rawBytes = 0, gzBytes = 0;
      for (const item of batch) {
        try {
          const r = this._archiveOne(item, cfg);
          rawBytes += r.rawBytes; gzBytes += r.gzBytes;
          done.push({ day: item.day, device: item.device, rawBytes: r.rawBytes, gzBytes: r.gzBytes });
        } catch (e) {
          failed.push({ day: item.day, device: item.device, error: e.message });
        }
        // 每个文件后让出事件循环，避免长时间阻塞采集与 HTTP 响应
        await new Promise((r) => setImmediate(r));
      }

      this.onArchived();
      const days = new Set(done.map(d => d.day));
      const result = {
        ok: true,
        files: done.length,
        days: days.size,
        remaining: Math.max(0, s.pendingFiles - done.length),
        rawBytes,
        rawText: fmtBytes(rawBytes),
        gzBytes,
        gzText: fmtBytes(gzBytes),
        freedBytes: Math.max(0, rawBytes - gzBytes),
        freedText: fmtBytes(Math.max(0, rawBytes - gzBytes)),
        ratio: gzBytes > 0 ? Math.round(rawBytes / gzBytes * 10) / 10 : 0,
        elapsedMs: Date.now() - started,
        failed: failed.length ? failed.slice(0, 20) : undefined
      };
      this.last = { at: Date.now(), ...result };
      if (done.length) {
        this.onEvent('info', '历史数据归档：压缩 ' + done.length + ' 个分片（' + days.size + ' 天，' +
          [...days].sort()[0] + ' ~ ' + [...days].sort()[days.size - 1] + '），' +
          result.rawText + ' → ' + result.gzText + '，释放 ' + result.freedText +
          (result.remaining ? '，剩余 ' + result.remaining + ' 个待下一轮' : ''));
      }
      if (failed.length) {
        this.onEvent('warn', '历史数据归档：' + failed.length + ' 个分片压缩失败（已保留原文件），首个原因：' + failed[0].error);
      }
      return result;
    } finally {
      this._busy = false;
    }
  }

  start() {
    this.stop();
    const cfg = this.config();
    const tick = async () => {
      try {
        const r = await this.run({ dry: false });
        if (r && r.ok) {
          console.log('[archive] 压缩 ' + r.files + ' 个分片，' + r.rawText + ' → ' + r.gzText + '，' + r.elapsedMs + 'ms');
        }
      } catch (e) {
        console.log('[archive] 检查失败: ' + e.message);
      }
    };
    // 启动 90 秒后再跑第一轮，避开启动瞬间的采集高峰
    setTimeout(tick, 90000).unref();
    this.timer = setInterval(tick, cfg.checkEveryMin * 60000);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

module.exports = { Archive, fmtBytes, gzOriginalSize, GZ_SUFFIX, GZ_EXT };
