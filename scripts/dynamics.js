const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * 列车管排风与制动缸标定（货车，列车管定压 600 kPa）。数值集中在这里便于按教学要求调整。
 *
 * - 均衡风缸与列车管必须**同速**下降：实车上均衡风缸是自阀控制的先导压力，
 *   经中继阀使列车管降压，两者变化幅度与速度基本一致。此前均衡风缸按一阶快趋近
 *   （约 0.4 秒到位）而列车管要几十秒，界面上看起来不像同一套制动系统。
 * - 列车管跟随均衡风缸留 FOLLOW_TAU 的滞后（阀件响应），稳态偏置约 τ×速率（1 kPa 量级），
 *   恰好被判定用的 1 kPa 容差抵消，因此「列车管达到目标 ±1 kPa」的时刻仍等于参考表的 T。
 * - 紧急制动不是"瞬间排空"，实测约 4~5 秒把列车管放到 0。
 * - 制动缸压力与列车管减压量近似成正比，定压 600 kPa 下最高约 450 kPa。
 */
const FOLLOW_TAU_FULL = 0.4;
// 紧急制动时均衡风缸与列车管串了两级一阶滞后（先导 → 中继阀），总排空时间约为 5.4×τ。
// 取 τ=0.8 使列车管约 4.3 秒排到 0（此前 τ=1.2 会因为串联滞后变成 6.5 秒，超出判定上限）。
// 该常数不随调试加速缩放——紧急制动排空是真实物理时间。
const EMERGENCY_TAU = 0.8;
const BRAKE_CYL_RATIO = 3.2;
const BRAKE_CYL_MAX = 450;

