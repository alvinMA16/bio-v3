// Frozen multi-turn history, real AgentService/Pi/context/tools, isolated local data.
import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AgentService } from '../dist/agent/agent.service.js';
import { AgentStorage } from '../dist/agent/agent-storage.js';
import { PiSessionFactory } from '../dist/agent/pi-session.factory.js';
import { PanelWorkspace } from '../dist/agent/panel-workspace.js';
import { MaterialsService } from '../dist/materials/materials.service.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const { values } = parseArgs({ options: {
  live: { type: 'boolean', default: false },
  cases: { type: 'string', default: join(repo, 'bench/voice/agent-cases.json') },
  output: { type: 'string' },
} });
if (!values.output) throw new Error('--output must name a new directory');
const cases = JSON.parse(await readFile(values.cases, 'utf8'));
const ids = new Set();
for (const c of cases) {
  if (!c.id || ids.has(c.id) || c.split !== 'dev' || !c.rubric?.expectation ||
      !['conversation', 'attachment_conversation'].includes(c.scene) ||
      !c.messages?.length || c.messages.at(-1).role !== 'user' ||
      c.messages.some(m => !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim()) ||
      (c.scene === 'attachment_conversation' && !c.attachment)) throw new Error('Invalid case');
  ids.add(c.id);
}
if (!cases.length) throw new Error('Empty case set');
const output = resolve(values.output);
await mkdir(output, { recursive: false, mode: 0o700 });
const root = await mkdtemp(join(tmpdir(), 'bio-agent-bench-'));
const requests = [];
let mock;
const sha = value => createHash('sha256').update(value).digest('hex');
const result = { version: 'agent-voice-v1', live: values.live, cases, artifacts: {}, results: [] };
try {
  for (const name of ['agent/agent-context', 'agent/pi-session.factory', 'agent/agent.service', 'models/model-provider']) {
    const source = await readFile(new URL(`../dist/${name}.js`, import.meta.url), 'utf8');
    result.artifacts[name] = { sha256: sha(source), source };
  }
  result.fingerprint = sha(JSON.stringify({ cases, artifacts: result.artifacts }));
  const settings = values.live ? { ...process.env } : {};
  if (!values.live) {
    mock = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'OFFLINE_PIPELINE_ONLY' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    mock.listen(0, '127.0.0.1');
    await once(mock, 'listening');
    Object.assign(settings, { MODEL_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'offline',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1` });
  }
  // No MemoryService: never connect to a database, even if env contains production settings.
  Object.assign(settings, { AGENT_DATA_DIR: root, GEMINI_GOOGLE_SEARCH_ENABLED: 'false', AGENT_TIMEOUT_MS: '60000' });
  const config = new ConfigService(settings);
  const storage = new AgentStorage(config);
  const materials = new MaterialsService(config);
  const factory = new PiSessionFactory(config, storage, materials);
  const agent = new AgentService(factory, storage, config);
  for (const c of cases) {
    const conversationId = randomUUID();
    const cwd = storage.conversationDirectory(conversationId);
    const panel = new PanelWorkspace(cwd, c.attachment ? [c.attachment] : []);
    panel.switchMode(c.scene, c.scene === 'attachment_conversation' ? c.attachment.id : undefined);
    const session = SessionManager.open(join(cwd, 'session.jsonl'), cwd, cwd);
    for (const [i, m] of c.messages.slice(0, -1).entries()) {
      session.appendMessage({ role: m.role, content: [{ type: 'text', text: m.content }], timestamp: i + 1,
        ...(m.role === 'assistant' ? { api: 'openai-completions', provider: 'bio-deepseek', model: 'deepseek-v4-flash', stopReason: 'stop',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } : {}) });
    }
    const start = performance.now();
    let firstTextMs;
    const offset = requests.length;
    try {
      const response = await agent.run({ conversationId, message: c.messages.at(-1).content }, event => {
        if (event.type === 'speech.delta' && event.delta && firstTextMs === undefined) firstTextMs = performance.now() - start;
      });
      result.results.push({ id: c.id, status: 'ok', response, firstTextMs, elapsedMs: performance.now() - start,
        trace: storage.readTrace(response.runId), ...(!values.live ? { requests: requests.slice(offset) } : {}) });
    } catch {
      // Do not expose provider error bodies, environment values or credentials.
      result.results.push({ id: c.id, status: 'failed', elapsedMs: performance.now() - start });
    }
    await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(`${c.id}: ${result.results.at(-1).status}`);
  }
  if (result.results.some(r => r.status !== 'ok')) process.exitCode = 1;
} finally {
  if (mock) { mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); }
  await rm(root, { recursive: true, force: true });
}
