import { drawGlassStack } from './voice-glass-stack.js';

const TAU = Math.PI * 2;
const palette = ['40,168,144', '58,155,213', '123,108,207', '207,123,164'];
const rgba = (color, opacity) => `rgba(${color},${opacity})`;
const bell = (x, center, spread) => Math.exp(-(((x-center)/spread)**2));

function gradient(c, left, right, alpha = 1) {
  const result = c.createLinearGradient(left, 0, right, 0);
  palette.forEach((color, i) => result.addColorStop(i / 3, rgba(color, alpha)));
  return result;
}
function point(c, x, y, radius, color) {
  c.fillStyle = color; c.beginPath(); c.arc(x,y,radius,0,TAU); c.fill();
}
function path(c, width, fn) {
  c.beginPath();
  for(let x = -width; x <= width; x += 2) {
    const y = fn(x / width);
    if(x === -width) c.moveTo(x,y); else c.lineTo(x,y);
  }
}
function halo(c,x,y,rx,ry,color,alpha) {
  c.save(); c.translate(x,y); c.scale(rx,ry);
  const g=c.createRadialGradient(0,0,0,0,0,1);
  g.addColorStop(0,rgba(color,alpha));g.addColorStop(.45,rgba(color,alpha*.5));g.addColorStop(1,rgba(color,0));
  c.fillStyle=g;c.fillRect(-1,-1,2,2);c.restore();
}

// All renderers use logical CSS pixels. The owning canvas applies its DPR transform.
export function renderMotion(surface, input) {
  const {ctx:c,w,h}=surface;
  if(!w||!h)return;
  const {index,state}=input;
  if(index>=5){drawGlassStack(surface,input);return;}
  c.clearRect(0,0,w,h);c.save();
  const time=input.reduced?0:input.time;
  const thinking=input.reduced?(state==='think'?1:0):input.thinkingMix;
  const volume=input.reduced?.18:input.level;
  const energy=volume*(1-thinking)+(.22+.04*Math.sin(time*1.5))*thinking;
  const bands=input.reduced?[.1,.1,.1]:input.bands.map((v,i)=>v*(1-thinking)+(.12+.04*Math.sin(time*.8+i))*thinking);
  const cy=index>=3?h*.5:h*.32, width=Math.min(w*.43,150);
  c.translate(w/2,cy);c.lineCap='round';c.lineJoin='round';
  if(index===0) silk(c,time,energy,thinking,bands,width,h);
  if(index===1) aurora(c,time,energy,thinking,bands,width,h);
  if(index===2) openWave(c,time,energy,thinking,width,h);
  if(index===3) strings(c,time,energy,thinking,width,h);
  if(index===4) tide(c,time,energy,thinking,width,h);
  c.restore();
}

function silk(c,t,e,thinking,bands,width,h) {
  const height=Math.min(25,h*.19);
  const wave=(u,k=0)=>{
    const envelope=Math.pow(Math.max(0,1-u*u),2.2);
    const carrier=Math.sin(u*8.5-t*(2.3-thinking*.9)+k*.055);
    const harmonic=Math.sin(u*17+t*1.3+k*.08)*.22;
    const shape=(.28+bell(u,-.4,.28)*(bands[0]+.1)+bell(u,.18,.32)*(bands[1]+.1)+bell(u,.6,.2)*bands[2]);
    return envelope*(carrier+harmonic)*(3+e*height*2)*shape+(k-12)*.52*envelope;
  };
  halo(c,-width*.2,0,width*.7,24,palette[0],.045+e*.06);
  halo(c,width*.25,0,width*.6,22,palette[2],.035+e*.05);
  for(let k=0;k<25;k++){
    path(c,width,u=>wave(u,k));
    c.strokeStyle=gradient(c,-width,width,k%6===0?.64:.18);
    c.lineWidth=k%6===0?1.1:.55;
    c.shadowColor=rgba(palette[k%4],.22);c.shadowBlur=k%6===0?5:0;c.stroke();
  }
  c.shadowBlur=0;
  // Particles travel on the wave surface, rather than orbiting independently.
  for(let i=0;i<48;i++){
    const progress=((i*.618033+t*(.075+thinking*.03))%1);
    const u=progress*2-1, k=i%25;
    const fade=Math.sin(progress*Math.PI)**1.5;
    const y=wave(u,k)+Math.sin(i*4.7+t)*e*3;
    const radius=i%9===0?1.5:.65;
    c.shadowBlur=i%9===0?6:0;c.shadowColor=rgba(palette[i%4],.6);
    point(c,u*width,y,radius,rgba(palette[i%4],fade*(.35+e*.5)));
  }
  c.shadowBlur=0;
}

