import 'reflect-metadata';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigService } from '@nestjs/config';
import { AgentStorage } from '../dist/agent/agent-storage.js';
import { PiSessionFactory } from '../dist/agent/pi-session.factory.js';
import { AgentService } from '../dist/agent/agent.service.js';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
const root = await mkdtemp(join(tmpdir(), 'bio-dialogue-'));
const config = new ConfigService({ ...process.env, AGENT_DATA_DIR: root });
const storage = new AgentStorage(config);
const agent = new AgentService(new PiSessionFactory(config, storage, {}), storage, config);
try {
  const absent = await agent.run({ message: '你记得我们上次聊到哪里了吗？' });
  assert.match(absent.message.content, /没有|没法|不能|不记得|无法|没接|看不到|不确定|没.*记忆|没.*记录/);
  assert.doesNotMatch(absent.message.content, /都留着|记得一些/);
  console.log('memory unavailable:', absent.message.content);
  const uncertain = await agent.run({ message: '第一家公司我不想去。第二家公司我很感兴趣，但还没决定接受，我想再等一周。你理解我对第二家的想法了吗？' });
  assert.doesNotMatch(uncertain.message.content, /偏向不去|已经决定|不想去第二/);
  assert.match(uncertain.message.content, /没|还|不确定|犹豫|再等/);
  console.log('uncertainty:', uncertain.message.content);
  const dates = await agent.run({ message: '按2026年9月16日到10月8日计算，不计起始日，隔多少天？请给出准确天数。' });
  assert.match(dates.message.content, /22|二十二/);
  console.log('date span:', dates.message.content);
} finally { await rm(root, { recursive: true, force: true }); }
