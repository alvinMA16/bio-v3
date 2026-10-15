import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaptureBuffer } from '../../miniprogram/miniprogram/lib/capture-buffer.ts';

function fixture() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}
test('refresh restores only unacknowledged audio and sequence; repeated ACKs are harmless', () => {
  const storage = fixture(); const first = new CaptureBuffer(storage, 'alice'); first.ready('draft', 0);
  first.append('first'); first.append('second'); first.acknowledge(1); first.append('third'); first.finish();
  const afterRefresh = new CaptureBuffer(storage, 'alice');
  assert.equal(afterRefresh.id, 'draft'); assert.equal(afterRefresh.finished, true);
  assert.deepEqual(afterRefresh.pending(), [{ sequence: 2, data: 'second' }, { sequence: 3, data: 'third' }]);
  afterRefresh.ready('draft', 2); afterRefresh.acknowledge(2);
  assert.deepEqual(afterRefresh.pending(), [{ sequence: 3, data: 'third' }]);
  assert.equal(new CaptureBuffer(storage, 'bob').id, undefined);
});
test('50-minute capture releases acknowledged audio continuously and bounds an offline tail', () => {
  const storage = fixture(), buffer = new CaptureBuffer(storage, 'long'); buffer.ready('draft', 0);
  for (let n = 1; n <= 30000; n++) { assert.equal(buffer.append('A'.repeat(4268)), n); buffer.acknowledge(n); }
  assert.equal(storage.data.size, 1);
  for (let n = 0; n < 599; n++) buffer.append('A'.repeat(4268));
  assert.throws(() => buffer.append('A'.repeat(4268)), /buffer full/);
  assert.equal(new CaptureBuffer(storage, 'long').pending().length, 599);
});
