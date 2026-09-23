import { TrainSimulation } from './dynamics.js?rev=simple-brake-test-v1-20260922';
import { MstsRouteScene } from './mstsRouteScene.js?rev=texture-case-v9-20260922';
import { createSimpleBrakeAttempt, EXHAUST_ANSWER_LABELS, SCENARIO_OPTIONS, EXAM_KEY } from './brakeTestScenarios.js';
import { BrakeTestWorkflow } from './brakeTestWorkflow.js';
import { buildBrakeTestRecord, formatRecordText, buildRecordHtml } from './brakeTestRecord.js';

const $ = (q) => document.querySelector(q);
// CIR（机车综合无线通信设备）在正面驾驶台上的热区，单位与其它部件一致（640×480 设计坐标）。
// 范围卡在左侧显示单元的屏幕区域：下沿 324 必须小于自阀 sprite 的 341 与自阀触控区的 326，
// 否则会盖住自阀导致拖不动。与实物位置不符时只改这一处即可。
const CIR_HOTSPOT = { x: 4, y: 246, w: 112, h: 78 };
// 场景可在运行中切换（教师指定 / 考核抽考），因此 attempt、sim、workflow 都是可替换的。
let attempt = createSimpleBrakeAttempt(location.search);
let sim = new TrainSimulation(attempt);
let workflow = new BrakeTestWorkflow(attempt);
const overlay = $('#overlay');
const routeScene = new MstsRouteScene($('#route-scene'));
const views = { front: 'HXD1C_front.png', left: 'HXD1C_left_full.png', right: 'HXD1C_right_full.png' };
const debugMode = new URLSearchParams(location.search).get('debug') === '1';
const keys = [['lkj','LKJ确认'],['panto','前受电弓'],['main-breaker','主断合'],['compressor','压缩机'],['parking','停放缓解'],['authority','信号确认'],['headlight','前照灯'],['horn','风笛'],['reset','警惕/复位']];
let selectedView = 'front';
let activeDrag = null;
let hornPointerId = null;
let switchPanelRoot = null;
let switchPanelMessageTimer = null;
let powerCabinetRoot = null;
let lkjRoot = null;
const hornAudio = new Audio('./assets/audio/HXD1C-horn.wav');
hornAudio.preload = 'auto'; hornAudio.loop = true;
const lkjKeyAudio = new Audio('./assets/audio/lkj-key.wav');
const lkjStartAudio = new Audio('./assets/audio/lkj-start.wav');
const switchDefs = [
  { id:'main-breaker', label:'主断路器', type:'short', x:15.6, read:s=>s.mainBreaker, on:'合', off:'分', directional:true },
  { id:'panto', label:'受电弓', type:'short', x:24.1, read:s=>s.panto, on:'升', off:'降', directional:true },
  { id:'compressor', label:'空压机', type:'long', x:32.5, read:s=>s.compressor, on:'投入', off:'停止', directional:true },
  { id:'headlight', label:'前照灯', type:'round', x:40.6, read:s=>s.headlight, on:'开', off:'关' },
  { id:'auxiliary-light', label:'辅照灯', type:'slider', x:51.8, read:s=>s.auxiliaryLight, on:'全', off:'0' },
  { id:'marker-front', label:'标志灯（前）', type:'short', x:63.0, read:s=>s.markerFront, states:['0','white','red'] },
  { id:'marker-rear', label:'标志灯（后）', type:'short', x:72.2, read:s=>s.markerRear, states:['0','white','red'] },
  { id:'cab-light', label:'司机室灯', type:'long', x:81.5, read:s=>s.cabLight, on:'开', off:'关' },
];
const pct = (value,total) => `${value / total * 100}%`;
function frame(el, index, cols, rows) { const col = index % cols; const row = Math.floor(index / cols); el.style.backgroundPosition = `${cols === 1 ? 0 : col / (cols - 1) * 100}% ${rows === 1 ? 0 : row / (rows - 1) * 100}%`; }
function makeSprite(id, image, x, y, w, h, cols, rows, label) { const el=document.createElement('div'); el.className=`sprite ${id}`; el.dataset.id=id; el.title=label; el.style.left=pct(x,640); el.style.top=pct(y,480); el.style.width=pct(w,640); el.style.height=pct(h,480); el.style.backgroundImage=`url("./assets/archive-cabview/${image}")`; el.style.backgroundSize=`${cols*100}% ${rows*100}%`; overlay.append(el); return el; }
function makeTouchTarget(id, x, y, w, h, label) { const el=document.createElement('button'); el.type='button'; el.className=`touch-target ${id==='direction'?'direction-target':''}`; el.dataset.dragTarget=id; el.setAttribute('aria-label',label); el.style.left=pct(x,640); el.style.top=pct(y,480); el.style.width=pct(w,640); el.style.height=pct(h,480); overlay.append(el); return el; }
function makeHotspot(id,label,x,y,w,h) { const el=document.createElement('button'); el.className='hotspot'; el.dataset.id=id; el.dataset.label=label; el.style.left=pct(x,640); el.style.top=pct(y,480); el.style.width=pct(w,640); el.style.height=pct(h,480); el.addEventListener('click',()=>command(id)); overlay.append(el); return el; }
function makePhysicalButton(id,label,x,y,w,h,action) { const el=document.createElement('button'); el.type='button'; el.className=`physical-control-hotspot ${id}`; el.dataset.label=label; el.setAttribute('aria-label',label); el.style.left=pct(x,640); el.style.top=pct(y,480); el.style.width=pct(w,640); el.style.height=pct(h,480); if(action)action(el); else el.addEventListener('click',()=>command(id)); overlay.append(el); return el; }
function makeNeedle(id,image,x,y,w,h,pivot,start,end,kind='') { const el=document.createElement('img'); el.className=`needle ${kind}`; el.dataset.id=id; el.dataset.start=start; el.dataset.end=end; el.src=`./assets/archive-cabview/${image}`; el.alt=''; el.style.left=pct(x,640); el.style.top=pct(y,480); el.style.width=pct(w,640); el.style.height=pct(h,480); el.style.transformOrigin=`50% ${pivot / h * 100}%`; overlay.append(el); return el; }
function makeBar(id,x,y,w,h,color='#5dffd5') { const el=document.createElement('div'); el.className='gauge-bar'; el.dataset.id=id; el.style.left=pct(x,640); el.style.top=pct(y,480); el.style.width=pct(w,640); el.style.height=pct(h,480); el.style.background=color; overlay.append(el); return el; }
function makeDigital(id,x,y,w,h,kind='') { const el=document.createElement('div'); el.className=`digital ${kind}`; el.dataset.id=id; el.style.left=pct(x,640); el.style.top=pct(y,480); el.style.width=pct(w,640); el.style.height=pct(h,480); overlay.append(el); return el; }
function makePositionBadge(id,label,x,y,w=82) { const el=document.createElement('div');el.className='control-position-badge';el.dataset.positionId=id;el.style.left=pct(x,640);el.style.top=pct(y,480);el.style.width=pct(w,640);el.innerHTML=`<b>${label}</b><span>—</span>`;overlay.append(el);return el; }
function makeStateSprite(id,image,x,y,w,h,cols,rows) { const el=document.createElement('div'); el.className=id==='signal'?'signal-sprite':'panto-sprite'; el.dataset.id=id; el.style.left=pct(x,640); el.style.top=pct(y,480); el.style.width=pct(w,640); el.style.height=pct(h,480); el.style.backgroundImage=`url("./assets/archive-cabview/${image}")`; el.style.backgroundSize=`${cols*100}% ${rows*100}%`; overlay.append(el); return el; }
function setNeedle(el,value,max) { const safe=Number.isFinite(Number(value))?Number(value):0;const ratio=Math.max(0,Math.min(1,safe/max)); const start=Number(el.dataset.start); const end=Number(el.dataset.end); el.style.transform=`rotate(${start+(end-start)*ratio}deg)`; }
// 原贴图从前推端到后拉端依次为：牵引最大(frame 0) → 零位(frame 7) → 电制动最大(frame 15)。
function tractionFrame(value) { return value > 0 ? Math.max(0,7-Math.min(7,value)) : value === 0 ? 7 : Math.min(15,7+Math.min(8,Math.abs(value))); }
let elements={};
function startDrag(id, el, event) {
  event.preventDefault();
  // 自阀按"一次拖动=一次操作"计次；拖动必然经过中间档位，不能按档位变化计数。
  if(id==='auto')workflow.noteAutoBrakeDrag();
  const range=id==='traction'?15:5;
  activeDrag={id,pointerId:event.pointerId,startY:event.clientY,start:sim.state[id==='auto'?'autoBrake':id==='independent'?'independentBrake':'traction'],pixelsPerStep:Math.max(8,el.getBoundingClientRect().height/range)};
  try{event.currentTarget.setPointerCapture?.(event.pointerId);}catch{ /* 部分 iOS WebKit 不开放指针捕获，窗口级监听仍可完成拖动。 */ }
}
function createFront() {
  overlay.replaceChildren(); elements={};
  elements.auto=makeSprite('auto-brake','HXD1C_DZ.png',35,341,45,60,4,3,'自动制动阀（拖动）');
  elements.independent=makeSprite('independent-brake','HXD1C_XZ.png',138,341,35,60,4,3,'单独制动阀（拖动）');
  elements.traction=makeSprite('traction','HXD1C_GL.png',464,345,46,81,2,8,'牵引/电制动手柄（拖动）');
  elements.direction=makeSprite('direction','HXD1C_HX.png',530,366,60,40,3,1,'方向手柄（点击切换）'); elements.direction.classList.add('direction'); elements.direction.addEventListener('click',()=>command('direction'));
  // 原 CVF 没有为中部板钮定义鼠标热区；不再用猜测坐标冒充真实按钮。
  // 电气与辅助设备通过右侧经过命名校验的操作按钮控制，车内只保留 CVF 明确定义的复位热区。
  elements.reset=makeHotspot('reset','警惕/复位',386,312,32,32);
  // 驾驶台上的 CIR 装置：点它打开列尾风压查询（现实中也由 CIR 查询列尾）。
  const cirButton=document.createElement('button');
  cirButton.type='button';cirButton.className='cir-hotspot';cirButton.id='cir-hotspot';
  cirButton.setAttribute('aria-label','CIR 列尾风压查询');
  cirButton.style.left=pct(CIR_HOTSPOT.x,640);cirButton.style.top=pct(CIR_HOTSPOT.y,480);
  cirButton.style.width=pct(CIR_HOTSPOT.w,640);cirButton.style.height=pct(CIR_HOTSPOT.h,480);
  cirButton.addEventListener('click',(event)=>{event.preventDefault();event.stopPropagation();openCir();});
  overlay.append(cirButton);
  makePhysicalButton('lkj-trigger','放大 LKJ 监控装置',210,226,101,94,(el)=>el.addEventListener('click',openLkj));
  elements.parkingApply=makePhysicalButton('parking-apply','停放制动施加（红）',157,350,21,29);
  elements.parkingRelease=makePhysicalButton('parking-release','停放制动缓解（绿）',179,350,22,29);
  elements.hornButton=makePhysicalButton('horn-button','风笛（按住）',577,408,37,39,(el)=>{
    el.addEventListener('pointerdown',(event)=>{event.preventDefault();hornPointerId=event.pointerId;el.classList.add('pressed');command('horn-start');hornAudio.currentTime=0;hornAudio.play().catch(()=>{});try{el.setPointerCapture(event.pointerId);}catch{}});
  });
  elements.autoPosition=makePositionBadge('auto','自阀',20,321,80);
  elements.independentPosition=makePositionBadge('independent','单阀',118,321,76);
  elements.tractionPosition=makePositionBadge('traction','牵引手柄',438,323,86);
  elements.directionPosition=makePositionBadge('direction','换向手柄',521,342,88);
  const switchPanelTrigger=document.createElement('button');
  switchPanelTrigger.type='button';switchPanelTrigger.className='switch-panel-trigger';switchPanelTrigger.setAttribute('aria-label','放大中部板钮面板');
  switchPanelTrigger.style.left=pct(232,640);switchPanelTrigger.style.top=pct(337,480);switchPanelTrigger.style.width=pct(165,640);switchPanelTrigger.style.height=pct(43,480);
  switchPanelTrigger.addEventListener('click',(event)=>{event.preventDefault();openSwitchPanel();});overlay.append(switchPanelTrigger);
  // 原 CVF 中的动态指针：两套风压表、速度表、网压与四路电流条。
  elements.speedNeedle=makeNeedle('speed-needle','HXD1C_SDZ.png',493,277,3,18,2,68,300,'speed');
  elements.mainNeedle=makeNeedle('main-needle','HXD1C_red.png',154,253,7,21,14,230,100);
  elements.pipeNeedle=makeNeedle('pipe-needle','HXD1C_black.png',154,253,7,21,14,230,130);
  elements.eqNeedle=makeNeedle('eq-needle','HXD1C_black.png',162,295,7,21,14,224,136);
  elements.cylNeedle=makeNeedle('cyl-needle','HXD1C_red.png',162,295,7,21,14,230,130);
  elements.mainNeedle2=makeNeedle('main-needle-2','HXD1C_PPW.png',75,299,7,18,1,3,358);
  elements.pipeNeedle2=makeNeedle('pipe-needle-2','HXD1C_PPR.png',75,299,7,18,1,3,336);
  elements.eqNeedle2=makeNeedle('eq-needle-2','HXD1C_PPW.png',36,312,7,18,1,3,336);
  elements.cylNeedle2=makeNeedle('cyl-needle-2','HXD1C_PPR.png',36,312,7,18,1,3,300);
  elements.voltageBar=makeBar('voltage-bar',351,266,4,30,'#56e9aa');
  elements.currentBars=[makeBar('current-1',362,266,4,30),makeBar('current-2',370,266,4,30),makeBar('current-3',381,266,4,30),makeBar('current-4',388,266,4,30)];
  elements.speedDigital=makeDigital('speed-digital',229,251,20,7);
  elements.limitDigital=makeDigital('limit-digital',244,251,20,7,'limit');
  elements.clockDigital=makeDigital('clock-digital',230,268,45,10,'clock');
  elements.pantoDisplay=makeStateSprite('panto','HXD1C_DG.png',410,295,7,8,1,2);
  elements.signal=makeStateSprite('signal','HXD1C_jx.png',540,0,100,162,4,2);
  for(const [id,el] of [['auto',elements.auto],['independent',elements.independent],['traction',elements.traction]]) el.addEventListener('pointerdown',(event)=>startDrag(id,el,event));
  // 原图控件保持原比例，另加透明的大触控区，避免手机上手指遮住并按不中小手柄。
  const touchControls=[
    ['auto',elements.auto,23,326,70,91,'拖动自动制动阀'],
    ['independent',elements.independent,122,326,66,91,'拖动单独制动阀'],
    ['traction',elements.traction,447,326,80,116,'拖动牵引和电制动手柄'],
  ];
  for(const [id,target,x,y,w,h,label] of touchControls){const zone=makeTouchTarget(id,x,y,w,h,label);zone.addEventListener('pointerdown',(event)=>startDrag(id,target,event));}
  const directionZone=makeTouchTarget('direction',516,350,88,70,'切换方向手柄');
  directionZone.addEventListener('click',(event)=>{event.preventDefault();command('direction');});
  elements.traction.addEventListener('dblclick',(event)=>{event.preventDefault();command('traction',0);});
}
function command(id,value) {
  const s=sim.state;
  if(id==='direction'&&value===undefined)value=s.direction==='N'?'F':s.direction==='F'?'R':'N';
  const gate=workflow.guardCommand(id,value);
  if(!gate.allowed)return sim.reject(gate.message);
  const accepted=sim.command(id,value);
  if(accepted)workflow.afterCommand(id,value,sim.state);
  return accepted;
}
function buildPowerCabinet(){
  const root=document.createElement('div');root.className='device-modal power-cabinet-modal';root.setAttribute('aria-hidden','true');
  root.innerHTML=`<div class="device-shell power-cabinet-shell" role="dialog" aria-modal="true" aria-label="HXD1C控制电源柜"><div class="device-head"><div><strong>HXD1C 控制电源柜</strong><span>按发车准备要求依次接通三项电源</span></div><button type="button" class="device-close" aria-label="关闭">×</button></div><div class="cabinet-face"><div class="cabinet-meter"><span>控制电压</span><b data-cabinet-voltage>0 V</b></div><div class="cabinet-lamps"><i data-lamp="110"></i><span>110V</span><i data-lamp="24"></i><span>24V</span></div><div class="cabinet-switches"></div><p class="cabinet-note">三项均接通后，司机室控制电源才建立。任何一项断开，主断与空压机均退出。</p></div></div>`;
  const defs=[['controlPowerOutput','控制电源输出'],['parkingPower','停放制动电源'],['output24V','24V 输出']];
  const box=root.querySelector('.cabinet-switches');
  for(const [key,label] of defs){const b=document.createElement('button');b.type='button';b.className='cabinet-switch';b.dataset.powerKey=key;b.innerHTML=`<span class="cabinet-toggle"><i></i></span><strong>${label}</strong><em>断开</em>`;b.addEventListener('click',()=>{const accepted=command('power-cabinet-switch',{key,enabled:!sim.state[key]});if(accepted)navigator.vibrate?.(18);syncPowerCabinet(sim.state);});box.append(b);}
  root.querySelector('.device-close').addEventListener('click',closePowerCabinet);root.addEventListener('click',(event)=>{if(event.target===root)closePowerCabinet();});document.body.append(root);powerCabinetRoot=root;syncPowerCabinet(sim.state);
}
function syncPowerCabinet(state){if(!powerCabinetRoot)return;for(const b of powerCabinetRoot.querySelectorAll('.cabinet-switch')){const on=Boolean(state[b.dataset.powerKey]);b.classList.toggle('on',on);b.querySelector('em').textContent=on?'接通':'断开';b.setAttribute('aria-pressed',String(on));}powerCabinetRoot.querySelector('[data-cabinet-voltage]').textContent=state.powerOn?'110 V':'0 V';powerCabinetRoot.querySelector('[data-lamp="110"]').classList.toggle('on',state.controlPowerOutput&&state.parkingPower);powerCabinetRoot.querySelector('[data-lamp="24"]').classList.toggle('on',state.output24V);}
function openPowerCabinet(){if(!powerCabinetRoot)buildPowerCabinet();closeLkj();closeSwitchPanel();powerCabinetRoot.classList.add('open');powerCabinetRoot.setAttribute('aria-hidden','false');document.body.classList.add('device-panel-active');syncPowerCabinet(sim.state);}
function closePowerCabinet(){if(!powerCabinetRoot)return;powerCabinetRoot.classList.remove('open');powerCabinetRoot.setAttribute('aria-hidden','true');document.body.classList.remove('device-panel-active');}

