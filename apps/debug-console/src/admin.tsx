import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PanelDocument } from '@bio/contracts';
import { DocumentReader } from './document-reader';
import { adminRoute, adminLink, adminQuery, statusLabels, auditLabels } from './admin-model';
import './admin.css';

type Row = Record<string,any>;
type PageData = { items:Row[];total:number;offset:number;limit:number };
const date=(value:unknown)=>value ? new Date(String(value)).toLocaleString('zh-CN',{ timeZone:'Asia/Shanghai',hour12:false }) : '—';
const label=(value:string)=>statusLabels[value] ?? value;
const enc=encodeURIComponent;
async function api(path:string,signal?:AbortSignal,method='GET') {
  const response=await fetch(`/api/v1/admin/${path}`,{method,...(signal ? {signal}: {})});
  const result=await response.json();
  if(!response.ok) throw new Error(response.status===403 ? '当前账号没有相应的管理权限。' : result.message || '暂时无法读取，请重试');
  return result;
}
function Resource({path,revision=0,children}:{path:string;revision?:number;children:(value:any)=>ReactNode}) {
  const [state,setState]=useState<{path?:string;data?:any;error?:string}>({});
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController(); setState({});
    void api(path,controller.signal).then(data=>{if(!controller.signal.aborted) setState({path,data});})
      .catch(error=>{if(!controller.signal.aborted) setState({path,error:error.message});});
    return ()=>controller.abort();
  },[path,revision,retry]);
  if(state.path===path && state.error) return <div className="admin-empty" role="alert"><p>{state.error}</p><button onClick={()=>setRetry(x=>x+1)}>重试</button>{path==='me' && <p><a href="/">返回产品首页</a></p>}</div>;
  if(state.path!==path || state.data===undefined) return <div className="admin-empty" role="status">正在读取…</div>;
  return <>{children(state.data)}</>;
}
function Badge({value}:{value:string}) { return <span className={`admin-badge admin-badge--${value}`}>{label(value)}</span>; }
function ID({value}:{value:string}) { return <span className="admin-id" title={value}>{value}</span>; }
function UserLink({id}:{id:string}) { return <a href={adminLink('user',id)}><ID value={id}/></a>; }
function Pager({data,onChange}:{data:PageData;onChange:(offset:number)=>void}) {
  return <div className="admin-pager"><span>{data.total ? `${data.offset+1}–${Math.min(data.offset+data.items.length,data.total)} / ${data.total}` : '暂无记录'}</span>
    <button disabled={data.offset===0} onClick={()=>onChange(Math.max(0,data.offset-data.limit))}>上一页</button>
    <button disabled={data.offset+data.items.length>=data.total} onClick={()=>onChange(data.offset+data.limit)}>下一页</button></div>;
}
type Column={name:string;render:(row:Row)=>ReactNode};
function Table({data,columns,onPage,empty='暂无记录'}:{data:PageData;columns:Column[];onPage:(offset:number)=>void;empty?:string}) {
  return <><div className="admin-table-wrap"><table><thead><tr>{columns.map(c=><th key={c.name} scope="col">{c.name}</th>)}</tr></thead>
    <tbody>{data.items.map((row,index)=><tr key={row.id ?? row.call_id ?? index}>{columns.map(c=><td key={c.name}>{c.render(row)}</td>)}</tr>)}</tbody></table>
    {!data.items.length && <div className="admin-empty">{empty}</div>}</div><Pager data={data} onChange={onPage}/></>;
}
function Json({value}:{value:unknown}) { return <pre className="admin-json">{JSON.stringify(value,null,2)}</pre>; }
function Dialog({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const dialog=ref.current;dialog?.showModal();return ()=>dialog?.close();},[]);
  return <dialog className="admin-dialog" ref={ref} aria-label={title} onCancel={event=>{event.preventDefault();onClose();}}>
    <header><h2>{title}</h2><button autoFocus onClick={onClose} aria-label="关闭详情">关闭</button></header><div className="admin-dialog-content">{children}</div></dialog>;
}
function Overview() {
  return <Resource path="overview">{data=><><div className="admin-metrics">{[
    ['用户',data.users],['今日使用人数',data.active_today],['近七日通话',data.calls_week],['近七日新增文稿',data.documents_week],
  ].map(([name,value])=><article key={name}><span>{name}</span><strong>{value}</strong></article>)}</div>
    <section className="admin-card"><h2>需要处理</h2><div className="admin-actions"><a className="admin-action" href={adminLink('jobs')}><strong>{data.failed_jobs}</strong><span>失败的记忆任务</span></a>
      <a className="admin-action" href={adminLink('jobs')}><strong>{data.waiting_jobs}</strong><span>等待或正在整理</span></a>
      <a className="admin-action" href={adminLink('sessions')}><strong>{data.failed_runs_week}</strong><span>近七日运行失败 · 已采集</span></a></div>
      {data.oldest_job && <p className="admin-muted">最早待整理任务：{date(data.oldest_job)}</p>}</section>
    <section className="admin-card"><h2>模型用量</h2><p className="admin-cost">{data.estimated_llm_cost_week===null ? '暂无可估算的费用' : `近七日约 ¥${Number(data.estimated_llm_cost_week).toFixed(4)}`}</p>
      <p className="admin-muted">{data.costCoverage}</p><p className="admin-muted">已有用量记录 {data.recorded_runs} / 归属运行记录 {data.owned_runs}；近七日可估价 {data.priced_runs_week} 次，价格未知 {data.unpriced_runs_week} 次。</p></section>
  </>}</Resource>;
}
function Users() {
  const [input,setInput]=useState(''),[query,setQuery]=useState(''),[offset,setOffset]=useState(0);
  return <><form className="admin-toolbar" onSubmit={event=>{event.preventDefault();setQuery(input);setOffset(0);}}>
    <input aria-label="搜索用户" placeholder="手机号或账号 ID" value={input} maxLength={100} onChange={event=>setInput(event.target.value)}/><button>搜索</button></form>
    <Resource path={adminQuery('users',{q:query,offset})}>{data=><Table data={data} onPage={setOffset} columns={[
      {name:'账号',render:row=><a href={adminLink('user',row.id)}>{row.phone}</a>},
      {name:'注册时间',render:row=>date(row.created_at)},{name:'最近使用',render:row=>date(row.last_activity)},
      {name:'通话',render:row=>row.calls},{name:'文稿',render:row=>row.documents},
      {name:'待处理',render:row=>Number(row.failed_jobs) ? <a href={adminLink('jobs','',row.id)}>{row.failed_jobs} 个失败任务</a> : '—'},
    ]}/>}</Resource></>;
}
function SessionList({user=''}:{user?:string}) {
  const [offset,setOffset]=useState(0);
  return <Resource path={adminQuery('sessions',{user,offset})}>{data=><Table data={data} onPage={setOffset} columns={[
    {name:'会话',render:row=><a href={adminLink('session',row.id)}>{date(row.activity_at)} · {row.call_id ? '通话' : '文字'}</a>},
    ...(!user ? [{name:'用户',render:(row:Row)=><UserLink id={row.user_id}/>}]:[]),
    {name:'状态',render:row=>row.status ? <Badge value={row.status}/> : '文字会话'},
    {name:'消息',render:row=>row.messages},{name:'记忆整理',render:row=>row.job_status ? <Badge value={row.job_status}/> : '—'},
  ]}/>}</Resource>;
}
function Trace({id}:{id:string}) {
  const [offset,setOffset]=useState(0);
  return <Resource path={adminQuery(`runs/${enc(id)}/trace`,{offset})}>{data=><><div className="admin-trace">{data.items.map((row:Row,index:number)=><details key={index}><summary>{row.sequence} · {row.type} <time>{date(row.timestamp)}</time></summary><Json value={row.data}/></details>)}</div><Pager data={data} onChange={setOffset}/></>}</Resource>;
}
function Session({id}:{id:string}) {
  const [offset,setOffset]=useState(0),[run,setRun]=useState('');
  return <Resource path={adminQuery(`sessions/${enc(id)}`,{offset})}>{data=><>
    <div className="admin-toolbar"><UserLink id={data.user_id}/>{data.status && <Badge value={data.status}/>}<span>{date(data.started_at)}{data.ended_at && ` → ${date(data.ended_at)}`}</span></div>
    {data.call_summary && <section className="admin-card"><h2>通话摘要</h2><p>{data.call_summary.summary}</p></section>}
    <section className="admin-card"><h2>逐轮原文与执行</h2><div className="admin-messages">{data.messages.items.map((row:Row)=><article key={row.id}>
      <header><Badge value={row.role}/><time>{date(row.created_at)}</time><button onClick={()=>setRun(row.run_id)}>查看本轮 Trace</button></header>
      <p>{row.body}</p></article>)}</div><Pager data={data.messages} onChange={setOffset}/></section>
    <section className="admin-card"><h2>运行用量与播放反馈</h2>{!data.runs.length && <p className="admin-muted">没有采集到运行用量；可从原文打开 Trace。</p>}
      {data.runs.map((row:Row)=><details key={row.id}><summary>{date(row.created_at)} · {row.model ?? '模型未知'} · {label(row.status)} · {row.duration_ms} ms</summary>
        <button onClick={()=>setRun(row.id)}>查看 Trace</button><Json value={{usage:row.usage,estimatedCost:row.estimated_cost,playback:row.playback ?? '无匹配播放记录'}}/></details>)}</section>
    {run && <Dialog title="运行记录" onClose={()=>setRun('')}><Trace id={run}/></Dialog>}
  </>}</Resource>;
}
function Jobs({user='',role}:{user?:string;role:string}) {
  const [status,setStatus]=useState('failed'),[offset,setOffset]=useState(0),[revision,setRevision]=useState(0);
  const [busy,setBusy]=useState(''),[notice,setNotice]=useState(''),[confirm,setConfirm]=useState<Row>();
  async function retry() {
    if(!confirm || busy) return;
    setBusy(confirm.call_id);setNotice('');
    try {await api(`jobs/${enc(confirm.call_id)}/retry`,undefined,'POST');setNotice('已重新排队，将按同用户任务顺序执行。');setConfirm(undefined);setRevision(x=>x+1);}
    catch(error) {setNotice(error instanceof Error ? error.message : '重试失败');}
    finally {setBusy('');}
  }
  return <><div className="admin-toolbar"><label>任务状态 <select value={status} onChange={event=>{setStatus(event.target.value);setOffset(0);}}>
    <option value="">全部</option>{['failed','pending','running','done'].map(value=><option key={value} value={value}>{label(value)}</option>)}</select></label></div>
    {notice && <p role="status" className="admin-notice">{notice}</p>}
    <Resource path={adminQuery('jobs',{user,status,offset})} revision={revision}>{data=><Table data={data} onPage={setOffset} columns={[
      {name:'通话',render:row=><a href={adminLink('session',row.conversation_id)}>{date(row.created_at)}</a>},
      ...(!user ? [{name:'用户',render:(row:Row)=><UserLink id={row.user_id}/>}]:[]),
      {name:'状态',render:row=><><Badge value={row.status}/>{row.blocked && <small className="admin-muted"> 等待前序任务</small>}</>},
      {name:'尝试',render:row=>row.attempts},{name:'错误',render:row=>row.error || '—'},
      {name:'操作',render:row=>row.status==='failed' && role==='operator' ? <button disabled={!!busy} onClick={()=>{setNotice('');setConfirm(row);}}>重试</button> : '—'},
    ]}/>}</Resource>
    {confirm && <Dialog title="重试记忆整理" onClose={()=>{if(!busy)setConfirm(undefined);}}><p>重新整理这通电话的原文。任务会再次调用模型，并可能产生费用。</p>
      <p>{date(confirm.created_at)} · <ID value={confirm.call_id}/></p><button disabled={!!busy} onClick={()=>void retry()}>{busy ? '正在提交…' : '确认重试'}</button></Dialog>}
  </>;
}
function DocumentDetail({user,id}:{user:string;id:string}) {
  const [offset,setOffset]=useState(0),[version,setVersion]=useState('');
  return <Resource path={adminQuery(`users/${enc(user)}/documents/${enc(id)}`,{offset})}>{data=><>
    <div className={version ? 'admin-document-compare' : ''}><DocumentReader document={data.document}/>
      {version && <Resource path={`users/${enc(user)}/documents/${enc(id)}/revisions/${version}`}>{(old:PanelDocument)=><DocumentReader document={old}/>}</Resource>}</div>
    {version && <button onClick={()=>setVersion('')}>关闭历史版本对照</button>}
    <h3>历史版本</h3><Table data={data.revisions} onPage={setOffset} columns={[
      {name:'版本',render:row=><button onClick={()=>setVersion(String(row.version))}>版本 {row.version} · 对照</button>},
      {name:'修改说明',render:row=>row.summary},{name:'时间',render:row=>date(row.created_at)},
      {name:'来源会话',render:row=><a href={adminLink('session',row.conversation_id)}>打开会话</a>},
    ]}/></>}</Resource>;
}
function Documents({user}:{user:string}) {
  const [offset,setOffset]=useState(0),[id,setId]=useState('');
  return <><Resource path={adminQuery(`users/${enc(user)}/documents`,{offset})}>{data=><Table data={data} onPage={setOffset} columns={[
    {name:'文稿',render:row=><button onClick={()=>setId(row.id)}>{row.title || '未命名文稿'}</button>},
    {name:'版本',render:row=>row.version},{name:'最后修改',render:row=>date(row.updated_at)},
    {name:'创建会话',render:row=><a href={adminLink('session',row.origin_conversation_id)}>打开会话</a>},
  ]}/>}</Resource>{id && <Dialog title="文稿与版本" onClose={()=>setId('')}><DocumentDetail user={user} id={id}/></Dialog>}</>;
}
function MaterialDetail({user,id}:{user:string;id:string}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function download() {
    setBusy(true);setError('');
    try {
      const response=await fetch(`/api/v1/admin/users/${enc(user)}/materials/${enc(id)}/file`);
      if(!response.ok) throw new Error('无法下载原件，请重试');
      const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');
      const filename=response.headers.get('Content-Disposition')?.split("filename*=UTF-8''")[1];
      link.href=url;link.download=filename ? decodeURIComponent(filename) : '资料原件';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){setError(error instanceof Error ? error.message : '下载失败');}finally{setBusy(false);}
  }
  return <Resource path={`users/${enc(user)}/materials/${enc(id)}`}>{data=><><h3>{data.title}</h3><p>{data.description || '未填写说明'}</p>
    <Badge value={data.status}/><p>{data.statusMessage}</p><button disabled={busy} onClick={()=>void download()}>{busy ? '正在下载…' : '下载原件'}</button>
    {error && <p role="alert">{error}</p>}<h3>提取 / 识别内容</h3><p className="admin-body-text">{data.text || '暂无提取内容'}</p></>}</Resource>;
}
function Materials({user}:{user:string}) {
  const [offset,setOffset]=useState(0),[id,setId]=useState('');
  return <><Resource path={adminQuery(`users/${enc(user)}/materials`,{offset})}>{data=><Table data={data} onPage={setOffset} columns={[
    {name:'资料',render:row=><button onClick={()=>setId(row.id)}>{row.title}</button>},{name:'文件',render:row=>row.filename},
    {name:'状态',render:row=><Badge value={row.status}/>},{name:'上传时间',render:row=>date(row.createdAt)},
  ]}/>}</Resource>{id && <Dialog title="资料详情" onClose={()=>setId('')}><MaterialDetail user={user} id={id}/></Dialog>}</>;
}
function MemoryDetail({user,id}:{user:string;id:string}) {
  const [version,setVersion]=useState('');
  return <Resource path={adminQuery(`users/${enc(user)}/memories/${enc(id)}`,{version})}>{data=><>
    <label>记忆版本 <select value={version} onChange={event=>setVersion(event.target.value)}><option value="">当前版本</option>{data.versions.map((row:Row)=><option key={row.version} value={row.version}>版本 {row.version} · {date(row.created_at)}</option>)}</select></label>
    <h3>{data.memory.title}</h3><p className="admin-body-text">{data.memory.body}</p><h3>原始依据</h3>
    {data.sources.map((row:Row)=><article className="admin-source" key={row.id}><a href={adminLink('session',row.conversation_id)}>{date(row.created_at)} · {label(row.role)}</a><p>{row.body}</p></article>)}
    {!data.sources.length && <p className="admin-muted">没有关联的原始依据</p>}</>}</Resource>;
}
function Memories({user}:{user:string}) {
  const [offset,setOffset]=useState(0),[id,setId]=useState('');
  return <><Resource path={adminQuery(`users/${enc(user)}/memories`,{offset})}>{data=><>
    <details className="admin-card"><summary>偏好与概要 {data.overview && `· 版本 ${data.overview.version}`}</summary>{data.overview ? <Json value={data.overview.overview}/> : <p>暂无记忆概要</p>}</details>
    <Table data={data} onPage={setOffset} columns={[
      {name:'记忆',render:row=><button onClick={()=>setId(row.id)}>{row.title}</button>},{name:'分类',render:row=>label(row.type)},
      {name:'摘要',render:row=>row.summary},{name:'版本',render:row=>row.version},{name:'更新时间',render:row=>date(row.updated_at)},
    ]}/></>}</Resource>{id && <Dialog title="记忆与依据" onClose={()=>setId('')}><MemoryDetail user={user} id={id}/></Dialog>}</>;
}
function User({id,role}:{id:string;role:string}) {
  const [tab,setTab]=useState('sessions');
  const tabs=[['sessions','使用记录'],['documents','文稿'],['materials','资料'],['memories','长期记忆'],['jobs','整理任务']];
  return <><Resource path={`users/${enc(id)}`}>{data=><section className="admin-user-heading"><h2>{data.phone}</h2><ID value={data.id}/>
    <p className="admin-muted">注册于 {date(data.created_at)} · 最近使用 {date(data.last_activity)}</p>
    {Number(data.failed_jobs)>0 && <button onClick={()=>setTab('jobs')}>{data.failed_jobs} 个整理任务失败 · 查看</button>}</section>}</Resource>
    <nav className="admin-tabs" aria-label="用户资料分类">{tabs.map(([key,title])=><button key={key} aria-current={tab===key ? 'page' : undefined} onClick={()=>setTab(key!)}>{title}</button>)}</nav>
    <div key={tab}>{tab==='sessions' ? <SessionList user={id}/> : tab==='documents' ? <Documents user={id}/> : tab==='materials' ? <Materials user={id}/> : tab==='memories' ? <Memories user={id}/> : <Jobs user={id} role={role}/>}</div>
  </>;
}
function Services() {
  const [offset,setOffset]=useState(0),[errorOffset,setErrorOffset]=useState(0);
  return <><Resource path="services">{data=><section className="admin-card"><h2>服务状态</h2><dl className="admin-service-list">
    {[[ '数据库',data.database==='ready' ? '连接正常' : '不可用'],['部署版本',data.deployment],['默认模型服务',data.model],['资料原件存储',data.materialStorage],['Trace 存储',data.traceStorage]].map(([name,value])=><div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl><p className="admin-muted">{data.externalServices}</p><p className="admin-muted">{data.usageCoverage}</p></section>}</Resource>
    <section className="admin-card"><h2>近期运行异常</h2><Resource path={adminQuery('errors',{offset:errorOffset})}>{data=><Table data={data} onPage={setErrorOffset} columns={[
      {name:'时间',render:row=>date(row.created_at)},{name:'环节',render:row=>row.stage},{name:'错误',render:row=>row.code},
      {name:'用户',render:row=><UserLink id={row.user_id}/>},{name:'会话',render:row=><a href={adminLink('session',row.conversation_id)}>查看执行详情</a>},
    ]}/>}</Resource></section>
    <section className="admin-card"><h2>管理操作记录</h2><Resource path={adminQuery('logs',{offset})}>{data=><Table data={data} onPage={setOffset} columns={[
      {name:'时间',render:row=>date(row.created_at)},{name:'操作',render:row=>auditLabels[row.action] ?? row.action},
      {name:'操作者',render:row=><ID value={row.actor_id}/>},{name:'用户',render:row=>row.user_id ? <UserLink id={row.user_id}/> : '—'},
      {name:'对象',render:row=>row.target_id ? <ID value={row.target_id}/> : '—'},
    ]}/>}</Resource></section></>;
}
export function AdminApp() {
  const [hash,setHash]=useState(location.hash),[revision,setRevision]=useState(0);
  useEffect(()=>{const change=()=>setHash(location.hash);window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
  const route=adminRoute(hash),nav=[['overview','概览'],['users','用户'],['sessions','通话与会话'],['jobs','后台任务'],['services','服务与日志']] as const;
  const selected=route.page==='user' ? 'users' : route.page==='session' ? 'sessions' : route.page;
  const title=route.page==='user' ? '用户详情' : route.page==='session' ? '会话详情' : nav.find(([key])=>key===route.page)?.[1];
  return <Resource path="me">{actor=><div className="admin-shell"><aside className="admin-sidebar"><a className="admin-brand" href={adminLink('overview')}><span>狸</span><strong>令狸管理台</strong></a>
    <nav aria-label="管理导航">{nav.map(([key,title])=><a href={adminLink(key)} key={key} aria-current={selected===key ? 'page' : undefined}>{title}</a>)}</nav>
    <footer><Badge value={actor.role}/><a href="/internal/">产品调试台 ↗</a><a href="/">产品首页 ↗</a></footer></aside>
    <main className="admin-main"><header className="admin-page-heading"><h1>{title}</h1><button onClick={()=>setRevision(x=>x+1)}>刷新</button></header>
      {route.user && <p className="admin-muted">已筛选用户：<UserLink id={route.user}/> · <a href={adminLink(route.page)}>清除筛选</a></p>}
      <div key={`${hash}:${revision}`}>{route.page==='overview' ? <Overview/> : route.page==='users' ? <Users/> : route.page==='user' ? <User id={route.id} role={actor.role}/> : route.page==='sessions' ? <SessionList user={route.user}/> : route.page==='session' ? <Session id={route.id}/> : route.page==='jobs' ? <Jobs user={route.user} role={actor.role}/> : <Services/>}</div>
    </main></div>}</Resource>;
}