export class TrainSimulation {
  constructor(config = {}) {
    this.config = {
      nominalTrainPipe: 600,
      targetReduction: 100,
      simulatedExhaustSeconds: 38.4,
      tailResponseRate: .34,
      simulatedLeakagePerMinute: 8,
      ...config,
    };
    this.listeners = new Set();
    this.reset();
  }
  reset() {
    const nominal = this.config.nominalTrainPipe;
    this.state = {
      controlPowerOutput: true, parkingPower: true, output24V: true, powerOn: true,
      initialConfirmed: true, lkjConfirmed: true, lkjData: { trainNo: '教学试验' }, panto: true, mainBreaker: true, compressor: true,
      parkingBrake: true, authority: false, headlight: false, horn: false, hornActive: false, vigilanceAcknowledged: false, direction: 'N',
      auxiliaryLight: false, markerFront: '0', markerRear: '0', cabLight: false,
      // 简略试验从机车已完成供电、风源建立且列车管达到定压的教学场景开始。
      autoBrake: 0, independentBrake: 0, traction: 0, mainRes: 850, equalizingRes: nominal, trainPipe: nominal, tailPipe: nominal, brakeCyl: 0,
      pneumaticLeak: 0, netVoltage: 25, speed: 0, distance: 0, tractionForce: 0, brakeForce: 0,
      brakeTested: false, releaseObserved: false, elapsed: 0,
      rejected: 0, abrupt: 0, maxAcceleration: 0, maxJerk: 0, lastAcceleration: 0,
    };
    this.emit();
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(message = '') { for (const fn of this.listeners) fn(this.state, message); }
  reject(message) { this.state.rejected += 1; this.emit(message); return false; }
  command(id, value) {
    const s = this.state;
    if (id === 'power-cabinet-switch') {
      const allowed = ['controlPowerOutput', 'parkingPower', 'output24V'];
      const key = value?.key;
      if (!allowed.includes(key)) return this.reject('未识别的控制电源柜开关。');
      const enabled = Boolean(value?.enabled);
      if (enabled && !s.powerOn && (s.traction !== 0 || s.direction !== 'N' || !s.parkingBrake)) return this.reject('初始位置不正确：确认牵引零位、方向中立并施加停放制动。');
      s[key] = enabled;
      const wasPowered = s.powerOn;
      s.powerOn = s.controlPowerOutput && s.parkingPower && s.output24V;
      if (s.powerOn) s.initialConfirmed = true;
      if (!s.powerOn) {
        s.mainBreaker = false;
        s.compressor = false;
        if (wasPowered) { s.lkjConfirmed = false; s.lkjData = null; }
      }
      const names = { controlPowerOutput: '控制电源输出', parkingPower: '停放制动电源', output24V: '24V 输出' };
      this.emit(s.powerOn ? '三项电源均已接通，司机室控制电源建立。' : `${names[key]}已${enabled ? '接通' : '断开'}；须完成三项操作才能建立控制电源。`);
      return true;
    }
    if (id === 'control-power') {
      if (!s.powerOn && (s.traction !== 0 || s.direction !== 'N' || !s.parkingBrake)) return this.reject('初始位置不正确：确认牵引零位、方向中立并施加停放制动。');
      const next = !s.powerOn;
      s.controlPowerOutput = next; s.parkingPower = next; s.output24V = next; s.powerOn = next;
      if (next) s.initialConfirmed = true;
      else { s.mainBreaker = false; s.compressor = false; s.lkjConfirmed = false; s.lkjData = null; }
      this.emit(next ? '调试快捷操作：三项控制电源已接通。' : '调试快捷操作：三项控制电源已断开。'); return true;
    }
    if (id === 'lkj-confirm') {
      const required = ['driverId', 'assistantId', 'section', 'station', 'trainNo', 'trainType', 'weight', 'cars', 'length'];
      if (!value || required.some((key) => String(value[key] ?? '').trim() === '')) return this.reject('LKJ 参数不完整，不能确认。');
      if (['weight', 'cars', 'length'].some((key) => !Number.isFinite(Number(value[key])) || Number(value[key]) <= 0)) return this.reject('LKJ 重量、辆数或计长输入不正确。');
      s.lkjData = { ...value }; s.lkjConfirmed = true; this.emit('LKJ 参数已输入，运行揭示已查询确认。'); return true;
    }
    if (id === 'lkj') { s.lkjData = { debug: true }; s.lkjConfirmed = true; this.emit('调试快捷操作：LKJ 已确认。'); return true; }
    if (id === 'panto') { const next=value===undefined?!s.panto:Boolean(value); if (next && !s.lkjConfirmed) return this.reject('请先完成 LKJ 参数输入与运行揭示核对。'); s.panto = next; if (!s.panto) s.mainBreaker = false; this.emit(s.panto ? '受电弓已升起，正在建立网压。' : '受电弓已降下。'); return true; }
    if (id === 'main-breaker') { const next=value===undefined?!s.mainBreaker:Boolean(value); if (next && (!s.panto || s.netVoltage < 19)) return this.reject('网压未建立，禁止闭合主断路器。'); s.mainBreaker = next; this.emit(s.mainBreaker ? '主断路器已闭合。' : '主断路器已断开。'); return true; }
    if (id === 'compressor') { const next=value===undefined?!s.compressor:Boolean(value); if (next && !s.mainBreaker) return this.reject('主断路器未闭合，空压机不能投入。'); s.compressor = next; this.emit(s.compressor ? '空气压缩机已投入。' : '空气压缩机已停止。'); return true; }
    if (id === 'parking-apply') { s.parkingBrake = true; this.emit('停放制动已施加。'); return true; }
    if (id === 'parking-release') { if (s.mainRes < 600) return this.reject('总风压力低于 600 kPa，不能缓解停放制动。'); s.parkingBrake = false; this.emit('停放制动已缓解。'); return true; }
    if (id === 'parking') { return this.command(s.parkingBrake ? 'parking-release' : 'parking-apply'); }
    if (id === 'authority') { if (!s.lkjConfirmed) return this.reject('请先完成 LKJ 参数与揭示核对。'); s.authority = true; this.emit('已确认发车许可与允许信号。'); return true; }
    if (id === 'headlight') { s.headlight = !s.headlight; this.emit(s.headlight ? '前照灯已开启。' : '前照灯已关闭。'); return true; }
    if (id === 'auxiliary-light') { s.auxiliaryLight = !s.auxiliaryLight; this.emit(s.auxiliaryLight ? '辅照灯已开启。' : '辅照灯已关闭。'); return true; }
    if (id === 'marker-front') { s.markerFront = value || '0'; this.emit(`前标志灯已置于${s.markerFront === 'white' ? '白灯' : s.markerFront === 'red' ? '红灯' : '零位'}。`); return true; }
    if (id === 'marker-rear') { s.markerRear = value || '0'; this.emit(`后标志灯已置于${s.markerRear === 'white' ? '白灯' : s.markerRear === 'red' ? '红灯' : '零位'}。`); return true; }
    if (id === 'cab-light') { s.cabLight = !s.cabLight; this.emit(s.cabLight ? '司机室灯已开启。' : '司机室灯已关闭。'); return true; }
    if (id === 'horn-start') { s.hornActive = true; s.horn = true; this.emit('风笛鸣响。'); return true; }
    if (id === 'horn-stop') { s.hornActive = false; this.emit('风笛停止。'); return true; }
    if (id === 'horn') { s.horn = true; this.emit('调试快捷操作：已执行鸣笛。'); return true; }
    if (id === 'reset') { s.vigilanceAcknowledged = true; this.emit('警惕/复位按钮已按下。'); return true; }
    if (id === 'direction') {
      if (s.traction !== 0) return this.reject('牵引手柄未回零，禁止改变方向。');
      s.direction = value; this.emit(`方向手柄已置于${value === 'F' ? '前进' : value === 'R' ? '后退' : '中立'}位。`); return true;
    }
    if (id === 'auto-brake') {
      const next = clamp(Number(value), 0, 5); if (next < s.autoBrake - 1 || next > s.autoBrake + 2) s.abrupt += 1;
      s.autoBrake = next; this.emit(next === 0 ? '自动制动阀已回运转位。' : `自动制动阀置于制动档 ${next}。`); return true;
    }
    if (id === 'independent-brake') { s.independentBrake = clamp(Number(value), 0, 5); this.emit('单独制动阀档位已调整。'); return true; }
    if (id === 'traction') {
      // 原 HXD1C Combined_Control：前推为 7 个牵引位，中央为零位，后拉为 8 个电制动位。
      const next = clamp(Number(value), -8, 7);
      if (next - s.traction > 1) s.abrupt += 1;
      s.traction = next;
      const tractionBlocked = next > 0 && (!s.authority || !s.horn || !s.headlight || s.direction !== 'F' || s.parkingBrake || s.autoBrake > 0 || s.independentBrake > 0 || s.brakeCyl > 15 || !s.mainBreaker);
      if (tractionBlocked) {
        s.rejected += 1;
        this.emit(`牵引手柄已置于 ${next} 级，但牵引联锁未满足，暂不输出牵引力。`);
        return false;
      }
      this.emit(next > 0 ? `牵引手柄置于 ${next} 级。` : next < 0 ? `电制动置于 ${Math.abs(next)} 级。` : '牵引手柄已回零。'); return true;
    }
    return false;
  }
  tick(dt) {
    const s = this.state; s.elapsed += dt;
    const netTarget = s.panto ? 25 : 0; s.netVoltage += (netTarget - s.netVoltage) * Math.min(1, dt * 1.8);
    const mainTarget = s.compressor && s.mainBreaker ? 900 : 0; s.mainRes += (mainTarget - s.mainRes) * Math.min(1, dt * (s.compressor ? .22 : .02));
    // 自阀各制动位按本轮列车管定压计算。第二常用制动档专用于简略试验的 100 kPa 减压。
    const nominal = this.config.nominalTrainPipe;
    const reductions = [0, 50, this.config.targetReduction, 140, 170, nominal];
    const equalizingTargets = reductions.map((reduction) => Math.max(0, nominal - reduction));
    const equalizingTarget = s.mainRes > 450 ? equalizingTargets[s.autoBrake] : 0;
    const emergencyBrake = s.autoBrake >= 5;
    // 本档的排风速率（kPa/s），由参考表按「本次减压量」算出的排风时间反推：
    // 50 kPa 约 24 s、100 kPa 约 38.4 s、140 kPa 约 48 s（48 辆货车），紧急档单独给定。
    const exhaustRate = this.config.exhaustRates?.[s.autoBrake]
      || (this.config.targetReduction / Math.max(1, this.config.simulatedExhaustSeconds));
    const reducing = s.autoBrake > 0 && equalizingTarget < s.equalizingRes;

    if (emergencyBrake) {
      s.equalizingRes += (equalizingTarget - s.equalizingRes) * Math.min(1, dt / EMERGENCY_TAU);
    } else if (reducing && exhaustRate > 0) {
      // 减压时均衡风缸线性下降——它与列车管是同一套制动作用，不能一个秒变一个慢慢降。
      s.equalizingRes = Math.max(equalizingTarget, s.equalizingRes - exhaustRate * dt);
    } else {
      s.equalizingRes += (equalizingTarget - s.equalizingRes) * Math.min(1, dt * .75);
    }
    // 管路漏泄只在保压/静止阶段累积。若排风过程中同时计入漏泄，注入"保压漏泄"的场景会连带
    // 把排风时间也判成过短（48 辆货车 28 kPa/min 会提前约 7 秒），学员看到两个不合格原因
    // 反而分不清问题出在哪个环节；参考表的排风时间基准也是正常状态下的列车。
    if (s.autoBrake > 0 && !emergencyBrake && !reducing) {
      s.pneumaticLeak += this.config.simulatedLeakagePerMinute / 60 * dt;
    } else if (!reducing) {
      s.pneumaticLeak += (0 - s.pneumaticLeak) * Math.min(1, dt * 2);
    }
    const trainPipeTarget = Math.max(0, s.equalizingRes - s.pneumaticLeak);
    // 列车管经中继阀跟随均衡风缸：减压与紧急用对应的时间常数，缓解充风仍按原一阶速率。
    // 滞后常数随调试加速同步缩放，保证加速模式下判定时间仍与参考表吻合。
    const followTau = this.config.followTau ?? FOLLOW_TAU_FULL;
    if (emergencyBrake) {
      s.trainPipe += (trainPipeTarget - s.trainPipe) * Math.min(1, dt / EMERGENCY_TAU);
    } else if (reducing) {
      s.trainPipe += (trainPipeTarget - s.trainPipe) * Math.min(1, dt / followTau);
    } else {
      s.trainPipe += (trainPipeTarget - s.trainPipe) * Math.min(1, dt * .72);
    }
    s.tailPipe += (s.trainPipe - s.tailPipe) * Math.min(1, dt * this.config.tailResponseRate);
    // 停放制动为独立的弹簧储能制动，不应冒充空气制动缸压力；否则大闸缓解试验会永远无法完成。
    const autoCyl = s.mainRes > 450 ? clamp((nominal - s.trainPipe) * BRAKE_CYL_RATIO, 0, BRAKE_CYL_MAX) : 0; const individualCyl = s.independentBrake * 60;
    const cylTarget = Math.max(autoCyl, individualCyl); s.brakeCyl += (cylTarget - s.brakeCyl) * Math.min(1, dt * 2.3);
    if (s.brakeTested && s.autoBrake === 0 && s.trainPipe > nominal - 30 && s.brakeCyl < 40) s.releaseObserved = true;
    const tractionAllowed = s.mainBreaker && s.authority && s.horn && s.headlight && s.direction === 'F' && !s.parkingBrake && s.autoBrake === 0 && s.independentBrake === 0 && s.brakeCyl < 15;
    s.tractionForce = tractionAllowed && s.traction > 0 ? s.traction * 68000 * Math.max(.34, 1 - s.speed / 125) : 0;
    const electricBrake = s.traction < 0 ? Math.abs(s.traction) * 43000 : 0;
    const parkingBrakeForce = s.parkingBrake ? 450000 : 0;
    s.brakeForce = s.brakeCyl * 1250 + electricBrake + parkingBrakeForce;
    const mass = 2800000; const resistance = 24000 + 60 * s.speed + 2 * s.speed * s.speed;
    const acceleration = (s.tractionForce - s.brakeForce - resistance) / mass;
    const actual = s.speed <= 0 && acceleration < 0 ? 0 : acceleration;
    s.speed = clamp(s.speed + actual * dt * 3.6, 0, 120); s.distance += s.speed / 3.6 * dt;
    s.maxAcceleration = Math.max(s.maxAcceleration, Math.abs(actual)); s.maxJerk = Math.max(s.maxJerk, Math.abs((actual - s.lastAcceleration) / Math.max(dt, .01))); s.lastAcceleration = actual;
    this.emit();
  }
}
