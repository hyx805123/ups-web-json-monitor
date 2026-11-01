// 生成测试设备清单（压测 / 脱敏截图用）
// 用法: node make-test-devices.js <目标目录> [--fake]
//   默认包含 3 台真实设备；加 --fake 则全部使用模拟数据（用于公开仓库截图）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const out = process.argv[2] || path.join(__dirname, '..', '.testdata');
const FAKE = process.argv.includes('--fake');
const dir = path.join(out, 'data');
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const real = FAKE ? [] : [
  { name: 'WH-OFFICE-14F-5KW', host: '10.204.130.240', site: '武汉总部', integrator: '南方电气', model: 'ITA-05K00AL1102C00' },
  { name: 'SH-WH-AUTO-UPS1-20KW', host: '10.213.130.240', site: '上海仓库', integrator: '华东集成', model: 'ITA-20K00AL3A02C00' },
  { name: 'SH-WH-AUTO-UPS2-20KW', host: '10.213.130.241', site: '上海仓库', integrator: '华东集成', model: 'ITA-20K00AL3A02C00' }
];
const sites = ['武汉总部', '上海仓库', '广州仓库', '深圳机房', '成都数据中心', '杭州园区', '西安分公司'];
const integrators = ['南方电气', '华东集成', '粤电工程', '蜀通科技', '中维机电'];
const devs = [];

for (const r of real) {
  devs.push({
    id: crypto.randomUUID(), name: r.name, host: r.host, port: 80,
    username: 'user', password: 'demo-password', vendor: 'vertiv-ita2', model: r.model,
    site: r.site, commissionDate: '2024-06-15', integrator: r.integrator,
    serial: 'SN' + crypto.randomBytes(4).toString('hex'),
    note: '', tags: [], groupIds: [], intervalMs: 10000, enabled: true,
    order: (devs.length + 1) * 10, createdAt: Date.now(), updatedAt: Date.now()
  });
}
for (let i = 1; i <= 37; i++) {
  const site = sites[i % sites.length];
  const is3 = i % 3 === 0;
  devs.push({
    id: crypto.randomUUID(),
    name: site.slice(0, 2) + '-UPS-' + String(i).padStart(2, '0') + (is3 ? '-3P' : '-1P'),
    host: '10.' + (FAKE ? '253' : '199') + '.' + (10 + Math.floor(i / 50)) + '.' + (10 + i),
    port: 80, username: 'user', password: 'demo-password', vendor: 'vertiv-ita2',
    model: is3 ? 'ITA-20K00AL3A02C00' : 'ITA-05K00AL1102C00',
    site, commissionDate: '202' + (3 + (i % 3)) + '-0' + (1 + (i % 9)) + '-10',
    integrator: integrators[i % integrators.length], serial: 'SN' + (100000 + i),
    note: '', tags: [], groupIds: [], intervalMs: 10000, enabled: true,
    order: (devs.length + 1) * 10, createdAt: Date.now(), updatedAt: Date.now()
  });
}

fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify({ devices: devs }, null, 2), 'utf8');
console.log('wrote ' + devs.length + ' devices to ' + path.join(dir, 'devices.json') + (FAKE ? '  [FAKE]' : ''));
