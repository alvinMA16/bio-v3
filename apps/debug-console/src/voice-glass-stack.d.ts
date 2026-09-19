export interface GlassInput {
  time: number;
  level: number;
  bands: number[];
  state: string;
  thinkingMix: number;
  reduced: boolean;
  index: number;
}
export function drawGlassStack(surface: { ctx: CanvasRenderingContext2D; w: number; h: number }, input: GlassInput): void;
export function disposeGlassStack(): void;
