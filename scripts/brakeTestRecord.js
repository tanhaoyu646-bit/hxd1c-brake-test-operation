/**
 * 试验记录单与操作评分。
 *
 * 设计约定（与教学口径一致）：
 * - 「试验结论」只由物理判定决定（定压、减压量、排风时间、保压漏泄、列尾制动/缓解）；
 * - 「操作评分」只反映操纵规范程度（流程完成、是否一次减压到位、判断题首答、列尾查询效率、无关操作扣分）；
 * - 两者互不换算，记录单上分列呈现，避免把"分高"误解为"试验合格"。
 */

const VERDICT_LABELS = { pass: '合格', fail: '不合格', pending: '未完成' };

export const VERDICT_TEXT = VERDICT_LABELS;

const round = (value, digits = 0) => {
  const safe = Number.isFinite(Number(value)) ? Number(value) : 0;
  return safe.toFixed(digits);
};

function pad(value) { return String(value).padStart(2, '0'); }

export function formatDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 简略试验评分：流程完成 60 / 一次减压到位 15 / 排风时间判断 15 / 列尾查询效率 10。 */
function buildSimpleScore(attempt, state, workflow) {
  const steps = workflow.getSteps(state);
  const doneSteps = steps.filter((step) => step.done).length;
  const progressPoints = Math.round(doneSteps / steps.length * 60);

  const autoBrakeOperations = workflow.autoBrakeOperations;
  const reducePoints = autoBrakeOperations <= 1 ? 15 : autoBrakeOperations === 2 ? 10 : autoBrakeOperations === 3 ? 5 : 0;

  const firstTry = workflow.answerFirstTryCorrect;
  const answerPoints = firstTry === true ? 15 : workflow.answerCorrect ? 8 : 0;

  const queries = workflow.tailQueryAttempts.brake + workflow.tailQueryAttempts.release;
  const passedQueries = (workflow.tailBrakeQuery?.passed ? 1 : 0) + (workflow.tailReleaseQuery?.passed ? 1 : 0);
  const wasted = Math.max(0, queries - passedQueries);
  // 列尾压力传导需要时间，等待后重查属于正常操作（允许 1 次），只在反复乱查时才明显扣分。
  const tailPoints = queries === 0 ? 0 : Math.max(4, 12 - wasted * 2);

  const deduction = Math.min(15, state.rejected * 3);

  const parts = [
    { label: '流程完成', points: progressPoints, max: 60, detail: `${doneSteps}/${steps.length} 步` },
    { label: '一次减压到位', points: reducePoints, max: 15, detail: `减压阶段自阀操作 ${autoBrakeOperations} 次` },
    { label: '排风时间判断', points: answerPoints, max: 15, detail: firstTry === true ? '首次判断正确' : workflow.answerCorrect ? '经纠正后判断正确' : '判断未完成' },
    { label: '列尾查询效率', points: tailPoints, max: 10, detail: queries === 0 ? '未进行列尾查询' : `查询 ${queries} 次，未通过 ${wasted} 次` },
    { label: '无关设备操作扣分', points: -deduction, max: 0, detail: deduction ? `${state.rejected} 次，扣 ${deduction} 分` : '无' },
  ];
  const total = Math.max(0, Math.min(100, parts.reduce((sum, part) => sum + part.points, 0)));
  return { total, parts, deduction };
}

/**
 * 全部试验评分：判定项通过 80 / 顺序与操纵 20 − 无关操作扣分。
 * 标准自阀操作为 6 次拖动（1 档→运转位→3 档→运转位→5 档→运转位），
 * 子试验之间必须恢复定压，多拉一次扣一档分。
 */
function buildFullScore(attempt, state, workflow) {
  const items = workflow.getJudgements(state);
  const passed = items.filter((item) => item.verdict === 'pass').length;
  const passPoints = Math.round(passed / items.length * 80);

  const operations = workflow.autoBrakeOperations || 0;
  const extra = Math.max(0, operations - 6);
  const orderPoints = extra === 0 ? 20 : extra === 1 ? 14 : extra === 2 ? 8 : 0;

  const deduction = Math.min(15, state.rejected * 3);

  const parts = [
    { label: '判定项通过', points: passPoints, max: 80, detail: `${passed}/${items.length} 项合格` },
    { label: '顺序与操纵', points: orderPoints, max: 20, detail: `自阀操作 ${operations} 次（标准 6 次：1 档→运转位→3 档→运转位→5 档→运转位）` },
    { label: '无关设备操作扣分', points: -deduction, max: 0, detail: deduction ? `${state.rejected} 次，扣 ${deduction} 分` : '无' },
  ];
  const total = Math.max(0, Math.min(100, parts.reduce((sum, part) => sum + part.points, 0)));
  return { total, parts, deduction };
}

function buildScore(attempt, state, workflow) {
  return attempt.testMode === 'full'
    ? buildFullScore(attempt, state, workflow)
    : buildSimpleScore(attempt, state, workflow);
}

