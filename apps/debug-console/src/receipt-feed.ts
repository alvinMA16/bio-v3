export const PRINT_DURATION_MS = 4200;

/** Short motor rests between three feeds; position always advances, never wipes the ink. */
export function feedProgress(elapsedMs: number): number {
  const stops = [[0, 0], [350, 0], [1350, .27], [1510, .27], [2700, .66], [2880, .66], [4000, 1], [4200, 1]] as const;
  for (let i = 1; i < stops.length; i++) {
    const [end, to] = stops[i]!;
    const [start, from] = stops[i - 1]!;
    if (elapsedMs <= end) {
      const t = Math.max(0, (elapsedMs - start) / (end - start));
      return from + (to - from) * (t * t * (3 - 2 * t));
    }
  }
  return 1;
}

/** y=0 is the fixed mouth. Positive y is inside the printer, negative y is visible. */
export function paperPoint(u: number, v: number, progress: number, width: number, height: number) {
  const fed = height * progress;
  const distance = v * height - (height - fed);
  const visible = Math.max(0, distance);
  const along = fed > 0 ? Math.min(1, visible / fed) : 0;
  const across = u * 2 - 1;
  // Paper retains a soft roll at the free edge; no oscillation once the motor stops.
  // A small exposed strip cannot bend farther than its own length. Keep the feed
  // monotonic below the mouth, including the very first millimetres of paper.
  const edgeCurl = Math.min(16 + 8 * (1 - progress), fed * .1);
  const curl = Math.pow(along, 5) * edgeCurl;
  // 16 cut teeth across the width, with intermediate mesh vertices on each slope.
  const phase = (u * 16) % 1;
  const tooth = v === 1 ? (1 - Math.abs(phase * 2 - 1)) * 5 : 0;
  return {
    x: across * width / 2 + Math.sin(along * Math.PI) * .7,
    y: -distance + curl * .55 + across * across * along * 1.2 + tooth,
    z: .3 + Math.sin(along * Math.PI * .8) * Math.min(2.4, fed * .02) + curl + Math.pow(across, 2) * along * Math.min(2, fed * .02),
  };
}
