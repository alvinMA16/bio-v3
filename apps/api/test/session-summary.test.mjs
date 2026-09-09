import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SessionSummaryDto } from '../dist/chat/dto/session-summary.dto.js';
import { parseSessionSummary } from '../dist/chat/session-summary.service.js';

test('summary output accepts JSON and rejects malformed or unbounded model responses', () => {
  assert.deepEqual(parseSessionSummary('```json\n{"summary":" 回忆童年 ","topics":["家人","家人"]}\n```'), {
    summary: '回忆童年', topics: ['家人'],
  });
  for (const text of ['null', '{}', '{"summary":"","topics":[]}', '{"summary":"回顾","topics":[3]}', JSON.stringify({ summary: '字'.repeat(161), topics: [] })]) {
    assert.throws(() => parseSessionSummary(text));
  }
});

test('summary input validates nested messages and enforces transcript bounds', async () => {
  for (const value of [{ messages: [] }, { messages: [{ role: 'system', content: 'hello' }] },
    { messages: [{ role: 'user', content: '字'.repeat(1001) }] },
    { messages: Array.from({ length: 41 }, () => ({ role: 'user', content: 'hello' })) }]) {
    assert.ok((await validate(plainToInstance(SessionSummaryDto, value))).length);
  }
  assert.equal((await validate(plainToInstance(SessionSummaryDto, { messages: [{ role: 'user', content: 'hello' }] }))).length, 0);
});
