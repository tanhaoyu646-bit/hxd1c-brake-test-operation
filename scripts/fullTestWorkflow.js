/**
 * 列车自动制动机「全部试验」流程。
 *
 * 按《技规》列车自动制动机全部试验的顺序：充风缓解 → 感度 → 安定 → 紧急制动 → 缓解。
 * 与「简略试验」共用同一套装置、同一套排风时间参考公式、同一套记录单骨架。
 *
 * 阶段推进只看「操作是否做到」；合格与否由 getJudgements() 汇总判定。
 * 这是刻意的口径：某个子项异常（例如排风过短）时流程仍走完，但结论判不合格并给出检查方向，
 * 学员能拿到完整结论；若中途中止就只能在记录单上看到"未完成"，失去教学价值。
 *
 * 自阀档位与本流程的对应（reductions = [0, 50, 100, 140, 170, 定压]）：
 *   1 档 = 初制动位（减压 50 kPa） → 感度试验
 *   3 档 = 常用制动Ⅲ（减压 140 kPa）→ 安定试验
 *   5 档 = 紧急位（列车管排空）      → 紧急制动试验
 * 三个档位的参考排风时间同样由参考表按各自减压量算出（48 辆货车：24.0 / 48.0 秒）。
 */

import { FULL_TEST_SPEC } from './brakeTestScenarios.js';

const CRITICAL_UNRELATED_COMMANDS = new Set([
  'panto', 'main-breaker', 'compressor', 'parking', 'parking-apply',
  'parking-release', 'direction', 'traction', 'independent-brake',
  'power-cabinet-switch', 'control-power',
]);

export const FULL_PHASES = {
  STABILIZING: 'STABILIZING',
  SENS_REDUCE: 'SENS_REDUCE',
  SENS_HOLD: 'SENS_HOLD',
  SENS_RELEASE: 'SENS_RELEASE',
  STAB_REDUCE: 'STAB_REDUCE',
  STAB_HOLD: 'STAB_HOLD',
  STAB_RELEASE: 'STAB_RELEASE',
  EMERGENCY: 'EMERGENCY',
  EMERGENCY_CHECK: 'EMERGENCY_CHECK',
  RELEASE: 'RELEASE',
  COMPLETE: 'COMPLETE',
  FAILED: 'FAILED',
};

/** 各阶段允许的自阀档位区间：[最小, 最大]。拖动必然经过中间档位，所以给区间而不是固定值。 */
const LEVEL_RANGES = {
  STABILIZING: [0, 0],
  SENS_REDUCE: [0, 1],
  SENS_HOLD: [1, 1],
  SENS_RELEASE: [0, 1],
  STAB_REDUCE: [0, 3],
  STAB_HOLD: [3, 3],
  STAB_RELEASE: [0, 3],
  EMERGENCY: [0, 5],
  EMERGENCY_CHECK: [5, 5],
  RELEASE: [0, 5],
};

const LEVEL_HINTS = {
  STABILIZING: '请确认列车管定压并保持自阀运转位。',
  SENS_REDUCE: `感度试验要求减压 ${FULL_TEST_SPEC.sensitivity.reduction} kPa，请将自阀置初制动位（1 档）。`,
  SENS_HOLD: '感度试验保压中，未完成前禁止移动自阀。',
  SENS_RELEASE: '请将自阀回运转位，待列车管充风恢复定压后再做安定试验。',
  STAB_REDUCE: `安定试验要求减压 ${FULL_TEST_SPEC.stability.reduction} kPa，请将自阀置常用制动Ⅲ位（3 档）。`,
  STAB_HOLD: '安定试验保压中，未完成前禁止移动自阀。',
  STAB_RELEASE: '请将自阀回运转位，待列车管充风恢复定压后再做紧急制动试验。',
  EMERGENCY: '紧急制动试验：请将自阀置紧急位（5 档）。',
  EMERGENCY_CHECK: '紧急制动作用中，正在检查列车管排空与制动缸压力。',
  RELEASE: '请将自阀回运转位，确认列车管充风恢复、制动缸压力归零。',
};

