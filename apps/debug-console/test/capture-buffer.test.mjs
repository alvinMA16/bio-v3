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

test('starting fresh parks packet metadata without deleting old audio; it can be restored after refresh', () => {
  const storage=fixture(), old=new CaptureBuffer(storage,'alice'); old.ready('old',0); old.append('unfinished'); old.park();
  const fresh=new CaptureBuffer(storage,'alice'); assert.equal(fresh.id,undefined); assert.equal(fresh.hasParked,true);
  fresh.ready('new',0); fresh.append('new story'); fresh.acknowledge(1); fresh.clear();
  const restored=new CaptureBuffer(storage,'alice'); restored.restoreParked();
  assert.equal(restored.id,'old'); assert.deepEqual(restored.pending(),[{sequence:1,data:'unfinished'}]);
});

test('recovery upload is paced, bounded by ACKs, and finishes only after durable confirmation', async t => {
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const {CaptureUpload}=await import('../../miniprogram/miniprogram/lib/capture-buffer.ts');
  const buffer=new CaptureBuffer(fixture(),'paced'); buffer.ready('capture',0);
  const data=Buffer.alloc(3200).toString('base64'); for(let i=0;i<400;i++) buffer.append(data);
  const sent=[];let drained=0,failed=0,writable=true;
  const upload=new CaptureUpload(buffer,{writable:()=>writable,send:f=>sent.push(f),drained:()=>drained++,failed:()=>failed++});
  t.after(()=>upload.stop()); upload.start();
  assert.equal(sent.length,1);t.mock.timers.tick(99);assert.equal(sent.length,1);
  for(let i=0;i<20;i++) t.mock.timers.tick(100);
  assert.equal(sent.length,10,'never more than ten unacknowledged packets');
  writable=false;buffer.acknowledge(10); t.mock.timers.tick(100); assert.equal(sent.length,10);
  writable=true;
  for(let i=0;i<500 && buffer.pendingCount;i++) {if(sent.length) buffer.acknowledge(sent.at(-1).sequence);t.mock.timers.tick(100);}
  assert.equal(sent.length,400);assert.equal(buffer.pendingCount,0);assert.equal(failed,0);assert.ok(drained>0);
  assert.deepEqual(sent.map(f=>f.sequence),Array.from({length:400},(_,i)=>i+1));
});

test('lost confirmations time out without erasing retained PCM', async t => {
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const {CaptureUpload}=await import('../../miniprogram/miniprogram/lib/capture-buffer.ts');
  const buffer=new CaptureBuffer(fixture(),'stalled');buffer.ready('capture',0);buffer.append('AAAA');
  let failed=0;const upload=new CaptureUpload(buffer,{writable:()=>true,send(){},drained(){},failed:()=>failed++});upload.start();
  t.after(()=>upload.stop());for(let i=0;i<210;i++)t.mock.timers.tick(100);
  assert.equal(failed,1);assert.equal(buffer.pendingCount,1);
});
