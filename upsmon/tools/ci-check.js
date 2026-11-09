#!/usr/bin/env node
'use strict';

/**
 * 静态检查：JavaScript 语法、HTML 内联脚本可编译性、style 标签配平
 *
 * 用法：node upsmon/tools/ci-check.js
 * 退出码：0 全部通过；1 存在失败项
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SKIP_DIRS = new Set([
  'node_modules', 'data', 'history', 'screenshots', 'docs',
  'ita2_extract', 'ita_extract', 'power-insight-extract'
]);

const failures = [];
const rel = f => path.relative(ROOT, f).replace(/\\/g, '/');

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

/** 从 node --check 的 stderr 中提取可读的错误行，形如 "SyntaxError: Unexpected token '{'" */
function firstLine(text) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const errLine = lines.find(l => /^[A-Za-z]*Error:/.test(l));
  return errLine || lines[0] || '';
}

/** JavaScript 语法：交给 node --check，与运行时解析器一致 */
function checkJs(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failures.push({ file: rel(file), msg: firstLine(err.stderr) || err.message });
  }
}

/** HTML：内联脚本逐段编译，style 标签配平，检测重复开标签 */
function checkHtml(file) {
  const src = fs.readFileSync(file, 'utf8');
  const re = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let count = 0;

  while ((match = re.exec(src)) !== null) {
    count++;
    const startLine = src.slice(0, match.index).split('\n').length;
    try {
      new vm.Script(match[1], { filename: rel(file) });
    } catch (err) {
      failures.push({
        file: rel(file),
        msg: `内联脚本 #${count}（第 ${startLine} 行起）语法错误：${err.message}`
      });
    }
  }

  const open = (src.match(/<style\b/gi) || []).length;
  const close = (src.match(/<\/style>/gi) || []).length;
  if (open !== close) {
    failures.push({ file: rel(file), msg: `<style> 标签不配平：开 ${open} 个，关 ${close} 个` });
  }
  if (/<style[^>]*>\s*<style\b/i.test(src)) {
    failures.push({ file: rel(file), msg: '检测到重复的 <style> 开标签（会导致整块 CSS 被浏览器丢弃）' });
  }

  return count;
}

const allFiles = walk(ROOT, []);
const jsFiles = allFiles.filter(f => f.endsWith('.js'));
const htmlFiles = allFiles.filter(f => f.endsWith('.html'));

jsFiles.forEach(checkJs);
let inlineBlocks = 0;
htmlFiles.forEach(f => { inlineBlocks += checkHtml(f); });

console.log(`检查 JS 文件：${jsFiles.length} 个`);
console.log(`检查 HTML 文件：${htmlFiles.length} 个，内联脚本 ${inlineBlocks} 段`);

if (failures.length === 0) {
  console.log('静态检查通过');
  process.exit(0);
}

console.log(`\n发现 ${failures.length} 处问题：`);
for (const f of failures) {
  console.log(`  [FAIL] ${f.file}`);
  console.log(`         ${f.msg}`);
}
process.exit(1);
