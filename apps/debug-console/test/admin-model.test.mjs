import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminRoute,adminLink,adminQuery } from '../src/admin-model.ts';
test('admin deep links encode identifiers and preserve navigation across reloads',()=>{
  for(const page of ['overview','users','user','sessions','session','jobs','services']) {
    const route=adminRoute(adminLink(page,'owner/a#?','user&b'));
    assert.deepEqual(route,{page,id:'owner/a#?',user:'user&b'});
  }
  assert.equal(adminRoute('#page=unexpected').page,'overview');
  assert.equal(adminQuery('users',{q:'138%_&',offset:25,empty:undefined}),'users?q=138%25_%26&offset=25');
});