export class FullTestWorkflow {
  constructor(attempt) {
    this.attempt = attempt;
    this.listeners = new Set();
    this.reset();
  }

  reset() {
    this.phase = FULL_PHASES.STABILIZING;
    this.message = '确认列车管达到规定压力并保持稳定，同时确认制动缸已缓解。';
    this.stableElapsed = 0;
    // 充风缓解试验
    this.chargePressure = null;
    this.chargeBrakeCyl = null;
    this.chargePassed = false;
    // 感度试验（减压 50 kPa）
    this.sensReductionStart = null;
    this.sensExhaustSeconds = null;
    this.sensHoldStart = null;
    this.sensHoldElapsed = 0;
    this.sensHoldStartPressure = null;
    this.sensHoldDrop = 0;
    this.sensBrakeCyl = 0;
    this.sensReleaseAt = null;
    this.sensReleasePressure = null;
    // 安定试验（减压 140 kPa）
    this.stabReductionStart = null;
    this.stabExhaustSeconds = null;
    this.stabHoldStart = null;
    this.stabHoldElapsed = 0;
    this.stabHoldStartPressure = null;
    this.stabHoldDrop = 0;
    this.stabBrakeCyl = 0;
    this.stabReleaseAt = null;
    this.stabReleasePressure = null;
    // 紧急制动试验
    this.emergencyStart = null;
    this.emergencyExhaustSeconds = null;
    this.emergencyCylReachedAt = null;
    this.emergencyBrakeCyl = 0;
    // 缓解
    this.releaseStart = null;
    this.releasePressure = null;
    this.releaseBrakeCyl = null;
    this.releasePassed = false;
    // 操纵评价
    this.autoBrakeOperations = 0;
    this.levelOrder = [];
    this.failureReason = null;
    this.events = [];
    this.lastTimerSecond = -1;
    this.emit();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }
  log(type, detail = {}) { this.events.push({ type, at: Date.now(), ...detail }); }
  setMessage(message) { this.message = message; this.emit(); }

  guardCommand(id, value) {
    if (CRITICAL_UNRELATED_COMMANDS.has(id)) {
      return { allowed: false, message: '当前为列车自动制动机试验，请勿操作无关设备。' };
    }
    if (id !== 'auto-brake') return { allowed: true };
    const next = Number(value);
    const range = LEVEL_RANGES[this.phase];
    if (!range) return { allowed: false, message: '当前步骤不需要操作自阀。' };
    if (next < range[0] || next > range[1]) {
      return { allowed: false, message: LEVEL_HINTS[this.phase] || '当前自阀位置不符合本步试验要求。' };
    }
    return { allowed: true };
  }

  /** 一次拖动自阀 = 一次操作，用于「操纵是否一次到位」的评价。 */
  noteAutoBrakeDrag() {
    this.autoBrakeOperations += 1;
  }

  afterCommand(id, value, state) {
    if (id !== 'auto-brake') return;
    const next = Number(value);
    if (this.phase === FULL_PHASES.SENS_REDUCE && next === 1 && this.sensReductionStart === null) {
      this.sensReductionStart = state.elapsed;
      this.log('sens-reduction-start', { pressure: state.trainPipe });
      this.setMessage(`感度试验：自阀已置初制动位，正在测量列车管排风时间（减压 ${FULL_TEST_SPEC.sensitivity.reduction} kPa）。`);
    }
    if (this.phase === FULL_PHASES.STAB_REDUCE && next === 3 && this.stabReductionStart === null) {
      this.stabReductionStart = state.elapsed;
      this.log('stab-reduction-start', { pressure: state.trainPipe });
      this.setMessage(`安定试验：自阀已置常用制动Ⅲ位，正在测量列车管排风时间（减压 ${FULL_TEST_SPEC.stability.reduction} kPa）。`);
    }
    if (this.phase === FULL_PHASES.EMERGENCY && next === 5 && this.emergencyStart === null) {
      this.emergencyStart = state.elapsed;
      this.log('emergency-start', { pressure: state.trainPipe });
      this.setMessage('紧急制动试验：自阀已置紧急位，正在测量列车管排空时间。');
    }
    if (this.phase === FULL_PHASES.RELEASE && next === 0 && this.releaseStart === null) {
      this.releaseStart = state.elapsed;
      this.log('release-start', { pressure: state.trainPipe });
      this.setMessage('自阀已回运转位，正在充风缓解。');
    }
    if (!this.levelOrder.includes(next)) this.levelOrder.push(next);
  }

