/** One scene source for both the room and the glass that refracts it. */
function createPaths() {
const arch = new Path2D('M0 940V155A155 155 0 0 1 310 155V940Z');
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
  ctx.save();
  ctx.scale(width / 390, height / 844);
  const wall = ctx.createLinearGradient(0, 0, 390, 844);
  wall.addColorStop(0, '#3b4845');
  wall.addColorStop(.48, '#293b3c');
  wall.addColorStop(1, '#203136');
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, 390, 844);
  const ambient = ctx.createRadialGradient(300, 60, 10, 220, 260, 640);
  ambient.addColorStop(0, '#efdab22b');
  ambient.addColorStop(.5, '#d6d4ac0e');
  ambient.addColorStop(1, '#d6d4ac00');
  ctx.fillStyle = ambient;
  ctx.fillRect(0, 0, 390, 844);
  if (grain) {
    ctx.fillStyle = grain;
    ctx.globalAlpha = .075;
    ctx.fillRect(0, 0, 390, 844);
  }
  ctx.restore();
}

function windowProjection(ctx: CanvasRenderingContext2D) {
  ctx.transform(1, .07, -.19, 1.03, 111, 36);
}

/** The frame removes direct sunlight. It never paints dark pigment onto the wall. */
function paintWindowLight(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.save();
  ctx.scale(width / 390, height / 844);
  windowProjection(ctx);
  const sun = ctx.createLinearGradient(80, 0, 180, 940);
  sun.addColorStop(0, '#ffe6b961');
  sun.addColorStop(.35, '#f5e2b841');
  sun.addColorStop(.72, '#e8dfbb34');
  sun.addColorStop(1, '#e8dfbb10');
  ctx.fillStyle = sun;
  ctx.fill(getPaths().arch);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.strokeStyle = '#ffffffed';
  ctx.lineWidth = 6.5;
  ctx.beginPath();
  ctx.moveTo(0, 155); ctx.lineTo(310, 155);
  for (const x of [103, 207]) { ctx.moveTo(x, 155); ctx.lineTo(x, 950); }
  for (const y of [330, 510, 690]) { ctx.moveTo(0, y); ctx.lineTo(310, y); }
  for (const a of [Math.PI * 1.25, Math.PI * 1.5, Math.PI * 1.75]) {
    ctx.moveTo(155, 155); ctx.lineTo(155 + 155 * Math.cos(a), 155 + 155 * Math.sin(a));
  }
  ctx.stroke();
  ctx.restore();
}

/** A broad, feathered shaft makes the air luminous, separate from light on the wall. */
function createLightShaft(width: number, height: number) {
  const canvas = makeLayer(width / 2, height / 2), ctx = canvas.getContext('2d')!;
  const pixels = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const px = x * 390 / canvas.width, py = y * 844 / canvas.height;
    const centre = 345 - (py + 90) * .38;
    const spread = 27 + (py + 90) * .075;
    const across = (px - centre) / spread;
    const falloff = Math.exp(-Math.pow((py - 165) / 640, 2));
    // Uneven scattering within one continuous shaft, without hard stripes.
    const beam = Math.exp(-across * across * 1.6) * .2
      + Math.exp(-Math.pow((across - .48) * 3, 2)) * .035;
    const i = (y * canvas.width + x) * 4;
    pixels.data[i] = 255; pixels.data[i + 1] = 233; pixels.data[i + 2] = 191;
    pixels.data[i + 3] = 255 * beam * falloff;
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

function makeLayer(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width); canvas.height = Math.ceil(height);
  return canvas;
}

export function createFeltGrain() {
  const canvas=document.createElement('canvas');canvas.width=canvas.height=128;const ctx=canvas.getContext('2d')!;
  let seed=371;const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  for(let i=0;i<2800;i++){const x=rand()*128,y=rand()*128;ctx.strokeStyle=rand()>.5?'#f3ebce99':'#101f2799';ctx.lineWidth=.35+rand()*.5;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+rand()*2-1,y+1+rand()*3);ctx.stroke();}
  return canvas;
}

