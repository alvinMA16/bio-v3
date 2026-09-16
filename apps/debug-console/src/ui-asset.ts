/** Stable same-origin entry; the API renews the private CDN signature on each load. */
export function uiAsset(path: string): string {
  return `/api/v1/ui-assets/${encodeURIComponent(path.split('/').at(-1) ?? '')}`;
}
