export function accountCacheKey(key: string) {
  const id = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem('bio-account-id');
  return id ? `${key}:${id}` : key;
}

/** Only the explicitly bound legacy owner may inherit the old private-preview cache. */
export function migrateLegacyOwnerCache(userId: string): void {
  if (userId !== 'owner') return;
  for (const key of ['bio-agent-lab-history-v2', 'lingli.last-session-receipt.v1']) {
    try {
      const legacy = localStorage.getItem(key);
      if (legacy !== null && localStorage.getItem(`${key}:owner`) === null) localStorage.setItem(`${key}:owner`, legacy);
    } catch { /* Server data remains available when browser storage is full. */ }
  }
}