  update(state, dt) {
    const a = this.attempt;
    const spec = FULL_TEST_SPEC;
    const levelTolerance = a.targetPressureTolerance;

    if (this.phase === FULL_PHASES.STABILIZING) {
      const stable = Math.abs(state.trainPipe - a.nominalTrainPipe) <= a.stablePressureTolerance
        && Math.abs(state.tailPipe - a.nominalTrainPipe) <= a.stablePressureTolerance
        && state.autoBrake === 0
        && state.brakeCyl <= spec.charge.maxBrakeCyl;
      this.stableElapsed = stable ? this.stableElapsed + dt : 0;
      if (stable) {
        this.chargePressure = { head: state.trainPipe, tail: state.tailPipe };
        this.chargeBrakeCyl = Math.max(this.chargeBrakeCyl ?? 0, state.brakeCyl);
      }
      if (this.stableElapsed >= a.stableDuration) {
        this.chargePassed = true;
        this.log('charge-pass', { head: state.trainPipe, cylinder: state.brakeCyl });
        this.phase = FULL_PHASES.SENS_REDUCE;
        this.setMessage(`充风缓解试验合格（列车管 ${Math.round(state.trainPipe)} kPa，制动缸 ${Math.round(state.brakeCyl)} kPa）。${LEVEL_HINTS.SENS_REDUCE}`);
      }
      return;
    }

    if (this.phase === FULL_PHASES.SENS_REDUCE) {
      if (this.sensReductionStart === null) return;
      const target = a.nominalTrainPipe - spec.sensitivity.reduction;
      if (state.trainPipe <= target + levelTolerance) {
        this.sensExhaustSeconds = Math.max(0, state.elapsed - this.sensReductionStart);
        this.sensHoldStart = state.elapsed;
        this.sensHoldStartPressure = state.trainPipe;
        this.sensBrakeCyl = state.brakeCyl;
        this.phase = FULL_PHASES.SENS_HOLD;
        this.log('sens-reduction-reached', { seconds: this.sensExhaustSeconds, pressure: state.trainPipe, cylinder: state.brakeCyl });
        this.setMessage(`感度试验减压达到 ${spec.sensitivity.reduction} kPa，开始保压 ${a.holdDuration} 秒。`);
      }
      return;
    }

    if (this.phase === FULL_PHASES.SENS_HOLD) {
      this.sensHoldElapsed = Math.min(a.holdDuration, Math.max(0, state.elapsed - this.sensHoldStart));
      this.sensHoldDrop = Math.max(0, this.sensHoldStartPressure - state.trainPipe);
      this.sensBrakeCyl = Math.max(this.sensBrakeCyl, state.brakeCyl);
      this.tickTimer();
      if (this.sensHoldElapsed >= a.holdDuration) {
        this.log('sens-hold-done', { drop: this.sensHoldDrop, cylinder: this.sensBrakeCyl });
        this.phase = FULL_PHASES.SENS_RELEASE;
        this.setMessage(`感度试验保压完成（制动缸 ${Math.round(this.sensBrakeCyl)} kPa，列车管下降 ${this.sensHoldDrop.toFixed(0)} kPa）。${LEVEL_HINTS.SENS_RELEASE}`);
      }
      return;
    }

    // 子试验之间必须恢复定压：感度试验只减压 50 kPa，若不复原就接着做安定试验，
    // 安定试验实际只排掉约 90 kPa，排风时间会明显短于 140 kPa 对应的参考值。
    if (this.phase === FULL_PHASES.SENS_RELEASE) {
      if (state.autoBrake === 0 && state.trainPipe >= a.nominalTrainPipe - a.stablePressureTolerance) {
        this.sensReleaseAt = state.elapsed;
        this.sensReleasePressure = state.trainPipe;
        this.log('sens-release-recovered', { pressure: state.trainPipe });
        this.phase = FULL_PHASES.STAB_REDUCE;
        this.setMessage(`感度试验后列车管已恢复定压（${Math.round(state.trainPipe)} kPa）。${LEVEL_HINTS.STAB_REDUCE}`);
      }
      return;
    }

    if (this.phase === FULL_PHASES.STAB_REDUCE) {
      if (this.stabReductionStart === null) return;
      const target = a.nominalTrainPipe - spec.stability.reduction;
      if (state.trainPipe <= target + levelTolerance) {
        this.stabExhaustSeconds = Math.max(0, state.elapsed - this.stabReductionStart);
        this.stabHoldStart = state.elapsed;
        this.stabHoldStartPressure = state.trainPipe;
        this.stabBrakeCyl = state.brakeCyl;
        this.phase = FULL_PHASES.STAB_HOLD;
        this.log('stab-reduction-reached', { seconds: this.stabExhaustSeconds, pressure: state.trainPipe, cylinder: state.brakeCyl });
        this.setMessage(`安定试验减压达到 ${spec.stability.reduction} kPa，开始保压 ${a.holdDuration} 秒。`);
      }
      return;
    }

    if (this.phase === FULL_PHASES.STAB_HOLD) {
      this.stabHoldElapsed = Math.min(a.holdDuration, Math.max(0, state.elapsed - this.stabHoldStart));
      this.stabHoldDrop = Math.max(0, this.stabHoldStartPressure - state.trainPipe);
      this.stabBrakeCyl = Math.max(this.stabBrakeCyl, state.brakeCyl);
      this.tickTimer();
      if (this.stabHoldElapsed >= a.holdDuration) {
        this.log('stab-hold-done', { drop: this.stabHoldDrop, cylinder: this.stabBrakeCyl });
        this.phase = FULL_PHASES.STAB_RELEASE;
        this.setMessage(`安定试验保压完成（制动缸 ${Math.round(this.stabBrakeCyl)} kPa，列车管下降 ${this.stabHoldDrop.toFixed(0)} kPa）。${LEVEL_HINTS.STAB_RELEASE}`);
      }
      return;
    }

    if (this.phase === FULL_PHASES.STAB_RELEASE) {
      if (state.autoBrake === 0 && state.trainPipe >= a.nominalTrainPipe - a.stablePressureTolerance) {
        this.stabReleaseAt = state.elapsed;
        this.stabReleasePressure = state.trainPipe;
        this.log('stab-release-recovered', { pressure: state.trainPipe });
        this.phase = FULL_PHASES.EMERGENCY;
        this.setMessage(`安定试验后列车管已恢复定压（${Math.round(state.trainPipe)} kPa）。${LEVEL_HINTS.EMERGENCY}`);
      }
      return;
    }

    if (this.phase === FULL_PHASES.EMERGENCY) {
      if (this.emergencyStart === null) return;
      this.emergencyBrakeCyl = Math.max(this.emergencyBrakeCyl, state.brakeCyl);
      if (state.trainPipe <= 15) {
        this.emergencyExhaustSeconds = Math.max(0, state.elapsed - this.emergencyStart);
        this.phase = FULL_PHASES.EMERGENCY_CHECK;
        this.log('emergency-exhausted', { seconds: this.emergencyExhaustSeconds, cylinder: state.brakeCyl });
        this.setMessage(`列车管已排空（用时 ${this.emergencyExhaustSeconds.toFixed(1)} 秒），正在检查制动缸压力。`);
      }
      return;
    }

    if (this.phase === FULL_PHASES.EMERGENCY_CHECK) {
      this.emergencyBrakeCyl = Math.max(this.emergencyBrakeCyl, state.brakeCyl);
      const reached = state.brakeCyl >= spec.emergency.minBrakeCyl;
      if (reached && this.emergencyCylReachedAt === null) {
        this.emergencyCylReachedAt = state.elapsed - this.emergencyStart;
        this.log('emergency-cylinder-reached', { seconds: this.emergencyCylReachedAt, cylinder: state.brakeCyl });
      }
      // 超时保护：制动缸迟迟不达标也要放行，否则学员会卡在这一步拿不到任何结论。
      const waited = state.elapsed - this.emergencyStart;
      if (reached || waited >= spec.emergency.maxBrakeCylSeconds * 2) {
        this.phase = FULL_PHASES.RELEASE;
        this.setMessage(`紧急制动试验检查完成（制动缸最高 ${Math.round(this.emergencyBrakeCyl)} kPa）。${LEVEL_HINTS.RELEASE}`);
      }
      return;
    }

    if (this.phase === FULL_PHASES.RELEASE) {
      if (this.releaseStart === null) return;
      const headRecovered = state.trainPipe >= a.nominalTrainPipe - a.stablePressureTolerance;
      const cylinderReleased = state.brakeCyl <= spec.release.maxBrakeCyl;
      if (headRecovered && cylinderReleased) {
        this.releasePressure = state.trainPipe;
        this.releaseBrakeCyl = state.brakeCyl;
        this.releasePassed = true;
        this.phase = FULL_PHASES.COMPLETE;
        this.log('complete', { head: state.trainPipe, cylinder: state.brakeCyl });
        this.setMessage('全部试验流程已走完，请核对试验记录单确认最终结论。');
      }
    }
  }

