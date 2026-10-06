import type { Message, Mode, RoutePlan } from '../shared/contracts.js';

const actionPattern=/\b(leia|read|abra|open|inspecione|inspect|analise|analyze|revise|review|corrija|fix|implemente|implement|crie|create|edite|edit|rode|run|execute|teste|test|compile|build|deploy|fa[cç]a|make|write|escreva|investigue|investigate|diagnostique|diagnose|explique|explain|resuma|resumir|summari[sz]e)\b/i;
const filePattern=/\b(readme|arquivo|file|projeto|project|c[oó]digo|code|repo|reposit[oó]rio|app|aplicativo|pasta|directory|p[aá]gina|page|branch|logs?|bug|erro|error|falha|build|deploy|pr)\b/i;
const fileExtensionPattern=/\.(?:tsx?|jsx?|mjs|cjs|py|json|md|ya?ml|toml|css|html|sql|sh|rs|go|java|kt|swift|vue|svelte)\b/i;
const pathPattern=/(?:^|[\s"'`(])(?:\.{1,2}\/)?[\w.-]+(?:\/[\w.-]+)+(?:\.[\w]+)?(?=$|[\s"'`),:])/i;
const pluralFilePattern=/\b(arquivos?|files?|projetos?|projects?)\b/i;
const researchPattern=/\b(pesquise|search|procure|look up|busque|browse|navegue)\b|\b(cot[aç][aã]o|pre[cç]o|price|clima|weather|not[ií]cia|news)\b.{0,60}\b(atual|hoje|today|latest|current|recent)\b|\b(atual|hoje|today|latest|current|recent)\b.{0,60}\b(cot[aç][aã]o|pre[cç]o|price|clima|weather|not[ií]cia|news)\b/i;
const implementationPattern=/\b(implemente|implement|crie|create|corrija|fix|edite|edit|altere|change|refatore|refactor|adicione|add)\b.{0,120}\b(api|endpoint|fun[cç][aã]o|function|componente|component|schema|migration|migra[cç][aã]o|banco de dados|database|script|servidor|server|frontend|backend)\b/i;
const toolPatterns: [RegExp,string][] = [
  [implementationPattern, 'O pedido requer implementação ou alteração de software'],
  [/\b(leia|read|abra|open|inspecione|inspect|analise|analyze|revise|review|corrija|fix|implemente|implement|crie|create|edite|edit|rode|run|execute|teste|test|compile|build|deploy)\b.{0,90}\b(readme|arquivo|file|projeto|project|c[oó]digo|code|repo|reposit[oó]rio|app|aplicativo|pasta|directory|bug|erro|error|falha)\b/i, 'O pedido envolve inspecionar ou alterar arquivos do projeto'],
  [/\b(leia|read|abra|open|inspecione|inspect|analise|analyze|revise|review|corrija|fix|implemente|implement|crie|create|edite|edit|rode|run|execute|teste|test|explique|explain|resuma|summari[sz]e)\s+((o|a|the|este|esse|esta|essa|this)\s+)?(readme|c[oó]digo|projeto|arquivo|repo|reposit[oó]rio)\b/i, 'O pedido envolve inspecionar ou alterar arquivos do projeto'],
  [researchPattern, 'A resposta depende de pesquisa ou informação atual'],
  [/\b(fa[cç]a|make|rode|run|execute|compile|compilem|implemente|implement)\b.{0,80}\b(build|deploy|pull request|pr|stack trace)\b/i, 'O pedido requer trabalho técnico com ferramentas'],
  [/\b(compare|comparar|comparativo|comparison|trade-?off|priorize|prioritize|decida|decide|planeje|plan|passo a passo|step by step)\b.{0,140}\b(recomende|recommend|melhor|best|escolha|choose|decida|decide|vantagens|desvantagens|trade-?off|custo|cost|risco|risk)\b/i, 'O pedido pede comparação e recomendação em várias etapas'],
  [/\b(lembra|lembre|remember|mem[oó]ria|memory|na conversa anterior|before|last time|como eu disse|as I said|contexto anterior|previous context)\b/i, 'O pedido depende de contexto ou memória anterior'],
];

export function routeMessage(content:string, mode:Mode, history:Message[] = [], memoryEnabled = false):RoutePlan {
  const text=content.trim();
  if (mode==='fast') return {level:'fast',reason:'Modo Rápido selecionado pelo operador',tools:true,memory:false,effort:'low',contextBudget:6000};
  if (mode==='deep') return {level:'deep',reason:'Modo Completo selecionado pelo operador',tools:needsTools(text),memory:memoryEnabled && /mem[oó]ria|memory|lembra|lembre/i.test(text),effort:'high',contextBudget:24000};
  if (actionPattern.test(text) && hasFileReference(text)) {
    return {level:'deep',reason:'O pedido aponta explicitamente para um arquivo ou projeto',tools:true,memory:false,effort:'high',contextBudget:24000};
  }
  for (const [pattern,reason] of toolPatterns) if (pattern.test(text)) {
    const memory=memoryEnabled && /mem[oó]ria|memory|lembra|lembre|contexto anterior|previous context|antes|anterior/i.test(text);
    return {level:'deep',reason,tools:needsTools(text),memory,effort:'high',contextBudget:24000};
  }
  // Follow-ups often omit the object of the request. Use the recent exchange as intent context.
  const isFollowUp=/^(e\b|and\b|agora\b|now\b|tamb[eé]m\b|also\b|ent[aã]o\b|then\b|isso\b|that\b|fa[cç]a\s+o\s+mesmo|do\s+the\s+same)/i.test(text);
  const lastUser=[...history].reverse().find(m=>m.role==='user');
  if (isFollowUp && lastUser && toolPatterns.slice(0,5).some(([p])=>p.test(lastUser.content))) {
    return {level:'deep',reason:'Continuação de um pedido anterior que exige contexto ampliado',tools:needsTools(lastUser.content),memory:false,effort:'high',contextBudget:24000};
  }
  // Long conceptual prompts can stay on the cheap route; length alone never promotes.
  return {level:'fast',reason:'Pergunta direta; ferramentas disponíveis se forem necessárias',tools:true,memory:false,effort:'low',contextBudget:6000};
}

function needsTools(text:string) {
  return implementationPattern.test(text) || researchPattern.test(text) || (actionPattern.test(text) && (filePattern.test(text) || hasFileReference(text)));
}

export function hasFileReference(text:string) {
  return fileExtensionPattern.test(text) || pathPattern.test(text) || pluralFilePattern.test(text);
}

export function selectHistory(history:Message[], budget:number):Message[] {
  let remaining=budget; const selected:Message[]=[];
  for (const m of [...history].reverse()) {
    const cost=m.content.length;
    if (selected.length && cost>remaining) break;
    if (cost>remaining) { selected.unshift({...m,content:m.content.slice(-remaining)}); break; }
    selected.unshift(m); remaining-=cost;
  }
  return selected;
}

export function titleFromMessage(content:string) { const t=content.replace(/\s+/g,' ').trim(); return t.length>64 ? `${t.slice(0,61)}…` : t || 'Nova conversa'; }
