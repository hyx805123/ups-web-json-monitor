#!/usr/bin/env node
'use strict';

/**
 * 冒烟测试：以临时数据目录启动服务，验证关键 HTTP 端点可用后退出
 *
 * 用法：node upsmon/tools/smoke.js [--port=8699]
 * 退出码：0 通过；1 失败
 *
 * 使用独立的 UPS_DATA_DIR，不触碰仓库内的 data/ 与任何真实设备配置。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = (() => {
  const arg = process.argv.find(a => a.startsWith('--port='));
  const n = arg ? Number(arg.split('=')[1]) : 8699;
  return Number.isFinite(n) && n > 0 ? n : 8699;
})();
const BASE = `http://127.0.0.1:${PORT}`;

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname, timeout: 5000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitUntilReady(deadlineMs) {
  const end = Date.now() + deadlineMs;
  let lastErr = null;
  while (Date.now() < end) {
    try {
      const res = await get('/api/brand');
      if (res.status === 200) return true;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(300);
  }
  throw new Error(`服务在 ${deadlineMs} ms 内未就绪：${lastErr && lastErr.message}`);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ups-smoke-data-'));
  fs.writeFileSync(
    path.join(dataDir, 'devices.json'),
    JSON.stringify({ devices: [] }, null, 2),
    'utf8'
  );

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), UPS_DATA_DIR: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const logs = [];
  child.stdout.on('data', d => logs.push(d.toString()));
  child.stderr.on('data', d => logs.push(d.toString()));

  let failed = false;
  const report = [];

  const check = async (name, fn) => {
    try {
      const detail = await fn();
      report.push({ ok: true, name, detail });
    } catch (err) {
      failed = true;
      report.push({ ok: false, name, detail: err.message });
    }
  };

  try {
    await waitUntilReady(30000);

    await check('GET /api/brand', async () => {
      const res = await get('/api/brand');
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const json = JSON.parse(res.body);
      if (typeof json !== 'object' || json === null) throw new Error('响应不是 JSON 对象');
      return '200';
    });

    await check('GET /api/state', async () => {
      const res = await get('/api/state');
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const json = JSON.parse(res.body);
      if (!Array.isArray(json.devices)) throw new Error('缺少 devices 数组');
      return `200 · ${json.devices.length} 台设备`;
    });

    await check('GET /api/history', async () => {
      const res = await get('/api/history');
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const json = JSON.parse(res.body);
      if (!Array.isArray(json.devices)) throw new Error('缺少 devices 数组');
      return '200';
    });

    await check('GET /（静态首页）', async () => {
      const res = await get('/');
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      if (!/<html/i.test(res.body)) throw new Error('响应不是 HTML 页面');
      if (!/ups/i.test(res.body)) throw new Error('页面内容异常');
      return `200 · ${res.body.length} 字节`;
    });
  } catch (err) {
    failed = true;
    report.push({ ok: false, name: '服务启动', detail: err.message });
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
    if (!child.killed) child.kill('SIGKILL');
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* 忽略清理失败 */ }
  }

  for (const r of report) {
    console.log(`  ${r.ok ? '[PASS]' : '[FAIL]'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }

  if (failed) {
    const tail = logs.join('').split('\n').slice(-20).join('\n');
    if (tail.trim()) console.log(`\n服务输出（末尾 20 行）：\n${tail}`);
    console.log('\n冒烟测试失败');
    process.exit(1);
  }
  console.log('\n冒烟测试通过');
  process.exit(0);
}

main().catch(err => {
  console.error('冒烟测试异常：' + err.message);
  process.exit(1);
});
