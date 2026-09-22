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

const DEBUG_SCENARIOS = {
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

export function createSimpleBrakeAttempt(search = '') {
  const params = new URLSearchParams(search);
  const requested = params.get('scenario') || 'normal';
  const source = DEBUG_SCENARIOS[requested] || DEFAULT_SCENARIO;
  const debugFast = params.get('debug') === '1';
  const scenario = {
    ...source,
    expectedExhaustSeconds: { ...source.expectedExhaustSeconds },
    holdDuration: debugFast ? 6 : source.holdDuration,
  };
  return {
    ...scenario,
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
