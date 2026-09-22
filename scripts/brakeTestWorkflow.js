import { classifyExhaustTime, EXHAUST_ANSWER_LABELS } from './brakeTestScenarios.js';

const CRITICAL_UNRELATED_COMMANDS = new Set([
  'panto', 'main-breaker', 'compressor', 'parking', 'parking-apply',
  'parking-release', 'direction', 'traction', 'independent-brake',
  'power-cabinet-switch', 'control-power',
]);

export class BrakeTestWorkflow {
  constructor(attempt) {
    this.attempt = attempt;
    this.listeners = new Set();
    this.reset();
  }

  reset() {
    this.phase = 'STABILIZING';
    this.message = '确认列车管达到规定压力并保持稳定。';
    this.stableElapsed = 0;
    this.reductionStart = null;
    this.reductionReachedAt = null;
    this.exhaustSeconds = null;
    this.holdStart = null;
    this.holdStartPressure = null;
    this.holdElapsed = 0;
    this.holdPassed = false;
    this.holdFailed = false;
    this.leakage = 0;
    this.answerAttempts = [];
    this.answerCorrect = false;
    this.tailBrakeQuery = null;
    this.tailBrakeConfirmed = false;
    this.releaseStart = null;
    this.tailReleaseQuery = null;
    this.tailReleaseConfirmed = false;
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
      return { allowed: false, message: '当前为列车自动制动机简略试验，请勿操作无关设备。' };
    }
    if (id !== 'auto-brake') return { allowed: true };
    const next = Number(value);
    if (this.phase === 'STABILIZING') return { allowed: false, message: '列车管尚未稳定，请等待定压确认。' };
    if (this.phase === 'REDUCE') {
      if (next < 0 || next > 2) return { allowed: false, message: '简略试验要求自阀减压100 kPa，请置规定常用制动位置。' };
      return { allowed: true };
    }
    if (this.phase === 'HOLD') return { allowed: false, message: '正在保压试验，未完成前禁止移动自阀。' };
    if (this.phase === 'RELEASE') {
      if (next !== 0) return { allowed: false, message: '请将自阀回运转位，执行充风缓解。' };
      return { allowed: true };
    }
    return { allowed: false, message: '当前步骤不需要操作自阀。' };
  }

  afterCommand(id, value, state) {
    if (id !== 'auto-brake') return;
    const next = Number(value);
    if (this.phase === 'REDUCE' && next > 0 && this.reductionStart === null) {
      this.reductionStart = state.elapsed;
      this.log('reduction-start', { pressure: state.trainPipe });
      this.setMessage('自阀已产生减压作用，正在测量列车管排风时间。');
    }
    if (this.phase === 'RELEASE' && next === 0 && this.releaseStart === null) {
      this.releaseStart = state.elapsed;
      this.log('release-start', { pressure: state.trainPipe });
      this.setMessage('自阀已回运转位。等待首尾列车管充风恢复后再次查询尾部风压。');
    }
  }

  update(state, dt) {
    const a = this.attempt;
    if (this.phase === 'STABILIZING') {
      const stable = Math.abs(state.trainPipe - a.nominalTrainPipe) <= a.stablePressureTolerance
        && Math.abs(state.tailPipe - a.nominalTrainPipe) <= a.stablePressureTolerance
        && state.autoBrake === 0;
      this.stableElapsed = stable ? this.stableElapsed + dt : 0;
      if (this.stableElapsed >= a.stableDuration) {
        this.phase = 'REDUCE';
        this.log('pressure-stable', { head: state.trainPipe, tail: state.tailPipe });
        this.setMessage(`列车管定压稳定。请操作自阀减压 ${a.targetReduction} kPa。`);
      }
      return;
    }

    if (this.phase === 'REDUCE' && this.reductionStart !== null) {
      if (state.trainPipe <= a.targetTrainPipe + a.targetPressureTolerance) {
        this.reductionReachedAt = state.elapsed;
        this.exhaustSeconds = Math.max(0, this.reductionReachedAt - this.reductionStart);
        this.holdStart = state.elapsed;
        this.holdStartPressure = state.trainPipe;
        this.phase = 'HOLD';
        this.log('reduction-reached', { seconds: this.exhaustSeconds, pressure: state.trainPipe });
        this.setMessage(`减压达到目标，开始保压 ${a.holdDuration} 秒。请完成排风时间判断和尾部确认。`);
      }
      return;
    }

    if (this.phase === 'HOLD') {
      this.holdElapsed = Math.min(a.holdDuration, Math.max(0, state.elapsed - this.holdStart));
      this.leakage = Math.max(0, this.holdStartPressure - state.trainPipe);
      const timerSecond = Math.floor(this.holdElapsed);
      if (timerSecond !== this.lastTimerSecond) {
        this.lastTimerSecond = timerSecond;
        this.emit();
      }
      if (!this.holdPassed && !this.holdFailed && this.holdElapsed >= a.holdDuration) {
        // 扣除进入保压时表针仍在目标容差内收敛的数值，避免把压力稳定过程误判为管路漏泄。
        const pressureSettlingAllowance = a.targetPressureTolerance * 2;
        const measuredLeakage = Math.max(0, this.leakage - pressureSettlingAllowance);
        const normalizedLeakage = measuredLeakage * 60 / a.holdDuration;
        if (normalizedLeakage <= a.maxLeakagePerMinute) {
          this.holdPassed = true;
          this.log('hold-pass', { leakagePerMinute: normalizedLeakage });
          this.setMessage('保压时间及漏泄检查合格。完成答题和尾部制动确认后方可缓解。');
        } else {
          this.holdFailed = true;
          this.phase = 'FAILED';
          this.log('hold-fail', { leakagePerMinute: normalizedLeakage });
          this.setMessage(`列车管漏泄量 ${normalizedLeakage.toFixed(1)} kPa/min，超过允许值，试验不合格。`);
          return;
        }
      }
      if (this.holdPassed && this.answerCorrect && this.tailBrakeQuery?.passed && this.tailBrakeConfirmed) {
        this.phase = 'RELEASE';
        this.log('ready-to-release');
        this.setMessage('制动阶段检查完成。请将自阀回运转位，执行充风缓解。');
      }
      return;
    }

    if (this.phase === 'RELEASE' && this.releaseStart !== null) {
      const headRecovered = state.trainPipe >= a.nominalTrainPipe - a.stablePressureTolerance;
      const tailRecovered = state.tailPipe >= a.nominalTrainPipe - a.tailPressureTolerance;
      const cylinderReleased = state.brakeCyl < 40;
      if (headRecovered && tailRecovered && cylinderReleased && this.tailReleaseQuery?.passed && this.tailReleaseConfirmed) {
        this.phase = 'COMPLETE';
        this.log('complete', { head: state.trainPipe, tail: state.tailPipe, cylinder: state.brakeCyl });
        this.setMessage('列车自动制动机简略试验完成，制动与缓解作用正常。');
      }
    }
  }

  submitExhaustAnswer(answer) {
    if (!Number.isFinite(this.exhaustSeconds)) {
      this.setMessage('排风时间尚未测得，不能答题。');
      return { accepted: false };
    }
    const expected = classifyExhaustTime(this.exhaustSeconds, this.attempt.expectedExhaustSeconds);
    const correct = answer === expected;
    this.answerAttempts.push({ answer, expected, correct });
    this.answerCorrect = correct;
    this.log('exhaust-answer', { answer, expected, correct });
    this.setMessage(correct
      ? `判断正确：本次${EXHAUST_ANSWER_LABELS[expected]}。`
      : `判断不正确。请结合编组和排风时间表重新判断。`);
    return { accepted: true, correct, expected };
  }

  queryTail(state, stage) {
    const a = this.attempt;
    if (stage === 'brake') {
      if (this.phase !== 'HOLD') {
        this.setMessage('当前阶段不能进行制动后的尾部风压查询。');
        return null;
      }
      const pressureDifference = Math.abs(state.tailPipe - state.trainPipe);
      const tailReduced = state.tailPipe <= a.targetTrainPipe + a.tailPressureTolerance;
      const passed = pressureDifference <= a.tailPressureTolerance && tailReduced;
      this.tailBrakeQuery = { head: state.trainPipe, tail: state.tailPipe, pressureDifference, passed };
      this.log('tail-brake-query', this.tailBrakeQuery);
      this.setMessage(passed
        ? '尾部风压与机车端列车管压力变化对应，制动主管贯通。'
        : '尾部风压尚未正常跟随，请等待压力传播后重新查询。');
      return this.tailBrakeQuery;
    }
    if (stage === 'release') {
      if (this.phase !== 'RELEASE' || this.releaseStart === null) {
        this.setMessage('请先将自阀回运转位，再查询缓解后的尾部风压。');
        return null;
      }
      const pressureDifference = Math.abs(state.tailPipe - state.trainPipe);
      const tailRecovered = state.tailPipe >= a.nominalTrainPipe - a.tailPressureTolerance;
      const passed = pressureDifference <= a.tailPressureTolerance && tailRecovered;
      this.tailReleaseQuery = { head: state.trainPipe, tail: state.tailPipe, pressureDifference, passed };
      this.log('tail-release-query', this.tailReleaseQuery);
      this.setMessage(passed
        ? '尾部风压已随列车管充风恢复。请获取最后一辆车缓解确认。'
        : '尾部风压尚未恢复，请稍后重新查询。');
      return this.tailReleaseQuery;
    }
    return null;
  }

  confirmTail(stage) {
    if (stage === 'brake') {
      if (!this.tailBrakeQuery?.passed) {
        this.setMessage('尾部风压查询尚未合格，不能确认最后一辆车制动作用。');
        return false;
      }
      this.tailBrakeConfirmed = true;
      this.log('tail-brake-confirmed');
      this.setMessage('已收到尾部反馈：最后一辆车制动作用正常。');
      return true;
    }
    if (stage === 'release') {
      if (!this.tailReleaseQuery?.passed) {
        this.setMessage('尾部风压尚未恢复，不能确认最后一辆车缓解。');
        return false;
      }
      this.tailReleaseConfirmed = true;
      this.log('tail-release-confirmed');
      this.setMessage('已收到尾部反馈：最后一辆车缓解正常。');
      return true;
    }
    return false;
  }

  getSteps(state) {
    const reduced = this.reductionReachedAt !== null;
    const released = this.releaseStart !== null && state.autoBrake === 0;
    return [
      { label: '确认列车管达到定压并稳定', done: this.phase !== 'STABILIZING' },
      { label: `自阀减压 ${this.attempt.targetReduction} kPa`, done: reduced },
      { label: '判断列车管排风时间', done: this.answerCorrect },
      { label: `保压 ${this.attempt.holdDuration} 秒并检查漏泄`, done: this.holdPassed },
      { label: '查询尾部风压并确认制动作用', done: Boolean(this.tailBrakeQuery?.passed && this.tailBrakeConfirmed) },
      { label: '自阀回运转位并充风缓解', done: released },
      { label: '查询尾部风压并确认缓解', done: this.phase === 'COMPLETE' },
    ];
  }
}
