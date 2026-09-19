import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GlassTravelingWave } from '../src/glass-traveling-wave.js';

test('later plates receive the same smoothed wave at the intended delay', () => {
  const wave = new GlassTravelingWave();
  for (let i=0;i<=160;i++) wave.update(i*.005, i>=20&&i<=30 ? .8 : 0);
  assert.ok(wave.at(.2,0)>.05);
  assert.ok(Math.abs(wave.at(.72,10)-wave.at(.2,0))<.00001);
  assert.equal(wave.at(.3,19),0);
});
test('crest amplitude follows loudness and silence has no invented voice wave', () => {
  const loud=new GlassTravelingWave(),soft=new GlassTravelingWave(),silent=new GlassTravelingWave();
  for(let i=0;i<=160;i++) {loud.update(i*.005,.8);soft.update(i*.005,.2);silent.update(i*.005,0);}
  assert.ok(Math.abs(loud.at(.72,10)/soft.at(.72,10)-4)<.0001);
  assert.equal(silent.at(.72,10),0);
});
test('an abrupt sound rises gradually and decays rather than snapping to zero', () => {
  const wave=new GlassTravelingWave();
  wave.update(0,0);wave.update(.016,1);
  assert.ok(wave.at(.016,0)>0&&wave.at(.016,0)<.2);
  const peak=wave.at(.016,0);wave.update(.032,0);
  assert.ok(wave.at(.032,0)>0&&wave.at(.032,0)<peak);
  for(let i=3;i<=200;i++)wave.update(i*.016,0);
  assert.ok(wave.at(3.2,0)<.0001);
});
test('a suspended page does not replay stale sound when it resumes', () => {
  const wave=new GlassTravelingWave();wave.update(.125,1);wave.update(5,0);
  assert.equal(wave.at(5,19),0);assert.equal(wave.at(5,0),0);
});
