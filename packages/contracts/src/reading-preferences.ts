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
