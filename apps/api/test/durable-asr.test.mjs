import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DurableAsr } from '../dist/voice/durable-asr.js';
import { VoiceSession } from '../dist/voice/voice-session.js';

function storeFixture() {
  const state = { id: 'capture', sequence: 0, block: 0, text: '', frames: [], blocks: [] };
  return { state,
    async load() { return { ...state, frames: state.frames.slice() }; },
    async append(_id, sequence, pcm) {
      if (sequence <= state.sequence) return false;
      assert.equal(sequence, state.sequence + 1);
      state.sequence = sequence; state.frames.push({ sequence, pcm }); return true;
    },
    async checkpoint(_id, text) { state.text = text; },
    async seal(_id, block, sequence, text) {
      assert.equal(block, state.block); state.block++; state.blocks.push(text);
      state.frames = state.frames.filter(f => f.sequence > sequence); state.text = '';
    },
    async text() { return state.blocks.filter(Boolean).join('\n'); },
  };
}
function providerFixture() {
  const streams = [];
  return { streams, async open(callback) {
    const values = []; let closed = false;
    const stream = { values, write(pcm) {
      assert.equal(closed, false); values.push(new DataView(pcm.buffer, pcm.byteOffset).getInt16(0, true));
      callback({ text: values.join(','), final: false });
    }, async finish() { return values.join(','); }, close() { closed = true; } };
    streams.push(stream); return stream;
  } };
}
const pcm = n => { const data = new Uint8Array(32000); new DataView(data.buffer).setInt16(0, n, true); return data; };

test('50 minutes of continuous PCM rotates bounded ASR streams, preserves order and calls Agent only at finish', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = storeFixture(), raw = providerFixture(), inputs = [], events = [];
  const durable = new DurableAsr(raw, store, () => {});
  const session = new VoiceSession(durable, { async synthesize() {} }, async input => {
    inputs.push(input.message); return { conversationId: 'test', message: { content: '' } };
  }, event => events.push(event));
  await session.listen('long', {});
  for (let second = 1; second <= 3000; second++) {
    t.mock.timers.tick(1000);
    session.audio(pcm(second), second);
    await durable.settled();
  }
  assert.equal(inputs.length, 0);
  assert.equal(events.some(e => e.type === 'error'), false);
  assert.equal(store.state.blocks.length, 100);
  assert.equal(store.state.frames.length, 0);
  assert.ok(raw.streams.every(s => s.values.length <= 30));
  session.finish('long'); await session.settled();
  const actual = inputs[0].split(/[\n,]/).map(Number);
  assert.deepEqual(actual, Array.from({ length: 3000 }, (_, i) => i + 1));
  assert.equal(inputs.length, 1); session.close(); await durable.settled();
});

test('disconnect and process recreation recover sealed text and unsealed audio; lost acknowledgements do not duplicate input', async () => {
  const store = storeFixture(), raw = providerFixture();
  const first = new DurableAsr(raw, store, () => {}, 3 * 32000), abort = new AbortController();
  const stream = await first.open(() => {}, abort.signal);
  for (let n = 1; n <= 5; n++) { stream.write(pcm(n), n); await first.settled(); }
  abort.abort(); await first.settled();
  assert.deepEqual(store.state.blocks, ['1,2,3']);
  assert.deepEqual(store.state.frames.map(f => f.sequence), [4, 5]);
  const acknowledgements = [];
  const second = new DurableAsr(raw, store, (...event) => acknowledgements.push(event), 3 * 32000);
  const restored = await second.open(() => {}, new AbortController().signal);
  restored.write(pcm(5), 5); // server committed it, browser never received its ACK
  restored.write(pcm(6), 6); restored.write(pcm(7), 7);
  assert.equal(await restored.finish(), '1,2,3\n4,5,6\n7');
  assert.equal(acknowledgements[0][2], 5);
  assert.equal(store.state.frames.length, 0);
  restored.close(); await second.settled();
});

test('failed final recognition keeps acknowledged audio available for another connection', async () => {
  const store = storeFixture();
  const first = new DurableAsr({ async open() { return { write() {}, close() {}, async finish() { throw new Error('network'); } }; } }, store, () => {});
  const stream = await first.open(() => {}, new AbortController().signal);
  stream.write(pcm(1), 1); await first.settled();
  await assert.rejects(stream.finish()); stream.close(); await first.settled();
  assert.equal(store.state.frames.length, 1);
  const recovered = new DurableAsr(providerFixture(), store, () => {});
  const next = await recovered.open(() => {}, new AbortController().signal);
  assert.equal(await next.finish(), '1'); next.close(); await recovered.settled();
});

