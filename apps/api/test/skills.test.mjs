import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductSkills } from '../dist/agent/skills.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bio-skills-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function add(root, name, body = 'Only loaded on demand.') {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Instructions for ${name} tasks.\n---\n${body}`);
}

test('new product skills are discovered without registration; only metadata is advertised', async t => {
  const root = fixture(t);
  add(root, 'first');
  add(root, 'second', 'A distinct full instruction.');
  const { prompt, tool } = createProductSkills(root);
  assert.match(prompt, /first/);
  assert.match(prompt, /second/);
  assert.ok(!prompt.includes('A distinct full instruction.'));
  const result = await tool.execute('call', { name: 'second' });
  assert.match(result.content[0].text, /A distinct full instruction/);
  await assert.rejects(tool.execute('call', { name: '../second/SKILL.md' }), /技能不存在/);
  await assert.rejects(tool.execute('call', { name: 'unknown' }), /技能不存在/);
});

test('product skill content is a session snapshot and loading respects cancellation', async t => {
  const root = fixture(t);
  add(root, 'first', 'Original rules.');
  const { tool } = createProductSkills(root);
  add(root, 'first', 'Changed rules.');
  assert.match((await tool.execute('call', { name: 'first' })).content[0].text, /Original rules/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(tool.execute('call', { name: 'first' }, controller.signal), { name: 'AbortError' });
});

test('malformed skills and links to resources outside the product root fail closed', t => {
  const root = fixture(t);
  add(root, 'invalid');
  writeFileSync(join(root, 'invalid', 'SKILL.md'), 'No metadata.');
  assert.throws(() => createProductSkills(root), /Invalid product skills/);
  rmSync(join(root, 'invalid'), { recursive: true });
  const outside = fixture(t);
  add(outside, 'external');
  symlinkSync(join(outside, 'external'), join(root, 'external'));
  assert.throws(() => createProductSkills(root), /outside the skill directory/);
});

test('bundled writing skills are independently discoverable and load only the selected instructions', async () => {
  const { prompt, tool } = createProductSkills();
  for (const name of ['travel-writing', 'memoir-writing']) {
    assert.ok(prompt.includes(name));
    const result = await tool.execute('call', { name });
    const source = readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8');
    assert.equal(result.content[0].text, source);
    assert.ok(!prompt.includes(source));
  }
  assert.ok(!prompt.includes('personal-narrative'));
  await assert.rejects(tool.execute('call', { name: 'personal-narrative' }), /技能不存在/);
});
