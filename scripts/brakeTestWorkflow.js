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
    this.leakagePerMinute = null;
    this.answerAttempts = [];
    this.answerCorrect = false;
    this.answerFirstTryCorrect = null;
    this.tailQueryAttempts = { brake: 0, release: 0 };
    this.tailFailStreak = { brake: 0, release: 0 };
    this.tailFirstQueryAt = { brake: null, release: null };
    this.failureReason = null;
    this.tailBrakeQuery = null;
    this.tailBrakeConfirmed = false;
    this.releaseStart = null;
    this.tailReleaseQuery = null;
    this.tailReleaseConfirmed = false;
    // 「一次减压到位」按"减压阶段拖动自阀的独立操作次数"计，而不是按档位变化次数：
    // 物理自阀必然要连续经过中间档位，用价值变化计数会把一次顺畅操作误判成多次。
    this.autoBrakeOperations = 0;
    this.reductionLevel = null;
    this.stabilizedPressure = null;
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
    // 自阀 6 个位置全部开放操作：教学上要让学员自己把每个位置都拉一遍，
    // 直观看到减压量越大、排风时间越长。位置不符合当前步骤时只给提示、不硬拦——
    // 物理上照常作用，流程推进仍按正确位置判定，乱拉既不会"过关"，也不计入无关设备操作扣分。
    if (this.phase === 'STABILIZING') {
      if (next === 0) return { allowed: true };
      return { allowed: true, message: '列车管尚未确认定压：此时移动自阀会直接影响定压确认。' };
    }
    if (this.phase === 'REDUCE') {
      if (next === 2) return { allowed: true };
      return { allowed: true, message: `简略试验要求自阀减压 100 kPa，请置第 2 档（常用制动Ⅱ）；当前第 ${next} 档，流程不会继续推进。` };
    }
    if (this.phase === 'HOLD') {
      if (next === 2) return { allowed: true };
      return { allowed: true, message: '正在保压试验：移动自阀会使保压压力变化，本次保压判定将按实际压力下降量计算。' };
    }
    // RELEASE 与其它阶段不做限制：自阀回运转位必须连续经过中间档位。
    return { allowed: true };
  }

  /**
   * 一次拖动自阀 = 一次操作。只有减压阶段的操作计入"一次减压到位"评价，
   * 否则回运转位的必备动作也会被算成多余操作。
   */
  noteAutoBrakeDrag() {
    if (this.phase === 'REDUCE') this.autoBrakeOperations += 1;
  }

  afterCommand(id, value, state) {
    if (id !== 'auto-brake') return;
    const next = Number(value);
    if (this.phase === 'REDUCE') {
      if (next === 2) {
        // 简略试验的目标位置固定为第 2 档（常用制动Ⅱ，减压 100 kPa）。
        if (this.reductionStart === null) {
          this.reductionStart = state.elapsed;
          this.log('reduction-start', { pressure: state.trainPipe });
          this.setMessage('自阀已置常用制动Ⅱ位，正在测量列车管排风时间。');
        }
      } else {
        // 学员自行试了别的档位：不计入本步测量，回到规定位时重新计时。
        // 否则先拉 1 档（减压 50）再拉到 2 档，两段排风会加在一起，排风时间被算长。
        this.reductionStart = null;
      }
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
      // 记录试验开始时的定压实测值：记录单必须写"试验前的定压"，
      // 不能用试验结束后（已减压、已缓解）的当前压力冒充。
      if (stable) this.stabilizedPressure = { head: state.trainPipe, tail: state.tailPipe };
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
        this.reductionLevel = state.autoBrake;
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
        this.leakagePerMinute = normalizedLeakage;
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
        // 结论由 getConclusion() 统一给出：排风时间异常时流程同样走完，但结论不合格。
        this.setMessage('试验流程已走完，请核对试验记录单确认最终结论。');
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
    if (this.answerAttempts.length === 1) this.answerFirstTryCorrect = correct;
    this.answerCorrect = correct;
    this.log('exhaust-answer', { answer, expected, correct });
    this.setMessage(correct
      ? `判断正确：本次${EXHAUST_ANSWER_LABELS[expected]}。`
      : `判断不正确。请结合编组和排风时间表重新判断。`);
    return { accepted: true, correct, expected };
  }

  /**
   * 列尾风压查询。
   *
   * 压力沿列车管传导需要时间，等待后重查属于正常操作；但若持续不跟随，
   * 说明列车管可能未贯通——此时必须给出「不合格」出口，否则学员会无限重查、
   * 流程永远停在保压阶段（异常工况下没有结论，是比"判错"更严重的教学缺陷）。
   */
  trackTailQuery(stage, state, passed) {
    if (this.tailFirstQueryAt[stage] === null) this.tailFirstQueryAt[stage] = state.elapsed;
    if (passed) { this.tailFailStreak[stage] = 0; return; }
    this.tailFailStreak[stage] += 1;
    const waited = state.elapsed - this.tailFirstQueryAt[stage];
    if (this.tailFailStreak[stage] >= 4 && waited >= 20) {
      this.failureReason = '列车管未贯通：尾部风压持续未跟随车端变化（折角塞门关闭或制动主管不畅）';
      this.phase = 'FAILED';
      this.log('tail-unresponsive', { stage, attempts: this.tailFailStreak[stage], waited });
      this.setMessage(`${this.failureReason}，试验不合格。已生成试验记录单。`);
    }
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
      this.tailQueryAttempts.brake += 1;
      this.tailBrakeQuery = { head: state.trainPipe, tail: state.tailPipe, pressureDifference, passed };
      this.log('tail-brake-query', this.tailBrakeQuery);
      this.trackTailQuery('brake', state, passed);
      if (this.phase !== 'FAILED') {
        this.setMessage(passed
          ? '尾部风压与机车端列车管压力变化对应，制动主管贯通。'
          : `尾部风压尚未正常跟随（第 ${this.tailFailStreak.brake} 次），请等待压力传播后重新查询。`);
      }
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
      this.tailQueryAttempts.release += 1;
      this.tailReleaseQuery = { head: state.trainPipe, tail: state.tailPipe, pressureDifference, passed };
      this.log('tail-release-query', this.tailReleaseQuery);
      this.trackTailQuery('release', state, passed);
      if (this.phase !== 'FAILED') {
        this.setMessage(passed
          ? '尾部风压已随列车管充风恢复。请获取最后一辆车缓解确认。'
          : `尾部风压尚未恢复（第 ${this.tailFailStreak.release} 次），请稍后重新查询。`);
      }
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

  /**
   * 逐项物理判定，供试验记录单与结论使用。
   *
   * 教学口径：排风时间异常只影响「结论」，不中止流程——简略试验在排风时间异常时
   * 仍须继续确认制动与缓解作用，所以流程照常走完，但结论判为不合格并给出检查方向。
   */
  getJudgements(state) {
    const a = this.attempt;
    const exhaustVerdict = !Number.isFinite(this.exhaustSeconds)
      ? 'unknown'
      : classifyExhaustTime(this.exhaustSeconds, a.expectedExhaustSeconds);
    const tailText = (query) => (query
      ? `${Math.round(query.head)} / ${Math.round(query.tail)} kPa（差 ${Math.round(query.pressureDifference)}）`
      : '未查询');
    const verdictOf = (query, confirmed) => {
      if (query?.passed && confirmed) return 'pass';
      if (query && !query.passed) return 'fail';
      return 'pending';
    };

    return [
      {
        label: '列车管定压',
        actual: this.stabilizedPressure
          ? `${Math.round(this.stabilizedPressure.head)} kPa（尾部 ${Math.round(this.stabilizedPressure.tail)} kPa）`
          : '未确认',
        reference: `${a.nominalTrainPipe} ± ${a.stablePressureTolerance} kPa`,
        verdict: this.phase === 'STABILIZING' ? 'pending' : 'pass',
        note: '',
      },
      {
        label: '减压量',
        actual: this.reductionReachedAt !== null ? `${a.targetReduction} kPa（自阀第 ${this.reductionLevel} 档）` : '未减压',
        reference: `${a.targetReduction} kPa（自阀第 2 档）`,
        verdict: this.reductionReachedAt === null ? 'pending' : 'pass',
        note: this.reductionReachedAt !== null && this.autoBrakeOperations > 1
          ? `自阀经 ${this.autoBrakeOperations} 次操作才到位，简略试验要求一次减压到位`
          : '',
      },
      {
        label: '排风时间',
        actual: Number.isFinite(this.exhaustSeconds) ? `${this.exhaustSeconds.toFixed(1)} s` : '未测得',
        // 调试加速时参考值与容差都要用加速后的口径，否则会出现"实测 6.2 s、
        // 参考 24 ± 2.4 s、却判合格"的自相矛盾表述。
        reference: a.exhaust.scale === 1
          ? `${a.exhaust.min} ～ ${a.exhaust.max} s（参考 ${a.exhaust.reference} ± ${a.exhaust.tolerance} s）`
          : `${a.exhaust.min} ～ ${a.exhaust.max} s（调试加速 1/${Math.round(1 / a.exhaust.scale)}：参考 ${a.exhaust.expected} ± ${a.exhaust.expectedTolerance} s，表中值 ${a.exhaust.reference} s）`,
        verdict: exhaustVerdict === 'normal' ? 'pass' : exhaustVerdict === 'unknown' ? 'pending' : 'fail',
        note: exhaustVerdict === 'short'
          ? `实测值低于参考下限。按${a.trainTypeLabel}公式（${a.exhaust.formulaText}），编组 ${a.formationCars} 辆、减压 ${a.targetReduction} kPa 应为 ${a.exhaust.reference} s；排风过快可能是折角塞门关闭或制动主管不畅，应检查列车管贯通状态`
          : exhaustVerdict === 'long'
            ? `实测值高于参考上限。按${a.trainTypeLabel}公式（${a.exhaust.formulaText}），编组 ${a.formationCars} 辆、减压 ${a.targetReduction} kPa 应为 ${a.exhaust.reference} s；排风过慢可能是漏泄或车列连接异常，应检查制动主管与车列编组`
            : '',
      },
      {
        // 保压时长是否达标与漏泄是否超限是两回事：保压满了但漏泄超限时，
        // 保压时间应记"合格"，不能跟着漏泄一起判不合格。
        label: '保压时间',
        actual: this.holdStart === null ? '未保压' : `${this.holdElapsed.toFixed(0)} s`,
        reference: `≥ ${a.holdDuration} s`,
        verdict: this.holdElapsed >= a.holdDuration ? 'pass' : 'pending',
        note: '',
      },
      {
        label: '列车管漏泄量',
        actual: this.leakagePerMinute === null ? '未测定' : `${this.leakagePerMinute.toFixed(1)} kPa/min`,
        reference: `≤ ${a.maxLeakagePerMinute} kPa/min`,
        verdict: this.holdPassed ? 'pass' : this.holdFailed ? 'fail' : 'pending',
        note: this.holdFailed ? '列车管漏泄量超过允许值，试验不合格，须查明漏泄处所并处理' : '',
      },
      {
        label: '列尾制动确认',
        actual: tailText(this.tailBrakeQuery),
        reference: `机车端与尾部压差 ≤ ${a.tailPressureTolerance} kPa 且尾部同步减压`,
        verdict: verdictOf(this.tailBrakeQuery, this.tailBrakeConfirmed),
        note: this.tailBrakeQuery && !this.tailBrakeQuery.passed
          ? `尾部风压未跟随机车端变化（查询 ${this.tailQueryAttempts.brake} 次仍未通过），列车管可能未贯通，应检查折角塞门与制动主管`
          : '',
      },
      {
        label: '列尾缓解确认',
        actual: tailText(this.tailReleaseQuery),
        reference: `机车端与尾部压差 ≤ ${a.tailPressureTolerance} kPa 且尾部恢复定压`,
        verdict: verdictOf(this.tailReleaseQuery, this.tailReleaseConfirmed),
        note: this.tailReleaseQuery && !this.tailReleaseQuery.passed
          ? `尾部风压未恢复定压（查询 ${this.tailQueryAttempts.release} 次仍未通过），须查明列车管过风受阻处所`
          : '',
      },
    ];
  }

  getConclusion(state) {
    const fails = this.getJudgements(state).filter((item) => item.verdict === 'fail');
    const reasons = fails.map((item) => `${item.label}：${item.note || item.actual}`);
    if (this.failureReason && !reasons.some((reason) => reason.startsWith(this.failureReason))) {
      reasons.unshift(this.failureReason);
    }
    if (this.phase === 'FAILED') {
      return { completed: false, pass: false, headline: '试验不合格（已中止）', reasons };
    }
    if (this.phase !== 'COMPLETE') {
      return { completed: false, pass: false, headline: '试验未完成', reasons: [] };
    }
    if (!fails.length) {
      return { completed: true, pass: true, headline: '试验合格', reasons: [] };
    }
    return { completed: true, pass: false, headline: '试验完成，但结论不合格', reasons };
  }
}
