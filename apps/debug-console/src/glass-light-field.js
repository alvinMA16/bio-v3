const smooth = value => {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
};

/** Moves a light boundary across fixed plates; never moves or scales the array. */
export class GlassLightField {
  time = -1;
  lastSound = -10;
  aperture = 0;
  thoughtPhase = 0;
  update(time, level, thinking) {
    if (this.time === time) return;
    const gap = time - this.time;
    const dt = this.time < 0 ? 0 : Math.max(0, Math.min(.1, gap));
    if (gap > .5 || gap < 0) { this.aperture = 0; this.lastSound = -10; }
    if (level > .035) this.lastSound = time;
    const target = time - this.lastSound < .55 ? 1 : 0;
    this.aperture += (target - this.aperture) * (1 - Math.exp(-dt / (target ? .26 : .7)));
    if (thinking < .01) this.thoughtPhase = 0;
    else this.thoughtPhase += dt / 3.8;
    this.time = time;
  }
  at(u, thinking = 0, reduced = false) {
    const distance = Math.abs(u * 2 - 1);
    const voiceRadius = .025 + 1.12 * this.aperture;
    const thoughtRadius = .025 + 1.12 * (.5 - .5 * Math.cos(this.thoughtPhase * Math.PI * 2));
    const radius = reduced ? .58 : voiceRadius * (1 - thinking) + thoughtRadius * thinking;
    return smooth((radius - distance + .12) / .24);
  }
}
