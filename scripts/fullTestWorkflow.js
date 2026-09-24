/**
 * 列车自动制动机「全部试验」流程。
 *
 * 依据《铁路机车操作规则》第 15 条（与《技规》一致）：
 *   全部试验 = **感度试验 + 安定试验两项，不包含紧急制动试验**。
 *   · 感度试验：自阀减压 50 kPa（编组 60 辆及以上为 70 kPa）并保压 1 min，
 *     全列车必须发生制动作用、不得自然缓解；手柄移至运转位后全列车须在 1 min 内缓解完毕。
 *   · 安定试验：自阀施行最大有效减压（定压 600 kPa 时为 170 kPa），要求不发生紧急制动，
 *     并检查制动缸活塞行程或制动指示器是否符合规定。
 *   · 两项都要检查制动主管漏泄量 ≤ 20 kPa/min；司机应确认并正确记录充、排风时间；
 *     装有列尾装置的列车，还要进行列尾风压查询。
 *
 * 与简略试验共用同一套装置、同一张排风时间参考表、同一套记录单骨架。
 * 每个子试验的"判断排风时间 / 列尾查询 / 列尾反馈"动作与简略试验完全一致，
 * 只是分别记在各自的子项上（互不覆盖）。
 *
 * 阶段推进只看「操作是否做到」；合格与否由 getJudgements() 汇总判定 ——
 * 某个子项异常时流程仍走完，但结论判不合格并给出检查方向，学员能拿到完整结论。
 */

import { FULL_TEST_SPEC, EXHAUST_ANSWER_LABELS } from './brakeTestScenarios.js';

const CRITICAL_UNRELATED_COMMANDS = new Set([
  'panto', 'main-breaker', 'compressor', 'parking', 'parking-apply',
  'parking-release', 'direction', 'traction', 'independent-brake',
  'power-cabinet-switch', 'control-power',
]);

/** 按《铁路机车操作规则》第 15 条，全部试验只有这两项。 */
const SUB_ORDER = ['sensitivity', 'stability'];

export const FULL_PHASES = {
  PREPARE: 'PREPARE',
  SENS_REDUCE: 'SENS_REDUCE',
  SENS_HOLD: 'SENS_HOLD',
  SENS_RELEASE: 'SENS_RELEASE',
  STAB_REDUCE: 'STAB_REDUCE',
  STAB_HOLD: 'STAB_HOLD',
  STAB_RELEASE: 'STAB_RELEASE',
  COMPLETE: 'COMPLETE',
  FAILED: 'FAILED',
};

/** 阶段 → （子项 key, 动作阶段）。子项逻辑通用，两个子试验共用同一段代码。 */
const PHASE_MAP = {
  SENS_REDUCE: ['sensitivity', 'reduce'],
  SENS_HOLD: ['sensitivity', 'hold'],
  SENS_RELEASE: ['sensitivity', 'release'],
  STAB_REDUCE: ['stability', 'reduce'],
  STAB_HOLD: ['stability', 'hold'],
  STAB_RELEASE: ['stability', 'release'],
};

const NEXT_PHASE = {
  SENS_RELEASE: FULL_PHASES.STAB_REDUCE,
  STAB_RELEASE: FULL_PHASES.COMPLETE,
};

/** 各阶段允许的自阀档位区间：[最小, 最大]。仅用于生成提示，不再硬拦。 */
const LEVEL_RANGES = {
  PREPARE: [0, 0],
  SENS_REDUCE: [0, 1],
  SENS_HOLD: [1, 1],
  SENS_RELEASE: [0, 1],
  STAB_REDUCE: [0, 4],
  STAB_HOLD: [4, 4],
  STAB_RELEASE: [0, 4],
};

function levelName(level) {
  return ['运转位', '初制动位', '常用制动Ⅱ', '常用制动Ⅲ', '常用制动Ⅳ', '紧急位'][level] || `第 ${level} 档`;
}

export class FullTestWorkflow {
  constructor(attempt) {
    this.attempt = attempt;
    this.listeners = new Set();
    this.reset();
  }

