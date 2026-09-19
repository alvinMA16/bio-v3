import { disposeGlassStack } from './voice-glass-stack.js';
import { renderMotion } from './voice-motion-renderer.js';
const $ = id => document.getElementById(id);
const designs = [
  ['星丝声波','保留版','保留上一版丝线与颗粒的融合，作为对照。'],
  ['极光声潮','02 · 保留版','保留上一版多层声潮，对照新版本的疏密与留白。'],
  ['留白声潮','02B · 微调','一条光带，两处错开的起伏；色彩沿线流动，中心不再堆叠。'],
  ['悬弦','03A · 新方向','两侧的细弦受声音牵动，轻轻弯曲后回落；文字占据安静的中央。'],
  ['微粒潮汐','03B · 新方向','少量微光排成有秩序的声纹，声音经过时逐次起伏，不聚成色块。'],
  ['层叠玻璃','04 · 保留版','15 片彩色方形玻璃横向层叠；声音传来时，逐片起伏、缩放，保留透光与厚度。'],
  ['通栏玻璃','04A · 宽度对齐','玻璃阵列延伸至附件预览区两侧，保留原来的片片大小和随声起伏。'],
  ['行进波玻璃','04B · 基准保留','40 片薄玻璃轻轻重叠，圆润波峰向右传递，舒展后缓缓收回；静音保持细小、连续。'],
  ['双侧玻璃','04C · 中央留白','文字固定居中，两边各一摞玻璃片，随声音起伏，外侧对齐附件边缘。'],
  ['柔光涟漪','04B+ · 精修对照','主波牵引轻微余波，玻璃随波面倾斜，光泽沿折面流转；保留密度与通栏布局。'],
  ['息光玻璃','04D · 静时收拢','说话时舒展成通栏涟漪；停声后缓缓收成文字后的一点微光，短暂停顿保持连贯。'],
];
const designLabels=['01','02','02B','03A','03B','04','04A','04B','04C','04B+','04D'];
const states = { listen: ['正在听你说','轮到你了，慢慢讲','LISTENING'], speak: ['令狸正在说','听一听，也可以打断','SPEAKING'], think: ['令狸在思考','稍等，正在整理思绪','THINKING'] };
let state = 'listen', selected = 10, source = 'demo', stream, context, analyser, micNode, audioNode, objectUrl, generation = 0, level = 0, gain = 1;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
$('options').innerHTML = designs.map(([name,tag,description],i) => `<button class="option" data-design="${i}" aria-pressed="${i === selected}"><div class="option-top"><span class="number">${designLabels[i]}</span><h2>${name}</h2><span class="tag">${tag}</span></div><div class="motion-stage"><canvas aria-hidden="true"></canvas><div class="caption"><strong>正在听你说</strong><small>LISTENING</small></div></div><p class="description">${description}</p></button>`).join('');
const surfaces = [...document.querySelectorAll('.option canvas'), $('phone-motion')].map((canvas,i) => ({canvas, ctx:canvas.getContext('2d'), design:i, w:0,h:0}));
const observer = new ResizeObserver(entries => {for (const entry of entries) {const s=surfaces.find(v=>v.canvas===entry.target);s.w=entry.contentRect.width;s.h=entry.contentRect.height;const dpr=Math.min(devicePixelRatio||1,2);s.canvas.width=Math.round(s.w*dpr);s.canvas.height=Math.round(s.h*dpr);s.ctx.setTransform(dpr,0,0,dpr,0,0);}});
surfaces.forEach(s=>observer.observe(s.canvas));
function updateState(next){state=next;document.querySelectorAll('[data-state]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.state===state)));document.querySelectorAll('.caption strong').forEach(x=>x.textContent=states[state][0]);document.querySelectorAll('.caption small').forEach(x=>x.textContent=states[state][2]);$('phone-state').textContent=states[state][0];$('phone-hint').textContent=states[state][1];}
document.querySelectorAll('[data-state]').forEach(b=>b.onclick=()=>{ $('cycle').checked=false;updateState(b.dataset.state); });
document.querySelectorAll('[data-design]').forEach(b=>b.onclick=()=>{selected=Number(b.dataset.design);document.querySelectorAll('[data-design]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));updateSelection();});
function updateSelection(){$('selection').textContent=`${designLabels[selected]} / ${designs[selected][0]}`;$('phone-motion').parentElement.classList.toggle('legacy',false);$('phone-motion').dataset.edge='false';$('phone-motion').parentElement.classList.toggle('compact-liquid',selected===3||selected===4);$('phone-motion').parentElement.classList.toggle('glass-overlay',selected>=5);$('phone-motion').parentElement.classList.toggle('glass-full',selected>=6);} updateSelection();
$('attachment').onchange=()=>{const attached=$('attachment').checked;$('document').hidden=!attached;$('dialogue').hidden=attached;};
$('gain').oninput=()=>gain=Number($('gain').value);
function stopInput(){generation++;stream?.getTracks().forEach(t=>t.stop());stream=undefined;micNode?.disconnect();micNode=undefined;audioNode?.disconnect();analyser?.disconnect();analyser=undefined;$('audio').pause();$('audio').hidden=true;$('mic').textContent='启用麦克风';$('mic').disabled=false;}
function sourceLabel(text){$('source-label').textContent=text;$('silence').setAttribute('aria-pressed',String(source==='silent'));$('demo').setAttribute('aria-pressed',String(source==='demo'));$('mic').setAttribute('aria-pressed',String(source==='mic'));}
async function audioContext(){context??=new AudioContext();if(context.state==='suspended')await context.resume();return context;}
function newAnalyser(ctx){const node=ctx.createAnalyser();node.fftSize=1024;node.smoothingTimeConstant=.7;return node;}
$('demo').onclick=()=>{stopInput();source='demo';sourceLabel('模拟语音 · 非真实录音');$('notice').textContent='模拟停顿、轻声和重音；切换状态查看思考循环。';};
$('silence').onclick=()=>{stopInput();source='silent';$('cycle').checked=false;updateState('listen');sourceLabel('安静预览 · 无声音输入');$('notice').textContent='观察停声后的收拢过程；点击模拟语音让玻璃重新舒展。';};
$('mic').onclick=async()=>{
 if(source==='mic'){$('demo').click();return;}
 stopInput();const token=generation;source='silent';sourceLabel('等待麦克风授权…');$('mic').disabled=true;
 try{const ctx=await audioContext();if(!navigator.mediaDevices?.getUserMedia)throw Error('当前页面不支持麦克风，请使用 localhost 或 HTTPS。');const next=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});if(token!==generation){next.getTracks().forEach(t=>t.stop());return;}stream=next;analyser=newAnalyser(ctx);micNode=ctx.createMediaStreamSource(stream);micNode.connect(analyser);source='mic';$('mic').textContent='停用麦克风';$('cycle').checked=false;updateState('listen');sourceLabel('真实麦克风 · 实时音量');$('notice').textContent='正在本机分析麦克风。点击停用或切换输入即可释放麦克风。';stream.getAudioTracks()[0].onended=()=>{if(source==='mic')$('demo').click();};}
 catch(error){if(token===generation){source='silent';sourceLabel('麦克风未启用');$('notice').textContent=error.name==='NotAllowedError'?'未获得麦克风权限。可使用模拟语音或选择音频文件。':error.message;}}
 finally{if(token===generation)$('mic').disabled=false;}
};
$('file').onchange=async()=>{const file=$('file').files[0];if(!file)return;stopInput();const token=generation;source='silent';try{const ctx=await audioContext();if(token!==generation)return;if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=URL.createObjectURL(file);const audio=$('audio');audio.src=objectUrl;audio.hidden=false;audioNode??=ctx.createMediaElementSource(audio);analyser=newAnalyser(ctx);audioNode.connect(analyser);analyser.connect(ctx.destination);source='file';$('cycle').checked=false;updateState('speak');sourceLabel('音频文件 · 实际播放音量');$('notice').textContent='用此音频模拟令狸回复；动效分析真实播放波形，暂停后自然收拢。';await audio.play();}catch(error){if(token===generation){$('notice').textContent=`音频未能自动播放：${error.message}。可使用播放器重试或更换文件。`;}}$('file').value='';};
$('audio').onerror=()=>{if(source==='file')$('notice').textContent='浏览器无法解码此音频，请换用 MP3 或 WAV。';};
const samples=new Float32Array(1024);
const spectrum=new Uint8Array(512);
const bands=[0,0,0];
let thinkingMix=0;
function envelope(t){const phrase=Math.max(0,Math.sin(t*.72)+.25);return Math.min(1,phrase*(.14+.37*Math.abs(Math.sin(t*4.2))+.25*Math.abs(Math.sin(t*7.1))));}
let last=0,lastCycle=0,lastMeter=0;
function frame(now){requestAnimationFrame(frame);if(document.hidden)return;if(now-last<(reduced.matches?100:30))return;const dt=Math.min((now-last)/1000,.1);last=now;const t=now/1000;if($('cycle').checked&&now-lastCycle>6500){updateState(['listen','speak','think'][(['listen','speak','think'].indexOf(state)+1)%3]);lastCycle=now;}if(!$('cycle').checked)lastCycle=now;let raw=source==='demo'?envelope(t):0;if(analyser){analyser.getFloatTimeDomainData(samples);raw=Math.sqrt(samples.reduce((sum,x)=>sum+x*x,0)/samples.length)*5;raw=Math.max(0,raw-.015);}raw=Math.min(1,raw*gain);level+=(raw-level)*(1-Math.exp(-dt/(raw>level?.065:.24)));if(analyser)analyser.getByteFrequencyData(spectrum);
 const ranges=[[2,12],[12,55],[55,180]];
 for(let i=0;i<3;i++){let target=0;if(analyser){const [lo,hi]=ranges[i];for(let j=lo;j<hi;j++)target+=spectrum[j]/255;target/=hi-lo;}else if(source==='demo'){target=level*(.55+.45*Math.sin(t*(2.1+i*.8)+i));}bands[i]+=(target-bands[i])*(1-Math.exp(-dt/.12));}
 thinkingMix+=((state==='think'?1:0)-thinkingMix)*(1-Math.exp(-dt/.32));
 for(const s of surfaces)renderMotion(s,{time:t,level,bands,state,thinkingMix,reduced:reduced.matches,index:s.design===designs.length?selected:s.design});if(now-lastMeter>100){$('meter').style.width=`${level*100}%`;$('level').value=`${Math.round(level*100)}%`;lastMeter=now;}}
requestAnimationFrame(frame);
window.addEventListener('pagehide',()=>{disposeGlassStack();stopInput();context?.close();if(objectUrl)URL.revokeObjectURL(objectUrl);observer.disconnect();});
