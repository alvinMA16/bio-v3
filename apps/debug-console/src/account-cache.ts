export function accountCacheKey(key: string) {
  const id = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem('bio-account-id');
  return id ? `${key}:${id}` : key;
}
