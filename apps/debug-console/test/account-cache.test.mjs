import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountCacheKey, migrateLegacyOwnerCache } from '../src/account-cache.ts';
test('only bound owner inherits legacy browser caches, without overwriting newer records', t => {
  const values = new Map([['bio-agent-lab-history-v2', 'old history'], ['lingli.last-session-receipt.v1', 'old receipt']]);
  const previousLocal = globalThis.localStorage, previousSession = globalThis.sessionStorage;
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  globalThis.sessionStorage = { getItem: () => 'someone-else' };
  t.after(() => { globalThis.localStorage = previousLocal; globalThis.sessionStorage = previousSession; });
  migrateLegacyOwnerCache('someone-else'); assert.equal(values.size, 2);
  assert.equal(accountCacheKey('history'), 'history:someone-else');
  migrateLegacyOwnerCache('owner'); assert.equal(values.get('bio-agent-lab-history-v2:owner'), 'old history');
  assert.equal(values.get('lingli.last-session-receipt.v1:owner'), 'old receipt');
  values.set('bio-agent-lab-history-v2:owner', 'new history'); migrateLegacyOwnerCache('owner');
  assert.equal(values.get('bio-agent-lab-history-v2:owner'), 'new history');
});
