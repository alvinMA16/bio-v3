import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GlassLightField } from '../src/glass-light-field.js';

test('speech illuminates the centre before the ends; silence darkens the ends first', () => {
  const light = new GlassLightField();
  for(let i=0;i<8;i++)light.update(i/60,.5,0);
  assert.ok(light.at(.5) > light.at(.02));
  for(let i=8;i<180;i++)light.update(i/60,.5,0);
  assert.ok(light.at(.02) > .95);
  for(let i=180;i<260;i++)light.update(i/60,0,0);
  assert.ok(light.at(.5) > .5);
  assert.equal(light.at(.02),0);
  for(let i=260;i<420;i++)light.update(i/60,0,0);
  assert.equal(light.at(.25),0);
});

test('thinking expands symmetrically and recedes on its own cycle without sound', () => {
  const light = new GlassLightField();
  light.update(0,0,1);
  const initial = light.at(.05,1);
  for(let i=1;i<=114;i++)light.update(i/60,0,1);
  assert.ok(light.at(.05,1) > initial + .9);
  assert.ok(Math.abs(light.at(.2,1) - light.at(.8,1)) < 1e-10);
  for(let i=115;i<=228;i++)light.update(i/60,0,1);
  assert.equal(light.at(.05,1),0);
});

test('brief pauses retain illumination and reduced motion is time-independent', () => {
  const light = new GlassLightField();
  for(let i=0;i<120;i++)light.update(i/60,.5,0);
  for(let i=120;i<132;i++)light.update(i/60,0,0);
  assert.ok(light.at(.05) > .9);
  const still=light.at(.25,1,true);
  light.update(20,0,1);
  assert.equal(light.at(.25,1,true),still);
  assert.equal(light.at(.05),0, 'background gaps do not replay stale speech');
});