// Cache soft textures at CSS resolution; each frame only composites and transforms them.
const sceneCache = new WeakMap<HTMLCanvasElement, {
  key: string; base: HTMLCanvasElement; light: HTMLCanvasElement;
  bounce: HTMLCanvasElement; shaft: HTMLCanvasElement; tree: HTMLCanvasElement;
  movingLight: HTMLCanvasElement;
}>();
export function paintCallScene(ctx: CanvasRenderingContext2D, width: number, height: number, seconds: number, grain: CanvasPattern | null) {
  const key = `${width}:${height}`;
  let scene = sceneCache.get(ctx.canvas);
  if (!scene || scene.key !== key) {
    const base = makeLayer(width, height);
    paintStaticRoom(base.getContext('2d')!, width, height, grain);
    const aperture = makeLayer(width, height);
    paintWindowLight(aperture.getContext('2d')!, width, height);
    const light = makeLayer(width, height), lightCtx = light.getContext('2d')!;
    lightCtx.filter = 'blur(1.6px)'; lightCtx.drawImage(aperture, 0, 0);
    const bounce = makeLayer(width / 4, height / 4), bounceCtx = bounce.getContext('2d')!;
    bounceCtx.filter = 'blur(7px)'; bounceCtx.globalAlpha = .32;
    bounceCtx.drawImage(aperture, 0, 0, bounce.width, bounce.height);
    const raw = makeLayer(500, 960);
    branch(raw.getContext('2d')!, 0);
    const tree = makeLayer(500, 960), treeCtx = tree.getContext('2d')!;
    treeCtx.filter = 'blur(2.8px)'; treeCtx.drawImage(raw, 0, 0);
    scene = { key, base, light, bounce, tree, shaft: createLightShaft(width, height), movingLight: makeLayer(width, height) };
    sceneCache.set(ctx.canvas, scene);
  }

  // All occluders subtract from this transparent light layer, so the wall remains
  // the minimum ambient exposure even where frame, leaves and bird overlap.
  const sunlight = scene.movingLight.getContext('2d')!;
  sunlight.clearRect(0, 0, scene.movingLight.width, scene.movingLight.height);
  sunlight.drawImage(scene.light, 0, 0);
  sunlight.save();
  sunlight.scale(width / 390, height / 844);
  windowProjection(sunlight);
  sunlight.globalCompositeOperation = 'destination-out';
  for (const near of [true, false]) {
    sunlight.save(); sunlight.globalAlpha = near ? .56 : .4;
    if (near) sunlight.translate(-60, -295);
    else { sunlight.translate(335, 310); sunlight.scale(-.9, .8); }
    const angle = near ? Math.sin(seconds * .31) * .019 : Math.sin(seconds * .23 + 1.4) * .024;
    sunlight.translate(430, 920); sunlight.rotate(angle); sunlight.translate(-430, -920);
    sunlight.drawImage(scene.tree, 0, 0);
    sunlight.restore();
  }
  const flight = (seconds + 8) % 57;
  if (flight > 53 && flight < 56) {
    const p = (flight - 53) / 3;
    sunlight.save(); sunlight.globalAlpha = Math.sin(p * Math.PI) * .3;
    sunlight.translate(360 - p * 430, 240 + p * 100); sunlight.rotate(-.25);
    sunlight.fill(new Path2D('M-22 3Q-12-14 0 0Q10-12 23-8Q10-5 2 5L-2 6Q-11-3-22 3Z'));
    sunlight.restore();
  }
  sunlight.restore();

  ctx.drawImage(scene.base, 0, 0, width, height);
  ctx.drawImage(scene.bounce, 0, 0, width, height);
  ctx.save();
  ctx.globalAlpha = .96 + Math.sin(seconds * .13) * .04;
  ctx.drawImage(scene.movingLight, 0, 0, width, height);
  ctx.globalAlpha = .88 + Math.sin(seconds * .17 + .8) * .12;
  ctx.drawImage(scene.shaft, Math.sin(seconds * .11) * width / 130, 0, width, height);
  ctx.restore();
}
