import type { Integration, MemoryHit, MemoryPage, Project } from '../shared/contracts.js';

const endpoint='http://127.0.0.1:49374/mcp';
type Tool={name:string;description?:string;inputSchema?:unknown};
let toolsCache:Tool[]|undefined;
let nextId=1;
let integrationCache:Integration|undefined;
let integrationRefresh:Promise<Integration>|undefined;
let integrationCheckedAt=0;

async function rpc(method:string,params:unknown,timeoutMs=2500):Promise<any> {
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
    const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:nextId++,method,params}),signal:controller.signal});
    if (!response.ok) throw new Error(`ai-memory respondeu HTTP ${response.status}`);
    const raw=await response.text();
    const line=raw.split('\n').find(l=>l.startsWith('data:'))?.slice(5).trim();
    const data=JSON.parse(line || raw);
    if (data.error) throw new Error(data.error.message || 'Erro JSON-RPC do ai-memory');
    return data.result;
  } finally { clearTimeout(timer); }
}
async function getTools() {
  if (toolsCache) return toolsCache;
  try { await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'adelic',version:'0.1.0'}}); } catch { /* server may already be initialized or omit initialize */ }
  const result=await rpc('tools/list',{}); toolsCache=result.tools ?? []; return toolsCache!;
}
const toolNames={search:['memory_query'],read:['memory_read_page'],write:['memory_write_page']} as const;
async function call(kind:'search'|'read'|'write',project:Project,args:Record<string,unknown>) {
  const ts=await getTools(); const tool=ts.find(t=>toolNames[kind].includes(t.name as never));
  if (!tool) throw new Error(`ai-memory não oferece ferramenta de ${kind === 'search'?'busca':kind==='read'?'leitura':'escrita'} nesta conexão`);
  const properties=(tool.inputSchema as any)?.properties ?? {};
  if (!Object.hasOwn(properties,'workspace') || !Object.hasOwn(properties,'project')) throw new Error('Ferramenta ai-memory sem escopo explícito de workspace/project');
  if (!project.memoryWorkspace || !project.memoryProject) throw new Error('Projeto sem escopo de memória configurado');
  const candidates:Record<string,unknown>={workspace:project.memoryWorkspace,project:project.memoryProject,query:args.query,q:args.query,path:args.path,body:args.body,title:args.title};
  const params=Object.fromEntries(Object.entries(candidates).filter(([k,v])=>k in properties && v!==undefined));
  const result=await rpc('tools/call',{name:tool.name,arguments:params},8000);
  if (result?.isError) throw new Error(result.content?.map((x:any)=>x.text).join('\n') || 'Falha da ferramenta ai-memory');
  return result;
}
function unwrap(result:any):any {
  const content=result?.content;
  const text=content?.find((x:any)=>x.type==='text')?.text;
  if (text) { try { return JSON.parse(text); } catch { return text; } }
  return result?.structuredContent ?? result;
}

export async function memorySearch(project:Project,q:string):Promise<MemoryHit[]> {
  const r=unwrap(await call('search',project,{query:q}));
  const hits=Array.isArray(r)?r:(r.hits ?? r.results ?? r.pages ?? []);
  return hits.map((h:any)=>({path:String(h.path ?? h.relative_path ?? ''),title:String(h.title ?? h.name ?? h.path ?? 'Nota'),snippet:String(h.snippet ?? h.excerpt ?? h.content ?? '').slice(0,600)}));
}
export async function memoryRead(project:Project,path:string):Promise<MemoryPage> {
  const r=unwrap(await call('read',project,{path}));
  return {path:String(r.path ?? path),title:String(r.title ?? path),body:String(r.body ?? r.content ?? r.text ?? '')};
}
export async function memoryWrite(project:Project,path:string,body:string):Promise<MemoryPage> {
  const r=unwrap(await call('write',project,{path,body}));
  return {path:String(r.path ?? path),title:String(r.title ?? path),body:String(r.body ?? r.content ?? body)};
}

const memoryStopwords=new Set(['a','as','o','os','de','da','das','do','dos','e','em','no','na','nos','nas','um','uma','que','qual','quais','como','para','por','sobre','com','minha','meu','meus','nossa','nosso','isso','essa','esse','antes','anterior','anteriores','lembre','lembra','lembrar','memoria','memory','decidimos','decisao','decisoes','configuracao','configuracoes','what','about','the','and','our','previous','remember']);
export function memoryQueryTerms(content:string):string[] {
  const words=content.normalize('NFD').replace(/[\u0300-\u036f]/g,'').match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
  const terms=[...new Set(words.filter(word=>!memoryStopwords.has(word.toLowerCase())))];
  terms.sort((a,b)=>Number(/^[A-Z0-9_-]{2,}$/.test(b))-Number(/^[A-Z0-9_-]{2,}$/.test(a)));
  return (terms.length?terms:['decisão']).slice(0,3);
}
export async function memoryContextFor(project:Project,content:string):Promise<string|undefined> {
  let hits:MemoryHit[]=[];
  for (const term of memoryQueryTerms(content)) {
    hits=await memorySearch(project,term);
    if (hits.length) break;
  }
  const hit=hits.find(item=>item.path.endsWith('.md') && !item.path.startsWith('/') && !item.path.split('/').includes('..') && !item.path.includes('\\'));
  if (!hit) return undefined;
  const page=await memoryRead(project,hit.path);
  const body=page.body.slice(0,6000);
  return `Fonte: ${page.path}\n${body}${page.body.length>body.length?'\n[Nota truncada pelo limite de contexto]':''}`;
}
export async function memoryIntegration(timeoutMs=700):Promise<Integration> {
  if (integrationCache && Date.now()-integrationCheckedAt<10000) return integrationCache;
  if (integrationRefresh) return integrationRefresh;
  integrationRefresh=(async()=>{
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try { const r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:0,method:'tools/list',params:{}}),signal:controller.signal});
    integrationCache=r.ok?{id:'ai-memory',name:'ai-memory',kind:'memory',status:'ready',detail:'Servidor MCP local disponível'}:{id:'ai-memory',name:'ai-memory',kind:'memory',status:'error',detail:`Servidor MCP retornou HTTP ${r.status}`};
  } catch { integrationCache={id:'ai-memory',name:'ai-memory',kind:'memory',status:'missing',detail:'Servidor MCP local indisponível'}; }
  finally {clearTimeout(timer);integrationCheckedAt=Date.now();integrationRefresh=undefined;}
  return integrationCache!;
  })();
  return integrationRefresh;
}
export function memoryIntegrationSnapshot():Integration {
  return integrationCache ?? {id:'ai-memory',name:'ai-memory',kind:'memory',status:'planned',detail:'Verificando servidor MCP local'};
}
