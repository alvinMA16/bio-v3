/** One scene source for both the room and the glass that refracts it. */
function createPaths() {
const arch = new Path2D('M0 690V155A155 155 0 0 1 310 155V690Z');
const leaf = new Path2D('M0 0C-3-9-14-18-26-15C-25-4-13 4 0 0Z');
const broadLeaf = new Path2D('M0 0C-7-3-6-17-20-20C-29-10-17 4 0 0Z');
const limbs = [
  new Path2D('M430 920C362 798 330 728 291 641C268 586 269 538 250 486C229 436 205 412 171 390'),
  new Path2D('M331 735C279 717 248 705 210 664M287 634C320 600 346 576 389 559M256 510C278 482 309 468 344 458M235 457C195 457 159 443 131 416'),
  new Path2D('M306 610 302 566M272 713 255 741M295 478 301 443M195 452 187 421'),
];
return {arch,leaf,broadLeaf,limbs};
}
let cachedPaths: ReturnType<typeof createPaths> | undefined;
const getPaths=()=>cachedPaths??=createPaths();
const leaves: readonly (readonly [number, number, number, number])[] = [
  [211,664,10,1.2],[248,701,74,1.3],[277,716,190,1.1],[256,736,-82,1.1],
  [315,690,140,1.4],[298,658,-15,1.1],[288,638,75,1.3],[303,573,60,1.05],
  [330,597,190,1.3],[356,580,132,1.1],[382,563,166,1.35],[270,591,26,1.3],
  [255,520,-65,1.1],[269,496,115,1.15],[297,476,176,1.3],[301,450,80,1.15],
  [336,461,152,1.1],[241,480,0,1.25],[223,452,-25,1.05],[189,426,100,1.2],
  [159,436,15,1.3],[135,419,35,1.1],[182,408,100,1.15],[208,430,155,1.1],
];
function branch(ctx: CanvasRenderingContext2D, angle: number) {
  const {limbs,leaf,broadLeaf}=getPaths();
  ctx.save();ctx.translate(430,920);ctx.rotate(angle);ctx.translate(-430,-920);
  ctx.strokeStyle = ctx.fillStyle = '#122326';ctx.lineCap='round';ctx.lineJoin='round';
  limbs.forEach((limb,i)=>{ctx.lineWidth=[8,3.5,1.8][i]!;ctx.stroke(limb);});
  leaves.forEach(([x,y,r,s],i)=>{ctx.save();ctx.translate(x,y);ctx.rotate(r*Math.PI/180);ctx.scale(s,s);ctx.fill(i%3?leaf:broadLeaf);ctx.restore();});
  ctx.restore();
}
function paintStaticRoom(ctx: CanvasRenderingContext2D, width: number, height: number, grain: CanvasPattern | null) {
  const {arch}=getPaths();
  ctx.save();ctx.scale(width/390,height/844);
  const room=ctx.createLinearGradient(0,0,390,844);room.addColorStop(0,'#3b4845');room.addColorStop(.48,'#243538');room.addColorStop(1,'#1a292e');ctx.fillStyle=room;ctx.fillRect(0,0,390,844);
  const ambient=ctx.createRadialGradient(280,60,10,220,260,640);ambient.addColorStop(0,'#efdab236');ambient.addColorStop(.5,'#d6d4ac0c');ambient.addColorStop(1,'#d6d4ac00');ctx.fillStyle=ambient;ctx.fillRect(0,0,390,844);
  // A tall arched fanlight with rectangular panes; the oblique projection fills the room.
  ctx.save();ctx.transform(1,.07,-.19,1.03,111,36);
  ctx.shadowColor='#f8dcac30';ctx.shadowBlur=32;ctx.fillStyle='#e9d5ae18';ctx.fill(arch);ctx.shadowBlur=0;
  ctx.clip(arch);
  const sun=ctx.createLinearGradient(80,0,260,700);sun.addColorStop(0,'#f5deb85c');sun.addColorStop(.45,'#e0d7ae35');sun.addColorStop(1,'#dce0bb42');ctx.fillStyle=sun;ctx.fillRect(-10,-10,330,720);
  // Opaque frame shadows subtract light, without adding a floating window object.
  ctx.strokeStyle='#293b3bf0';ctx.lineWidth=7;ctx.filter='blur(1.25px)';ctx.beginPath();
  ctx.moveTo(0,155);ctx.lineTo(310,155);
  for(const x of [103,207]) {ctx.moveTo(x,155);ctx.lineTo(x,700);}
  for(const y of [330,510]) {ctx.moveTo(0,y);ctx.lineTo(310,y);}
  for(const a of [Math.PI*1.25,Math.PI*1.5,Math.PI*1.75]) {ctx.moveTo(155,155);ctx.lineTo(155+155*Math.cos(a),155+155*Math.sin(a));}
  ctx.stroke();ctx.filter='none';
  ctx.restore();
  // Gentle room illumination and a quiet pool behind the face/status, not an opaque panel.
  const veil=ctx.createRadialGradient(190,390,45,190,390,180);veil.addColorStop(0,'#20303446');veil.addColorStop(1,'#20303400');ctx.fillStyle=veil;ctx.fillRect(0,0,390,844);
  if(grain){ctx.fillStyle=grain;ctx.globalAlpha=.075;ctx.fillRect(0,0,390,844);ctx.globalAlpha=1;}
  ctx.restore();
}
export function createFeltGrain() {
  const canvas=document.createElement('canvas');canvas.width=canvas.height=128;const ctx=canvas.getContext('2d')!;
  let seed=371;const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  for(let i=0;i<2800;i++){const x=rand()*128,y=rand()*128;ctx.strokeStyle=rand()>.5?'#f3ebce99':'#101f2799';ctx.lineWidth=.35+rand()*.5;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+rand()*2-1,y+1+rand()*3);ctx.stroke();}
  return canvas;
}

