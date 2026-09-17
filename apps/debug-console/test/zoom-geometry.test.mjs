import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundZoom } from '../src/zoom-geometry.ts';
test('landscape letterboxing cannot be dragged into extra blank space', () => {
  assert.deepEqual(boundZoom({scale:1,x:300,y:-900},{width:320,height:500},{width:1600,height:900}),{scale:1,x:0,y:-0});
  assert.deepEqual(boundZoom({scale:2,x:999,y:999},{width:320,height:500},{width:1600,height:900}),{scale:2,x:160,y:0});
});
test('portrait bounds, resizing in focus mode and restoring whole page', () => {
  assert.deepEqual(boundZoom({scale:10,x:999,y:999},{width:300,height:400},{width:300,height:600}),{scale:4,x:250,y:600});
  const restored=boundZoom({scale:1,x:999,y:999},{width:300,height:600},{width:300,height:600});
  assert.deepEqual(restored,{scale:1,x:0,y:0});
  assert.deepEqual(boundZoom({scale:3,x:2,y:3},{width:0,height:0},{width:0,height:0}),{scale:1,x:0,y:0});
});
