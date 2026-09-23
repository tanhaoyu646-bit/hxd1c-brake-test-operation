/**
 * 简略试验场景定义与装置。
 *
 * 场景来源有三条，优先级从高到低：
 *  1. 页面内「教学场景」选择器（教师指定，或选"考核抽考"现场随机抽一种）
 *  2. 地址参数 ?scenario=xxx
 *  3. 都不给 → 正常场景
 *
 * 「考核抽考」的要点：**抽到的故障类型在考试过程中不告诉学员**，
 * 只在最终记录单上写明，便于教师事后核对追溯。
 *
 * ------------------------------------------------------------------
 * 排风时间判定依据（《列车制动机减压排风时间参考表》）
 *
 *   客运列车：T = 0.75 × 辆数 × 减压量 / 100
 *     抽验：12 辆 50 kPa = 4.5 s；20 辆 100 kPa = 15 s；12 辆 170 kPa = 15.3 s
 *
 *   货运列车（电力机车）：T = 辆数 × 常数
 *     常数：50 kPa → 0.5；100 kPa → 0.8；140 kPa → 1.0
 *     抽验：60 辆 50 kPa = 30 s；60 辆 100 kPa = 48 s；60 辆 140 kPa = 60 s
 *
 * 表内只给出离散编组（货运 30/40/50/60 辆），本项目按公式连续推算，
 * 不再把期望时间写成常量，改编组或改车型时参考时间自动跟着变。
 * 允许偏差取「参考值的 10%」与「2 秒」中的较大者：
 * 短编组（几秒）用 2 秒更合理，长编组用 10% 更合理。
 * ------------------------------------------------------------------
 */

/** 货运列车减压量 → 常数 的取值点（来自参考表），中间线性插值。 */
const FREIGHT_CONSTANT_POINTS = [[0, 0], [50, 0.5], [100, 0.8], [140, 1.0]];

function freightConstant(reduction) {
  const r = Math.max(0, Number(reduction) || 0);
  for (let i = 1; i < FREIGHT_CONSTANT_POINTS.length; i += 1) {
    const [x0, y0] = FREIGHT_CONSTANT_POINTS[i - 1];
    const [x1, y1] = FREIGHT_CONSTANT_POINTS[i];
    if (r <= x1) return y0 + (y1 - y0) * (r - x0) / (x1 - x0);
  }
  // 超过 140 kPa 按最后一段斜率外推（货运最高常用减压为 140 kPa，此处仅作兜底）
  const n = FREIGHT_CONSTANT_POINTS.length;
  const [xn, yn] = FREIGHT_CONSTANT_POINTS[n - 1];
  const [xp, yp] = FREIGHT_CONSTANT_POINTS[n - 2];
  return yn + (yn - yp) / (xn - xp) * (r - xn);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

export const TRAIN_TYPES = {
  passenger: {
    key: 'passenger',
    label: '客车',
    formationCars: 48,
    formulaText: 'T = 0.75 × 辆数 × 减压量 / 100',
    referenceSeconds(cars, reduction) {
      return 0.75 * cars * reduction / 100;
    },
  },
  freight: {
    key: 'freight',
    label: '货车',
    formationCars: 48,
    formulaText: 'T = 辆数 × 常数（50 kPa→0.5，100 kPa→0.8，140 kPa→1.0）',
    referenceSeconds(cars, reduction) {
      return cars * freightConstant(reduction);
    },
  },
};

export const DEFAULT_TRAIN_TYPE = 'freight';

export const TRAIN_TYPE_OPTIONS = [
  { key: 'freight', label: '货车' },
  { key: 'passenger', label: '客车' },
];

export function resolveTrainType(raw) {
  return TRAIN_TYPES[raw] ? raw : DEFAULT_TRAIN_TYPE;
}

export function trainTypeLabel(key) {
  return (TRAIN_TYPES[key] || TRAIN_TYPES[DEFAULT_TRAIN_TYPE]).label;
}

/**
 * 由车型、编组、减压量算出参考排风时间与允许区间。
 * @param {string} trainTypeKey
 * @param {number} cars           编组辆数
 * @param {number} reduction      列车管减压量 kPa
 * @param {number} scale          时间缩放（仅调试加速用，正式为 1）
 */
export function buildExhaustReference(trainTypeKey, cars, reduction, scale = 1) {
  const type = TRAIN_TYPES[resolveTrainType(trainTypeKey)];
  const reference = type.referenceSeconds(cars, reduction);
  const tolerance = Math.max(reference * 0.1, 2);
  const expected = reference * scale;
  const expectedTolerance = tolerance * scale;
  return {
    trainTypeKey: type.key,
    trainTypeLabel: type.label,
    formationCars: cars,
    reduction,
    formulaText: type.formulaText,
    /** 参考表算出的排风时间（秒，未加速） */
    reference: round1(reference),
    /** 允许偏差（秒，未加速） */
    tolerance: round1(tolerance),
    toleranceRule: '取参考值的 10% 与 2 秒中的较大者',
    /** 调试加速系数：1 = 正式；<1 = 已加速 */
    scale,
    /** 实际渲染期望值（= 参考值 × 加速系数） */
    expected: round1(expected),
    expectedTolerance: round1(expectedTolerance),
    min: round1(expected - expectedTolerance),
    max: round1(expected + expectedTolerance),
  };
}

const BASE_SCENARIO = {
  id: 'simple-normal-48',
  title: '简略试验 · 标准编组',
  formationCars: 48,
  nominalTrainPipe: 600,
  targetReduction: 100,
  targetPressureTolerance: 1,
  stablePressureTolerance: 5,
  stableDuration: 2,
  holdDuration: 60,
  maxLeakagePerMinute: 20,
  /** 排风时间相对参考值的倍率：1 = 与参考表一致 */
  exhaustScale: 1,
  tailResponseRate: 0.34,
  tailPressureTolerance: 18,
  simulatedLeakagePerMinute: 8,
};

const SCENARIOS = {
  normal: BASE_SCENARIO,
  short: {
    ...BASE_SCENARIO,
    id: 'simple-short-exhaust',
    title: '简略试验 · 排风过短',
    exhaustScale: 0.4,
    tailResponseRate: 0.08,
  },
  long: {
    ...BASE_SCENARIO,
    id: 'simple-long-exhaust',
    title: '简略试验 · 排风过长',
    exhaustScale: 1.6,
    tailResponseRate: 0.2,
  },
  leak: {
    ...BASE_SCENARIO,
    id: 'simple-excessive-leakage',
    title: '简略试验 · 保压漏泄异常',
    simulatedLeakagePerMinute: 28,
  },
};

export const SCENARIO_KEYS = Object.keys(SCENARIOS);

export const EXAM_KEY = 'exam';

export const SCENARIO_OPTIONS = [
  { key: 'normal', label: '正常 · 标准编组' },
  { key: 'short', label: '排风时间过短' },
  { key: 'long', label: '排风时间过长' },
  { key: 'leak', label: '保压漏泄超限' },
  { key: EXAM_KEY, label: '考核抽考（不告知）' },
];

/** 考核抽考概率（百分比）。要调整考核难度改这里即可。 */
export const EXAM_DRAW_WEIGHTS = { normal: 50, short: 20, long: 20, leak: 10 };

/** 调试模式下的时间加速系数（保压与排风同步加速，判定基准同步缩放）。 */
export const DEBUG_TIME_SCALE = 0.25;

export function scenarioTitle(key) {
  return (SCENARIOS[key] || BASE_SCENARIO).title;
}

export function resolveScenarioKey(search = '') {
  const raw = new URLSearchParams(search).get('scenario');
  if (!raw) return { key: 'normal', requested: null, valid: true };
  if (raw === EXAM_KEY) return { key: EXAM_KEY, requested: raw, valid: true };
  if (SCENARIOS[raw]) return { key: raw, requested: raw, valid: true };
  return { key: 'normal', requested: raw, valid: false };
}

export function drawExamScenario(weights = EXAM_DRAW_WEIGHTS, random = Math.random) {
  const entries = SCENARIO_KEYS
    .map((key) => [key, Number(weights[key]) || 0])
    .filter(([, weight]) => weight > 0);
  if (!entries.length) return 'normal';
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [key, weight] of entries) {
    roll -= weight;
    if (roll < 0) return key;
  }
  return entries[entries.length - 1][0];
}

