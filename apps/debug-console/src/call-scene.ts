import { breezeAt, scenePhase, SCENE_LOOP_SECONDS } from './call-scene-motion';

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
// View the floor from above. Sunlight enters from the lower left and travels
// away across it; the arched end recedes and narrows in the same direction.
const daylight = { x: .35, y: -.94, depth: 1000 } as const;
const windowSize = { width: 330, height: 960, padding: 10 };

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

function paintTree(ctx: CanvasRenderingContext2D, tree: HTMLCanvasElement, foliage: readonly HTMLCanvasElement[], seconds: number, mirrored: boolean) {
  const time = seconds - (mirrored ? .42 : 0);
  const wind = breezeAt(time);
  const angle = scenePhase(time) / SCENE_LOOP_SECONDS * Math.PI * 2;
  ctx.save();
  // Mirroring the far branch must not reverse the world-space wind direction.
  ctx.translate(430, 920); ctx.rotate(wind.branch * (mirrored ? .03 : -.032)); ctx.translate(-430, -920);
  ctx.drawImage(tree, 0, 0);
  leaves.forEach(([x, y, rotation, scale], i) => {
    const flutter = wind.leaf * (.13 + noise(i) * .07)
      + (.018 + Math.abs(wind.leaf) * .025) * Math.sin(angle * 2 + i * .74)
      + .009 * Math.sin(angle * 3 + i * 1.13);
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
  const floor = ctx.createLinearGradient(-100, 900, 420, 0);
  floor.addColorStop(0, '#3b4845');
  floor.addColorStop(.48, '#293b3c');
  floor.addColorStop(1, '#203136');
  ctx.fillStyle = floor;
  ctx.fillRect(0, 0, 390, 844);
  const ambient = ctx.createRadialGradient(-50, 830, 10, 100, 650, 800);
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

/** Project the window onto a receding floor plane, using one homography. */
function floorSample(x: number, y: number) {
  const a = 250 / 310, b = -270 / 940, d = 80 / 310, e = 501 / 940, h = -.3 / 940;
  const v = (a * (y - 10) - d * (x - 130)) / (a * (e - y * h) - d * (b - x * h));
  const u = (x - 130 - (b - x * h) * v) / a;
  return { x: u + windowSize.padding, y: v + windowSize.padding };
}

/** Occluders remove light from this aperture mask, never from the ground itself. */
function paintWindowLight(ctx: CanvasRenderingContext2D) {
  ctx.save(); ctx.translate(windowSize.padding, windowSize.padding);
  ctx.fillStyle = '#fff'; ctx.fill(getPaths().arch);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.strokeStyle = '#ffffffed'; ctx.lineWidth = 6.5; ctx.beginPath();
  ctx.moveTo(0, 155); ctx.lineTo(310, 155);
  for (const x of [103, 207]) { ctx.moveTo(x, 155); ctx.lineTo(x, 950); }
  for (const y of [330, 510, 690]) { ctx.moveTo(0, y); ctx.lineTo(310, y); }
  for (const a of [Math.PI * 1.25, Math.PI * 1.5, Math.PI * 1.75]) {
    ctx.moveTo(155, 155); ctx.lineTo(155 + 155 * Math.cos(a), 155 + 155 * Math.sin(a));
  }
  ctx.stroke(); ctx.restore();
}

type Projection = { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; pixels: ImageData; field: Float32Array };
function makeProjection(width: number, height: number): Projection {
  const canvas = makeLayer(width, height), context = canvas.getContext('2d')!;
  const pixels = context.createImageData(canvas.width, canvas.height), field = new Float32Array(canvas.width * canvas.height * 4);
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const px = (x + .5) * 390 / width, py = (y + .5) * 844 / height;
    const uv = floorSample(px, py), k = (y * canvas.width + x) * 4;
    field[k] = -1;
    if (uv.x < 0 || uv.y < 0 || uv.x >= windowSize.width - 1 || uv.y >= windowSize.height - 1) continue;
    const ix = Math.floor(uv.x), iy = Math.floor(uv.y);
    field[k] = (iy * windowSize.width + ix) * 4 + 3;
    field[k + 1] = uv.x - ix; field[k + 2] = uv.y - iy;
    const travel = Math.max(0, Math.min(1, ((px + 250) * daylight.x + (py - 1040) * daylight.y) / 1200));
    field[k + 3] = .3 - .09 * travel;
    pixels.data[k] = 245; pixels.data[k + 1] = 226; pixels.data[k + 2] = 185;
  }
  return { canvas, context, pixels, field };
}
function projectLight(projection: Projection, source: CanvasRenderingContext2D) {
  const alpha = source.getImageData(0, 0, windowSize.width, windowSize.height).data;
  const { field, pixels } = projection, stride = windowSize.width * 4;
  for (let k = 0; k < field.length; k += 4) {
    const i = field[k]!; if (i < 0) continue;
    const fx = field[k + 1]!, fy = field[k + 2]!;
    pixels.data[k + 3] = ((alpha[i]! * (1 - fx) + alpha[i + 4]! * fx) * (1 - fy)
      + (alpha[i + stride]! * (1 - fx) + alpha[i + stride + 4]! * fx) * fy) * field[k + 3]!;
  }
  projection.context.putImageData(pixels, 0, 0);
}

/** Integrate the lit window cross-section back towards the actual window.
 * Every slice follows the same parallel rays and ends at the floor projection.
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
  key: string; base: HTMLCanvasElement; light: HTMLCanvasElement; projection: Projection;
  bounce: HTMLCanvasElement; air: HTMLCanvasElement; tree: HTMLCanvasElement; foliage: readonly HTMLCanvasElement[];
  movingLight: HTMLCanvasElement;
}>();
export function paintCallScene(ctx: CanvasRenderingContext2D, width: number, height: number, seconds: number, grain: CanvasPattern | null) {
  const key = `${width}:${height}`;
  let scene = sceneCache.get(ctx.canvas);
  if (!scene || scene.key !== key) {
    const base = makeLayer(width, height);
    paintStaticRoom(base.getContext('2d')!, width, height, grain);
    const aperture = makeLayer(windowSize.width, windowSize.height);
    paintWindowLight(aperture.getContext('2d')!);
    const light = makeLayer(windowSize.width, windowSize.height), lightCtx = light.getContext('2d', { willReadFrequently: true })!;
    lightCtx.filter = 'blur(1.6px)'; lightCtx.drawImage(aperture, 0, 0);
    const projection = makeProjection(width, height);
    projectLight(projection, lightCtx);
    const bounce = makeLayer(width / 4, height / 4), bounceCtx = bounce.getContext('2d')!;
    bounceCtx.filter = 'blur(7px)'; bounceCtx.globalAlpha = .32;
    bounceCtx.drawImage(projection.canvas, 0, 0, bounce.width, bounce.height);
    const raw = makeLayer(500, 960);
    branch(raw.getContext('2d')!);
    const tree = makeLayer(500, 960), treeCtx = tree.getContext('2d')!;
    treeCtx.filter = 'blur(2.8px)'; treeCtx.drawImage(raw, 0, 0);
    scene = { key, base, light, bounce, tree, projection,
      foliage: [leafTexture(getPaths().leaf), leafTexture(getPaths().broadLeaf)],
      air: makeLayer(width / 2, height / 2), movingLight: makeLayer(windowSize.width, windowSize.height) };
    sceneCache.set(ctx.canvas, scene);
  }

  // All occluders subtract from this transparent light layer, so the ground remains
  // at its minimum ambient exposure even where frame, leaves and bird overlap.
  const sunlight = scene.movingLight.getContext('2d', { willReadFrequently: true })!;
  sunlight.clearRect(0, 0, scene.movingLight.width, scene.movingLight.height);
  sunlight.drawImage(scene.light, 0, 0);
  sunlight.save();
  sunlight.translate(windowSize.padding, windowSize.padding);
  sunlight.globalCompositeOperation = 'destination-out';
  for (const near of [true, false]) {
    sunlight.save(); sunlight.globalAlpha = near ? .56 : .4;
    if (near) sunlight.translate(-60, -295);
    else { sunlight.translate(335, 310); sunlight.scale(-.9, .8); }
    paintTree(sunlight, scene.tree, scene.foliage, seconds, !near);
    sunlight.restore();
  }
  const flight = scenePhase(seconds);
  if (flight > 2 && flight < 4) {
    const p = (flight - 2) / 2;
    sunlight.save(); sunlight.globalAlpha = Math.sin(p * Math.PI) ** 2 * .18;
    sunlight.translate(360 - p * 430, 240 + p * 100); sunlight.rotate(-.25);
    sunlight.fill(new Path2D('M-22 3Q-12-14 0 0Q10-12 23-8Q10-5 2 5L-2 6Q-11-3-22 3Z'));
    sunlight.restore();
  }
  sunlight.restore();

  ctx.drawImage(scene.base, 0, 0, width, height);
  ctx.drawImage(scene.bounce, 0, 0, width, height);
  projectLight(scene.projection, sunlight);
  ctx.drawImage(scene.projection.canvas, 0, 0, width, height);
  paintAirLight(scene.air, scene.projection.canvas);
  ctx.drawImage(scene.air, 0, 0, width, height);
}
