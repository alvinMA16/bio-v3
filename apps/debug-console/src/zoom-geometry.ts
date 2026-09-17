export interface ZoomPose { scale: number; x: number; y: number }
export function boundZoom(next: ZoomPose, stage: { width: number; height: number }, image: { width: number; height: number }): ZoomPose {
  if (image.width <= 0 || image.height <= 0 || stage.width <= 0 || stage.height <= 0) return { scale: 1, x: 0, y: 0 };
  const fit = Math.min(stage.width / image.width, stage.height / image.height);
  const scale = Math.max(1, Math.min(4, next.scale));
  const dx = Math.max(0, (image.width * fit * scale - stage.width) / 2);
  const dy = Math.max(0, (image.height * fit * scale - stage.height) / 2);
  return { scale, x: Math.max(-dx, Math.min(dx, next.x)), y: Math.max(-dy, Math.min(dy, next.y)) };
}
