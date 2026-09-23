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

/** 自阀各制动位对应的列车管减压量（必须与 dynamics.js 的 reductions 保持一致）。 */
export function levelReductions(nominalTrainPipe, targetReduction) {
  return [0, 50, targetReduction, 140, 170, nominalTrainPipe];
}

/**
 * 每一档的参考排风时间与判定区间。
 *
 * 感度试验（50 kPa）、简略试验（100 kPa）、安定试验（140 kPa）**用同一张参考表**算出，
 * 不是另设一套数值：货车 48 辆分别是 24.0 / 38.4 / 48.0 秒。
 *
 * 判定区间只随「调试加速 timeScale」缩放，**不随场景倍率缩放**——
 * 否则注入"排风过短"时基准也跟着变快，异常就被判成正常了。
 */
export function buildExhaustByLevel(trainTypeKey, cars, nominalTrainPipe, targetReduction, timeScale) {
  const type = TRAIN_TYPES[resolveTrainType(trainTypeKey)];
  return levelReductions(nominalTrainPipe, targetReduction).map((reduction, index) => {
    if (index === 0 || reduction <= 0) {
      return { level: index, reduction: 0, reference: 0, min: 0, max: 0, tolerance: 0, checked: true };
    }
    if (index === 5) {
      // 紧急制动不按参考表判定排风时间，由紧急排空过程单独判定。
      return { level: index, reduction, reference: null, min: null, max: null, tolerance: null, checked: false };
    }
    const reference = type.referenceSeconds(cars, reduction);
    const scaled = reference * timeScale;
    const tolerance = Math.max(scaled * 0.1, 2 * timeScale);
    return {
      level: index,
      reduction,
      /** 参考表口径（未加速），用于注明"表中值" */
      reference: round1(reference),
      referenceTolerance: round1(Math.max(reference * 0.1, 2)),
      /** 当前判定口径（含调试加速）。显示与判定都必须用它，否则会自相矛盾。 */
      expected: round1(scaled),
      tolerance: round1(tolerance),
      min: round1(scaled - tolerance),
      max: round1(scaled + tolerance),
      checked: true,
    };
  });
}

/** 试验项目：简略试验 / 全部试验（充风缓解 + 感度 + 安定 + 紧急制动）。 */
export const TEST_MODES = {
  simple: { key: 'simple', label: '简略试验', title: '列车自动制动机简略试验' },
  full: { key: 'full', label: '全部试验', title: '列车自动制动机全部试验' },
};

export const DEFAULT_TEST_MODE = 'simple';

export const TEST_MODE_OPTIONS = [
  { key: 'simple', label: '简略试验' },
  { key: 'full', label: '全部试验' },
];

export function resolveTestMode(raw) {
  return TEST_MODES[raw] ? raw : DEFAULT_TEST_MODE;
}

export function testModeLabel(key) {
  return (TEST_MODES[key] || TEST_MODES[DEFAULT_TEST_MODE]).label;
}

/**
 * 全部试验四个子项的判定规格（货车，列车管定压 600 kPa）。
 *
 * 判定值按常用教学口径设定，集中在这里便于按本校教材调整：
 * 制动缸压力与减压量成正比（3.2 kPa / kPa，上限 450），故
 * 感度 50 kPa → 160 kPa、安定 140 kPa → 448 kPa、紧急 → 450 kPa。
 */
export const FULL_TEST_SPEC = {
  charge: {
    label: '充风缓解试验',
    maxBrakeCyl: 15,
  },
  sensitivity: {
    label: '感度试验',
    level: 1,
    reduction: 50,
    minBrakeCyl: 100,
    holdDuration: 60,
    maxHoldDrop: 12,
  },
  stability: {
    label: '安定试验',
    level: 3,
    reduction: 140,
    minBrakeCyl: 380,
    holdDuration: 60,
    maxHoldDrop: 25,
  },
  emergency: {
    label: '紧急制动试验',
    level: 5,
    maxExhaustSeconds: 6,
    minBrakeCyl: 400,
    maxBrakeCylSeconds: 9,
  },
  release: {
    maxBrakeCyl: 15,
  },
};

/** 常用编组辆数（参考表只列 30/40/50/60 辆，其余按公式连续推算）。 */
export const FORMATION_OPTIONS = [20, 30, 40, 48, 60];

/**
 * 默认编组 30 辆。
 * 48 辆时货车 100 kPa 的参考排风时间是 38.4 秒，课堂上压力变化看着偏慢；
 * 30 辆对应 24.0 秒（排风速率 4.2 kPa/s），演示节奏更合适；需要标准场景时可切回 48 辆。
 */
export const DEFAULT_FORMATION_CARS = 30;

const BASE_SCENARIO = {
  id: 'simple-normal',
  title: '简略试验 · 标准编组',
  formationCars: DEFAULT_FORMATION_CARS,
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
  const testModeKey = resolveTestMode(overrides.testMode ?? params.get('test'));
  // 编组可由抽屉选择器、地址参数 ?cars= 或调用参数覆盖。
  // 它同时决定参考排风时间与压力变化速率（辆数越少排得越快），是调节演示节奏的物理手段。
  const requestedCars = Number(overrides.formationCars ?? params.get('cars'));
  const formationCars = Number.isFinite(requestedCars) && requestedCars > 0 ? requestedCars : source.formationCars;
  const timeScale = debugFast ? DEBUG_TIME_SCALE : 1;
  const exhaust = buildExhaustReference(trainTypeKey, formationCars, source.targetReduction, timeScale);
  const exhaustByLevel = buildExhaustByLevel(trainTypeKey, formationCars, source.nominalTrainPipe, source.targetReduction, timeScale);

  // 各制动位的排风速率（kPa/s）：由参考表按该档减压量算出的排风时间反推，
  // 并乘场景倍率（注入"排风过短/过长"时整机排风特性改变）与调试加速。
  const type = TRAIN_TYPES[trainTypeKey];
  const exhaustRates = levelReductions(source.nominalTrainPipe, source.targetReduction).map((reduction, index) => {
    if (index === 0 || index === 5 || reduction <= 0) return 0;
    const seconds = type.referenceSeconds(formationCars, reduction) * source.exhaustScale * timeScale;
    return seconds > 0 ? reduction / seconds : 0;
  });

  const holdDuration = debugFast ? 6 : source.holdDuration;

  return {
    ...source,
    formationCars,
    scenarioKey: key,
    trainType: trainTypeKey,
    trainTypeLabel: exhaust.trainTypeLabel,
    testMode: testModeKey,
    testModeLabel: TEST_MODES[testModeKey].label,
    exam: Boolean(exam),
    requestedScenario: resolved.requested,
    scenarioValid: resolved.valid,
    attemptId: `${testModeKey}-${source.id}-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    debugFast,
    timeScale,
    targetTrainPipe: source.nominalTrainPipe - source.targetReduction,
    /** 列车管跟随均衡风缸的滞后常数，随调试加速缩放（正式 0.4 s）。 */
    followTau: 0.4 * timeScale,
    exhaust,
    exhaustByLevel,
    exhaustRates,
    /** 参考表算出的本车排风时间（× 场景倍率 × 调试加速），供物理与评分使用 */
    simulatedExhaustSeconds: Math.max(1, exhaust.reference * source.exhaustScale * timeScale),
    /** 判定区间（已含加速），保留 {min,max} 结构供 classifyExhaustTime 使用 */
    expectedExhaustSeconds: { min: exhaust.min, max: exhaust.max },
    holdDuration,
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
