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
// The wall faces the viewer. The window is in front of it, off screen to the
// right. Parallel sunlight travels left and slightly down until it meets the wall.
const daylight = { x: -.96, y: .24, depth: 500 } as const;

function branch(ctx: CanvasRenderingContext2D) {
  ctx.strokeStyle = '#122326';
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  getPaths().limbs.forEach((limb, i) => { ctx.lineWidth = [8, 3.5, 1.8][i]!; ctx.stroke(limb); });
}

function leafTexture(shape: Path2D) {
  const raw = makeLayer(80, 80), rawCtx = raw.getContext('2d')!;
  rawCtx.translate(40, 40); rawCtx.fill(shape);
  const soft = makeLayer(80, 80), softCtx = soft.getContext('2d')!;
  softCtx.filter = 'blur(2.4px)'; softCtx.drawImage(raw, 0, 0);
  return soft;
}

const noise = (seed: number) => {
  const n = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return n - Math.floor(n);
};

/** Damped spring response to a finite gust; quiet between irregular arrivals. */
function windResponse(seconds: number, damping: number, frequency: number) {
  const response = (t: number) => t <= 0 ? 0 : 1 - Math.exp(-damping * t)
    * (Math.cos(frequency * t) + damping / frequency * Math.sin(frequency * t));
  const block = Math.floor(seconds / 14);
  let wind = 0;
  for (let i = block - 1; i <= block; i++) {
    const arrival = i * 14 + 2 + noise(i * 3) * 4;
    const duration = 1.4 + noise(i * 3 + 1) * 1.6;
    const strength = .65 + noise(i * 3 + 2) * .35;
    const t = seconds - arrival;
    wind += strength * (response(t) - response(t - duration)
      + .22 * (response(t - .7) - response(t - 1.15)));
  }
  return wind;
}

function paintTree(ctx: CanvasRenderingContext2D, tree: HTMLCanvasElement, foliage: readonly HTMLCanvasElement[], seconds: number, mirrored: boolean) {
  const time = seconds - (mirrored ? .42 : 0);
  const wind = windResponse(time, 2.8, 4.8);
  const leafWind = windResponse(time - .16, 3.8, 10);
  ctx.save();
  // Mirroring the far branch must not reverse the world-space wind direction.
  ctx.translate(430, 920); ctx.rotate(wind * (mirrored ? .032 : -.038)); ctx.translate(-430, -920);
  ctx.drawImage(tree, 0, 0);
  leaves.forEach(([x, y, rotation, scale], i) => {
    const flutter = leafWind * (.15 + noise(i) * .09)
      + Math.sin(time * 13 + i * .74) * Math.abs(leafWind) * .035;
    ctx.save(); ctx.translate(x, y);
    ctx.rotate(rotation * Math.PI / 180 + flutter * (mirrored ? -1 : 1));
    ctx.scale(scale, scale); ctx.drawImage(foliage[i % 3 ? 0 : 1]!, -40, -40);
    ctx.restore();
  });
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
  const sun = ctx.createLinearGradient(500, 100, 500 + daylight.x * 720, 100 + daylight.y * 720);
  sun.addColorStop(0, '#ffe6b950');
  sun.addColorStop(.55, '#f5e2b83d');
  sun.addColorStop(1, '#e8dfbb30');
  windowProjection(ctx);
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

/** Integrate the lit window cross-section back towards the actual window.
 * Every slice follows the same parallel rays and ends at the wall projection.
 * Leaf occlusion is included, so air light changes only when the foliage moves.
 */
function paintAirLight(layer: HTMLCanvasElement, sunlight: HTMLCanvasElement) {
  const ctx = layer.getContext('2d')!;
  ctx.clearRect(0, 0, layer.width, layer.height);
  const steps = 64;
  for (let i = steps; i > 0; i--) {
    const depth = i / steps;
    ctx.globalAlpha = (.9 / steps) * (.5 + depth * .5);
    ctx.drawImage(sunlight,
      -daylight.x * daylight.depth * depth * layer.width / 390,
      -daylight.y * daylight.depth * depth * layer.height / 844,
      layer.width, layer.height);
  }
  ctx.globalAlpha = 1;
  // Keep the scattering colour independent of low-alpha 8-bit blending.
  // The accumulated window/foliage coverage supplies opacity, never dark ink.
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#ffe9bf'; ctx.fillRect(0, 0, layer.width, layer.height);
  ctx.globalCompositeOperation = 'source-over';
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
  bounce: HTMLCanvasElement; air: HTMLCanvasElement; tree: HTMLCanvasElement; foliage: readonly HTMLCanvasElement[];
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
    branch(raw.getContext('2d')!);
    const tree = makeLayer(500, 960), treeCtx = tree.getContext('2d')!;
    treeCtx.filter = 'blur(2.8px)'; treeCtx.drawImage(raw, 0, 0);
    scene = { key, base, light, bounce, tree,
      foliage: [leafTexture(getPaths().leaf), leafTexture(getPaths().broadLeaf)],
      air: makeLayer(width / 2, height / 2), movingLight: makeLayer(width, height) };
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
    paintTree(sunlight, scene.tree, scene.foliage, seconds, !near);
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
  ctx.drawImage(scene.movingLight, 0, 0, width, height);
  paintAirLight(scene.air, scene.movingLight);
  ctx.drawImage(scene.air, 0, 0, width, height);
}
