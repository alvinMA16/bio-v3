export type AdminPage = 'overview' | 'users' | 'user' | 'sessions' | 'session' | 'jobs' | 'services';
const pages: AdminPage[] = ['overview','users','user','sessions','session','jobs','services'];
export function adminRoute(hash: string) {
  const params = new URLSearchParams(hash.replace(/^#/,''));
  const value = params.get('page');
  return { page: pages.includes(value as AdminPage) ? value as AdminPage : 'overview', id: params.get('id') ?? '', user: params.get('user') ?? '' };
}
export function adminLink(page: AdminPage, id = '', user = '') {
  const params = new URLSearchParams({ page });
  if(id) params.set('id',id);
  if(user) params.set('user',user);
  return `#${params}`;
}
export function adminQuery(path: string, params: Record<string,string | number | undefined>) {
  const query=new URLSearchParams();
  for(const [key,value] of Object.entries(params)) if(value!==undefined && value!=='') query.set(key,String(value));
  return `${path}${query.size ? `?${query}` : ''}`;
}
export const statusLabels: Record<string,string> = { active:'通话中',disconnected:'等待重连',ended:'已结束',pending:'等待整理',running:'整理中',done:'已完成',failed:'失败',cancelled:'已取消',ready:'可用','needs-description':'需补充说明',operator:'可操作',viewer:'只读',person:'人物',story:'故事',interaction:'互动',user:'用户',assistant:'令狸',tool:'工具' };
export const auditLabels: Record<string,string> = { read_session_list:'查看会话列表',read_session:'查看会话原文',read_trace:'查看运行记录',read_document:'查看文稿',read_document_revision:'查看文稿版本',read_material:'查看资料正文',download_material:'下载资料原件',read_memory_overview:'查看记忆概要',read_memory:'查看记忆及依据',retry_memory_job:'重试记忆任务' };