test('journal failure cannot acknowledge unsaved audio or invoke Agent', async () => {
  const store = storeFixture(); store.append = async () => { throw new Error('database unavailable'); };
  const events = [], ack = [], inputs = [];
  const durable = new DurableAsr(providerFixture(), store, (...event) => ack.push(event));
  const session = new VoiceSession(durable, { async synthesize() {} }, async input => { inputs.push(input); }, e => events.push(e));
  await session.listen('failure', {}); session.audio(pcm(1), 1); await durable.settled();
  assert.equal(ack.some(([type]) => type === 'capture.saved'), false);
  assert.equal(inputs.length, 0); assert.ok(events.some(e => e.type === 'error'));
  session.close(); await durable.settled();
});

test('24.5 second tail reports recovery progress before ready and preserves sealed text', async () => {
  const store=storeFixture();store.state.sequence=245;store.state.block=4;store.state.blocks=['已保存'];
  store.state.frames=Array.from({length:245},(_,i)=>({sequence:i+1,pcm:new Uint8Array(3200)}));
  const events=[];let replayed=0;
  const durable=new DurableAsr({async open(){return {async replay(){replayed++;},write(){},close(){},async finish(){return '尾音';}};}},store,(type)=>events.push({type,replayed}),undefined,(remainingMs,totalMs)=>events.push({type:'progress',remainingMs,totalMs,replayed}));
  const stream=await durable.open(()=>{},new AbortController().signal);
  assert.equal(events[0].remainingMs,24500);assert.equal(events[0].replayed,0);
  assert.equal(events.at(-1).type,'capture.ready');assert.equal(events.at(-1).replayed,245);
  assert.equal(events.at(-2).remainingMs,0);
  stream.close();await durable.settled();
});

test('ASR stream and readiness failures are recorded exactly once without raw provider messages', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let callback;const diagnostics=[],events=[];
  const session=new VoiceSession({async open(cb){callback=cb;return {write(){},close(){},async finish(){return '';}};}},{},async()=>{},e=>events.push(e),2500,{progress(){},diagnostic:e=>diagnostics.push(e)});
  await session.listen('failure',{});callback({text:'',final:false,error:true,code:'asr_read_timeout'});
  callback({text:'',final:false,error:true,code:'asr_read_timeout'});
  assert.equal(diagnostics.length,1);assert.equal(diagnostics[0].code,'asr_read_timeout');session.close();
  let release;const stalled=new VoiceSession({open:()=>new Promise(r=>release=r)},{},async()=>{},e=>events.push(e),2500,{progress(){},diagnostic:e=>diagnostics.push(e)});
  const listening=stalled.listen('timeout',{});await Promise.resolve();await Promise.resolve();
  t.mock.timers.tick(60000);assert.equal(diagnostics.at(-1).code,'asr_ready_timeout');
  let closed=false;release({write(){},close(){closed=true;},async finish(){return '';}});await listening;
  assert.equal(closed,true);assert.equal(events.some(e=>e.turnId==='timeout'&&e.type==='state'&&e.state==='listening'),false);stalled.close();
});

test('a silence endpoint cannot submit half a recovered upload before its last packet is saved', async t => {
  t.mock.timers.enable({apis:['setTimeout']});let callback;const inputs=[];
  const session=new VoiceSession({async open(cb){callback=cb;return {write(){},close(){},async finish(){return '完整讲述';}};}},{async synthesize(){}},async input=>{inputs.push(input);return {conversationId:'test',message:{content:''}};},()=>{});
  await session.listen('tail',{});session.holdCapture('tail',40);
  callback({text:'前半段',final:true});t.mock.timers.tick(3000);assert.equal(inputs.length,0);
  session.captureSaved('tail',39);t.mock.timers.tick(3000);assert.equal(inputs.length,0);
  session.captureSaved('tail',40);t.mock.timers.tick(2500);await session.settled();assert.equal(inputs.length,1);session.close();
});

test('ordered capture endpoint requests client flush and never submits before explicit durable finish', async t => {
  t.mock.timers.enable({apis:['setTimeout']});let callback;const inputs=[],events=[];
  const values=[];
  const session=new VoiceSession({async open(cb){callback=cb;return {write(bytes){values.push(bytes[0]);},close(){},async finish(){return values.join(',');}};}},{async synthesize(){}},async input=>{inputs.push(input);return {conversationId:'test',message:{content:''}};},e=>events.push(e));
  await session.listen('ordered',{},false,false,true);session.audio(new Uint8Array([1,0]),1);
  callback({text:'开头',final:true});t.mock.timers.tick(2500);
  assert.equal(events.filter(e=>e.type==='capture.finish').length,1);assert.equal(inputs.length,0);
  session.audio(new Uint8Array([2,0]),2);session.audio(new Uint8Array([3,0]),3);
  session.finish('ordered');await session.settled();assert.equal(inputs[0].message,'1,2,3');session.close();
});
