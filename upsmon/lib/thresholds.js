'use strict';
// 指标阈值定义与判定
//
// 依据（均为公开可查的官方参数与国家标准）：
//  · Vertiv ITA2 官方手册 / 产品手册
//      - 输入电压范围：单相 176~288Vac（三相 353~461Vac）
//      - 输出电压稳态精度 ±1%，输出波形畸变 <2%(线性)/<4%(非线性)
//      - 旁路输入范围 -40%~+20%（可设置）
//      - 输入频率范围 40~70Hz
//      - 过载能力：正常 105%~125%(10min)、125%~150%(1min)、>200%(200ms)
//      - 工作温度 0~40℃ 不降额，50℃ 降额至 70%~80%
//  · GB/T 7260-2016《不间断供电设备(UPS)》：稳态输出电压偏差 ±1%(单机)/±2%(并机)
//  · GB 50174-2017《数据中心设计规范》：末端电压偏差 ±7%，频率 50Hz±0.5Hz
//  · GB/T 12325-2008《电能质量 供电电压偏差》：220V 单相 +7%/-10%，380V 三相 ±7%
//  · GB/T 15543-2008：电压不平衡度 ≤2%
//
// 判定返回三档：ok(绿) / warn(黄) / crit(红)

const DEFAULT_THRESHOLDS = {
  outputVoltage: {
    enabled: true, label: '输出电压', unit: 'V', mode: 'nominal',
    nominal: 0,              // 0 = 自动：相电压 220V（单相/三相通用）
    warnPct: 5, critPct: 10
  },
  inputVoltage: {
    enabled: true, label: '输入电压', unit: 'V', mode: 'deviceRange',
    warnPct: 10, critPct: 20,
    deviceRange: [[176, 288]]   // 相电压口径：单相 176~288V；三相相电压折算后同区间
  },
  bypassVoltage: {
    enabled: true, label: '旁路电压', unit: 'V', mode: 'deviceRange',
    warnPct: 20, critPct: 30,
    deviceRange: [[176, 288]]
  },
  lineVoltage: {
    enabled: true, label: '线电压(AB)', unit: 'V', mode: 'nominal',
    nominal: 380,             // 仅三相有意义
    warnPct: 5, critPct: 10
  },
  outputCurrent: {
    enabled: true, label: '输出电流', unit: 'A', mode: 'ratedCurrent',
    warnPct: 85, critPct: 100
  },
  loadPercent: {
    enabled: true, label: '负载率', unit: '%', mode: 'fixed',
    warn: 70, crit: 85
  },
  batteryCapacity: {
    enabled: true, label: '电池容量', unit: '%', mode: 'fixedLow',
    warn: 50, crit: 20
  },
  frequency: {
    enabled: true, label: '输出频率', unit: 'Hz', mode: 'fixedDev',
    warn: 0.5, crit: 2, nominal: 50
  },
  envTemp: {
    enabled: true, label: '环境温度', unit: '℃', mode: 'fixedHigh',
    warn: 30, crit: 35
  },
  phaseImbalance: {
    enabled: true, label: '三相电压不平衡', unit: '%', mode: 'fixedHigh',
    warn: 1, crit: 2
  }
};

// 标称相电压：单相与三相的"相对中性点"电压都是 220V
// （JSON 里的 L_N_Volt 是相电压；三相 380V 制式下相电压同样是 220V，线电压在 L_L_Volt）
function nominalVoltage(phases) {
  return 220;
}

// 额定输出电流（A）：UPS 输出功率因数为 1
function ratedCurrent(snap) {
  if (!snap || !snap.ratedKw) return null;
  const phases = snap.phases || 1;
  if (phases >= 3) return snap.ratedKw * 1000 / (1.732 * 380);
  return snap.ratedKw * 1000 / 220;
}

function pct(v, nominal) {
  if (v === null || v === undefined || !nominal) return null;
  return Math.abs(v - nominal) / nominal * 100;
}