// Cache expensive soft shadows once. Animation only transforms these images.
const sceneCache=new WeakMap<HTMLCanvasElement,{key:string;base:HTMLCanvasElement;tree:HTMLCanvasElement}>();
export function paintCallScene(ctx: CanvasRenderingContext2D,width:number,height:number,seconds:number,grain:CanvasPattern|null) {
  const scale=ctx.canvas.width/width,key=`${width}:${height}:${scale}`;
  let scene=sceneCache.get(ctx.canvas);
  if(!scene||scene.key!==key){
    const base=document.createElement('canvas');base.width=Math.ceil(width);base.height=Math.ceil(height);
    const baseCtx=base.getContext('2d')!;paintStaticRoom(baseCtx,width,height,grain);
    const raw=document.createElement('canvas');raw.width=500;raw.height=960;branch(raw.getContext('2d')!,0);
    const tree=document.createElement('canvas');tree.width=500;tree.height=960;
    const treeCtx=tree.getContext('2d')!;treeCtx.filter='blur(2.4px)';treeCtx.drawImage(raw,0,0);
    scene={key,base,tree};sceneCache.set(ctx.canvas,scene);
  }
  ctx.drawImage(scene.base,0,0,width,height);
  ctx.save();ctx.scale(width/390,height/844);ctx.transform(1,.07,-.19,1.03,111,36);ctx.clip(getPaths().arch);
  for(const near of [true,false]){
    ctx.save();ctx.globalAlpha=near?.36:.24;
    if(near)ctx.translate(-60,-295);else{ctx.translate(335,310);ctx.scale(-.9,.8);}
    const angle=near?Math.sin(seconds*.31)*.019:Math.sin(seconds*.23+1.4)*.024;
    ctx.translate(430,920);ctx.rotate(angle);ctx.translate(-430,-920);ctx.drawImage(scene.tree,0,0);ctx.restore();
  }
  const flight=(seconds+8)%57;
  if(flight>53&&flight<56){const p=(flight-53)/3;ctx.save();ctx.globalAlpha=Math.sin(p*Math.PI)*.22;ctx.translate(360-p*430,240+p*100);ctx.rotate(-.25);ctx.fillStyle='#102126';ctx.fill(new Path2D('M-22 3Q-12-14 0 0Q10-12 23-8Q10-5 2 5L-2 6Q-11-3-22 3Z'));ctx.restore();}
  ctx.restore();
}
