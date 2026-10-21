import test from 'node:test';
import assert from 'node:assert/strict';
import { lensOffset, lensSurface, lensLighting } from '../src/glass-optics.ts';
test('glass field preserves the centre and refracts symmetrically without sampling extreme offsets', () => {
  for (const [w,h,r] of [[240,48,24],[44,44,22],[112,52,26],[180,55,17]]) {
    assert.deepEqual(lensOffset(w/2,h/2,w,h,r), {x:0,y:0});
    for (let y=0;y<=h;y+=2) for(let x=0;x<=w;x+=2) {
      const a=lensOffset(x,y,w,h,r), b=lensOffset(w-x,h-y,w,h,r);
      assert.ok(Number.isFinite(a.x)&&Number.isFinite(a.y));
      assert.ok(Math.abs(a.x)<16&&Math.abs(a.y)<16);
      assert.ok(Math.abs(a.x+b.x)<1e-8&&Math.abs(a.y+b.y)<1e-8);
    }
    assert.ok(Math.abs(lensOffset(w/2,3,w,h,r).y)>0);
  }
});

test('capsule highlights follow the curved edge and keep the centre clear', () => {
  const top=lensSurface(120,1,240,48,24),bottom=lensSurface(120,47,240,48,24);
  assert.equal(top.depth,bottom.depth);
  const upper=lensLighting(top.depth,top.nx,top.ny),lower=lensLighting(bottom.depth,bottom.nx,bottom.ny);
  assert.ok(upper.light>lower.light);
  assert.ok(lower.shade>upper.shade);
  assert.ok(lensLighting(24,0,0).light<.001);
  assert.deepEqual(lensLighting(-1,1,0),{light:0,shade:0});
});
