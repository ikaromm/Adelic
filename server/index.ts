import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GraphifyConfig, Mode, OrchestrationConfig, Project, ProviderId, ProviderRegistry, Session, Settings } from '../shared/contracts.js';
import { memoryIntegration, memoryIntegrationSnapshot, memoryRead, memorySearch, memoryWrite } from './memory.js';
import { Orchestrator } from './orchestrator.js';
import { Store } from './store.js';
import { GraphifyService, graphify, mountGraphifyRoutes } from './graphify.js';

const validProviders=new Set<ProviderId>(['codex','claude','kiro','opencode']); const modes=new Set<Mode>(['auto','fast','deep']);
function orchestrationConfig(value:unknown,base?:OrchestrationConfig):OrchestrationConfig|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const b=value as Record<string,unknown>;const merged={...(base||{enabled:true,maxWorkers:2,review:true}),...b};
  for(const key of ['workerProviderId','workerModel','reviewerProviderId','reviewerModel'] as const)if(b[key]===null)delete (merged as any)[key];
  if(typeof merged.enabled!=='boolean'||![1,2,3].includes(merged.maxWorkers as number)||typeof merged.review!=='boolean')return undefined;
  for(const key of ['workerProviderId','reviewerProviderId'] as const)if(merged[key]!==undefined&&!validProviders.has(merged[key] as ProviderId))return undefined;
  for(const key of ['workerModel','reviewerModel'] as const)if(merged[key]!==undefined&&(typeof merged[key]!=='string'||!(merged[key] as string).trim()||(merged[key] as string).length>120))return undefined;
  const allowed=new Set(['enabled','maxWorkers','review','workerProviderId','workerModel','reviewerProviderId','reviewerModel']);
  if(Object.keys(b).some(k=>!allowed.has(k)))return undefined;
  return merged as OrchestrationConfig;
}
function graphifyConfig(value:unknown):GraphifyConfig|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const b=value as Record<string,unknown>;if(Object.keys(b).some(k=>k!=='enabled')||typeof b.enabled!=='boolean')return undefined;
  return {enabled:b.enabled};
}
const error=(res:Response,status:number,message:string)=>res.status(status).json({error:message});
const str=(v:unknown,max=200)=>typeof v==='string'&&v.trim().length>0&&v.length<=max ? v.trim():undefined;
function originGuard(req:Request,res:Response,next:NextFunction) {
  const host=(req.get('host')||'').toLowerCase();
  if (!/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host)) return error(res,403,'Host inválido');
  if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
    if (!req.is('application/json')) return error(res,415,'Mutação exige application/json');
    const origin=req.get('origin');
    if (origin) { try { const u=new URL(origin); if (!['http:','https:'].includes(u.protocol) || u.host.toLowerCase()!==host) return error(res,403,'Origin externo bloqueado'); } catch { return error(res,403,'Origin inválido'); } }
    const fetchSite=req.get('sec-fetch-site'); if (fetchSite && !['same-origin','none'].includes(fetchSite)) return error(res,403,'Origem externa bloqueada');
  }
  next();
}
function projectPath(input:unknown) { if (typeof input!=='string' || !input.trim()) throw new Error('path obrigatório'); const p=realpathSync(resolve(input)); if (!existsSync(p)||!statSync(p).isDirectory()) throw new Error('O caminho precisa ser uma pasta existente'); return p; }

