/** A delayed amplitude envelope: each plate receives the same wave a little later. */
export class GlassTravelingWave {
  samples = [];
  smoothed = 0;
  update(time, level, thinking = 0) {
    const last = this.samples.at(-1);
    if (last?.time === time) return;
    if (last && (time < last.time || time - last.time > .25)) { this.samples = []; this.smoothed = 0; }
    const volume = Math.min(1, Math.max(0, level));
    const mix = Math.min(1, Math.max(0, thinking));
    const crest = .18 + .82 * (Math.sin(time * Math.PI * 2.5) + 1) / 2;
    const thought = ((Math.sin(time * Math.PI * 1.5) + 1) / 2) ** 2;
    const target = volume * crest * (1 - mix) + .20 * thought * mix;
    const dt = last ? Math.max(0, Math.min(.1, time - last.time)) : 1 / 60;
    // A rounded attack and slower release keep individual syllables from snapping.
    const inertia = target > this.smoothed ? .085 : .22;
    this.smoothed += (target - this.smoothed) * (1 - Math.exp(-dt / inertia));
    this.samples.push({ time, value: this.smoothed });
    while (this.samples.length > 1 && this.samples[1].time < time - 1.5) this.samples.shift();
  }
  at(time, plateIndex) {
    const target = time - plateIndex * .052;
    if (!this.samples.length || target < this.samples[0].time) return 0;
    for (let i = 1; i < this.samples.length; i++) {
      const right = this.samples[i], left = this.samples[i - 1];
      if (right.time >= target) {
        const amount = (target - left.time) / (right.time - left.time);
        return left.value + (right.value - left.value) * amount;
      }
    }
    return this.samples.at(-1).value;
  }
}