  tickTimer() {
    const second = Math.floor(Math.max(this.sensHoldElapsed, this.stabHoldElapsed));
    if (second !== this.lastTimerSecond) { this.lastTimerSecond = second; this.emit(); }
  }

  /** 保压剩余秒数（供界面显示）。 */
  get holdRemaining() {
    const a = this.attempt;
    if (this.phase === FULL_PHASES.SENS_HOLD) return Math.max(0, a.holdDuration - this.sensHoldElapsed);
    if (this.phase === FULL_PHASES.STAB_HOLD) return Math.max(0, a.holdDuration - this.stabHoldElapsed);
    return null;
  }

  get holdProgress() {
    const a = this.attempt;
    if (this.phase === FULL_PHASES.SENS_HOLD) return Math.min(100, this.sensHoldElapsed / a.holdDuration * 100);
    if (this.phase === FULL_PHASES.STAB_HOLD) return Math.min(100, this.stabHoldElapsed / a.holdDuration * 100);
    return 0;
  }

  getSteps(state) {
    const spec = FULL_TEST_SPEC;
    const hold = this.attempt.holdDuration;
    return [
      { label: '充风缓解试验：列车管达定压、制动缸缓解', done: this.chargePassed },
      { label: `感度试验：自阀减压 ${spec.sensitivity.reduction} kPa`, done: this.sensExhaustSeconds !== null },
      { label: `感度试验保压 ${hold} 秒并检查制动缸`, done: this.sensHoldStart !== null && this.sensHoldElapsed >= hold },
      { label: '感度试验后缓解，列车管恢复定压', done: this.sensReleaseAt !== null },
      { label: `安定试验：自阀减压 ${spec.stability.reduction} kPa`, done: this.stabExhaustSeconds !== null },
      { label: `安定试验保压 ${hold} 秒并检查是否发生紧急制动`, done: this.stabHoldStart !== null && this.stabHoldElapsed >= hold },
      { label: '安定试验后缓解，列车管恢复定压', done: this.stabReleaseAt !== null },
      { label: '紧急制动试验：自阀置紧急位', done: this.emergencyStart !== null },
      { label: '检查列车管排空时间与制动缸压力', done: this.emergencyCylReachedAt !== null || this.phase === FULL_PHASES.RELEASE || this.phase === FULL_PHASES.COMPLETE },
      { label: '自阀回运转位，充风缓解', done: this.releaseStart !== null },
      { label: '确认列车管恢复定压、制动缸归零', done: this.phase === FULL_PHASES.COMPLETE },
    ];
  }

