import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { chooseFoxBehavior, DEFAULT_FOX_ACTIVITY } from '../../miniprogram/miniprogram/lib/fox-behavior.ts';

// Compile only the shared controller for Node; production keeps extensionless mini-program imports.
const source = name => readFileSync(new URL(`../../miniprogram/miniprogram/lib/${name}.ts`, import.meta.url), 'utf8');
const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64')}`;
const behaviorUrl = moduleUrl(source('fox-behavior'));
const { FoxAnimationController } = await import(moduleUrl(source('fox-animation-controller').replace("'./fox-behavior'", JSON.stringify(behaviorUrl))));
const activity = fields => ({ ...DEFAULT_FOX_ACTIVITY, ...fields });

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const states = [];
  const controller = new FoxAnimationController(state => states.push(state));
  t.after(() => controller.destroy());
  return { controller, last: () => states.at(-1), states };
}

test('listening interrupts speech; speech takes priority over writing; reduced motion stays still', () => {
  assert.deepEqual(chooseFoxBehavior(activity({ phase: 'listening', speech: 'audio' })), { action: 'blink', playback: 'ambient' });
  assert.deepEqual(chooseFoxBehavior(activity({ phase: 'writing', speech: 'audio', notebook: true })), { action: 'notebookTalk', playback: 'speech' });
  assert.deepEqual(chooseFoxBehavior(activity({ phase: 'writing', reducedMotion: true })), { action: 'blink', playback: 'still' });
});

test('welcome plays once and is immediately interrupted by user speech', t => {
  const { controller, last } = setup(t);
  controller.startWelcomeSequence();
  assert.equal(last().action.id, 'wave');
  controller.setActivity(activity({ phase: 'listening' }));
  assert.equal(last().action.id, 'blink');
  controller.startWelcomeSequence();
  assert.equal(last().action.id, 'blink');
});

test('short writes do not flash an animation; sustained writes pause holding the notebook', t => {
  const { controller, last } = setup(t);
  controller.setActivity(activity({ phase: 'writing', notebook: true }));
  t.mock.timers.tick(200);
  controller.setActivity(activity({ notebook: true }));
  t.mock.timers.tick(500);
  assert.equal(last().action.id, 'notebookTalk');
  assert.equal(last().frame, 0);
  controller.setActivity(activity({ phase: 'writing', notebook: true }));
  t.mock.timers.tick(450);
  assert.equal(last().action.id, 'note');
  for (let i = 0; i < 13; i++) t.mock.timers.tick(200);
  assert.equal(last().action.id, 'notebookTalk');
  t.mock.timers.tick(1800);
  assert.equal(last().action.id, 'note');
});

test('audio keeps talking after agent becomes idle, and interruption stops its loop', t => {
  const { controller, last } = setup(t);
  controller.setActivity(activity({ phase: 'processing', speech: 'audio' }));
  t.mock.timers.tick(170);
  const frame = last().frame;
  controller.setActivity(activity({ phase: 'idle', speech: 'audio' }));
  assert.equal(last().frame, frame);
  for (let i = 0; i < 20; i++) t.mock.timers.tick(170);
  assert.equal(last().action.id, 'notebookTalk');
  controller.setActivity(activity({ phase: 'listening', speech: 'audio' }));
  assert.equal(last().action.id, 'blink');
  assert.equal(last().frame, 0);
});

test('hidden page and destroyed controller stop emitting frames; resume uses latest activity', t => {
  const { controller, states, last } = setup(t);
  controller.setActivity(activity({ speech: 'text' }));
  controller.suspend();
  const count = states.length;
  t.mock.timers.tick(5000);
  assert.equal(states.length, count);
  controller.setActivity(activity({ notebook: true }));
  controller.resume();
  assert.equal(last().action.id, 'notebookTalk');
  controller.destroy();
  const destroyedCount = states.length;
  t.mock.timers.tick(40_000);
  assert.equal(states.length, destroyedCount);
});

test('acknowledgment requires notebook listening and has a cooldown', t => {
  const { controller, last } = setup(t);
  controller.setActivity(activity({ notebook: true, phase: 'listening' }));
  controller.acknowledge();
  assert.equal(last().action.id, 'nod');
  for (let i = 0; i < 13; i++) t.mock.timers.tick(200);
  controller.acknowledge();
  assert.equal(last().action.id, 'notebookTalk');
});


test('thinking writes with pauses, transitions to notebook speech, and stops on interruption or end', t => {
  const { controller, last } = setup(t);
  controller.setActivity(activity({ phase: 'processing' }));
  t.mock.timers.tick(450);
  assert.equal(last().action.id, 'note');
  controller.setActivity(activity({ phase: 'processing', speech: 'audio' }));
  assert.equal(last().action.id, 'notebookTalk');
  t.mock.timers.tick(170);
  assert.ok(last().frame > 0);
  controller.setActivity(activity({ phase: 'idle', speech: 'audio' }));
  assert.equal(last().action.id, 'notebookTalk');
  controller.setActivity(activity({ phase: 'listening', speech: 'audio' }));
  assert.equal(last().action.id, 'blink');
  assert.equal(last().frame, 0);
  controller.setActivity(activity({ phase: 'processing' }));
  t.mock.timers.tick(450);
  controller.setActivity(activity({ phase: 'idle' }));
  t.mock.timers.tick(3000);
  assert.equal(last().action.id, 'blink');
  assert.equal(last().frame, 0);
});

test('reading does not introduce a dedicated action or write notes', t => {
  const { controller, last } = setup(t);
  controller.setActivity(activity({ phase: 'reading' }));
  t.mock.timers.tick(3000);
  assert.equal(last().action.id, 'blink');
  assert.equal(last().frame, 0);
});