  reset() {
    const a = this.attempt;
    const spec = FULL_TEST_SPEC;
    this.phase = FULL_PHASES.PREPARE;
    this.message = '确认列车充满风、制动主管达到规定压力，制动缸呈缓解状态。';
    this.prepareElapsed = 0;
    this.preparePressure = null;
    this.prepareBrakeCyl = null;
    this.preparePassed = false;

    // 两个子试验各存一份，字段同名，逻辑复用
    this.subs = {};
    for (const key of SUB_ORDER) {
      const conf = spec[key];
      const level = conf.level;
      this.subs[key] = {
        key,
        label: conf.label,
        shortLabel: key === 'sensitivity' ? '感度' : '安定',
        level,
        reduction: (a.levelReductions && a.levelReductions[level]) || 0,
        reduceStart: null,
        exhaustSeconds: null,
        holdStart: null,
        holdElapsed: 0,
        holdStartCyl: null,
        holdStartPressure: null,
        cylRelax: 0,
        holdDrop: 0,
        maxCyl: 0,
        answer: null,
        answerCorrect: null,
        tailQuery: null,
        tailConfirmed: false,
        releaseStart: null,
        releaseElapsed: null,
        releasePassed: false,
        releaseTailQuery: null,
        releaseConfirmed: false,
        /** 保压/缓解以动作做完为准时的宽限计时，避免漏做列尾动作就卡死 */
        holdWait: 0,
        releaseWait: 0,
      };
    }

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

  /** 当前阶段对应的子项与动作阶段，例如 ['sensitivity', 'hold']。 */
  get current() { return PHASE_MAP[this.phase] || null; }
  get currentSub() { const c = this.current; return c ? this.subs[c[0]] : null; }
  get stage() { const c = this.current; return c ? c[1] : null; }

  /** 当前子试验的减压量（感度档随编组变化：60 辆及以上为 70 kPa）。 */
  reductionOf(key) { return this.subs[key].reduction; }

  // ---------------------------------------------------------------- 指令闸门

  guardCommand(id, value) {
    if (CRITICAL_UNRELATED_COMMANDS.has(id)) {
      return { allowed: false, message: '当前为列车自动制动机试验，请勿操作无关设备。' };
    }
    if (id !== 'auto-brake') return { allowed: true };
    const next = Number(value);
    // 与简略试验同一口径：自阀 6 个位置全部开放操作，位置不符合本步要求时只提示、不硬拦。
    const range = LEVEL_RANGES[this.phase];
    if (!range || (next >= range[0] && next <= range[1])) return { allowed: true };
    return { allowed: true, message: this.stepHint(next) };
  }

  stepHint(level) {
    const sub = this.currentSub;
    if (this.phase === FULL_PHASES.PREPARE) {
      return '列车尚未充满风：此时移动自阀会影响定压确认。';
    }
    if (this.phase === FULL_PHASES.COMPLETE || this.phase === FULL_PHASES.FAILED) {
      return '全部试验已完成，请核对试验记录单；如需重做请点「重新开始本轮试验」。';
    }
    if (!sub) return '当前自阀位置不符合本步试验要求，流程不会继续推进。';
    if (this.stage === 'reduce') {
      return `${sub.label}要求自阀置第 ${sub.level} 档（${levelName(sub.level)}，减压 ${sub.reduction} kPa）；当前第 ${level} 档，流程不会继续推进。`;
    }
    if (this.stage === 'hold') {
      return `${sub.label}保压中：移动自阀会使保压压力变化，本次保压判定将按实际变化量计算。`;
    }
    if (this.stage === 'release') {
      return `${sub.label}：请将自阀回运转位，待列车管充风恢复后做列尾查询并确认尾部缓解。`;
    }
    return '全部试验已完成，请核对试验记录单；如需重做请点「重新开始本轮试验」。';
  }

  /** 一次拖动自阀 = 一次操作，用于「操纵是否一次到位」的评价。 */
  noteAutoBrakeDrag() { this.autoBrakeOperations += 1; }

  afterCommand(id, value, state) {
    if (id !== 'auto-brake') return;
    const next = Number(value);
    if (!this.levelOrder.includes(next)) this.levelOrder.push(next);
    const sub = this.currentSub;
    if (!sub) return;

    if (this.stage === 'reduce') {
      if (next === sub.level) {
        if (sub.reduceStart === null) {
          sub.reduceStart = state.elapsed;
          this.log(`${sub.key}-reduce-start`, { pressure: state.trainPipe });
          this.setMessage(`${sub.label}：自阀已置第 ${sub.level} 档（减压 ${sub.reduction} kPa），正在测量列车管排风时间。`);
        }
      } else {
        // 学员自行试了别的档位：不计入本步测量，回到规定位时重新计时。
        // 否则先拉一档别的再拉到规定位，两段排风会加在一起、排风时间被算长。
        sub.reduceStart = null;
      }
      return;
    }
    if (this.stage === 'release' && next === 0 && sub.releaseStart === null) {
      sub.releaseStart = state.elapsed;
      this.log(`${sub.key}-release-start`, { pressure: state.trainPipe });
      this.setMessage(`${sub.label}：自阀已回运转位，正在充风缓解（规程要求 1 min 内缓解完毕）。`);
    }
  }

  // ---------------------------------------------------- 学员动作（答题 / 列尾）

  /** 当前需要学员判断排风时间的子项 key；不需要时返回 null。 */
  get answerTarget() {
    const sub = this.currentSub;
    if (!sub || this.stage !== 'hold') return null;
    if (!Number.isFinite(sub.exhaustSeconds)) return null;
    return sub.answer === null ? sub.key : null;
  }

  submitExhaustAnswer(answer) {
    const sub = this.currentSub;
    if (!sub || this.stage !== 'hold') return { accepted: false };
    const verdict = this.exhaustVerdictOf(sub.level, sub.exhaustSeconds);
    sub.answer = answer;
    sub.answerCorrect = answer === verdict;
    this.log(`${sub.key}-answer`, { answer, correct: sub.answerCorrect });
    this.setMessage(sub.answerCorrect
      ? `${sub.label}排风时间判断正确（${EXHAUST_ANSWER_LABELS[answer]}）。`
      : `${sub.label}排风时间判断有误：实测 ${sub.exhaustSeconds.toFixed(1)} 秒，应为「${EXHAUST_ANSWER_LABELS[verdict] || '—'}」。`);
    return { accepted: true, correct: sub.answerCorrect };
  }

  /** 当前可做的列尾动作：{ key, kind } 或 null。kind: 'brake'（制动后）| 'release'（缓解后）。 */
  get tailTarget() {
    const sub = this.currentSub;
    if (!sub) return null;
    if (sub.key === 'stability' && this.stage === 'reduce') return null;
    if (this.stage === 'hold' || this.stage === 'reduce') {
      if (!Number.isFinite(sub.exhaustSeconds)) return null;
      if (!sub.tailConfirmed) return { key: sub.key, kind: 'brake' };
      return null;
    }
    if (this.stage === 'release') {
      if (!sub.releaseConfirmed) return { key: sub.key, kind: 'release' };
      return null;
    }
    return null;
  }

  queryTail(state) {
    const target = this.tailTarget;
    if (!target) return null;
    const sub = this.subs[target.key];
    const record = {
      kind: target.kind,
      head: state.trainPipe,
      tail: state.tailPipe,
      pressureDifference: Math.abs(state.trainPipe - state.tailPipe),
      at: state.elapsed,
    };
    record.passed = target.kind === 'brake'
      ? record.pressureDifference <= FULL_TEST_SPEC.common.maxTailDifference && state.trainPipe < this.attempt.nominalTrainPipe - 10
      : record.pressureDifference <= FULL_TEST_SPEC.common.maxTailDifference && state.trainPipe >= this.attempt.nominalTrainPipe - this.attempt.stablePressureTolerance;
    if (target.kind === 'brake') sub.tailQuery = record; else sub.releaseTailQuery = record;
    this.log(`${sub.key}-tail-query-${target.kind}`, record);
    this.setMessage(record.passed
      ? `${sub.label}列尾查询：尾部风压与机车端${target.kind === 'brake' ? '同步下降，列车管贯通' : '同步恢复，缓解作用正常'}。`
      : `${sub.label}列尾查询：尾部风压尚未正常跟随（差 ${record.pressureDifference.toFixed(0)} kPa），请稍候重新查询。`);
    return record;
  }

  confirmTail() {
    const target = this.tailTarget;
    if (!target) return null;
    const sub = this.subs[target.key];
    if (target.kind === 'brake') {
      if (!sub.tailQuery?.passed) {
        this.setMessage(`${sub.label}：请先查询列尾风压，确认尾部风压与机车端对应后再确认制动作用。`);
        return null;
      }
      sub.tailConfirmed = true;
      this.log(`${sub.key}-tail-confirm-brake`, {});
      this.setMessage(`${sub.label}列尾反馈：最后一辆车制动作用正常。`);
    } else {
      if (!sub.releaseTailQuery?.passed) {
        this.setMessage(`${sub.label}：请先查询列尾风压，确认尾部风压恢复后再确认缓解。`);
        return null;
      }
      sub.releaseConfirmed = true;
      this.log(`${sub.key}-tail-confirm-release`, {});
      this.setMessage(`${sub.label}列尾反馈：最后一辆车缓解完毕。`);
    }
    this.emit();
    return true;
  }

  // ------------------------------------------------------------------ 推进

  update(state, dt) {
    const a = this.attempt;
    const tol = a.targetPressureTolerance;

    if (this.phase === FULL_PHASES.PREPARE) {
      const ready = Math.abs(state.trainPipe - a.nominalTrainPipe) <= a.stablePressureTolerance
        && Math.abs(state.tailPipe - a.nominalTrainPipe) <= a.stablePressureTolerance
        && state.autoBrake === 0
        && state.brakeCyl <= FULL_TEST_SPEC.prepare.maxBrakeCyl;
      this.prepareElapsed = ready ? this.prepareElapsed + dt : 0;
      if (ready) {
        this.preparePressure = { head: state.trainPipe, tail: state.tailPipe };
        this.prepareBrakeCyl = state.brakeCyl;
      }
      if (this.prepareElapsed >= a.stableDuration) {
        this.preparePassed = true;
        this.log('prepare-pass', { head: state.trainPipe, cylinder: state.brakeCyl });
        this.phase = FULL_PHASES.SENS_REDUCE;
        this.setMessage(`列车已充满风（制动主管 ${Math.round(state.trainPipe)} kPa）。${this.stepHint(0)}`);
      }
      return;
    }

    const sub = this.currentSub;
    if (!sub) return;
    const spec = FULL_TEST_SPEC[sub.key];

    if (this.stage === 'reduce') {
      if (sub.reduceStart === null) return;
      const target = a.nominalTrainPipe - sub.reduction;
      if (state.trainPipe <= target + tol) {
        sub.exhaustSeconds = Math.max(0, state.elapsed - sub.reduceStart);
        sub.holdStart = state.elapsed;
        sub.holdStartPressure = state.trainPipe;
        sub.holdStartCyl = state.brakeCyl;
        sub.holdElapsed = 0;
        this.nextPhase(`${sub.key === 'sensitivity' ? 'SENS' : 'STAB'}_HOLD`);
        this.log(`${sub.key}-reduce-reached`, { seconds: sub.exhaustSeconds, pressure: state.trainPipe, cylinder: state.brakeCyl });
        this.setMessage(`${sub.label}减压达到 ${sub.reduction} kPa（排风 ${sub.exhaustSeconds.toFixed(1)} 秒）。请判断排风时间，并做列尾查询后开始保压。`);
      }
      return;
    }

    if (this.stage === 'hold') {
      sub.holdElapsed = Math.min(a.holdDuration, Math.max(0, state.elapsed - sub.holdStart));
      sub.cylRelax = Math.max(0, (sub.holdStartCyl || 0) - state.brakeCyl);
      sub.holdDrop = Math.max(0, sub.holdStartPressure - state.trainPipe);
      sub.maxCyl = Math.max(sub.maxCyl, state.brakeCyl);
      this.tickTimer();
      if (sub.holdElapsed >= a.holdDuration) {
        // 保压满之后还要完成列尾风压查询与尾部制动确认（规程要求），做完再进缓解。
        // 给 25 秒宽限，避免学员漏做列尾动作就卡在这一步拿不到结论。
        sub.holdWait += dt;
        if (sub.tailConfirmed || sub.holdWait >= 25) {
          this.log(`${sub.key}-hold-done`, { cylinderRelax: sub.cylRelax, drop: sub.holdDrop, tailConfirmed: sub.tailConfirmed });
          this.nextPhase(`${sub.key === 'sensitivity' ? 'SENS' : 'STAB'}_RELEASE`);
          this.setMessage(`${sub.label}保压完成（制动缸 ${Math.round(state.brakeCyl)} kPa）。${this.stepHint(0)}`);
        }
      }
      return;
    }

    if (this.stage === 'release') {
      if (sub.releaseStart === null) return;
      sub.releaseElapsed = Math.max(0, state.elapsed - sub.releaseStart);
      // 规程：手柄移至运转位后全列车须在 1 min 内缓解完毕
      const released = state.brakeCyl <= FULL_TEST_SPEC.release.maxBrakeCyl
        && state.trainPipe >= a.nominalTrainPipe - a.stablePressureTolerance;
      if (!sub.releasePassed && released && sub.releaseElapsed <= FULL_TEST_SPEC.release.maxSeconds) {
        sub.releasePassed = true;
        this.log(`${sub.key}-released`, { seconds: sub.releaseElapsed });
      }
      // 缓解到位后还要做列尾查询并确认尾部缓解；超时（含宽限）一律放行，
      // 学员仍能拿到完整结论，而不是卡在这一步。
      if (sub.releasePassed) sub.releaseWait += dt;
      const releaseDone = sub.releasePassed && (sub.releaseConfirmed || sub.releaseWait >= 25);
      if (releaseDone || sub.releaseElapsed >= FULL_TEST_SPEC.release.maxSeconds * 2) {
        const next = NEXT_PHASE[this.phase];
        this.nextPhase(next);
        if (next === FULL_PHASES.COMPLETE) {
          this.log('complete', { head: state.trainPipe, cylinder: state.brakeCyl });
          this.setMessage('全部试验流程已走完，请核对试验记录单确认最终结论。');
        } else {
          this.setMessage(`${sub.label}缓解完成。${this.stepHint(0)}`);
        }
      }
    }
  }

  nextPhase(phase) {
    this.phase = phase;
    this.lastTimerSecond = -1;
    this.emit();
  }

  tickTimer() {
    const second = Math.floor(this.currentSub ? this.currentSub.holdElapsed : 0);
    if (second !== this.lastTimerSecond) { this.lastTimerSecond = second; this.emit(); }
  }

  get holdRemaining() {
    const sub = this.currentSub;
    if (!sub || this.stage !== 'hold') return null;
    return Math.max(0, this.attempt.holdDuration - sub.holdElapsed);
  }

  get holdProgress() {
    const sub = this.currentSub;
    if (!sub || this.stage !== 'hold') return null;
    return Math.min(100, sub.holdElapsed / this.attempt.holdDuration * 100);
  }

  // ------------------------------------------------------------------ 输出

  getSteps(state) {
    const s = this.subs.sensitivity;
    const t = this.subs.stability;
    const hold = this.attempt.holdDuration;
    return [
      { label: '试验前准备：列车充满风、制动主管达定压、制动缸缓解', done: this.preparePassed },
      { label: `感度试验：自阀减压 ${s.reduction} kPa（第 ${s.level} 档）`, done: Number.isFinite(s.exhaustSeconds) },
      { label: '感度试验：判断列车管排风时间', done: s.answer !== null },
      { label: '感度试验：列尾风压查询并确认尾部制动作用', done: s.tailConfirmed },
      { label: `感度试验：保压 ${hold} 秒，检查制动作用与自然缓解`, done: s.holdStart !== null && s.holdElapsed >= hold },
      { label: '感度试验：自阀回运转位，1 min 内缓解完毕', done: s.releasePassed },
      { label: '感度试验：列尾查询确认尾部缓解', done: s.releaseConfirmed },
      { label: `安定试验：自阀施行最大有效减压（${t.reduction} kPa，第 ${t.level} 档）`, done: Number.isFinite(t.exhaustSeconds) },
      { label: '安定试验：判断列车管排风时间', done: t.answer !== null },
      { label: '安定试验：列尾风压查询并确认尾部制动作用', done: t.tailConfirmed },
      { label: `安定试验：保压 ${hold} 秒，检查不发生紧急制动`, done: t.holdStart !== null && t.holdElapsed >= hold },
      { label: '安定试验：自阀回运转位，1 min 内缓解完毕', done: t.releasePassed },
      { label: '安定试验：列尾查询确认尾部缓解', done: t.releaseConfirmed },
    ];
  }

  exhaustVerdictOf(levelIndex, seconds) {
    const spec = this.attempt.exhaustByLevel?.[levelIndex];
    if (!spec || spec.reference === null || !Number.isFinite(seconds)) return 'unknown';
    if (seconds < spec.min) return 'short';
    if (seconds > spec.max) return 'long';
    return 'normal';
  }

  /** 排风时间的显示口径：调试加速时用加速后的参考值与容差，并与"表中值"一并注明。 */
  exhaustRangeText(item) {
    const a = this.attempt;
    if (!item || item.reference === null) return '—';
    return a.exhaust.scale === 1
      ? `${item.min} ～ ${item.max} s（参考 ${item.reference} ± ${item.referenceTolerance} s）`
      : `${item.min} ～ ${item.max} s（调试加速 1/${Math.round(1 / a.exhaust.scale)}：参考 ${item.expected} ± ${item.tolerance} s，表中值 ${item.reference} s）`;
  }

  /** 按《铁路机车操作规则》第 15 条逐项判定。 */
  getJudgements(state) {
    const a = this.attempt;
    const spec = FULL_TEST_SPEC;
    const items = [];

    items.push({
      label: '试验前准备·制动主管定压',
      actual: this.preparePressure ? `${Math.round(this.preparePressure.head)} kPa（尾部 ${Math.round(this.preparePressure.tail)} kPa）` : '未确认',
      reference: `${a.nominalTrainPipe} ± ${a.stablePressureTolerance} kPa`,
      verdict: this.preparePassed ? 'pass' : 'pending',
      note: '',
    });
    items.push({
      label: '试验前准备·制动缸缓解',
      actual: this.prepareBrakeCyl === null ? '未确认' : `${Math.round(this.prepareBrakeCyl)} kPa`,
      reference: `≤ ${spec.prepare.maxBrakeCyl} kPa`,
      verdict: this.preparePassed ? 'pass' : 'pending',
      note: '',
    });

    for (const key of SUB_ORDER) {
      const sub = this.subs[key];
      const conf = spec[key];
      const level = a.exhaustByLevel?.[conf.level];
      const verdict = this.exhaustVerdictOf(conf.level, sub.exhaustSeconds);
      const leak = sub.holdDrop === 0 ? 0 : Math.round(sub.holdDrop * (60 / Math.max(1, sub.holdElapsed)));

      items.push({
        label: `${sub.shortLabel}·减压量`,
        actual: Number.isFinite(sub.exhaustSeconds) ? `${sub.reduction} kPa（第 ${sub.level} 档 ${levelName(sub.level)}）` : '未减压',
        reference: key === 'sensitivity'
          ? `${sub.reduction} kPa（编组 ${a.formationCars} 辆${a.formationCars >= 60 ? '，60 辆及以上为 70 kPa' : ''}）`
          : `${sub.reduction} kPa（定压 ${a.nominalTrainPipe} kPa 的最大有效减压）`,
        verdict: Number.isFinite(sub.exhaustSeconds) ? 'pass' : 'pending',
        note: '',
      });
      items.push({
        label: `${sub.shortLabel}·排风时间`,
        actual: Number.isFinite(sub.exhaustSeconds) ? `${sub.exhaustSeconds.toFixed(1)} s` : '未测得',
        reference: this.exhaustRangeText(level),
        verdict: verdict === 'normal' ? 'pass' : verdict === 'unknown' ? 'pending' : 'fail',
        note: verdict === 'short'
          ? `${sub.label}排风时间低于参考下限（按${a.trainTypeLabel}公式编组 ${a.formationCars} 辆、减压 ${sub.reduction} kPa 应为 ${a.exhaust.scale === 1 ? level?.reference : level?.expected} s）；排风过快可能是折角塞门关闭或制动主管不畅`
          : verdict === 'long'
            ? `${sub.label}排风时间高于参考上限；排风过慢可能是漏泄或车列连接异常`
            : '',
      });
      items.push({
        label: `${sub.shortLabel}·排风时间判断`,
        actual: sub.answer === null ? '未作答' : `${EXHAUST_ANSWER_LABELS[sub.answer] || sub.answer}${sub.answerCorrect ? '' : '（判断有误）'}`,
        reference: '学员判断结果应与实测排风时间相符',
        verdict: sub.answer === null ? 'pending' : sub.answerCorrect ? 'pass' : 'fail',
        note: sub.answer !== null && !sub.answerCorrect ? '排风时间判断有误，应按参考表重新判断' : '',
      });

      if (key === 'sensitivity') {
        items.push({
          label: '感度·全列车发生制动作用',
          actual: sub.maxCyl ? `${Math.round(sub.maxCyl)} kPa` : '未测定',
          reference: `≥ ${conf.minBrakeCyl} kPa（全列车必须发生制动作用）`,
          verdict: sub.holdStart === null ? 'pending' : sub.maxCyl >= conf.minBrakeCyl ? 'pass' : 'fail',
          note: sub.holdStart !== null && sub.maxCyl < conf.minBrakeCyl ? '未发生制动作用，应检查制动主管贯通与分配阀' : '',
        });
        items.push({
          label: '感度·不得自然缓解',
          actual: sub.holdStart === null ? '未保压' : `保压 ${sub.holdElapsed.toFixed(0)} s 制动缸下降 ${sub.cylRelax.toFixed(0)} kPa`,
          reference: `保压 ≥ ${a.holdDuration} s 且制动缸下降 ≤ ${conf.maxCylRelax} kPa`,
          verdict: sub.holdStart === null ? 'pending' : sub.cylRelax <= conf.maxCylRelax ? 'pass' : 'fail',
          note: sub.holdStart !== null && sub.cylRelax > conf.maxCylRelax ? '保压期间发生自然缓解，应检查制动缸与分配阀' : '',
        });
      } else {
        items.push({
          label: '安定·不发生紧急制动',
          actual: sub.holdStart === null ? '未保压' : `保压 ${sub.holdElapsed.toFixed(0)} s 列车管下降 ${sub.holdDrop.toFixed(0)} kPa`,
          reference: `保压 ≥ ${a.holdDuration} s 且列车管下降 ≤ ${conf.maxHoldDrop} kPa`,
          verdict: sub.holdStart === null ? 'pending' : sub.holdDrop <= conf.maxHoldDrop ? 'pass' : 'fail',
          note: sub.holdStart !== null && sub.holdDrop > conf.maxHoldDrop ? '最大有效减压后列车管仍持续下降，发生紧急制动，应检查分配阀安定性' : '',
        });
        items.push({
          label: '安定·制动缸压力',
          actual: sub.maxCyl ? `${Math.round(sub.maxCyl)} kPa` : '未测定',
          reference: `≥ ${conf.minBrakeCyl} kPa`,
          verdict: sub.holdStart === null ? 'pending' : sub.maxCyl >= conf.minBrakeCyl ? 'pass' : 'fail',
          note: sub.holdStart !== null && sub.maxCyl < conf.minBrakeCyl ? '制动缸压力未达最大有效减压要求，应检查制动缸及闸调器' : '',
        });
      }

      items.push({
        label: `${sub.shortLabel}·制动主管漏泄量`,
        actual: sub.holdStart === null ? '未测定' : `${leak} kPa/min`,
        reference: `≤ ${spec.common.maxLeakage} kPa/min`,
        verdict: sub.holdStart === null ? 'pending' : leak <= spec.common.maxLeakage ? 'pass' : 'fail',
        note: sub.holdStart !== null && leak > spec.common.maxLeakage ? '制动主管漏泄超限，应查明漏泄处所' : '',
      });

      items.push({
        label: `${sub.shortLabel}·列尾查询与制动确认`,
        actual: sub.tailQuery ? `机车端 ${Math.round(sub.tailQuery.head)} / 尾部 ${Math.round(sub.tailQuery.tail)} kPa（差 ${Math.round(sub.tailQuery.pressureDifference)}）` : '未查询',
        reference: `查询尾部风压（压差 ≤ ${spec.common.maxTailDifference} kPa）并确认最后一辆车制动作用`,
        verdict: sub.tailConfirmed ? 'pass' : 'pending',
        note: sub.tailQuery && !sub.tailConfirmed ? '已查询但未确认尾部制动作用' : '',
      });

      items.push({
        label: `${sub.shortLabel}·缓解时间`,
        actual: sub.releasePassed ? `${sub.releaseElapsed === null ? '—' : sub.releaseElapsed.toFixed(1)} s` : (sub.releaseStart === null ? '未缓解' : '超时未缓解'),
        reference: `手柄移至运转位后 ≤ ${spec.release.maxSeconds} s（1 min）内缓解完毕`,
        verdict: sub.releasePassed ? 'pass' : sub.releaseStart === null ? 'pending' : 'fail',
        note: sub.releaseStart !== null && !sub.releasePassed ? '缓解超时，应检查制动缸缓解通路' : '',
      });
      items.push({
        label: `${sub.shortLabel}·列尾缓解确认`,
        actual: sub.releaseTailQuery ? `机车端 ${Math.round(sub.releaseTailQuery.head)} / 尾部 ${Math.round(sub.releaseTailQuery.tail)} kPa（差 ${Math.round(sub.releaseTailQuery.pressureDifference)}）` : '未查询',
        reference: '列尾查询确认尾部压力恢复、最后一辆车缓解',
        verdict: sub.releaseConfirmed ? 'pass' : 'pending',
        note: '',
      });
    }

    return items;
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
