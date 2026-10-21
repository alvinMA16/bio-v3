export const READING_FONT_SIZES = ['小号', '较小', '标准', '较大', '大号'] as const;
export type ReadingFontSize = typeof READING_FONT_SIZES[number];
export const DEFAULT_READING_FONT_SIZE: ReadingFontSize = '标准';
/** Standard is slightly smaller than the previous fixed typography. */
export const READING_FONT_SCALE: Record<ReadingFontSize, number> = { 小号: .75, 较小: .875, 标准: .9375, 较大: 1.0625, 大号: 1.1875 };
export function isReadingFontSize(value: unknown): value is ReadingFontSize {
  return typeof value === 'string' && (READING_FONT_SIZES as readonly string[]).includes(value);
}
export function adjustReadingFontSize(current: ReadingFontSize, size: ReadingFontSize | '调小' | '调大' | '恢复默认'): ReadingFontSize {
  if (size === '恢复默认') return DEFAULT_READING_FONT_SIZE;
  if (size === '调小' || size === '调大') return READING_FONT_SIZES[Math.max(0, Math.min(4, READING_FONT_SIZES.indexOf(current) + (size === '调小' ? -1 : 1)))]!;
  return size;
}

/** Only opaque sRGB colors are accepted at the tool/storage boundary. */
export function isDocumentBackgroundColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}
export const DEFAULT_DOCUMENT_BACKGROUND = '#FCFCF9';
export function documentTextColor(background: string): '#000000' | '#FFFFFF' {
  if (!isDocumentBackgroundColor(background)) throw new Error('Invalid background color');
  const linear = [1, 3, 5].map(offset => {
    const channel = parseInt(background.slice(offset, offset + 2), 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  const luminance = .2126 * linear[0]! + .7152 * linear[1]! + .0722 * linear[2]!;
  return (luminance + .05) / .05 >= 1.05 / (luminance + .05) ? '#000000' : '#FFFFFF';
}