export function createBackend(store:Store,providers:ProviderRegistry,graphifyService:GraphifyService=graphify) {
const app=express(); app.disable('x-powered-by'); app.use(express.json({limit:'128kb',strict:true}));
const orchestrator=new Orchestrator(store,providers,undefined,graphifyService);
let providersCache:{at:number;value:Awaited<ReturnType<typeof providers.list>>}|undefined;
async function providerList() { if (!providersCache || Date.now()-providersCache.at>10000) providersCache={at:Date.now(),value:await providers.list()}; return providersCache.value; }
let jail: string|undefined;
function jailIntegration() {
  if (!jail) { try { jail=execFileSync('which',['ai-jail'],{encoding:'utf8',timeout:300,stdio:['ignore','pipe','ignore']}).trim(); } catch { jail=''; } }
  return {id:'ai-jail',name:'ai-jail',kind:'sandbox' as const,status:jail?'planned' as const:'missing' as const,detail:jail?'ai-jail instalado; os runtimes ainda não estão integrados a ele':'ai-jail não encontrado no PATH'};
}
function integrations() { return [memoryIntegrationSnapshot(),jailIntegration(),{id:'runtime-tools',name:'Ferramentas dos runtimes',kind:'tool' as const,status:'ready' as const,detail:'Capacidades declaradas individualmente por cada provedor'}]; }
app.use(originGuard);
app.get('/api/bootstrap',async(_req,res)=>{ try { const [providersResult]=await Promise.all([providerList(),memoryIntegration()]); res.json(store.bootstrap(providersResult,integrations())); } catch(e) { error(res,500,message(e)); } });
app.post('/api/projects',(req,res)=>{
  const name=str(req.body?.name), path=str(req.body?.path,4096), memoryWorkspace=str(req.body?.memoryWorkspace,100), memoryProject=str(req.body?.memoryProject,100); if (!name||!path||!memoryWorkspace||!memoryProject) return error(res,400,'name, path, memoryWorkspace e memoryProject são obrigatórios');
  try { const resolved=projectPath(path);const config=req.body?.orchestration===undefined?undefined:orchestrationConfig(req.body.orchestration);if(req.body?.orchestration!==undefined&&!config)return error(res,400,'orchestration inválida');const graphify=req.body?.graphify===undefined?undefined:graphifyConfig(req.body.graphify);if(req.body?.graphify!==undefined&&!graphify)return error(res,400,'graphify inválido'); const p:Project={id:randomUUID(),name,path:resolved,createdAt:new Date().toISOString(),memoryWorkspace,memoryProject,orchestration:config,graphify}; store.putProject(p); res.status(201).json(store.getProject(p.id)); }
  catch(e) { error(res,400,message(e)); }
});
app.get('/api/projects/:id/coordination',(req,res)=>{const result=orchestrator.coordination(req.params.id);if(!result)return error(res,404,'Projeto não encontrado');res.json(result);});
app.get('/api/tasks/:id',(req,res)=>{const task=store.getTask(req.params.id);if(!task)return error(res,404,'Tarefa não encontrada');res.json(task);});
app.patch('/api/projects/:id',(req,res)=>{ const p=store.getProject(req.params.id); if (!p) return error(res,404,'Projeto não encontrado'); const name=req.body?.name===undefined?p.name:str(req.body.name); const workspace=req.body?.memoryWorkspace===undefined?p.memoryWorkspace:str(req.body.memoryWorkspace,100); const project=req.body?.memoryProject===undefined?p.memoryProject:str(req.body.memoryProject,100);if(req.body?.orchestration!==undefined){const c=orchestrationConfig(req.body.orchestration,p.orchestration);if(!c)return error(res,400,'orchestration inválida');p.orchestration=c;}if(req.body?.graphify!==undefined){const g=graphifyConfig(req.body.graphify);if(!g)return error(res,400,'graphify inválido');p.graphify=g;} if (!name||!workspace||!project) return error(res,400,'Campos de projeto inválidos'); p.name=name;p.memoryWorkspace=workspace;p.memoryProject=project;res.json(store.updateProject(p)); });
app.post('/api/sessions',(req,res)=>{ const rawProjectId=req.body?.projectId; if(rawProjectId!==undefined&&rawProjectId!==null&&typeof rawProjectId!=='string')return error(res,400,'projectId inválido');const projectId=rawProjectId===null?undefined:str(rawProjectId);if(rawProjectId!==undefined&&rawProjectId!==null&&!projectId)return error(res,400,'projectId inválido');const project=projectId?store.getProject(projectId):undefined;if(projectId&&!project)return error(res,404,'Projeto não encontrado'); const providerId=req.body?.providerId===undefined?store.getSettings()!.defaultProviderId:req.body.providerId; if (!validProviders.has(providerId)) return error(res,400,'providerId inválido'); const mode=req.body?.mode===undefined?store.getSettings()!.defaultMode:req.body.mode; if (!modes.has(mode)) return error(res,400,'mode inválido'); const model=req.body?.model===undefined?undefined:str(req.body.model,120); if (req.body?.model!==undefined&&!model) return error(res,400,'model inválido'); const now=new Date().toISOString(); const s:Session={id:randomUUID(),projectId:project?.id??null,title:str(req.body?.title,160)||'Nova conversa',providerId,model,mode,createdAt:now,updatedAt:now}; store.putSession(s); res.status(201).json(s); });
app.get('/api/sessions/:id',(req,res)=>{ const s=store.getSession(req.params.id); if (!s) return error(res,404,'Conversa não encontrada'); res.json(store.detail(s)); });
app.patch('/api/sessions/:id',(req,res)=>{ const s=store.getSession(req.params.id); if (!s) return error(res,404,'Conversa não encontrada'); if(s.activeRunId||orchestrator.isActive(s.id)) return error(res,409,'Não é possível alterar uma conversa em execução'); const body=req.body||{};
  let nextProjectId=s.projectId;
  if(body.projectId!==undefined){if(body.projectId!==null&&typeof body.projectId!=='string')return error(res,400,'projectId inválido');const value=body.projectId===null?undefined:str(body.projectId);if(body.projectId!==null&&!value)return error(res,400,'projectId inválido');if(value&&!store.getProject(value))return error(res,404,'Projeto não encontrado');nextProjectId=value??null;}
  const title=body.title===undefined?s.title:str(body.title,160);if(!title)return error(res,400,'title inválido');
  const providerId=body.providerId===undefined?s.providerId:body.providerId;if(!validProviders.has(providerId))return error(res,400,'providerId inválido');
  let model=s.model;if(body.model!==undefined){if(body.model!==null&&!str(body.model,120))return error(res,400,'model inválido');model=body.model===null?undefined:str(body.model,120);}
  const mode=body.mode===undefined?s.mode:body.mode;if(!modes.has(mode))return error(res,400,'mode inválido');
  const workspaceChanged=nextProjectId!==s.projectId,providerChanged=s.providerId!==providerId,modelChanged=s.model!==model;s.projectId=nextProjectId;s.title=title;s.providerId=providerId;s.model=model;s.mode=mode;if(workspaceChanged||providerChanged||modelChanged)delete s.nativeSessionId;s.updatedAt=new Date().toISOString();store.putSession(s);res.json(s); });
app.delete('/api/sessions/:id',(req,res)=>{ const s=store.getSession(req.params.id);if(!s)return error(res,404,'Conversa não encontrada');if(s.activeRunId)return error(res,409,'Conversa em execução');store.deleteSession(s.id);res.status(204).end(); });
app.post('/api/sessions/:id/messages',async(req,res)=>{ const s=store.getSession(req.params.id);if(!s)return error(res,404,'Conversa não encontrada'); const content=str(req.body?.content,32000); if(!content)return error(res,400,'content obrigatório (máximo 32000 caracteres)'); const clientMessageId=req.body?.clientMessageId===undefined?undefined:str(req.body.clientMessageId,128); if(req.body?.clientMessageId!==undefined&&!clientMessageId)return error(res,400,'clientMessageId inválido'); try { const result=await orchestrator.start(s,content,clientMessageId);res.status(202).json(result); } catch(e) { const status=(e as any)?.status||500;error(res,status,message(e)); } });
app.post('/api/sessions/:id/cancel',async(req,res)=>{ if(!store.getSession(req.params.id))return error(res,404,'Conversa não encontrada');try{await orchestrator.cancel(req.params.id);res.status(202).json({ok:true});}catch(e){error(res,(e as any)?.status||500,message(e));} });
app.post('/api/approvals/:id',async(req,res)=>{const decision=req.body?.decision;if(!['approve','deny'].includes(decision))return error(res,400,'decision deve ser approve ou deny');const a=store.getApproval(req.params.id);if(!a)return error(res,404,'Aprovação não encontrada');try{await orchestrator.decide(a.id,a.sessionId,decision);res.json(store.getApproval(a.id));}catch(e){error(res,(e as any)?.status||500,message(e));}});
app.get('/api/events',(req,res)=>{res.status(200).set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();res.write(`data: ${JSON.stringify({type:'refresh'})}\n\n`);const unsub=orchestrator.subscribe(e=>res.write(`data: ${JSON.stringify(e)}\n\n`));const ping=setInterval(()=>res.write(': ping\n\n'),20000);req.on('close',()=>{clearInterval(ping);unsub();});});
app.patch('/api/settings',(req,res)=>{const old=store.getSettings()!;const b=req.body||{};const next:Settings={...old};if(b.defaultProviderId!==undefined){if(!validProviders.has(b.defaultProviderId))return error(res,400,'defaultProviderId inválido');next.defaultProviderId=b.defaultProviderId;}if(b.defaultMode!==undefined){if(!modes.has(b.defaultMode))return error(res,400,'defaultMode inválido');next.defaultMode=b.defaultMode;}if(b.memoryEnabled!==undefined){if(typeof b.memoryEnabled!=='boolean')return error(res,400,'memoryEnabled deve ser booleano');next.memoryEnabled=b.memoryEnabled;}if(b.sandbox!==undefined){if(!['read-only','workspace-write'].includes(b.sandbox))return error(res,400,'sandbox inválido');next.sandbox=b.sandbox;}if(b.responseStyle!==undefined){if(!['concise','balanced'].includes(b.responseStyle))return error(res,400,'responseStyle inválido');next.responseStyle=b.responseStyle;}res.json(store.setSettings(next));});
app.get('/api/memory/search',async(req,res)=>{const p=store.getProject(String(req.query.projectId||''));const q=str(req.query.q,1000);if(!p||!q)return error(res,400,'projectId e q são obrigatórios');try{res.json({hits:await memorySearch(p,q)});}catch(e){error(res,503,message(e));}});
app.get('/api/memory/page',async(req,res)=>{const p=store.getProject(String(req.query.projectId||''));const path=str(req.query.path,500);if(!p||!path)return error(res,400,'projectId e path são obrigatórios');if(!safeMemoryPath(path))return error(res,400,'path inválido');try{res.json(await memoryRead(p,path));}catch(e){error(res,503,message(e));}});
app.post('/api/memory/page',async(req,res)=>{const p=store.getProject(str(req.body?.projectId)||'');const path=str(req.body?.path,500),body=typeof req.body?.body==='string'&&req.body.body.length<=50000?req.body.body:undefined;if(!p||!path||body===undefined)return error(res,400,'projectId, path e body (máximo 50000 caracteres) são obrigatórios');if(!safeMemoryPath(path))return error(res,400,'path inválido');try{res.json(await memoryWrite(p,path,body));}catch(e){error(res,503,message(e));}});
app.patch('/api/skills/:id',(req,res)=>{const skill=store.getSkill(req.params.id);if(!skill)return error(res,404,'Skill não encontrada');if(typeof req.body?.enabled!=='boolean')return error(res,400,'enabled deve ser booleano');skill.enabled=req.body.enabled;res.json(store.setSkill(skill));});
app.get('/api/health',async(_req,res)=>{res.json({status:'ok',providers:(await providerList()).map(p=>({id:p.id,status:p.status,available:p.available})),memory:(await memoryIntegration()).status,jail:jailIntegration().status==='planned'?'installed':'missing'});});
app.get('/api/export',(_req,res)=>res.json(store.exportData()));
mountGraphifyRoutes(app,store,graphifyService);
app.use('/api',(req,res)=>error(res,404,'Endpoint não encontrado'));
app.use((e:unknown,_req:Request,res:Response,_next:NextFunction)=>error(res,400,message(e)));
return {app,orchestrator,graphify:graphifyService};
}
function safeMemoryPath(p:string) { return !p.startsWith('/')&&!p.split('/').includes('..')&&!p.includes('\\')&&p.endsWith('.md'); }
function message(e:unknown){return e instanceof Error?e.message:String(e);}
