// Run from repository root after building API. Tool executions and playback are local.
// --live uses the existing production container solely as a credential-preserving
// model API relay. It does not invoke the production Agent or change stored data.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const require = createRequire(resolve('apps/api/package.json'));
require('reflect-metadata');
const ts = require('typescript');
const { PanelWorkspace } = await import('../../apps/api/dist/agent/panel-workspace.js');
const currentTools = await import('../../apps/api/dist/agent/presentation-tools.js');
const currentContext = await import('../../apps/api/dist/agent/agent-context.js');
const baseline = process.env.NARRATION_BASELINE ?? 'HEAD';
const oldPaths = [];
function oldModule(name) {
  const source = execFileSync('git', ['show', `${baseline}:apps/api/src/agent/${name}.ts`], { encoding: 'utf8' });
  const path = resolve(`apps/api/dist/agent/.narration-baseline-${name}-${process.pid}.js`);
  oldPaths.push(path);
  writeFileSync(path, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
  return import(pathToFileURL(path));
}
const tracePath = process.argv.find(a => a.startsWith('--trace='))?.slice(8);
if (tracePath && process.argv.includes('--live')) throw Error('Live mode uses synthetic text only; trace fixtures are offline-only.');
const outputPath = process.argv.find(a => a.startsWith('--output='))?.slice(9);
const trace = tracePath ? readFileSync(tracePath, 'utf8').trim().split('\n').map(JSON.parse) : [];
const document = trace.find(e => e.type === 'panel.state.updated' && e.data.panel.document)?.data.panel.document ?? {
  id: 'experiment', title: '海边散步', version: 1, blocks: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, kind: 'paragraph',
    text: `第${i + 1}段。早晨沿着海边的小路散步，风吹过树梢，远处传来海浪的声音。我们在路口停下来，看到一家刚刚开门的面包店。店主把温热的面包放进纸袋，笑着告诉我们今天的天气很好。我们带着早餐继续往前走，在长椅上坐了一会儿，安静地看着阳光落在水面上。` })) };
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const relayCode = `import {GoogleGenAI} from '@google/genai';let s='';for await(const c of process.stdin)s+=c;const request=JSON.parse(s);const client=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY,httpOptions:{...(process.env.GEMINI_BASE_URL?{baseUrl:process.env.GEMINI_BASE_URL,apiVersion:''}:{}),timeout:90000}});try{const r=await client.models.generateContent(request);process.stdout.write(JSON.stringify({candidate:r.candidates?.[0],usage:r.usageMetadata}));}catch(e){process.stdout.write(JSON.stringify({error:{name:e.name,status:e.status??null}}));process.exitCode=1;}`;
const relayCommand = `docker exec -i bio-v3-api-1 node --input-type=module -e ${quote(relayCode)}`;
async function generate(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['qs@neozeppelin.com', relayCommand], { stdio: ['pipe', 'pipe', 'pipe'] });
    let data = '', error = '';
    const timeout = setTimeout(() => { child.kill(); reject(Error('Relay timeout')); }, 100000);
    child.stdout.on('data', c => { data += c; }); child.stderr.on('data', c => { error += c; });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timeout); if (code) reject(Error(`Relay failed ${code}: ${error.slice(0, 200)}`)); else resolve(JSON.parse(data)); });
    child.stdin.end(JSON.stringify(payload));
  });
}
const roots = [], report = { method: 'Local real-tool loop; live Gemini generation through credential-preserving relay; immediate simulated TTS/playback; no production Agent, memory, explicit cache or ASR', baseline,
  documentCharacters: document.blocks.reduce((n, b) => n + b.text.length, 0), historicObserved: trace.filter(e => e.type === 'model.response').map(e => e.data), arms: [] };
try {
  const oldTools = await oldModule('presentation-tools'), oldContext = await oldModule('agent-context');
  for (const arm of ['old', 'new']) {
    const root = mkdtempSync(join(tmpdir(), 'bio-narration-bench-')); roots.push(root);
    const workspace = new PanelWorkspace(root); workspace.showDocument(document);
    const history = [{ role: 'user', parts: [{ text: '请从开头到结尾，逐字朗读这篇已经写好的文章。' }] }];
    let directCharacters = 0;
    const runtime = { beforeShow: async () => {}, narrate: async (chunks, played) => { directCharacters += chunks.reduce((n, c) => n + c.text.length, 0); chunks.forEach((_, i) => played(i)); } };
    const tools = (arm === 'old' ? oldTools : currentTools).createPresentationTools(workspace, () => {}, undefined,
      { store: { get: async (_u, id) => { if (id !== document.id) throw Error('Unknown document'); return document; } }, conversationId: 'experiment' }, runtime);
    const context = arm === 'old' ? oldContext : currentContext;
    const stats = { arm, calls: [], modelTextCharacters: 0, directCharacters: 0, toolCalls: [], completed: false };
    report.arms.push(stats);
    if (!process.argv.includes('--live')) {
      // Offline execution validates the new content path, not token usage.
      if (arm === 'new') await tools.find(t => t.name === 'narrate_document').execute('offline', { documentId: document.id, scope: 'all' });
      stats.directCharacters = directCharacters; continue;
    }
    for (let i = 0; i < 12; i++) {
      const payload = { model: 'gemini-3.8-flash', contents: [...history, { role: 'user', parts: [{ text: context.buildRuntimeContext(undefined, workspace.context(arm === 'new')) }] }],
        config: { systemInstruction: context.buildSystemPrompt('你是令狸，用户的人生记录伙伴。'), temperature: 0, maxOutputTokens: 8192,
          thinkingConfig: { thinkingLevel: 'LOW' }, tools: [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }] } };
      const start = Date.now(), result = await generate(payload);
      if (!result.candidate?.content) throw Error('Missing model result');
      stats.calls.push({ durationMs: Date.now() - start, usage: result.usage, finishReason: result.candidate.finishReason });
      const content = result.candidate.content;
      history.push(content);
      stats.modelTextCharacters += content.parts.filter(p => p.text && !p.thought).reduce((n, p) => n + p.text.length, 0);
      const calls = content.parts.filter(p => p.functionCall).map(p => p.functionCall);
      console.log(JSON.stringify({ arm, call: i + 1, usage: result.usage, tools: calls.map(c => c.name) }));
      if (!calls.length) { stats.completed = result.candidate.finishReason === 'STOP'; break; }
      const responses = [];
      for (const call of calls) {
        stats.toolCalls.push({ name: call.name, scope: call.args?.scope, page: call.args?.page, navigation: call.args?.navigation });
        const tool = tools.find(t => t.name === call.name);
        if (!tool) throw Error(`Unknown tool ${call.name}`);
        const value = await tool.execute(`call_${i}`, call.args);
        responses.push({ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: { result: value.content } } });
      }
      history.push({ role: 'user', parts: responses });
    }
    stats.directCharacters = directCharacters;
  }
  for (const arm of report.arms) arm.totals = arm.calls.reduce((sum, c) => {
    const u = c.usage ?? {};
    sum.input += u.promptTokenCount ?? 0; sum.output += (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
    sum.cached += u.cachedContentTokenCount ?? 0; return sum;
  }, { input: 0, output: 0, cached: 0 });
  if (outputPath) writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ documentCharacters: report.documentCharacters, arms: report.arms.map(({ calls, ...s }) => ({ ...s, modelCalls: calls.length })) }));
} finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); for (const path of oldPaths) rmSync(path, { force: true }); }
