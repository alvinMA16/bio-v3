// Run via stdin in the API working directory; credentials remain in the runtime environment.
// Produces metrics only. Reconstructs one fixed historical fixture and never executes generated tools.
import 'reflect-metadata';
import {readFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
import {streamSimple} from '@earendil-works/pi-ai/api/google-generative-ai';
import {convertToLlm} from '@earendil-works/pi-coding-agent';
import {PanelWorkspace} from './dist/agent/panel-workspace.js';
import {createPresentationTools} from './dist/agent/presentation-tools.js';
import {createMemoryTools} from './dist/memory/memory-tools.js';
import {buildRuntimeContext,buildSystemPrompt} from './dist/agent/agent-context.js';
import {GEMINI_SEARCH_RULES} from './dist/models/gemini-search.js';
import {MEMORY_RULES} from './dist/memory/memory-types.js';
import {CALL_HISTORY_RULES} from './dist/memory/call-history.js';
const requireGenai=createRequire(import.meta.resolve('@earendil-works/pi-ai/api/google-generative-ai'));
const {GoogleGenAI}=requireGenai('@google/genai');
const client=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY,httpOptions:{...(process.env.GEMINI_BASE_URL?{baseUrl:process.env.GEMINI_BASE_URL,apiVersion:''}:{}),timeout:90000}});
const output=row=>console.log(JSON.stringify({...row,at:new Date().toISOString()}));
const fixture=process.env.CACHE_EXPERIMENT_FIXTURE??'synthetic';
if(!['synthetic','historical'].includes(fixture))throw Error('Unknown fixture');
const root=await mkdtemp(join(tmpdir(),'bio-history-ab-'));
try{
 const rows=[];
 if(fixture==='historical'){
 const dir=join(process.env.AGENT_DATA_DIR,'traces');
 for(const name of await readdir(dir)){if(!name.endsWith('.jsonl'))continue;const rr=(await readFile(join(dir,name),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);if(rr[0]?.conversationId==='9cb03f44-a1f0-48d5-8b47-25ee85adc564')rows.push(...rr);}
 rows.sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.sequence-b.sequence);
 }
 const workspace=new PanelWorkspace(root);const tools=[...createPresentationTools(workspace,()=>{}),...createMemoryTools({},'owner')].map(({name,description,parameters})=>({name,description,parameters}));
 const history=[],cases=[];let request,panel;
 if(fixture==='synthetic'){
  const reference=Array.from({length:60},(_,i)=>`虚构果园记录${i}：第${i%9}区有${i*7+11}棵树，样本编号${i*7919}。本段仅为缓存实验合成资料，不描述真实人物。`).join('\n');
  const user=text=>({role:'user',content:text,timestamp:1});
  const assistant=text=>({role:'assistant',content:[{type:'text',text}],api:'google-generative-ai',provider:'bio-gemini',model:process.env.GEMINI_MODEL,stopReason:'stop',timestamp:1,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
  for(let n=1;n<=8;n++){
   history.push(user(n===1?`以下都是虚构资料，仅供测试。${reference}\n只回复“收到”，不要使用工具。`:`继续核对虚构记录${n}，只回复“收到”，不要使用工具。`));
   const document={id:'synthetic-document',title:'虚构果园实验文稿',version:n<5?1:2,blocks:[{id:'p1',kind:'paragraph',text:reference+(n<5?'':'\n第五轮起增加一条虚构记录。')}]};
   workspace.value={panel:{mode:'editor',revision:n,document,documentView:{documentId:document.id,version:document.version,page:1}},documents:[document],attachments:[]};
   workspace.documentDirectory=[{id:document.id,title:document.title,version:document.version}];
   workspace.acknowledgedView=undefined;
   const view=workspace.context();view.screen.visibleContent=[{blockId:'p1',start:n*20,end:n*20+120,text:reference.slice(n*20,n*20+120)}];
   const runtime={role:'custom',customType:'bio_runtime_context',content:buildRuntimeContext(undefined,view),display:false,timestamp:1};
   cases.push({n,original:convertToLlm(structuredClone([...history.slice(0,-1),runtime,history.at(-1)])),tail:convertToLlm(structuredClone([...history,runtime]))});
   history.push(assistant('收到。'));
  }
 }
 for(const r of rows){
  if(r.type==='request')request=r.data;
  if(r.type==='panel.state.updated')panel=r.data.panel;
  if(r.type==='message_end')history.push(r.data.message);
  if(r.type==='model.request'){
   workspace.value={panel:structuredClone(panel),documents:[panel.document],attachments:[]};workspace.documentDirectory=[{id:panel.document.id,title:panel.document.title,version:panel.document.version}];workspace.acknowledgedView=undefined;
   workspace.acceptDocumentView(request.context?.documentView);
   const runtime={role:'custom',customType:'bio_runtime_context',content:buildRuntimeContext(request.context,workspace.context()),display:false,timestamp:1};
   let idx=history.length-1;while(idx>=0&&history[idx].role!=='user'&&history[idx].customType!=='bio_call_opening')idx--;
   const original=[...history.slice(0,idx),runtime,...history.slice(idx)];const tail=[...history,runtime];
   cases.push({n:cases.length+1,original:convertToLlm(structuredClone(original)),tail:convertToLlm(structuredClone(tail))});
  }
 }
 const id=process.env.GEMINI_MODEL||'gemini-3.8-flash';const model={id,name:id,api:'google-generative-ai',provider:'bio-gemini',baseUrl:process.env.GEMINI_BASE_URL||'https://generativelanguage.googleapis.com/v1beta',reasoning:true,input:['text'],contextWindow:1048576,maxTokens:8192,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
 const systemPrompt=buildSystemPrompt('你是令狸，用户的人生记录伙伴。')+GEMINI_SEARCH_RULES+'\n当前能力：内容工具可用；长期记忆已启用，依据下方概要与只读工具检索。\n'+MEMORY_RULES+'\n'+CALL_HISTORY_RULES;
 output({revision:process.env.BIO_COMMIT,run:'stable-prefix-v2',fixture,kind:'method',cases:cases.length,model:id,source:fixture==='historical'?'historical message_end, tool results, panel states and submitted view':'synthetic Chinese orchard records; viewport changes each call; document version changes at call 5',limitations:'Historical mode is reconstruction, not exact replay. Fixed system without historical memory summary; same 512 output cap in all arms. No returned tool calls are executed. Arms share implicit-cache namespace.'});
 if(cases.length!==8)throw Error('Unexpected fixture size');
 const payloads=[];
 for(const c of cases){
  const entry={n:c.n};
  for(const arm of ['original','tail']){
   let captured;
   const stream=streamSimple(model,{systemPrompt,messages:c[arm],tools},{apiKey:process.env.GEMINI_API_KEY,reasoning:'low',maxTokens:512,onPayload:p=>{
    p.config.tools.push({googleSearch:{}});
    p.config.toolConfig={...p.config.toolConfig,includeServerSideToolInvocations:true};
    captured=structuredClone(p);throw Error('LOCAL_CAPTURE_ONLY');
   }});
   for await(const event of stream){}await stream.result();
   if(!captured)throw Error('Payload capture failed');
   entry[arm]=captured;
  }
  payloads.push(entry);
 }
 const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
 const errorInfo=e=>({status:e.status??e.code??null,name:e.name,message:String(e.message).replaceAll(process.env.GEMINI_API_KEY,'[REDACTED]').slice(0,500)});
 async function generate(p,label){
  const start=Date.now();let firstChunkMs=null,firstTextMs=null,usage=null,finish=null,chunks=0,toolCalls=0,textChars=0,error=null;
  try{
   const response=await client.models.generateContentStream(p);
   for await(const chunk of response){
    chunks++;firstChunkMs??=Date.now()-start;
    if(chunk.usageMetadata)usage=chunk.usageMetadata;
    for(const candidate of chunk.candidates??[]){
     finish=candidate.finishReason??finish;
     for(const part of candidate.content?.parts??[]){
      if(part.text&&!part.thought){firstTextMs??=Date.now()-start;textChars+=part.text.length;}
      if(part.functionCall)toolCalls++;
     }
    }
   }
  }catch(e){error=errorInfo(e);}
  output({kind:'generation',...label,ms:Date.now()-start,firstChunkMs,firstTextMs,chunks,textChars,toolCalls,finish,usage,cacheFieldPresent:usage?Object.hasOwn(usage,'cachedContentTokenCount'):false,error});
  if(error)throw Error('Generation failed; see metric record');
 }
 async function remove(cache,round,reason){
  if(!cache)return;
  const start=Date.now();let error=null;
  try{await client.caches.delete({name:cache.name});}catch(e){error=errorInfo(e);}
  output({kind:'cache_delete',round,reason,ms:Date.now()-start,error});
 }
 for(let round=1;round<=2;round++){
  let cache=null,cachePrefix=[],cacheConfig=null;
  const previous={};
  try{
   for(const c of payloads){
    const orders=round===1?[['original','tail','explicit'],['tail','explicit','original'],['explicit','original','tail']]:[['explicit','tail','original'],['original','explicit','tail'],['tail','original','explicit']];
    for(const arm of orders[(c.n-1)%3]){
     let p=structuredClone(c[arm==='original'?'original':'tail']);
     const hashes=p.contents.map(digest);let commonMessages=null;
     if(previous[arm]){commonMessages=0;while(commonMessages<Math.min(hashes.length,previous[arm].length)&&hashes[commonMessages]===previous[arm][commonMessages])commonMessages++;}
     previous[arm]=hashes;
     let setupMs=0;
     if(arm==='explicit'){
      if(c.n===5&&cache){await remove(cache,round,'grow_prefix');cache=null;}
      if(cache&&!isDeepStrictEqual(p.contents.slice(0,cachePrefix.length),cachePrefix))throw Error('Cached prefix changed');
      if(!cache&&c.n>1){
       // Cache only the previous call's stable history, excluding its ephemeral runtime tail.
       const prefix=payloads[c.n-2].tail.contents.slice(0,-1);
       if(!isDeepStrictEqual(p.contents.slice(0,prefix.length),prefix))throw Error('Candidate prefix changed');
       const config={contents:prefix,systemInstruction:p.config.systemInstruction,tools:p.config.tools,toolConfig:p.config.toolConfig,ttl:'600s'};
       const start=Date.now();let error=null,tokenCount=null;
       try{
        tokenCount=(await client.models.countTokens({model:id,contents:prefix})).totalTokens;
       }catch(e){output({kind:'count_error',round,case:c.n,error:errorInfo(e)});}
       try{cache=await client.caches.create({model:id,config});cachePrefix=structuredClone(prefix);cacheConfig=structuredClone(config);}catch(e){error=errorInfo(e);}
       setupMs=Date.now()-start;
       output({kind:'cache_create',round,case:c.n,ms:setupMs,contentsCount:prefix.length,prefixContentTokens:tokenCount,usage:cache?.usageMetadata??null,expireTime:cache?.expireTime??null,error});
      }
      if(cache){
       for(const field of ['systemInstruction','tools','toolConfig']){
        if(!isDeepStrictEqual(p.config[field],cacheConfig[field]))throw Error('Cached config changed');
        delete p.config[field];
       }
       p.contents=p.contents.slice(cachePrefix.length);p.config.cachedContent=cache.name;
       if(!isDeepStrictEqual([...cachePrefix,...p.contents],c.tail.contents))throw Error('Expanded request differs');
      }
     }
     await generate(p,{round,arm,case:c.n,commonMessages,fullMessageCount:hashes.length,requestFingerprint:digest(c[arm==='original'?'original':'tail']),cacheActive:arm==='explicit'&&!!cache,cachedMessages:arm==='explicit'&&cache?cachePrefix.length:0,setupMs});
    }
   }
  }finally{await remove(cache,round,'round_complete');}
 }
}finally{await rm(root,{recursive:true,force:true});}