function classify(key, cfg, value, ctx) {
  if (!cfg || cfg.enabled === false) return { level: 'ok', value, text: '' };
  if (value === null || value === undefined) return { level: 'ok', value, text: '无数据' };

  if (cfg.mode === 'nominal') {
    const nom = cfg.nominal || nominalVoltage(ctx.phases);
    const dev = pct(value, nom);
    if (dev === null) return { level: 'ok', value, text: '' };
    if (dev > cfg.critPct) return { level: 'crit', value, text: '超出标称 ±' + cfg.critPct + '%（标称 ' + nom + 'V）' };
    if (dev > cfg.warnPct) return { level: 'warn', value, text: '偏离标称 ' + dev.toFixed(1) + '%' };
    return { level: 'ok', value, text: '' };
  }

  if (cfg.mode === 'deviceRange') {
    const range = (cfg.deviceRange || [])[0] || [0, 0];
    const nom = nominalVoltage(ctx.phases);
    const dev = pct(value, nom);
    if (value < range[0] || value > range[1]) {
      return { level: 'crit', value, text: '超出设备工作范围 ' + range[0] + '~' + range[1] + 'V' };
    }
    if (dev !== null && dev > cfg.critPct) return { level: 'crit', value, text: '偏离标称 ' + dev.toFixed(1) + '%' };
    if (dev !== null && dev > cfg.warnPct) return { level: 'warn', value, text: '偏离标称 ' + dev.toFixed(1) + '%' };
    return { level: 'ok', value, text: '' };
  }

  if (cfg.mode === 'ratedCurrent') {
    const rated = ratedCurrent(ctx.snap);
    if (!rated) return { level: 'ok', value, text: '' };
    const ratio = value / rated * 100;
    if (ratio > cfg.critPct) return { level: 'crit', value, text: '达额定电流 ' + ratio.toFixed(0) + '%（额定 ' + rated.toFixed(1) + 'A）' };
    if (ratio > cfg.warnPct) return { level: 'warn', value, text: '达额定电流 ' + ratio.toFixed(0) + '%' };
    return { level: 'ok', value, text: '' };
  }

  if (cfg.mode === 'fixed') {
    if (value >= cfg.crit) return { level: 'crit', value, text: '≥ ' + cfg.crit + cfg.unit };
    if (value >= cfg.warn) return { level: 'warn', value, text: '≥ ' + cfg.warn + cfg.unit };
    return { level: 'ok', value, text: '' };
  }

  if (cfg.mode === 'fixedLow') {
    if (value <= cfg.crit) return { level: 'crit', value, text: '≤ ' + cfg.crit + cfg.unit };
    if (value <= cfg.warn) return { level: 'warn', value, text: '≤ ' + cfg.warn + cfg.unit };
    return { level: 'ok', value, text: '' };
  }

  if (cfg.mode === 'fixedHigh') {
    if (value >= cfg.crit) return { level: 'crit', value, text: '≥ ' + cfg.crit + cfg.unit };
    if (value >= cfg.warn) return { level: 'warn', value, text: '≥ ' + cfg.warn + cfg.unit };
    return { level: 'ok', value, text: '' };
  }

  if (cfg.mode === 'fixedDev') {
    const nom = cfg.nominal || 50;
    const dev = Math.abs(value - nom);
    if (dev > cfg.crit) return { level: 'crit', value, text: '偏离 ' + dev.toFixed(2) + 'Hz' };
    if (dev > cfg.warn) return { level: 'warn', value, text: '偏离 ' + dev.toFixed(2) + 'Hz' };
    return { level: 'ok', value, text: '' };
  }

  return { level: 'ok', value, text: '' };
}

// 对整台设备做一次阈值判定
function evaluate(snap, thresholds) {
  const cfg = thresholds || DEFAULT_THRESHOLDS;
  const ctx = { phases: snap && snap.phases ? snap.phases : 1, snap: snap };
  const out = {};
  const s = snap || {};
  const phases = ctx.phases;
  const pick = (tr) => (tr && tr.a !== null && tr.a !== undefined) ? tr.a : null;

  const batteryV = s.battery ? s.battery.vP : null;
  const phaseImb = (function () {
    if (!s.output || !s.output.v || phases < 3) return null;
    const vs = [s.output.v.a, s.output.v.b, s.output.v.c].filter(v => v !== null && v !== undefined && v > 1);
    if (vs.length < 3) return null;
    const avg = vs.reduce((x, y) => x + y, 0) / 3;
    return Math.max.apply(null, vs.map(v => Math.abs(v - avg) / avg * 100));
  })();

  const items = {
    outputVoltage: pick(s.output && s.output.v),
    inputVoltage: pick(s.input && s.input.v),
    bypassVoltage: pick(s.bypass && s.bypass.v),
    lineVoltage: (phases >= 3 && s.output && s.output.vll) ? pick(s.output.vll) : null,
    outputCurrent: pick(s.output && s.output.i),
    loadPercent: pick(s.load && s.load.pct),
    batteryCapacity: s.battery ? s.battery.capPct : null,
    frequency: pick(s.output && s.output.f),
    envTemp: s.env ? s.env.tempC : null,
    phaseImbalance: phaseImb
  };

  for (const key of Object.keys(items)) {
    out[key] = classify(key, cfg[key], items[key], ctx);
  }
  return out;
}

// 归一化快照中提取用于告警规则判断的字段（补充阈值维度）
function factsFromLevels(levels) {
  return levels || {};
}

module.exports = { DEFAULT_THRESHOLDS, evaluate, ratedCurrent, nominalVoltage, classify };
