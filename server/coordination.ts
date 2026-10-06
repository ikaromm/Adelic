import type { DelegatedTask, Project, ProjectBrief, ProviderInfo, ProviderId } from '../shared/contracts.js';
import { hasFileReference } from './router.js';

export interface PlannedTask { id:string; title:string; instructions:string; scope:string[]; dependsOn:string[] }

/** Extract only Graphify's canonical source attributes, never node labels or basenames. */
export function graphifyPaths(text:string):string[] {
  const paths:string[]=[];
  for(const match of text.matchAll(/\[([^\]]*?)\]/g)) {
    const source=match[1].match(/(?:^|\s)src=(.*?)(?=\s+[\w.-]+=|$)/)?.[1]?.trim();
    if(!source||source.startsWith('/')||source.startsWith('\\')||/^[a-z]:/i.test(source)||source.includes('\\'))continue;
    const parts=source.split('/');
    if(parts.some(part=>!part||part==='.'||part==='..'))continue;
    if(!paths.includes(source))paths.push(source);
    if(paths.length>=160)break;
  }
  return paths;
}

/** Validates and bounds the planner's JSON before it can create runtime work. */
export function parseTaskPlan(text:string):PlannedTask[] {
  let value:unknown;
  try { value=JSON.parse(text); } catch { throw new Error('O planejador não retornou JSON válido'); }
  if (!value || typeof value!=='object' || !Array.isArray((value as any).tasks)) throw new Error('Plano deve conter uma lista tasks');
  const raw=(value as any).tasks;
  if (raw.length<1 || raw.length>6) throw new Error('Plano deve conter de 1 a 6 tarefas');
  const ids=new Set<string>();
  const tasks:PlannedTask[]=raw.map((item:unknown,index:number)=>{
    if (!item || typeof item!=='object') throw new Error(`Tarefa ${index+1} inválida`);
    const t=item as Record<string,unknown>;
    if (typeof t.id!=='string'||!/^[a-zA-Z0-9_-]{1,40}$/.test(t.id)||ids.has(t.id)) throw new Error(`ID inválido ou repetido na tarefa ${index+1}`);
    ids.add(t.id);
    if (typeof t.title!=='string'||!t.title.trim()||t.title.length>160) throw new Error(`Título inválido na tarefa ${index+1}`);
    if (typeof t.instructions!=='string'||!t.instructions.trim()||t.instructions.length>5000) throw new Error(`Instruções inválidas na tarefa ${index+1}`);
    if (!Array.isArray(t.scope)||t.scope.length>30||t.scope.some(p=>typeof p!=='string'||p.length>300)) throw new Error(`Escopo inválido na tarefa ${index+1}`);
    if (!Array.isArray(t.dependsOn)||t.dependsOn.length>6||t.dependsOn.some(id=>typeof id!=='string')) throw new Error(`Dependências inválidas na tarefa ${index+1}`);
    return {id:t.id,title:t.title.trim(),instructions:t.instructions.trim(),scope:[...new Set(t.scope as string[])],dependsOn:[...new Set(t.dependsOn as string[])]};
  });
  const byId=new Map(tasks.map(t=>[t.id,t]));
  for (const task of tasks) for (const dep of task.dependsOn) if (!byId.has(dep)||dep===task.id) throw new Error(`Dependência inválida em ${task.id}`);
  const visiting=new Set<string>(),visited=new Set<string>();
  const visit=(id:string)=>{ if(visiting.has(id))throw new Error('O plano contém dependências cíclicas');if(visited.has(id))return;visiting.add(id);for(const dep of byId.get(id)!.dependsOn)visit(dep);visiting.delete(id);visited.add(id); };
  tasks.forEach(t=>visit(t.id));
  return tasks;
}

