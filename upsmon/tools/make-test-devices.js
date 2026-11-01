// 生成测试设备清单（压测 / 截图用）
// 用法: node make-test-devices.js <目标目录>
// 全部使用模拟数据，不含任何真实设备信息（公开仓库安全）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const out = process.argv[2] || path.join(__dirname, '..', '.testdata');
const dir = path.join(out, 'data');
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const sites = ['武汉总部', '上海仓库', '广州仓库', '深圳机房', '成都数据中心', '杭州园区', '西安分公司'];
const integrators = ['南方电气', '华东集成', '粤电工程', '蜀通科技', '中维机电'];
const devs = [];

for (let i = 1; i <= 37; i++) {
  const site = sites[i % sites.length];
  const is3 = i % 3 === 0;
  devs.push({
    id: crypto.randomUUID(),
    name: site.slice(0, 2) + '-UPS-' + String(i).padStart(2, '0') + (is3 ? '-3P' : '-1P'),
    host: '10.253.' + (10 + Math.floor(i / 50)) + '.' + (10 + i),
    port: 80, username: 'user', password: 'demo-password', vendor: 'vertiv-ita2',
    model: is3 ? 'ITA-20K00AL3A02C00' : 'ITA-05K00AL1102C00',
    site, commissionDate: '202' + (3 + (i % 3)) + '-0' + (1 + (i % 9)) + '-10',
    integrator: integrators[i % integrators.length], serial: 'SN' + (100000 + i),
    note: '', tags: [], groupIds: [], intervalMs: 10000, enabled: true,
    order: (devs.length + 1) * 10, createdAt: Date.now(), updatedAt: Date.now()
  });
}

fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify({ devices: devs }, null, 2), 'utf8');
console.log('wrote ' + devs.length + ' mock devices to ' + path.join(dir, 'devices.json'));