const lkjFields=[['driverId','司机号'],['assistantId','副司机号'],['section','区段号'],['station','车站号'],['trainNo','车次'],['trainType','列车种类'],['weight','总重（t）'],['cars','辆数'],['length','计长']];
const lkjKeyDefs=[
  ['alarm','警惕',134,532,52,57],['unlock','解锁',187,510,50,40],['relief','缓解',187,550,50,40],
  ['digit-1','向前／1',238,510,51,40],['digit-6','向后／6',238,550,51,40],['digit-2','调车／2',290,510,51,40],['digit-7','开车／7',290,550,51,40],
  ['digit-3','车位／3',343,510,51,40],['digit-8','自动校正／8',343,550,51,40],['digit-4','进路号／4',395,510,51,40],['digit-9','出入库／9',395,550,51,40],
  ['digit-5','定标／5',447,510,51,40],['digit-0','巡检／0',447,550,51,40],['query','查询',499,510,53,40],['left','左箭头／删除',499,550,53,40],
  ['up','上箭头',553,510,51,40],['down','下箭头',553,550,51,40],['dump','转储',604,510,50,40],['right','右箭头／确认',604,550,50,40],
];
let lkjDraft={};let lkjFieldIndex=0;let lkjPhase='boot';let lkjNotice='';
function buildLkj(){
  const root=document.createElement('div');root.className='device-modal lkj-modal';root.setAttribute('aria-hidden','true');
  root.innerHTML=`<div class="device-shell lkj-shell" role="dialog" aria-modal="true" aria-label="LKJ2000监控装置"><div class="device-head"><div><strong>LKJ2000 监控装置</strong><span>输入参数并核对运行揭示</span></div><button type="button" class="device-close" aria-label="关闭">×</button></div><div class="lkj-device"><img src="./assets/lkj/LKJ2000.png" alt="LKJ2000设备面板"><div class="lkj-screen"></div><div class="lkj-keypad"></div></div></div>`;
  root.querySelector('.device-close').addEventListener('click',closeLkj);root.addEventListener('click',(event)=>{if(event.target===root)closeLkj();});
  const keypad=root.querySelector('.lkj-keypad');
  for(const [id,label,x,y,w,h] of lkjKeyDefs){const button=document.createElement('button');button.type='button';button.dataset.lkjKey=id;button.setAttribute('aria-label',label);button.style.left=pct(x,800);button.style.top=pct(y,600);button.style.width=pct(w,800);button.style.height=pct(h,600);const release=()=>button.classList.remove('pressed');button.addEventListener('pointerdown',()=>button.classList.add('pressed'));button.addEventListener('pointerup',release);button.addEventListener('pointercancel',release);button.addEventListener('pointerleave',release);button.addEventListener('click',()=>handleLkjKey(id));keypad.append(button);}
  document.body.append(root);lkjRoot=root;renderLkj();
}
function playLkjKey(){try{lkjKeyAudio.currentTime=0;lkjKeyAudio.play().catch(()=>{});}catch{}}
function flashLkj(message){lkjNotice=message;renderLkj();const screen=lkjRoot?.querySelector('.lkj-screen');screen?.classList.add('error');setTimeout(()=>{if(lkjNotice===message){lkjNotice='';renderLkj();}},900);}
function handleLkjKey(id){
  playLkjKey();navigator.vibrate?.(12);
  if(sim.state.lkjConfirmed){if(id==='query')lkjPhase='review';else if(lkjPhase==='review'&&(id==='left'||id==='relief'||id==='right'))lkjPhase='done';renderLkj();return;}
  if(lkjPhase==='boot'){if(id==='query'||id==='right'){lkjPhase='edit';lkjFieldIndex=0;renderLkj();}else flashLkj('请按【查询】进入参数设定');return;}
  if(lkjPhase==='edit'){
    const [key]=lkjFields[lkjFieldIndex];const value=lkjDraft[key]||'';const digit=id.startsWith('digit-')?id.slice(6):'';
    if(digit){if(value.length<10)lkjDraft[key]=value+digit;renderLkj();return;}
    if(id==='left'){lkjDraft[key]=value.slice(0,-1);renderLkj();return;}
    if(id==='unlock'){lkjDraft[key]='';renderLkj();return;}
    if(id==='up'||id==='relief'){lkjFieldIndex=Math.max(0,lkjFieldIndex-1);renderLkj();return;}
    if(id==='down'){lkjFieldIndex=Math.min(lkjFields.length-1,lkjFieldIndex+1);renderLkj();return;}
    if(id==='query'){if(lkjFields.some(([field])=>!lkjDraft[field]))flashLkj('参数尚未填写完整');else{lkjPhase='review';renderLkj();}return;}
    if(id==='right'){if(!value){flashLkj('本项不能为空');return;}if(lkjFieldIndex<lkjFields.length-1)lkjFieldIndex+=1;else lkjPhase='review';renderLkj();return;}
    flashLkj('当前为参数输入状态');return;
  }
  if(lkjPhase==='review'){if(id==='left'||id==='up'||id==='relief'){lkjPhase='edit';renderLkj();return;}if(id==='right'||id==='query'){lkjPhase='reveal';renderLkj();return;}flashLkj('按【→】进入揭示核对');return;}
  if(lkjPhase==='reveal'){if(id==='left'||id==='relief'){lkjPhase='review';renderLkj();return;}if(id==='right'||id==='query'||id==='digit-7'){if(command('lkj-confirm',lkjDraft)){lkjPhase='done';renderLkj();}return;}flashLkj('按【→】确认运行揭示');}
}
function renderLkj(){
  if(!lkjRoot)return;const screen=lkjRoot.querySelector('.lkj-screen');
  if(sim.state.lkjConfirmed&&lkjPhase!=='review'){screen.innerHTML=`<b>监控状态</b><span>车次 ${sim.state.lkjData?.trainNo||'—'}　揭示已确认</span><strong class="lkj-ok">LKJ 监控投入</strong><span class="lkj-help">按【查询】查看已设参数</span>`;return;}
  if(lkjPhase==='boot'){screen.innerHTML='<b>LKJ2000</b><span>设备自检正常</span><strong>按【查询】进入参数设定</strong><span class="lkj-help">使用显示器下方实体键操作</span>';return;}
  if(lkjPhase==='edit'){
    const [key,label]=lkjFields[lkjFieldIndex];const value=lkjDraft[key]||'';screen.innerHTML=`<b>参数输入 ${lkjFieldIndex+1}/${lkjFields.length}</b><span>${label}</span><strong class="lkj-input">${value||'_'}</strong>`;
    screen.insertAdjacentHTML('beforeend',`<span class="lkj-help">数字键输入　【←】删除　【↑↓】换项　【→】确认${lkjNotice?`<br>${lkjNotice}`:''}</span>`);return;
  }
  if(lkjPhase==='review'){screen.innerHTML=`<b>参数核对</b><div class="lkj-review">${lkjFields.map(([key,label])=>`<span>${label}</span><strong>${lkjDraft[key]||'—'}</strong>`).join('')}</div><span class="lkj-help">【←】返回修改　【→】进入揭示核对${lkjNotice?`<br>${lkjNotice}`:''}</span>`;return;}
  screen.innerHTML=`<b>运行揭示查询</b><span>揭示条目 3 条，已完成核对</span><strong>按【→】确认并投入监控</strong><span class="lkj-help">【←】返回参数${lkjNotice?`<br>${lkjNotice}`:''}</span>`;
}
function openLkj(){if(!lkjRoot)buildLkj();closeSwitchPanel();lkjPhase=sim.state.lkjConfirmed?'done':'boot';lkjDraft=sim.state.lkjData&&!sim.state.lkjData.debug?{...sim.state.lkjData}:{};lkjRoot.classList.add('open');lkjRoot.setAttribute('aria-hidden','false');document.body.classList.add('device-panel-active');lkjStartAudio.currentTime=0;lkjStartAudio.play().catch(()=>{});renderLkj();}
function closeLkj(){if(!lkjRoot)return;lkjRoot.classList.remove('open');lkjRoot.setAttribute('aria-hidden','true');document.body.classList.remove('device-panel-active');}
function closeDevicePanels(){closeRecordModal();closeCir();closeSwitchPanel();closePowerCabinet();closeLkj();if(hornPointerId!==null)stopHorn();else{hornAudio.pause();hornAudio.currentTime=0;if(sim.state.hornActive)command('horn-stop');}}
function buildSwitchPanel(){
  const root=document.createElement('div');root.id='switch-panel-modal';root.className='switch-panel-modal';root.setAttribute('aria-hidden','true');
  root.innerHTML=`<div class="switch-panel-shell" role="dialog" aria-modal="true" aria-label="HXD1C板钮面板"><div class="switch-panel-head"><div><strong>板钮面板</strong><span>点击上半区或下半区拨动，板钮保持在所选位置</span></div><button type="button" class="switch-panel-close" aria-label="关闭板钮面板">×</button></div><div class="switch-panel-photo"><img src="./assets/switch-panel/HXD1C-switch-panel-reference.jpg" alt="HXD1C板钮面板实物参考" /><div class="switch-panel-controls"></div></div><div class="switch-panel-status">主断：上合/下分；受电弓：上升/下降；空压机：上投入/下停止。</div></div>`;
  const controls=root.querySelector('.switch-panel-controls');
  for(const def of switchDefs){
    const button=document.createElement('button');button.type='button';button.className=`switch-unit type-${def.type}`;button.dataset.switchId=def.id;button.style.setProperty('--switch-x',def.x);button.setAttribute('aria-label',def.label);
    button.innerHTML=`<span class="switch-mask"><span class="switch-slot"></span><span class="switch-lever"><i></i></span></span><span class="switch-name">${def.label}</span><span class="switch-value">0</span>`;
    button.addEventListener('click',(event)=>operateSwitch(def,button,event));controls.append(button);
  }
  root.querySelector('.switch-panel-close').addEventListener('click',closeSwitchPanel);
  root.addEventListener('click',(event)=>{if(event.target===root)closeSwitchPanel();});
  document.body.append(root);switchPanelRoot=root;syncSwitchPanel(sim.state);
}
function setSwitchPanelMessage(message=''){
  if(!switchPanelRoot)return;const status=switchPanelRoot.querySelector('.switch-panel-status');if(!status)return;
  const normal='主断：上合/下分；受电弓：上升/下降；空压机：上投入/下停止。';
  status.textContent=message||normal;status.classList.toggle('message',Boolean(message));clearTimeout(switchPanelMessageTimer);if(message)switchPanelMessageTimer=setTimeout(()=>{status.textContent=normal;status.classList.remove('message');},2600);
}
function openSwitchPanel(){if(selectedView!=='front')return;if(!switchPanelRoot)buildSwitchPanel();switchPanelRoot.classList.add('open');switchPanelRoot.setAttribute('aria-hidden','false');document.body.classList.add('switch-panel-active');syncSwitchPanel(sim.state);}
function closeSwitchPanel(){if(!switchPanelRoot)return;switchPanelRoot.classList.remove('open');switchPanelRoot.setAttribute('aria-hidden','true');document.body.classList.remove('switch-panel-active');}
function operateSwitch(def,button,event){
  const state=sim.state;let targetUp=true;let accepted=true;
  if(def.states){const current=def.read(state);const next=def.states[(def.states.indexOf(current)+1)%def.states.length];targetUp=next==='white';accepted=command(def.id,next);}
  else if(def.directional){const rect=button.getBoundingClientRect();targetUp=event?.clientY?event.clientY<rect.top+rect.height/2:!Boolean(def.read(state));accepted=command(def.id,targetUp);}
  else{targetUp=!Boolean(def.read(state));accepted=command(def.id,targetUp);}
  button.classList.remove('throw-up','throw-down','rejected');void button.offsetWidth;button.classList.add(targetUp?'throw-up':'throw-down');
  if(accepted===false)button.classList.add('rejected');
  setTimeout(()=>button.classList.remove('throw-up','throw-down','rejected'),260);syncSwitchPanel(sim.state);
  navigator.vibrate?.(accepted===false?[30,35,30]:18);
}
function syncSwitchPanel(state){
  if(!switchPanelRoot)return;
  for(const def of switchDefs){const button=switchPanelRoot.querySelector(`[data-switch-id="${def.id}"]`);if(!button)continue;const value=def.read(state);button.classList.remove('state-up','state-mid','state-down');let label='0';if(def.states){label=value==='white'?'白':value==='red'?'红':'0';button.classList.add(value==='white'?'state-up':value==='red'?'state-down':'state-mid');}else{const on=Boolean(value);label=on?def.on:def.off;button.classList.add(on?'state-up':'state-down');}button.querySelector('.switch-value').textContent=label;button.setAttribute('aria-pressed',String(Boolean(value&&value!=='0')));}
}
function bindDrag() { addEventListener('pointermove',(event)=>{ if(!activeDrag||(activeDrag.pointerId!==undefined&&event.pointerId!==activeDrag.pointerId))return; event.preventDefault(); const d=activeDrag; const delta=Math.round((d.startY-event.clientY)/d.pixelsPerStep); if(d.id==='traction')command('traction',Math.max(-8,Math.min(7,d.start+delta))); else command(d.id==='auto'?'auto-brake':'independent-brake',Math.max(0,Math.min(5,d.start+delta))); },{passive:false}); addEventListener('pointerup',(event)=>{if(!activeDrag||activeDrag.pointerId===event.pointerId)activeDrag=null}); addEventListener('pointercancel',(event)=>{if(!activeDrag||activeDrag.pointerId===event.pointerId)activeDrag=null}); }
function activeState(id,state) { return Boolean(state[id==='panto'?'panto':id==='main-breaker'?'mainBreaker':id==='control-power'?'powerOn':id==='parking'?'parkingBrake':id==='headlight'?'headlight':id==='compressor'?'compressor':id==='authority'?'authority':id==='horn'?'hornActive':id==='lkj'?'lkjConfirmed':id==='reset'?'vigilanceAcknowledged':false]); }
function renderTraining(state,message='') {
  const steps=workflow.getSteps(state);const current=steps.findIndex(step=>!step.done);
  const conclusion=workflow.getConclusion(state);
  $('#procedure').innerHTML=steps.map((step,index)=>`<li class="${step.done?'done':index===current?'active current':'blocked'}">${step.label}</li>`).join('');
  const a=attempt;const holdRemaining=Math.max(0,a.holdDuration-workflow.holdElapsed);const holdPercent=Math.min(100,workflow.holdElapsed/a.holdDuration*100);
  // 结论与流程进度分开表达：流程走完不等于试验合格（排风时间异常属于"走完但不合格"）。
  const stateLabel=workflow.phase==='COMPLETE'
    ?(conclusion.pass?'<span class="training-complete">试验合格</span>':'<span class="training-failed">试验完成 · 结论不合格</span>')
    :workflow.phase==='FAILED'?'<span class="training-failed">试验不合格</span>'
    :`第 ${Math.max(1,current+1)} 步`;
  // 风压改成画面下层的一排常显条：手机全屏、抽屉收起时也一定看得到。
  $('#pb-main').textContent=state.mainRes.toFixed(0);
  $('#pb-equalizing').textContent=state.equalizingRes.toFixed(0);
  $('#pb-train').textContent=state.trainPipe.toFixed(0);
  $('#pb-tail').textContent=state.tailPipe.toFixed(0);
  $('#pb-cyl').textContent=state.brakeCyl.toFixed(0);
  $('#pb-hold').textContent=workflow.phase==='HOLD'?holdRemaining.toFixed(0)+' s':'—';
  // 数值已移到下方风压条，抽屉里只留结论状态与保压进度。
  $('#status').innerHTML=`<strong>状态：</strong>${stateLabel}<div class="hold-progress" style="--hold-progress:${holdPercent}%"><i></i></div>`;
  // 考核模式下不告知注入了哪种故障，只给编组与压力这类学员本来就该知道的信息。
  const summaryTitle=a.exam?'考核模式 · 本轮场景不告知':a.title;
  $('#attempt-summary').innerHTML=`<strong>${summaryTitle}</strong><br>编组 ${a.formationCars} 辆 · 定压 ${a.nominalTrainPipe} kPa · 目标 ${a.targetTrainPipe} kPa${a.debugFast?'<br><span class="tag">调试模式：保压时间已缩短</span>':''}`;
  const observation=$('#observation');const latest=workflow.tailReleaseQuery||workflow.tailBrakeQuery;
  if(latest){observation.innerHTML=`最近列尾查询：机车端 <b>${latest.head.toFixed(0)}</b> kPa，尾部 <b>${latest.tail.toFixed(0)}</b> kPa，差值 <b>${latest.pressureDifference.toFixed(0)}</b> kPa。<br>${latest.passed?'压力变化对应，列车管贯通。':'压力尚未正常跟随，需要重新查询。'}`;observation.className=`observation ${latest.passed?'pass':'warn'}`;}
  else if(Number.isFinite(workflow.exhaustSeconds)){observation.innerHTML=`本次列车管减压耗时 <b>${workflow.exhaustSeconds.toFixed(1)} 秒</b>。请根据编组和排风时间表完成判断。`;observation.className='observation';}
  else{observation.textContent='尚无测量结果。完成100 kPa减压后将记录排风时间。';observation.className='observation';}
  // 试验操作台与 CIR 面板共用同一批列尾动作，启用条件必须一致，避免两处状态打架。
  const tailGate={
    judge:Number.isFinite(workflow.exhaustSeconds)&&workflow.phase!=='COMPLETE'&&workflow.phase!=='FAILED',
    queryBrake:workflow.phase==='HOLD',
    confirmBrake:workflow.phase==='HOLD'&&Boolean(workflow.tailBrakeQuery?.passed)&&!workflow.tailBrakeConfirmed,
    queryRelease:workflow.phase==='RELEASE'&&workflow.releaseStart!==null,
    confirmRelease:workflow.phase==='RELEASE'&&Boolean(workflow.tailReleaseQuery?.passed)&&!workflow.tailReleaseConfirmed,
  };
  $('#judge-exhaust').disabled=!tailGate.judge;
  $('#query-tail-brake').disabled=!tailGate.queryBrake;
  $('#confirm-tail-brake').disabled=!tailGate.confirmBrake;
  $('#query-tail-release').disabled=!tailGate.queryRelease;
  $('#confirm-tail-release').disabled=!tailGate.confirmRelease;
  $('#cir-query-brake').disabled=!tailGate.queryBrake;
  $('#cir-confirm-brake').disabled=!tailGate.confirmBrake;
  $('#cir-query-release').disabled=!tailGate.queryRelease;
  $('#cir-confirm-release').disabled=!tailGate.confirmRelease;
  renderCir(state);
  $('#open-record').disabled=!(workflow.phase==='COMPLETE'||workflow.phase==='FAILED');
  if(message||workflow.message)$('#hint').textContent=message||workflow.message;
  // 流程走完或中止时自动出单一次；结论不合格时把原因直接写到提示栏，避免"完成"被误读为"合格"。
  if(workflow.phase==='COMPLETE'||workflow.phase==='FAILED'){
    if(!conclusion.pass)$('#hint').textContent=`判定不合格：${conclusion.reasons.join('；')}。已生成试验记录单。`;
    if(!recordAutoShown){recordAutoShown=true;setTimeout(openRecordModal,420);}
  }
}
function render(state,message='') {
  routeScene.update(state.distance,state.speed,selectedView);
  if(selectedView==='front') {
    frame(elements.auto,[0,1,2,9,10,11][state.autoBrake],4,3); frame(elements.independent,Math.min(11,state.independentBrake),4,3); frame(elements.traction,tractionFrame(state.traction),2,8); frame(elements.direction,state.direction==='R'?0:state.direction==='N'?1:2,3,1);
    for(const [id] of keys) elements[id]?.classList.toggle('on',activeState(id,state));
    setNeedle(elements.speedNeedle,state.speed,158); setNeedle(elements.mainNeedle,state.mainRes,1600); setNeedle(elements.pipeNeedle,state.trainPipe,1000); setNeedle(elements.eqNeedle,state.equalizingRes,1600); setNeedle(elements.cylNeedle,state.brakeCyl,1600); setNeedle(elements.mainNeedle2,state.mainRes,1600); setNeedle(elements.pipeNeedle2,state.trainPipe,1600); setNeedle(elements.eqNeedle2,state.equalizingRes,1600); setNeedle(elements.cylNeedle2,state.brakeCyl,1600);
    const current=Math.max(0,state.traction)*105; elements.voltageBar.style.transform=`scaleY(${Math.max(.03,state.netVoltage/30)})`; elements.currentBars.forEach((bar,index)=>bar.style.transform=`scaleY(${Math.max(.02,Math.min(1,(current-index*22)/1000))})`);
    elements.speedDigital.textContent=Math.round(state.speed); elements.limitDigital.textContent='30'; elements.clockDigital.textContent=new Date().toLocaleTimeString('zh-CN',{hour12:false});
    const autoNames=['运转位','初制动位','常用制动Ⅱ','常用制动Ⅲ','常用制动Ⅳ','紧急位'];const independentNames=['缓解位','制动Ⅰ','制动Ⅱ','制动Ⅲ','制动Ⅳ','全制动位'];
    elements.autoPosition.querySelector('span').textContent=autoNames[state.autoBrake];elements.independentPosition.querySelector('span').textContent=independentNames[state.independentBrake];elements.directionPosition.querySelector('span').textContent=state.direction==='F'?'前进位':state.direction==='R'?'后退位':'中立位';elements.tractionPosition.querySelector('span').textContent=state.traction>0?`牵引 ${state.traction} 级`:state.traction<0?`电制动 ${Math.abs(state.traction)} 级`:'零位';
    frame(elements.pantoDisplay,state.panto?1:0,1,2); frame(elements.signal,state.authority?6:0,4,2);
  }
  for(const [id] of keys) document.querySelector(`#keys [data-id="${id}"]`)?.classList.toggle('active',activeState(id,state));
  syncSwitchPanel(state);
  if(message&&switchPanelRoot?.classList.contains('open'))setSwitchPanelMessage(message);
  syncPowerCabinet(state);
  renderTraining(state,message);
}
function stopHorn(event){if(hornPointerId===null)return;if(event?.pointerId!==undefined&&event.pointerId!==hornPointerId)return;hornPointerId=null;hornAudio.pause();hornAudio.currentTime=0;if(sim.state.hornActive)command('horn-stop');elements.hornButton?.classList.remove('pressed');}
function buildKeys(){if(!debugMode)return;document.body.classList.add('debug-mode');const root=$('#keys');keys.forEach(([id,name])=>{const b=document.createElement('button');b.dataset.id=id;b.textContent=name;b.addEventListener('click',()=>command(id));root.append(b);});}
function setView(view){closeDevicePanels();selectedView=view;const cab=$('#cab');cab.src=`./assets/archive-cabview/${views[view]}`;cab.classList.toggle('side-view',view!=='front');routeScene.setView(view);document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));if(view==='front')createFront();else overlay.replaceChildren();render(sim.state);}
const mobileLike=matchMedia('(pointer: coarse)').matches||navigator.maxTouchPoints>0||/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
if(mobileLike)document.body.classList.add('mobile-controls-enabled');
async function enterImmersive(){
  document.documentElement.classList.add('immersive');
  $('#landscape-gate').hidden=true;
  try{const root=document.documentElement;if(root.requestFullscreen)await root.requestFullscreen({navigationUI:'hide'});else if(root.webkitRequestFullscreen)await root.webkitRequestFullscreen();}catch{ /* iPhone Safari 常拒绝普通网页全屏，CSS 沉浸模式继续生效。 */ }
  try{await screen.orientation?.lock?.('landscape');}catch{ /* iOS 及部分浏览器不允许网页锁定方向。 */ }
  setTimeout(()=>{scrollTo(0,1);routeScene.resize();},120);
}
async function exitImmersive(){
  closeDevicePanels();
  try{if(document.fullscreenElement)await document.exitFullscreen();else if(document.webkitFullscreenElement)await document.webkitExitFullscreen();}catch{ /* CSS 状态仍可正常退出。 */ }
  document.documentElement.classList.remove('immersive');
  routeScene.resize();
}
function openAnswerModal(){
  if(!Number.isFinite(workflow.exhaustSeconds)){workflow.setMessage('排风时间尚未测得，不能答题。');return;}
  const expected=attempt.expectedExhaustSeconds;
  $('#answer-question').textContent=`本次列车编组 ${attempt.formationCars} 辆，列车管由 ${attempt.nominalTrainPipe} kPa 降至 ${attempt.targetTrainPipe} kPa，实测排风时间 ${workflow.exhaustSeconds.toFixed(1)} 秒。参考范围 ${expected.min}～${expected.max} 秒，请判断。`;
  $('#answer-feedback').textContent='';$('#answer-feedback').className='answer-feedback';
  $('#answer-modal').classList.add('open');$('#answer-modal').setAttribute('aria-hidden','false');document.body.classList.add('device-panel-active');
}
function closeAnswerModal(){$('#answer-modal').classList.remove('open');$('#answer-modal').setAttribute('aria-hidden','true');document.body.classList.remove('device-panel-active');}
$('#judge-exhaust').addEventListener('click',openAnswerModal);
$('#answer-close').addEventListener('click',closeAnswerModal);
$('#answer-modal').addEventListener('click',(event)=>{if(event.target===$('#answer-modal'))closeAnswerModal();});
document.querySelectorAll('[data-answer]').forEach(button=>button.addEventListener('click',()=>{const result=workflow.submitExhaustAnswer(button.dataset.answer);const feedback=$('#answer-feedback');if(!result.accepted)return;feedback.textContent=result.correct?'判断正确。':'判断不正确，请重新选择。';feedback.className=`answer-feedback ${result.correct?'ok':'error'}`;if(result.correct)setTimeout(closeAnswerModal,500);}));
let recordAutoShown=false;
function currentRecord(){return buildBrakeTestRecord({attempt,state:sim.state,workflow});}
function renderRecord(){
  const record=currentRecord();const html=buildRecordHtml(record);
  const sceneLine=record.header.exam
    ?`场景 <span class="tag">考核抽考</span> · 本轮实际注入：${record.header.scenario}`
    :`场景 ${record.header.scenario}`;
  $('#record-meta').innerHTML=`试验编号 ${record.header.attemptId}<br>${sceneLine} · 编组 ${record.header.formationCars} 辆 · 定压 ${record.header.nominalTrainPipe} kPa · 减压量 ${record.header.targetReduction} kPa<br>开始 ${record.header.createdAt} · 出单 ${record.header.generatedAt}${record.header.debugFast?'<br><span class="tag">调试模式：保压时间已缩短，不得作为正式记录</span>':''}`;
  $('#record-body').innerHTML=html.body;
  $('#record-conclusion').className=`record-conclusion ${record.conclusion.pass?'pass':'bad'}`;
  $('#record-conclusion').innerHTML=html.conclusion;
  $('#record-score').innerHTML=html.score;
  return record;
}
function openRecordModal(){renderRecord();$('#record-modal').classList.add('open');$('#record-modal').setAttribute('aria-hidden','false');document.body.classList.add('device-panel-active');}
function closeRecordModal(){const modal=$('#record-modal');if(!modal)return;modal.classList.remove('open');modal.setAttribute('aria-hidden','true');document.body.classList.remove('device-panel-active');}
$('#open-record').addEventListener('click',openRecordModal);
$('#record-close').addEventListener('click',closeRecordModal);
$('#record-modal').addEventListener('click',(event)=>{if(event.target===$('#record-modal'))closeRecordModal();});
$('#record-copy').addEventListener('click',async()=>{
  const button=$('#record-copy');const text=formatRecordText(currentRecord());
  try{
    if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(text);
    else{const area=document.createElement('textarea');area.value=text;area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();document.execCommand('copy');area.remove();}
    button.textContent='已复制到剪贴板';
  }catch{button.textContent='复制失败，请手动选择文本';}
  setTimeout(()=>{button.textContent='复制记录单文本';},1800);
});
$('#record-print').addEventListener('click',()=>window.print());

