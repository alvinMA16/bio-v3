/** A periodic breeze, with softly arriving gusts and a settled spring response. */
export const SCENE_LOOP_SECONDS = 72;
const rate = 120;
const count = SCENE_LOOP_SECONDS * rate;
const tau = Math.PI * 2;
const gusts = [
  { start: 5, rise: 3.2, hold: .6, fall: 2.8, strength: .52 },
  { start: 28, rise: 4.1, hold: .8, fall: 3.1, strength: .65 },
  { start: 54, rise: 3.6, hold: .4, fall: 2.6, strength: .56 },
] as const;
export const scenePhase = (seconds: number) => ((seconds % SCENE_LOOP_SECONDS) + SCENE_LOOP_SECONDS) % SCENE_LOOP_SECONDS;
const ease = (x: number) => x * x * x * (x * (x * 6 - 15) + 10);

function pressure(seconds: number) {
  const phase = scenePhase(seconds), angle = phase / SCENE_LOOP_SECONDS * tau;
  // All frequencies complete whole cycles, including the low background breeze.
  let value = .085 * Math.sin(angle * 6 + .4) + .04 * Math.sin(angle * 11 + 1.1) + .018 * Math.sin(angle * 17 + 2);
  for (const { start, rise, hold, fall, strength } of gusts) {
    const t = scenePhase(phase - start);
    if (t < rise) value += strength * ease(t / rise);
    else if (t < rise + hold) value += strength;
    else if (t < rise + hold + fall) value += strength * (1 - ease((t - rise - hold) / fall));
  }
  return value;
}

function makeCycle() {
  const branch = new Float64Array(count + 1), branchSpeed = new Float64Array(count + 1);
  const leaf = new Float64Array(count + 1), leafSpeed = new Float64Array(count + 1);
  const force = Float64Array.from({ length: count }, (_, i) => pressure(i / rate));
  const leafForce = Float64Array.from({ length: count }, (_, i) => pressure(i / rate - .18));
  let x = 0, v = 0, lx = 0, lv = 0;
  // Settle three loops before recording. The first frame is already in the
  // periodic steady state, so looping does not restart a spring from rest.
  for (let i = 0; i < count * 4; i++) {
    const tick = i % count;
    if (i >= count * 3) {
      const j = i - count * 3;
      branch[j] = x; branchSpeed[j] = v; leaf[j] = lx; leafSpeed[j] = lv;
    }
    v += (2.5 ** 2 * (force[tick]! - x) - 2 * .56 * 2.5 * v) / rate;
    x += v / rate;
    lv += (4.2 ** 2 * (leafForce[tick]! - lx) - 2 * .52 * 4.2 * lv) / rate;
    lx += lv / rate;
  }
  for (const values of [branch, branchSpeed, leaf, leafSpeed]) values[count] = values[0]!;
  return { branch, branchSpeed, leaf, leafSpeed };
}
let cycle: ReturnType<typeof makeCycle> | undefined;

export function breezeAt(seconds: number) {
  const field = cycle ??= makeCycle(), phase = scenePhase(seconds) * rate;
  const index = Math.floor(phase), t = phase - index;
  // Hermite interpolation preserves position and velocity through the seam.
  const sample = (values: Float64Array, speeds: Float64Array) =>
    (2 * t ** 3 - 3 * t ** 2 + 1) * values[index]!
    + (t ** 3 - 2 * t ** 2 + t) * speeds[index]! / rate
    + (-2 * t ** 3 + 3 * t ** 2) * values[index + 1]!
    + (t ** 3 - t ** 2) * speeds[index + 1]! / rate;
  return { branch: sample(field.branch, field.branchSpeed), leaf: sample(field.leaf, field.leafSpeed) };
}