export function buildBrakeTestRecord({ attempt, state, workflow, now = new Date() }) {
  const items = workflow.getJudgements(state);
  const conclusion = workflow.getConclusion(state);
  const score = buildScore(attempt, state, workflow);
  return {
    header: {
      title: `HXD1C 列车自动制动机${attempt.testModeLabel || '简略试验'}记录单`,
      testMode: attempt.testMode,
      testModeLabel: attempt.testModeLabel || '简略试验',
      attemptId: attempt.attemptId,
      createdAt: formatDateTime(attempt.createdAt),
      generatedAt: formatDateTime(now),
      scenario: attempt.title,
      scenarioKey: attempt.scenarioKey,
      exam: Boolean(attempt.exam),
      trainType: attempt.trainType,
      trainTypeLabel: attempt.trainTypeLabel,
      formationCars: attempt.formationCars,
      nominalTrainPipe: attempt.nominalTrainPipe,
      targetReduction: attempt.targetReduction,
      exhaust: attempt.exhaust,
      debugFast: attempt.debugFast,
    },
    items,
    conclusion,
    score,
  };
}

export function formatRecordText(record) {
  const { header, items, conclusion, score } = record;
  const lines = [];
  lines.push(header.title);
  lines.push('='.repeat(46));
  lines.push(`试验编号：${header.attemptId}`);
  lines.push(`试验场景：${header.scenario}${header.exam ? '（考核抽考 · 考试中未告知学员）' : ''}`);
  lines.push(`列车类型：${header.trainTypeLabel}　编组 ${header.formationCars} 辆　定压 ${header.nominalTrainPipe} kPa　减压 ${header.targetReduction} kPa`);
  lines.push(`排风时间依据：${header.exhaust.formulaText} → 参考 ${header.exhaust.reference} s，允许偏差 ±${header.exhaust.tolerance} s（${header.exhaust.toleranceRule}）`);
  if (header.exhaust.scale !== 1) {
    lines.push(`注意：本轮为调试加速模式，判定基准已同步缩放为 ${header.exhaust.min}～${header.exhaust.max} s，不得作为正式记录。`);
  }
  lines.push(`开始时间：${header.createdAt}`);
  lines.push(`出单时间：${header.generatedAt}`);
  lines.push('');
  lines.push('试验项目'.padEnd(14, ' ') + '实测结果'.padEnd(24, ' ') + '参考要求'.padEnd(22, ' ') + '判定');
  lines.push('-'.repeat(46));
  for (const item of items) {
    lines.push(
      `${item.label.padEnd(12, ' ')}${String(item.actual).padEnd(22, ' ')}${String(item.reference).padEnd(20, ' ')}${VERDICT_LABELS[item.verdict]}`,
    );
    if (item.note) lines.push(`  ↳ ${item.note}`);
  }
  lines.push('');
  lines.push('操作评分');
  lines.push('-'.repeat(46));
  for (const part of score.parts) {
    const sign = part.points < 0 ? '' : '+';
    const maxText = part.max ? `/${part.max}` : '';
    lines.push(`${part.label}：${sign}${part.points}${maxText} 分（${part.detail}）`);
  }
  lines.push(`合计：${score.total} / 100 分`);
  lines.push('');
  lines.push(`试验结论：${conclusion.headline}`);
  if (conclusion.reasons.length) {
    lines.push('不合格原因：');
    for (const reason of conclusion.reasons) lines.push(`  · ${reason}`);
  }
  return lines.join('\n');
}

export function buildRecordHtml(record) {
  const { items, conclusion, score } = record;
  const rows = items.map((item) => {
    const note = item.note ? `<b class="record-note">${item.note}</b>` : '';
    return `<tr class="verdict-${item.verdict}"><td>${item.label}${note}</td><td>${item.actual}</td><td>${item.reference}</td><td>${VERDICT_LABELS[item.verdict]}</td></tr>`;
  }).join('');
  const parts = score.parts.map((part) => {
    const sign = part.points < 0 ? '−' : '+';
    const maxText = part.max ? ` / ${part.max}` : '';
    return `<span>${part.label}<b>${sign}${Math.abs(part.points)}${maxText}</b></span>`;
  }).join('');
  return {
    body: rows,
    conclusion: `<strong class="${conclusion.pass ? 'ok' : 'bad'}">试验结论：${conclusion.headline}</strong>${conclusion.reasons.length ? `<ul>${conclusion.reasons.map((reason) => `<li>${reason}</li>`).join('')}</ul>` : '<p>制动与缓解作用正常，可交付后续作业。</p>'}`,
    score: `<div class="record-score-head">操作评分 <b>${score.total}</b> / 100 分</div><div class="record-score-parts">${parts}</div><p class="record-score-note">评分只反映操纵规范程度，与试验结论无关；试验合格与否以上方判定为准。</p>`,
  };
}

export { round };
