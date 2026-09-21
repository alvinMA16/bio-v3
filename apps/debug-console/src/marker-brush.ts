import type { DocumentHighlight } from '@bio/contracts';

export const MARKER_COLORS = { yellow: '#f2df38', green: '#8ddd68', purple: '#c59aef', blue: '#80cafa', pink: '#ff95b6' };
const edges = [
  'M0 7 L8 5 L20 6 L34 4 L47 6 L61 5 L76 7 L91 4 L100 6 L100 23 L87 25 L72 23 L59 26 L43 24 L28 25 L14 23 L0 25 Z',
  'M0 5 L15 7 L29 4 L44 5 L60 7 L75 5 L89 6 L100 4 L100 22 L92 25 L77 24 L65 26 L48 23 L34 25 L19 24 L0 26 Z',
  'M0 8 L11 5 L27 7 L42 5 L57 4 L70 6 L83 5 L100 7 L100 25 L84 23 L68 25 L54 24 L40 26 L24 23 L9 25 L0 23 Z',
];

/** Native inline backgrounds clone at line breaks and resize with the text. */
export function markerBrush(color: DocumentHighlight['color'] = 'yellow', seed = 0): string {
  const ink = MARKER_COLORS[color] ?? MARKER_COLORS.yellow;
  const shape = edges[Math.abs(seed) % edges.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 30" preserveAspectRatio="none"><path d="${shape}" fill="${ink}" fill-opacity=".62"/><path d="M2 20 Q27 18 51 20 T98 18" fill="none" stroke="${ink}" stroke-width="3" stroke-opacity=".22"/><path d="M4 9 Q29 7 55 9 T95 8" fill="none" stroke="white" stroke-width=".7" stroke-opacity=".18"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
