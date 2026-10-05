import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GraphifyService, graphify, graphifyContext } from '../server/graphify.js';
import { createBackend } from '../server/index.js';
import { Store } from '../server/store.js';
import type { Project, ProviderRegistry } from '../shared/contracts.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(hang = false, mutateDuringExtraction = false) {
  const path = await mkdtemp(join(tmpdir(), 'adelic-graphify-')); dirs.push(path);
  await mkdir(join(path, '.adelic'));
  const binary = join(path, 'fake-graphify'), log = join(path, '.adelic/calls.jsonl'), envLog = join(path, '.adelic/cli-environment.json');
  await writeFile(join(path, 'app.ts'), 'export const a = 1;');
  await writeFile(binary, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
const envValues=fs.existsSync(${JSON.stringify(envLog)})?JSON.parse(fs.readFileSync(${JSON.stringify(envLog)},'utf8')):[];envValues.push(process.env.GRAPHIFY_OUT);fs.writeFileSync(${JSON.stringify(envLog)},JSON.stringify(envValues));
if(args[0]==='extract') {
  if(${hang}) { setInterval(()=>{},1000); } else {
    const out=args[args.indexOf('--out')+1],dir=path.join(out,'graphify-out');fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'graph.json'),JSON.stringify({nodes:[{id:'a',label:'a'}],edges:[]}));
    if(${mutateDuringExtraction}) fs.appendFileSync(path.join(${JSON.stringify(path)},'app.ts'),'\\n// concurrent source edit');
  }
} else if(args[0]==='query') { console.log('Scoped result: app.ts — symbol a'); }
`);
  await chmod(binary, 0o700);
  const project: Project = { id: 'p', name: 'P', path, createdAt: new Date().toISOString(), memoryWorkspace: 'pessoal', memoryProject: 'test' };
  return { project, binary, log, envLog, service: new GraphifyService(async () => binary, join(path, '.adelic/data')) };
}

describe('Graphify project index', () => {
  it('keeps the executable and graph path available when a worker receives a bounded excerpt', async () => {
    const { project } = await fixture();
    vi.spyOn(graphify, 'query').mockResolvedValue({ query: 'a', context: 'N'.repeat(5000), status: { enabled: true, installed: true, status: 'ready', graphPath: '/tmp/project graph/graphify-out/graph.json', detail: 'fixture' } });
    const context = await graphifyContext(project, 'a');
    expect(context.length).toBeLessThanOrEqual(4000);
    expect(context.slice(0,4000)).toContain("--graph '/tmp/project graph/graphify-out/graph.json' --budget 800");
    expect(context).toContain('dados não confiáveis');
  });

  it('indexes locally once for simultaneous callers, bounds queries, and detects source changes', async () => {
    const { project, log, envLog, service } = await fixture();
    expect((await service.status(project)).status).toBe('unindexed');
    const [first, second] = await Promise.all([service.index(project), service.index(project)]);
    expect(first.status).toBe('ready'); expect(second.nodes).toBe(1);
    const query = await service.query(project, 'a'); expect(query.context).toContain('app.ts');
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(calls.filter(args => args[0] === 'extract')).toHaveLength(1);
    expect(calls[0]).toContain('--code-only'); expect(calls[0]).toContain('--no-cluster');
    expect(calls[1].slice(-2)).toEqual(['--budget', '800']);
    const envValues=JSON.parse(await readFile(envLog,'utf8')) as string[];
    expect(envValues).toHaveLength(calls.length);
    expect(envValues).toEqual(Array(calls.length).fill(dirname(service.graphPath(project))));
    await writeFile(join(project.path, 'app.ts'), 'export const a = 10000;');
    expect((await service.status(project)).status).toBe('stale');
    expect((await service.query(project, 'a')).status.status).toBe('ready');
    await writeFile(join(project.path, 'new-language.dart'), 'void main() {}');
    expect((await service.status(project)).status).toBe('stale');
  });

  it('reports missing and disabled indices without pretending to retrieve a graph', async () => {
    const { project } = await fixture(); const service = new GraphifyService(async () => undefined);
    expect((await service.query(project, 'a')).status.status).toBe('missing');
    const disabled = await service.query({ ...project, graphify: { enabled: false } }, 'a');
    expect(disabled.context).toBe(''); expect(disabled.status.status).toBe('disabled');
  });

  it('kills an indexing child on cancellation and never marks it ready', async () => {
    const { project, binary, log, service } = await fixture(true); const controller = new AbortController();
    const indexing = service.index(project, controller.signal);
    for (let i = 0; i < 100; i++) { try { if ((await readFile(log, 'utf8')).length) break; } catch {} await new Promise(resolve => setTimeout(resolve, 10)); }
    controller.abort(); const status = await indexing;
    expect(status.status).toBe('error'); expect(status.detail).toContain('cancelada');
    await writeFile(binary, (await readFile(binary, 'utf8')).replace('if(true)', 'if(false)'));
    const recovered = await service.query(project, 'a');
    expect(recovered.status.status).toBe('ready'); expect(recovered.context).toContain('app.ts');
  });

  it('cancels a shared index waiter independently while preserving the manual index until service shutdown', async () => {
    const { project, log, service } = await fixture(true);
    let firstSettled = false;
    const manualIndex = service.index(project).then(status => { firstSettled = true; return status; });
    for (let i = 0; i < 100; i++) { try { if ((await readFile(log, 'utf8')).trim()) break; } catch {} await new Promise(resolve => setTimeout(resolve, 10)); }
    const controller = new AbortController();
    const orchestrationWaiter = service.index(project, controller.signal);
    await new Promise<void>(resolve => setImmediate(resolve));
    controller.abort();
    await expect(orchestrationWaiter).rejects.toThrow('Consulta Graphify cancelada');
    expect(firstSettled).toBe(false);
    await service.shutdown();
    const status = await manualIndex;
    expect(status.status).toBe('error'); expect(status.detail).toContain('cancelada');
  });

  it('does not return outdated context when code changes during extraction', async () => {
    const { project, log, service } = await fixture(false, true);
    const result = await service.query(project, 'a');
    expect(result.status.status).toBe('stale'); expect(result.context).toBe('');
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(calls.every(args => args[0] !== 'query')).toBe(true);
  });

  it.each([
    ['index', (id: string) => `/api/projects/${id}/graphify/index`, undefined],
    ['query', (id: string) => `/api/projects/${id}/graphify/query`, JSON.stringify({ query: 'long-running query' })],
  ] as const)('stops a running manual Graphify %s request before backend shutdown completes', async (_name, endpoint, body) => {
    const { project, log, service } = await fixture(true);
    const store = new Store(join(project.path, '.adelic/data'));
    store.putProject(project);
    const providers: ProviderRegistry = { async list() { return []; }, async run() { throw new Error('provider should not run'); }, async approve() {}, async shutdown() {} };
    const backend = createBackend(store, providers, service);
    expect(backend.graphify).toBe(service);
    const server = createServer(backend.app); servers.push(server); server.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.listening ? resolve() : server.once('listening', () => resolve()));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
    const request = fetch(`http://127.0.0.1:${address.port}${endpoint(project.id)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, ...(body ? { body } : {}),
    });
    for (let i = 0; i < 100; i++) { try { if ((await readFile(log, 'utf8')).trim()) break; } catch {} await new Promise(resolve => setTimeout(resolve, 10)); }
    expect((await readFile(log, 'utf8')).trim()).not.toBe('');
    await service.shutdown();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const response = await Promise.race([request, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('manual Graphify route did not stop')), 3000); })]).finally(() => clearTimeout(timeout));
    expect(response.status).toBe(503);
    const payload = await response.json() as { status?: string; error?: string };
    if (endpoint(project.id).endsWith('/index')) expect(payload.status).toBe('error'); else expect(payload.error).toContain('cancelada');
    await backend.orchestrator.shutdown(); store.close();
  });
});