function aurora(c,t,e,thinking,bands,width,h) {
  const height=Math.min(26,h*.19), amplitude=3+height*e;
  // Filled light volumes, with soft shoulders and one continuous specular crest.
  // Avoid outlining each layer: intersections should look refractive, not wireframe.
  for(let j=0;j<3;j++){
    const center=Math.sin(t*(.36+thinking*.22)+j*2.1)*.28;
    const profile=(u,side)=>{
      const env=Math.pow(Math.max(0,1-u*u),2.6);
      const pulse=bell(u,center,.40+j*.035);
      const bend=Math.sin(u*5.2-t*.95+j*1.3)*amplitude*.26;
      return env*(bend+side*(pulse*amplitude*(.8+bands[j]*.65)+.6));
    };
    const shape=()=>{
      c.beginPath();for(let n=0;n<=160;n++){const u=-1+n/80;const y=profile(u,-1);n===0?c.moveTo(u*width,y):c.lineTo(u*width,y);}
      for(let n=160;n>=0;n--){const u=-1+n/80;c.lineTo(u*width,profile(u,1));}c.closePath();
    };
    const color=[palette[1],palette[3],palette[0]][j];
    c.save();c.filter='blur(5px)';shape();c.fillStyle=rgba(color,.15);c.fill();c.restore();
    const fill=c.createLinearGradient(0,-amplitude,0,amplitude);
    fill.addColorStop(0,rgba(color,.04));fill.addColorStop(.32,rgba(color,.28));
    fill.addColorStop(.55,rgba(color,.44));fill.addColorStop(.8,rgba(color,.19));fill.addColorStop(1,rgba(color,0));
    shape();c.fillStyle=fill;c.fill();
    c.save();c.clip();
    halo(c,center*width,-amplitude*.16,width*.30,amplitude*.45,'245,255,255',.30);
    c.restore();
  }
  path(c,width,u=>Math.sin(u*5-t*.95)*Math.pow(1-u*u,3)*amplitude*.22);
  c.strokeStyle=gradient(c,-width,width,.20);c.lineWidth=.65;c.stroke();
}

// One unbroken surface. Separated opposing crests leave a quiet crossing in the middle.
function openWave(c,t,e,thinking,width,h) {
  const extent=Math.min(width,145), height=Math.min(25,h*.20);
  const shift=Math.sin(t*.60)*.06;
  const shape=u=>{
    const left=bell(u,-.42+shift,.23), right=bell(u,.42+shift,.23);
    const lift=4+e*height;
    return (left-right)*lift*(.83+.17*Math.sin(t*.85));
  };
  const breadth=u=>Math.pow(Math.max(0,1-u*u),2)*(1+e*3.2);
  const outline=()=>{
    c.beginPath();for(let i=0;i<=160;i++){const u=-1+i/80;const y=shape(u)-breadth(u);i?c.lineTo(u*extent,y):c.moveTo(u*extent,y);}
    for(let i=160;i>=0;i--){const u=-1+i/80;c.lineTo(u*extent,shape(u)+breadth(u));}c.closePath();
  };
  const wash=c.createLinearGradient(-extent,0,extent,0);
  wash.addColorStop(0,'rgba(51,155,153,0)');wash.addColorStop(.24,'rgba(60,169,172,.52)');
  wash.addColorStop(.52,'rgba(91,159,193,.28)');wash.addColorStop(.78,'rgba(142,135,197,.48)');wash.addColorStop(1,'rgba(142,135,197,0)');
  c.save();c.filter='blur(3px)';outline();c.fillStyle=wash;c.globalAlpha=.25;c.fill();c.restore();
  outline();c.fillStyle=wash;c.fill();
  path(c,extent,u=>shape(u)-breadth(u)*.5);c.strokeStyle='rgba(251,255,255,.60)';c.lineWidth=.65;c.stroke();
}

function strings(c,t,e,thinking,width,h) {
  const inner=61,outer=Math.max(inner+24,Math.min(width*.93,133));
  const height=Math.min(20,h*.32);
  for(const side of [-1,1]){
    const bend=(4+e*height)*Math.sin(t*(thinking?1.4:1.8)+side*.65);
    for(let j=0;j<3;j++){
      c.beginPath();c.moveTo(side*inner,0);
      c.bezierCurveTo(side*(inner+14),bend*(.65+j*.15),side*(outer-16),-bend*(.32+j*.13),side*outer,0);
      c.strokeStyle=rgba(palette[side===-1?0:2],j===0?.65:.19);c.lineWidth=j===0?1:.65;c.stroke();
    }
    const u=(Math.sin(t*.85+side)+1)/2;
    const x=inner+(outer-inner)*u;
    const y=3*(1-u)**2*u*bend*.65+3*(1-u)*u*u*-bend*.32;
    halo(c,side*x,y,5,5,palette[side===-1?0:2],.16);
    point(c,side*x,y,1.45,rgba(palette[side===-1?0:2],.72));
    point(c,side*outer,0,1,rgba(palette[side===-1?0:2],.30));
  }
}

function tide(c,t,e,thinking,width,h) {
  const inner=65,outer=Math.max(inner+22,Math.min(width*.94,133)),height=Math.min(21,h*.33);
  for(const side of [-1,1])for(let i=0;i<16;i++){
    const u=i/15, x=inner+(outer-inner)*u;
    const env=Math.sin(u*Math.PI)**.7;
    const pulse=Math.sin(u*5.0-t*(thinking?1.25:2.2)+side*.6);
    const y=env*pulse*(3+e*height);
    const color=palette[side===-1?0:2];
    // Only one bright spine; two faint echoes carry depth without a cloud of points.
    for(let j=2;j>=0;j--){
      const dy=y*(1-j*.19)+(j-1)*2.5*env;
      point(c,side*x,dy,j===0?1.2:.7,rgba(color,j===0?.30+env*.46:.12));
    }
  }
}
