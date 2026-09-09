import type { SessionReceipt } from './session-receipt';

export function drawPaperBump(): HTMLCanvasElement {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  const pixels = ctx.createImageData(256, 256);
  let seed = 92;
  for (let i = 0; i < pixels.data.length; i += 4) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const grey = 110 + seed % 36;
    pixels.data[i] = grey; pixels.data[i + 1] = grey; pixels.data[i + 2] = grey; pixels.data[i + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

export function drawReceiptTexture(receipt: SessionReceipt, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const scale = 4;
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#f5f5f2';
  ctx.fillRect(0, 0, width, height);
  let seed = 7419;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  // Fine, non-repeating fibres instead of the old regular CSS stripes.
  for (let i = 0; i < 16000; i++) {
    const x = random() * width, y = random() * height;
    ctx.fillStyle = random() > .5 ? '#ffffff14' : '#6666620b';
    ctx.fillRect(x, y, .2 + random() * .6, .2 + random() * .5);
  }
  for (let i = 0; i < 900; i++) {
    ctx.strokeStyle = i % 2 ? '#66666209' : '#ffffff2a';
    ctx.lineWidth = .25;
    const x = random() * width, y = random() * height;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + random() * 2, y + random() * 3); ctx.stroke();
  }
  const edge = ctx.createLinearGradient(0, 0, width, 0);
  edge.addColorStop(0, '#85858120'); edge.addColorStop(.06, '#85858100');
  edge.addColorStop(.94, '#85858100'); edge.addColorStop(1, '#85858118');
  ctx.fillStyle = edge; ctx.fillRect(0, 0, width, height);

  const serif = '"Songti SC", "Noto Serif CJK SC", serif';
  const ink = '#494945';
  const left = 18, right = width - 18;
  const text = (value: string, x: number, y: number, size: number, align: CanvasTextAlign = 'left', color = ink, font = serif) => {
    ctx.font = `${size}px ${font}`; ctx.fillStyle = color; ctx.textAlign = align;
    ctx.fillText(value, x, y);
  };
  const rule = (y: number) => {
    ctx.strokeStyle = '#92928b88'; ctx.lineWidth = .65; ctx.setLineDash([2, 2.5]);
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); ctx.setLineDash([]);
  };
  text('聊天小票', width / 2, height * .13, 26, 'center');
  text(receipt.date, width / 2, height * .215, 13, 'center', '#75756f', 'monospace');
  text(receipt.timeRange, width / 2, height * .29, 14, 'center', ink, 'monospace');
  rule(height * .37);
  const metrics = [['聊天时长', receipt.duration], ['你发言', `${receipt.shares} 次`], ['令狸发言', `${receipt.replies} 次`]];
  metrics.forEach(([label, value], index) => {
    text(label!, left, height * (.49 + index * .155), 15);
    text(value!, right, height * (.49 + index * .155), 17, 'right', ink, 'monospace');
  });
  rule(height - 27);
  return canvas;
}
