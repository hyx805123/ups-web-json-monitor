'use strict';
// 分组引擎：支持按型号 / 场地 / 状态动态分组，以及自定义静态分组
const { STATUS_LABELS } = require('./settings');

function statusBucket(state) {
  if (!state) return 'offline';
  if (state.status === 'disabled') return 'offline';
  if (state.status === 'offline') return 'offline';
  if (state.status === 'degraded') return 'warn';
  if (!state.snap) return 'offline';
  return state.snap.severity.level || 'ok';
}

function statusLabel(bucket) {
  return STATUS_LABELS[bucket] || bucket;
}

// 动态分组：type=model/site/status 时由设备字段或运行状态自动归类
function autoMatch(group, dev, state) {
  if (group.type === 'model') {
    const m = (dev.model || (state && state.snap && state.snap.model) || '').trim();
    return !!m && m === group.value;
  }
  if (group.type === 'site') {
    const s = (dev.site || '').trim();
    return !!s && s === group.value;
  }
  if (group.type === 'status') {
    return statusBucket(state) === group.value;
  }
  return false;
}

// 返回该设备所属的所有分组
function resolveGroups(dev, groups, state) {
  const out = [];
  for (const g of groups) {
    if (g.enabled === false) continue;
    if (g.type === 'custom') {
      if ((dev.groupIds || []).includes(g.id)) out.push(g);
    } else if (autoMatch(g, dev, state)) {
      out.push(g);
    }
  }
  return out;
}

// groupBy: 'none' | 'model' | 'site' | 'status' | 具体分组 id
function buildGroups(devices, groups, stateById, groupBy) {
  const list = devices.map(d => ({ dev: d, state: stateById[d.id] || null }));

  if (!groupBy || groupBy === 'none') {
    return [{ group: { id: '__all', name: '全部设备', type: 'none', color: '#4ea8de' }, items: list }];
  }

  if (['model', 'site', 'status'].includes(groupBy)) {
    const buckets = new Map();
    for (const it of list) {
      let key, name;
      if (groupBy === 'model') {
        key = (it.dev.model || (it.state && it.state.snap && it.state.snap.model) || '未标注型号').trim();
        name = key;
      } else if (groupBy === 'site') {
        key = (it.dev.site || '未标注场地').trim();
        name = key;
      } else {
        key = statusBucket(it.state);
        name = statusLabel(key);
      }
      if (!buckets.has(key)) buckets.set(key, { key, name, items: [] });
      buckets.get(key).items.push(it);
    }
    const colors = { ok: '#2fbf71', warn: '#e8a33d', crit: '#e2564d', offline: '#78899a' };
    return Array.from(buckets.values())
      .sort((a, b) => (a.key === 'offline' ? 1 : 0) - (b.key === 'offline' ? 1 : 0) || String(a.name).localeCompare(String(b.name)))
      .map(b => ({
        group: {
          id: '__' + groupBy + '_' + b.key,
          name: b.name,
          type: groupBy,
          color: groupBy === 'status' ? (colors[b.key] || '#4ea8de') : '#4ea8de'
        },
        items: b.items
      }));
  }

  // 具体分组（含自定义组）
  const g = groups.find(x => x.id === groupBy);
  if (!g) return [{ group: { id: '__all', name: '全部设备', type: 'none', color: '#4ea8de' }, items: list }];
  const items = list.filter(it => resolveGroups(it.dev, groups, it.state).some(x => x.id === g.id));
  return [{ group: g, items }];
}

// 分组下拉选项（自定义分组 + 动态维度）
function groupOptions(groups) {
  const opt = [
    { id: 'none', name: '不分组', type: 'none' },
    { id: 'model', name: '按型号分组', type: 'model' },
    { id: 'site', name: '按场地分组', type: 'site' },
    { id: 'status', name: '按状态分组', type: 'status' }
  ];
  groups.filter(g => g.type === 'custom').forEach(g => {
    opt.push({ id: g.id, name: g.name, type: 'custom', color: g.color });
  });
  return opt;
}

module.exports = { statusBucket, statusLabel, resolveGroups, buildGroups, groupOptions };
