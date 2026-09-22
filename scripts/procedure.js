export const PROCEDURE = [
  ['输入并核对 LKJ 参数和运行揭示', s => s.lkjConfirmed],
  ['升受电弓并确认网压', s => s.panto && s.netVoltage >= 22.5],
  ['闭合主断路器', s => s.mainBreaker],
  ['投入空压机并建立总风', s => s.compressor && s.mainRes >= 750],
  ['自动制动机减压试验', s => s.brakeTested],
  ['大闸回运转位并确认缓解', s => s.releaseObserved],
  ['缓解停放制动', s => !s.parkingBrake],
  ['确认发车许可、前照灯和风笛', s => s.authority && s.headlight && s.horn],
  ['方向手柄置前进', s => s.direction === 'F'],
  ['低级位平稳起动', s => s.speed >= 5 && s.traction > 0],
  ['短距离稳定运行', s => s.distance >= 250 && s.speed >= 12 && s.speed <= 30],
];

export function procedureState(state) {
  const complete = PROCEDURE.map(([, test]) => test(state));
  const current = complete.findIndex((done) => !done);
  return { complete, current: current < 0 ? PROCEDURE.length - 1 : current, done: complete.every(Boolean) };
}

export function scoreRun(state) {
  const p = procedureState(state); const completed = p.complete.filter(Boolean).length;
  const base = Math.round(completed / PROCEDURE.length * 85);
  const quality = state.speed >= 5 && state.speed <= 30 ? 15 : Math.min(10, Math.round(state.distance / 40));
  const deductions = Math.min(20, state.rejected * 2 + state.abrupt * 3 + (state.maxAcceleration > .55 ? 5 : 0));
  return { score: Math.max(0, Math.min(100, base + quality - deductions)), completed, deductions, quality };
}