// ---------- CIR（机车综合无线通信设备）列尾查询面板 ----------
function renderCir(state){
  if(!$('#cir-modal'))return;
  const latest=(workflow.phase==='RELEASE'||workflow.phase==='COMPLETE')?workflow.tailReleaseQuery:workflow.tailBrakeQuery;
  $('#cir-head-value').textContent=Math.round(state.trainPipe)+' kPa';
  $('#cir-tail-value').textContent=Math.round(state.tailPipe)+' kPa';
  $('#cir-diff-value').textContent=Math.round(Math.abs(state.tailPipe-state.trainPipe))+' kPa';
  const verdict=$('#cir-verdict');
  if(latest){
    verdict.textContent=latest.passed
      ?`列尾查询通过：压差 ${Math.round(latest.pressureDifference)} kPa，列车管贯通。`
      :`列尾查询未通过：压差 ${Math.round(latest.pressureDifference)} kPa，尾部尚未正常跟随，请等待后重查。`;
    verdict.className=`cir-verdict ${latest.passed?'pass':'warn'}`;
  }else{
    verdict.textContent='尚未查询';
    verdict.className='cir-verdict';
  }
  $('#cir-hint').textContent=workflow.message||'按下方功能键查询列尾风压';
}
function openCir(){closeDevicePanels();renderCir(sim.state);$('#cir-modal').classList.add('open');$('#cir-modal').setAttribute('aria-hidden','false');document.body.classList.add('device-panel-active');}
function closeCir(){const modal=$('#cir-modal');if(!modal)return;modal.classList.remove('open');modal.setAttribute('aria-hidden','true');document.body.classList.remove('device-panel-active');}
$('#open-cir').addEventListener('click',openCir);
$('#cir-close').addEventListener('click',closeCir);
$('#cir-modal').addEventListener('click',(event)=>{if(event.target===$('#cir-modal'))closeCir();});
$('#cir-query-brake').addEventListener('click',()=>workflow.queryTail(sim.state,'brake'));
$('#cir-confirm-brake').addEventListener('click',()=>workflow.confirmTail('brake'));
$('#cir-query-release').addEventListener('click',()=>workflow.queryTail(sim.state,'release'));
$('#cir-confirm-release').addEventListener('click',()=>workflow.confirmTail('release'));

