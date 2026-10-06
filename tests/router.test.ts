import { describe, expect, it } from 'vitest';
import { routeMessage } from '../server/router.js';
import { memoryQueryTerms } from '../server/memory.js';

describe('adaptive router', () => {
  it('keeps direct conceptual questions fast even when long or technical', () => {
    expect(routeMessage('Explique o que é uma API REST e como ela funciona.', 'auto').level).toBe('fast');
    expect(routeMessage('Compare gato e cachorro em termos de personalidade.', 'auto').level).toBe('fast');
    expect(routeMessage('Explique em bastante detalhe os fundamentos de TypeScript e como tipos estruturais ajudam a organizar uma aplicação grande.', 'auto').level).toBe('fast');
  });
  it('routes short file, current research, and follow-up requests deeply', () => {
    const readme=routeMessage('Leia o README', 'auto');
    expect(readme).toMatchObject({level:'deep',tools:true,contextBudget:24000,effort:'high'});
    expect(routeMessage('Summarize the README', 'auto').tools).toBe(true);
    expect(routeMessage('Explique este código', 'auto').tools).toBe(true);
    expect(routeMessage('Pesquise a cotação atual do dólar', 'auto').tools).toBe(true);
    expect(routeMessage('e corrija esse problema agora', 'auto', [{id:'1',sessionId:'s',role:'user',content:'Leia o README',createdAt:''}]).level).toBe('deep');
  });
  it('routes explicit file paths and plural file or project references to tools',()=>{
    for (const prompt of ['Leia src/App.tsx','Read scripts/check.py','Open config/project.json','Leia os arquivos','Read two files','Analise os projetos']) {
      expect(routeMessage(prompt,'auto')).toMatchObject({level:'deep',tools:true});
    }
    expect(routeMessage('Explique a versão 3.14','auto')).toMatchObject({level:'fast',tools:true,memory:false});
  });
  it('honors manual mode and never consults memory in fast mode', () => {
    expect(routeMessage('Leia o README', 'fast', [], true)).toMatchObject({level:'fast',tools:true,memory:false,effort:'low',contextBudget:6000});
    expect(routeMessage('Explique este conceito', 'deep')).toMatchObject({level:'deep',effort:'high',contextBudget:24000});
  });
  it('keeps ordinary creative and conceptual prompts fast while making tools available', () => {
    for (const prompt of ['Crie uma poesia', 'Teste meus conhecimentos de história', 'Como funciona um teste unitário?', 'Explique o que é um teste unitário?', 'O que significa commit?', 'Como a web funciona?', 'Como funciona o comando build?', 'O que significa PR?', 'Defina clima']) {
      expect(routeMessage(prompt, 'auto')).toMatchObject({level:'fast',tools:true,memory:false});
    }
    expect(routeMessage('Qual é o clima hoje?', 'auto').tools).toBe(true);
    expect(routeMessage('Rode o build do projeto', 'auto').tools).toBe(true);
    expect(routeMessage('Crie uma poesia', 'deep').tools).toBe(false);
  });
  it('searches memory by a short subject instead of the full request', () => {
    expect(memoryQueryTerms('Lembre o que decidimos sobre VPN e Tailscale no computador')).toEqual(['VPN','Tailscale','computador']);
    expect(memoryQueryTerms('O que decidimos sobre Adelic e memória?')).toEqual(['Adelic']);
  });
  it('delegates concrete software changes while keeping API definitions simple', () => {
    for (const prompt of ['Implemente uma rota de API', 'Crie um endpoint', 'Adicione um componente de login', 'Create a database migration']) {
      expect(routeMessage(prompt, 'auto')).toMatchObject({ level: 'deep', tools: true });
    }
    expect(routeMessage('Explique o que é uma API REST', 'auto')).toMatchObject({ level: 'fast', tools: true, memory: false });
  });
});