export function resolveAgent(info:ProviderInfo[],configuredProvider:ProviderId|undefined,configuredModel:string|undefined,role:'worker'|'reviewer',fallbackProvider:ProviderId,fallbackModel?:string) {
  const providerId=configuredProvider || fallbackProvider;
  const provider=info.find(p=>p.id===providerId);
  if(!provider?.available) throw new Error(`${role==='worker'?'Executor':'Revisor'} indisponível: ${provider?.detail || `provedor ${providerId} não disponível`}`);
  const models=provider.models;
  const preferredId=role==='worker'?'gpt-6-luna':'gpt-6-sol';
  const preferred=configuredModel || (role==='worker'
    ? models.find(m=>m.id===preferredId)?.id || models.find(m=>/luna/i.test(`${m.id} ${m.name}`))?.id
    : models.find(m=>m.id===preferredId)?.id || models.find(m=>/sol/i.test(`${m.id} ${m.name}`))?.id);
  const model=preferred || (providerId===fallbackProvider?fallbackModel:undefined);
  if(model&&!provider.models.some(m=>m.id===model||m.name===model)) throw new Error(`Modelo ${model} não está disponível em ${providerId}`);
  return {providerId,model};
}

export function boundedCoordinatorContext(history:{role:string;content:string}[], current:string, brief:ProjectBrief|null, paths:string[], maxChars=7000) {
  const recent=history.slice(-4).map(m=>`${m.role}: ${m.content.slice(-900)}`).join('\n');
  const map=paths.slice(0,160).join('\n');
  const briefText=brief?`Resumo persistido: ${brief.summary.slice(0,1800)}\nObjetivo anterior: ${brief.objective.slice(0,500)}`:'';
  const prefix=`Pedido atual: ${current}`;
  const remainder=Math.max(0,maxChars-prefix.length-2);
  const supporting=[briefText,map?`Mapa de caminhos (índice, não conteúdo):\n${map}`:'',recent?`Mensagens recentes:\n${recent}`:''].filter(Boolean).join('\n\n').slice(0,remainder);
  return supporting?`${prefix}\n\n${supporting}`:prefix;
}

export function briefFor(project:Project,objective:string,summary:string,paths:string[]):ProjectBrief {
  const unique=[...new Set(paths)].slice(0,160); const truncated=paths.length>unique.length;
  return {projectId:project.id,updatedAt:new Date().toISOString(),paths:unique,truncated,objective:objective.slice(0,1000),summary:summary.slice(0,4000)};
}

export function isSimpleInspectionRequest(text:string) {
  const mutating=/\b(implemente|implement|crie|create|edite|edit|corrija|fix|altere|change|write|escreva|delete|remova|refatore|refactor|instale|install|rode|run|execute|build|compile|teste|test|deploy)\b/i;
  const inspection=/\b(leia|read|abra|open|inspecione|inspect|analise|analyze|explique|explain|resuma|summari[sz]e|summarize)\b/i;
  const file=/\b(arquivo|file|projeto|project|c[oó]digo|code|repo|reposit[oó]rio|readme|pasta|directory|m[oó]dulo|module|componente|component)\b/i;
  const complex=/\b(v[aá]rios|m[uú]ltiplos|multiple|several|whole|todo o|toda a|arquitetura|architecture|etapas|steps|plano|plan|trade-?off|recomend|recommend)\b|\b(duas|dois|tr[eê]s|quatro|cinco|seis|quarta?|quint[oa]s?|sext[oa]s?|two|three|four|five|six|fourth|fifth|sixth|[2-6])\s+(?:independentes?\s+|independent\s+)?(partes?|tarefas?|etapas?|arquivos?|m[oó]dulos?|parts?|tasks?|stages?|files?|modules?)\b|\b(partes?|tarefas?|etapas?|arquivos?|m[oó]dulos?|parts?|tasks?|stages?|files?|modules?)\s+(independentes?|independent)\b|\bem paralelo\b|\bparallel(?:ly)?\b/i;
  return inspection.test(text)&&(file.test(text)||hasFileReference(text))&&!mutating.test(text)&&!complex.test(text);
}

export function taskRecord(input:Omit<DelegatedTask,'createdAt'|'status'>):DelegatedTask {
  return {...input,status:'queued',createdAt:new Date().toISOString()};
}