// ---------- 右侧可缩进抽屉（流程 / 操作台 / 教学场景） ----------
// 刻意不做全屏遮罩：抽屉打开时学员还要一边看流程一边操作驾驶台，遮罩会把整个驾驶台挡住。
function setDrawer(open){
  const drawer=$('#training-drawer');if(!drawer)return;
  drawer.classList.toggle('open',open);
  drawer.setAttribute('aria-hidden',String(!open));
  $('#drawer-toggle').setAttribute('aria-expanded',String(open));
}
$('#drawer-toggle').addEventListener('click',()=>setDrawer(!$('#training-drawer').classList.contains('open')));
addEventListener('keydown',(event)=>{if(event.key==='Escape')setDrawer(false);});
$('#query-tail-brake').addEventListener('click',()=>workflow.queryTail(sim.state,'brake'));
$('#confirm-tail-brake').addEventListener('click',()=>workflow.confirmTail('brake'));
$('#query-tail-release').addEventListener('click',()=>workflow.queryTail(sim.state,'release'));
$('#confirm-tail-release').addEventListener('click',()=>workflow.confirmTail('release'));
function buildScenarioPicker(){
  const select=$('#scenario-select');if(!select)return;
  select.innerHTML=SCENARIO_OPTIONS.map(option=>`<option value="${option.key}">${option.label}</option>`).join('');
  select.value=attempt.exam?EXAM_KEY:attempt.scenarioKey;
  const warning=$('#scenario-warning');if(!warning)return;
  if(attempt.scenarioValid){warning.hidden=true;warning.textContent='';return;}
  const keys=SCENARIO_OPTIONS.filter(option=>option.key!==EXAM_KEY).map(option=>option.key).join(' / ');
  warning.hidden=false;
  warning.textContent=`地址参数 ?scenario=${attempt.requestedScenario} 不是有效场景，已按「正常 · 标准编组」运行。可用值：${keys}，或 ${EXAM_KEY}（考核抽考）。`;
}
/** 切换到新一轮：整组替换 attempt / sim / workflow，并复位记录单状态。 */
function startAttempt(next){
  closeAnswerModal();closeDevicePanels();
  attempt=next;
  sim=new TrainSimulation(attempt);
  workflow=new BrakeTestWorkflow(attempt);
  sim.onChange(render);
  workflow.onChange(()=>renderTraining(sim.state));
  recordAutoShown=false;
  buildScenarioPicker();
  setView('front');
}
$('#scenario-select')?.addEventListener('change',(event)=>{
  const isExam=event.target.value===EXAM_KEY;
  // 选「考核抽考」就现场抽一种：抽到什么在记录单出来之前都不显示给学员。
  startAttempt(createSimpleBrakeAttempt(location.search,{scenario:isExam?EXAM_KEY:event.target.value,exam:isExam}));
});
$('#restart-test').addEventListener('click',()=>{
  // 重新开始本轮试验沿用本轮已定的场景（含抽考已抽到的那一种），不重新抽签。
  startAttempt(createSimpleBrakeAttempt(location.search,{scenario:attempt.scenarioKey,exam:attempt.exam}));
});
buildScenarioPicker();
$('#enter-training').addEventListener('click',enterImmersive);
$('#exit-immersive').addEventListener('click',exitImmersive);
addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&document.documentElement.classList.contains('immersive')&&!mobileLike)document.documentElement.classList.remove('immersive');routeScene.resize();});
addEventListener('orientationchange',()=>{closeDevicePanels();setTimeout(()=>routeScene.resize(),160);});
window.visualViewport?.addEventListener('resize',()=>routeScene.resize());
addEventListener('pointerup',stopHorn,true);addEventListener('pointercancel',stopHorn,true);addEventListener('blur',()=>stopHorn());addEventListener('pagehide',()=>stopHorn());document.addEventListener('visibilitychange',()=>{if(document.hidden)stopHorn();});
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));buildSwitchPanel();buildLkj();buildKeys();bindDrag();setView('front');sim.onChange(render);workflow.onChange(()=>renderTraining(sim.state));let last=performance.now();function loop(now){const dt=Math.min(.05,(now-last)/1000);sim.tick(dt);workflow.update(sim.state,dt);routeScene.render();last=now;requestAnimationFrame(loop)}requestAnimationFrame(loop);
