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
 */

const DEFAULT_SCENARIO = {
  id: 'simple-normal-48',
  title: '简略试验 · 标准编组',
  formationCars: 48,
  nominalTrainPipe: 500,
  targetReduction: 100,
  targetPressureTolerance: 1,
  stablePressureTolerance: 5,
  stableDuration: 2,
  holdDuration: 60,
  maxLeakagePerMinute: 20,
  expectedExhaustSeconds: { min: 6, max: 10 },
  simulatedExhaustSeconds: 8,
  tailResponseRate: 0.34,
  tailPressureTolerance: 18,
  simulatedLeakagePerMinute: 8,
};

const SCENARIOS = {
  normal: DEFAULT_SCENARIO,
  short: {
    ...DEFAULT_SCENARIO,
    id: 'simple-short-exhaust',
    title: '简略试验 · 排风过短',
    simulatedExhaustSeconds: 3,
    tailResponseRate: 0.08,
  },
  long: {
    ...DEFAULT_SCENARIO,
    id: 'simple-long-exhaust',
    title: '简略试验 · 排风过长',
    simulatedExhaustSeconds: 15,
    tailResponseRate: 0.2,
  },
  leak: {
    ...DEFAULT_SCENARIO,
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

export function scenarioTitle(key) {
  return (SCENARIOS[key] || DEFAULT_SCENARIO).title;
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
 *   - scenario: 指定场景键或 EXAM_KEY（选 EXAM_KEY 时现场抽一种）
 *   - exam:     强制标记为考核模式（重新开始本轮试验时用来保留考核属性）
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

  const source = SCENARIOS[key] || DEFAULT_SCENARIO;
  const scenario = {
    ...source,
    expectedExhaustSeconds: { ...source.expectedExhaustSeconds },
    holdDuration: debugFast ? 6 : source.holdDuration,
  };
  return {
    ...scenario,
    scenarioKey: key,
    exam: Boolean(exam),
    requestedScenario: resolved.requested,
    scenarioValid: resolved.valid,
    attemptId: `${scenario.id}-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    debugFast,
    targetTrainPipe: scenario.nominalTrainPipe - scenario.targetReduction,
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