  exhaustVerdictOf(levelIndex, seconds) {
    const spec = this.attempt.exhaustByLevel?.[levelIndex];
    if (!spec || spec.reference === null) return 'unknown';
    if (!Number.isFinite(seconds)) return 'unknown';
    if (seconds < spec.min) return 'short';
    if (seconds > spec.max) return 'long';
    return 'normal';
  }

  /**
   * 全部试验的逐项判定，供记录单与结论使用。
   * 每项都给出实测值、参考要求与判定，便于逐条对照《技规》。
   */
  getJudgements(state) {
    const a = this.attempt;
    const spec = FULL_TEST_SPEC;
    const sensLevel = a.exhaustByLevel?.[spec.sensitivity.level];
    const stabLevel = a.exhaustByLevel?.[spec.stability.level];
    const sensVerdict = this.exhaustVerdictOf(spec.sensitivity.level, this.sensExhaustSeconds);
    const stabVerdict = this.exhaustVerdictOf(spec.stability.level, this.stabExhaustSeconds);
    const range = (item) => (item && item.reference !== null
      ? `${item.min} ～ ${item.max} s（参考 ${item.reference} ± ${item.tolerance} s）`
      : '—');
    const exhaustNote = (verdict, label, item, cars) => {
      if (verdict === 'short') return `${label}实测值低于参考下限。按${a.trainTypeLabel}公式，编组 ${cars} 辆、减压 ${item?.reduction} kPa 应为 ${item?.reference} s；排风过快可能是折角塞门关闭或制动主管不畅`;
      if (verdict === 'long') return `${label}实测值高于参考上限。按${a.trainTypeLabel}公式，编组 ${cars} 辆、减压 ${item?.reduction} kPa 应为 ${item?.reference} s；排风过慢可能是漏泄或车列连接异常`;
      return '';
    };

    return [
      {
        label: '充风缓解·列车管定压',
        actual: this.chargePressure ? `${Math.round(this.chargePressure.head)} kPa（尾部 ${Math.round(this.chargePressure.tail)} kPa）` : '未确认',
        reference: `${a.nominalTrainPipe} ± ${a.stablePressureTolerance} kPa`,
        verdict: this.chargePassed ? 'pass' : 'pending',
        note: '',
      },
      {
        label: '充风缓解·制动缸',
        actual: this.chargeBrakeCyl === null ? '未确认' : `${Math.round(this.chargeBrakeCyl)} kPa`,
        reference: `≤ ${spec.charge.maxBrakeCyl} kPa（应呈缓解状态）`,
        verdict: this.chargePassed ? 'pass' : 'pending',
        note: '',
      },
      {
        label: '感度试验·减压量',
        actual: this.sensExhaustSeconds === null ? '未减压' : `${sensLevel?.reduction} kPa（自阀 1 档）`,
        reference: `${spec.sensitivity.reduction} kPa（自阀初制动位）`,
        verdict: this.sensExhaustSeconds === null ? 'pending' : 'pass',
        note: '',
      },
      {
        label: '感度试验·排风时间',
        actual: Number.isFinite(this.sensExhaustSeconds) ? `${this.sensExhaustSeconds.toFixed(1)} s` : '未测得',
        reference: range(sensLevel),
        verdict: sensVerdict === 'normal' ? 'pass' : sensVerdict === 'unknown' ? 'pending' : 'fail',
        note: exhaustNote(sensVerdict, '感度试验', sensLevel, a.formationCars),
      },
      {
        label: '感度试验·制动缸压力',
        actual: this.sensHoldStart === null ? '未测定' : `${Math.round(this.sensBrakeCyl)} kPa`,
        reference: `≥ ${spec.sensitivity.minBrakeCyl} kPa（应产生制动作用）`,
        verdict: this.sensHoldStart === null ? 'pending' : this.sensBrakeCyl >= spec.sensitivity.minBrakeCyl ? 'pass' : 'fail',
        note: this.sensHoldStart !== null && this.sensBrakeCyl < spec.sensitivity.minBrakeCyl ? '制动缸压力不足，制动感度不良，应检查分配阀作用' : '',
      },
      {
        label: '感度试验·保压稳定',
        actual: this.sensHoldStart === null ? '未保压' : `列车管下降 ${this.sensHoldDrop.toFixed(0)} kPa（${this.sensHoldElapsed.toFixed(0)} s）`,
        reference: `保压 ≥ ${a.holdDuration} s 且列车管下降 ≤ ${spec.sensitivity.maxHoldDrop} kPa`,
        verdict: this.sensHoldStart === null ? 'pending' : this.sensHoldDrop <= spec.sensitivity.maxHoldDrop ? 'pass' : 'fail',
        note: this.sensHoldStart !== null && this.sensHoldDrop > spec.sensitivity.maxHoldDrop ? '保压期间列车管持续下降，制动作用不稳定，应检查列车管系漏泄' : '',
      },
      {
        label: '感度试验·缓解恢复',
        actual: this.sensReleasePressure === null ? '未确认' : `${Math.round(this.sensReleasePressure)} kPa`,
        reference: `≥ ${a.nominalTrainPipe - a.stablePressureTolerance} kPa（恢复定压后再做安定试验）`,
        verdict: this.sensReleasePressure === null ? 'pending' : 'pass',
        note: '',
      },
      {
        label: '安定试验·减压量',
        actual: this.stabExhaustSeconds === null ? '未减压' : `${stabLevel?.reduction} kPa（自阀 3 档）`,
        reference: `${spec.stability.reduction} kPa（最大有效减压量）`,
        verdict: this.stabExhaustSeconds === null ? 'pending' : 'pass',
        note: '',
      },
      {
        label: '安定试验·排风时间',
        actual: Number.isFinite(this.stabExhaustSeconds) ? `${this.stabExhaustSeconds.toFixed(1)} s` : '未测得',
        reference: range(stabLevel),
        verdict: stabVerdict === 'normal' ? 'pass' : stabVerdict === 'unknown' ? 'pending' : 'fail',
        note: exhaustNote(stabVerdict, '安定试验', stabLevel, a.formationCars),
      },
      {
        label: '安定试验·制动缸压力',
        actual: this.stabHoldStart === null ? '未测定' : `${Math.round(this.stabBrakeCyl)} kPa`,
        reference: `≥ ${spec.stability.minBrakeCyl} kPa（应达到最大有效减压）`,
        verdict: this.stabHoldStart === null ? 'pending' : this.stabBrakeCyl >= spec.stability.minBrakeCyl ? 'pass' : 'fail',
        note: this.stabHoldStart !== null && this.stabBrakeCyl < spec.stability.minBrakeCyl ? '制动缸压力未达最大有效减压量要求，应检查制动缸及闸调器' : '',
      },
      {
        label: '安定试验·不得紧急',
        actual: this.stabHoldStart === null ? '未保压' : `列车管下降 ${this.stabHoldDrop.toFixed(0)} kPa`,
        reference: `保压 ≥ ${a.holdDuration} s 且列车管下降 ≤ ${spec.stability.maxHoldDrop} kPa`,
        verdict: this.stabHoldStart === null ? 'pending' : this.stabHoldDrop <= spec.stability.maxHoldDrop ? 'pass' : 'fail',
        note: this.stabHoldStart !== null && this.stabHoldDrop > spec.stability.maxHoldDrop ? '减压 140 kPa 后列车管仍持续下降，发生紧急制动，应检查分配阀安定性' : '',
      },
      {
        label: '安定试验·缓解恢复',
        actual: this.stabReleasePressure === null ? '未确认' : `${Math.round(this.stabReleasePressure)} kPa`,
        reference: `≥ ${a.nominalTrainPipe - a.stablePressureTolerance} kPa（恢复定压后再做紧急制动试验）`,
        verdict: this.stabReleasePressure === null ? 'pending' : 'pass',
        note: '',
      },
      {
        label: '紧急制动·列车管排空时间',
        actual: Number.isFinite(this.emergencyExhaustSeconds) ? `${this.emergencyExhaustSeconds.toFixed(1)} s` : '未测得',
        reference: `≤ ${spec.emergency.maxExhaustSeconds} s 降至 0`,
        verdict: !Number.isFinite(this.emergencyExhaustSeconds) ? 'pending'
          : this.emergencyExhaustSeconds <= spec.emergency.maxExhaustSeconds ? 'pass' : 'fail',
        note: Number.isFinite(this.emergencyExhaustSeconds) && this.emergencyExhaustSeconds > spec.emergency.maxExhaustSeconds
          ? '列车管排空过慢，紧急制动作用不良，应检查紧急放风阀' : '',
      },
      {
        label: '紧急制动·制动缸压力',
        actual: this.emergencyBrakeCyl ? `${Math.round(this.emergencyBrakeCyl)} kPa` : '未测定',
        reference: `≥ ${spec.emergency.minBrakeCyl} kPa`,
        verdict: this.emergencyBrakeCyl === 0 ? 'pending' : this.emergencyBrakeCyl >= spec.emergency.minBrakeCyl ? 'pass' : 'fail',
        note: this.emergencyBrakeCyl > 0 && this.emergencyBrakeCyl < spec.emergency.minBrakeCyl ? '紧急制动时制动缸压力不足，应检查制动缸及紧急阀' : '',
      },
      {
        label: '紧急制动·制动缸达标时间',
        actual: Number.isFinite(this.emergencyCylReachedAt) ? `${this.emergencyCylReachedAt.toFixed(1)} s` : '未达标',
        reference: `≤ ${spec.emergency.maxBrakeCylSeconds} s 达到规定压力`,
        verdict: !Number.isFinite(this.emergencyCylReachedAt) ? 'pending'
          : this.emergencyCylReachedAt <= spec.emergency.maxBrakeCylSeconds ? 'pass' : 'fail',
        note: Number.isFinite(this.emergencyCylReachedAt) && this.emergencyCylReachedAt > spec.emergency.maxBrakeCylSeconds
          ? '制动缸升压过慢，应检查制动缸与作用阀' : '',
      },
      {
        label: '缓解·列车管恢复',
        actual: this.releasePressure === null ? '未确认' : `${Math.round(this.releasePressure)} kPa`,
        reference: `≥ ${a.nominalTrainPipe - a.stablePressureTolerance} kPa`,
        verdict: this.releasePassed ? 'pass' : 'pending',
        note: '',
      },
      {
        label: '缓解·制动缸归零',
        actual: this.releaseBrakeCyl === null ? '未确认' : `${Math.round(this.releaseBrakeCyl)} kPa`,
        reference: `≤ ${spec.release.maxBrakeCyl} kPa`,
        verdict: this.releasePassed ? 'pass' : 'pending',
        note: '',
      },
    ];
  }

  getConclusion(state) {
    const items = this.getJudgements(state);
    const fails = items.filter((item) => item.verdict === 'fail');
    const reasons = fails.map((item) => `${item.label}：${item.note || item.actual}`);
    if (this.phase === FULL_PHASES.FAILED) {
      return { completed: false, pass: false, headline: '试验不合格（已中止）', reasons };
    }
    if (this.phase !== FULL_PHASES.COMPLETE) {
      return { completed: false, pass: false, headline: '试验未完成', reasons: [] };
    }
    if (!fails.length) return { completed: true, pass: true, headline: '试验合格', reasons: [] };
    return { completed: true, pass: false, headline: '试验完成，但结论不合格', reasons };
  }
}