/**
 * @param {string} search          页面 location.search
 * @param {object} overrides
 *   - scenario:  指定场景键或 EXAM_KEY（选 EXAM_KEY 时现场抽一种）
 *   - trainType: 指定客车/货车（覆盖地址参数）
 *   - formationCars: 覆盖编组辆数
 *   - exam:      强制标记为考核模式（重新开始本轮试验时用来保留考核属性）
 *   - weights / random: 抽考概率与随机源，便于测试注入
 */
export function createSimpleBrakeAttempt(search = '', overrides = {}) {
  const params = new URLSearchParams(search);
  const resolved = resolveScenarioKey(search);
  const debugFast = params.get('debug') === '1';

  let key = overrides.scenario ?? resolved.key;
  let exam = overrides.exam ?? (resolved.key === EXAM_KEY);
  if (key === EXAM_KEY) {
    key = drawExamScenario(overrides.weights, overrides.random);
    exam = true;
  }

  const source = SCENARIOS[key] || BASE_SCENARIO;
  const trainTypeKey = resolveTrainType(overrides.trainType ?? params.get('type'));
  const formationCars = Number(overrides.formationCars ?? source.formationCars);
  const timeScale = debugFast ? DEBUG_TIME_SCALE : 1;
  const exhaust = buildExhaustReference(trainTypeKey, formationCars, source.targetReduction, timeScale);

  return {
    ...source,
    formationCars,
    scenarioKey: key,
    trainType: trainTypeKey,
    trainTypeLabel: exhaust.trainTypeLabel,
    exam: Boolean(exam),
    requestedScenario: resolved.requested,
    scenarioValid: resolved.valid,
    attemptId: `${source.id}-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    debugFast,
    timeScale,
    targetTrainPipe: source.nominalTrainPipe - source.targetReduction,
    exhaust,
    /** 参考表算出的本车排风时间（× 场景倍率 × 调试加速），供物理与评分使用 */
    simulatedExhaustSeconds: Math.max(1, exhaust.reference * source.exhaustScale * timeScale),
    /** 判定区间（已含加速），保留 {min,max} 结构供 classifyExhaustTime 使用 */
    expectedExhaustSeconds: { min: exhaust.min, max: exhaust.max },
    holdDuration: debugFast ? 6 : source.holdDuration,
  };
}

export function classifyExhaustTime(seconds, expected) {
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds < expected.min) return 'short';
  if (seconds > expected.max) return 'long';
  return 'normal';
}

export const EXHAUST_ANSWER_LABELS = {
  normal: '排风时间正常',
  short: '排风时间过短',
  long: '排风时间过长',
};
