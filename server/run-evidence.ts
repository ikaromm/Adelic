import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, parse, relative, resolve, sep } from 'node:path';
import type { WriteStream } from 'node:fs';

export interface RunEvidenceCheck {
  eventId: string;
  name: string;
  status: string;
  exitCode: number | null;
  command?: string;
  output?: string;
  truncated?: boolean;
  detail?: string;
  operationalLog?: { status: 'available' | 'truncated' | 'unavailable'; bytes?: number };
  source: unknown;
  environment: unknown;
}
export interface RunEvidenceRecord {
  runId: string;
  sessionId: string;
  taskId?: string;
  capturedAt: string;
  source: unknown;
  environment: unknown;
  artifacts: unknown;
  checks: RunEvidenceCheck[];
  outcome: { status: string; termination?: string; error?: string };
  workers?: unknown[];
  /** Bounded observed executions, separate from configured checks and approval. */
  reviewObservations?: unknown[];
  /** Bounded excerpt for indexes/context; full output is available only via explicit paging. */
  review?: string;
  fullReview?: string;
}

export const RUN_EVIDENCE_LOG_MAX = 8 * 1024 * 1024;

/** Private operational evidence store, outside the project tree/Git. */
export class RunEvidenceStore {
  constructor(private readonly dataDir: string) {}

  private readonly writes = new Map<string, Promise<void>>();

  private async verifyDirectory(directory: string) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('evidence directory is not private storage');
  }

  /** Verify every existing component, not just the leaf: an ancestor symlink can redirect writes. */
  private async verifyDirectoryChain(directory: string) {
    const absolute = resolve(directory);
    const root = parse(absolute).root;
    let current = root;
    for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
      current = join(current, component);
      await this.verifyDirectory(current);
    }
  }

  private async ensureDirectory(directory: string) {
    const absolute = resolve(directory);
    const root = parse(absolute).root;
    let current = root;
    for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
      current = join(current, component);
      try {
        await lstat(current);
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
        // Create one component only after its parent was verified, avoiding recursive mkdir
        // following a pre-existing symlink into another evidence compartment.
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if (
            !mkdirError ||
            typeof mkdirError !== 'object' ||
            !('code' in mkdirError) ||
            mkdirError.code !== 'EEXIST'
          ) {
            throw mkdirError;
          }
        }
      }
      await this.verifyDirectory(current);
    }
    await chmod(absolute, 0o700);
  }

  private path(runId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error('invalid run id');
    return join(this.dataDir, 'run-evidence', runId + '.json');
  }

  private logDirectory(runId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error('invalid run id');
    return join(this.dataDir, 'run-evidence', runId);
  }

  private logPath(runId: string, eventId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(eventId)) throw new Error('invalid check event id');
    return join(this.logDirectory(runId), eventId + '.log');
  }

  async beginCheckLog(runId: string, eventId: string) {
    const directory = this.logDirectory(runId);
    await this.ensureDirectory(directory);
    const stream: WriteStream = createWriteStream(this.logPath(runId, eventId), { flags: 'wx', mode: 0o600 });
    let bytes = 0;
    let truncated = false;
    let failure = false;
    stream.on('error', () => (failure = true));
    return {
      write: (chunk: Buffer) => {
        if (failure) return;
        const remaining = RUN_EVIDENCE_LOG_MAX - bytes;
        if (remaining <= 0) {
          truncated = true;
          return;
        }
        const accepted = chunk.subarray(0, remaining);
        if (accepted.length !== chunk.length) truncated = true;
        bytes += accepted.length;
        stream.write(accepted);
      },
      finish: () =>
        new Promise<{ status: 'available' | 'truncated' | 'unavailable'; bytes?: number }>((resolve) => {
          stream.end(() =>
            resolve(failure ? { status: 'unavailable' } : { status: truncated ? 'truncated' : 'available', bytes }),
          );
        }),
    };
  }

  async getCheckLog(runId: string, eventId: string) {
    try {
      await this.verifyDirectoryChain(this.logDirectory(runId));
      return await readFile(this.logPath(runId, eventId), 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async put(record: RunEvidenceRecord) {
    const previous = this.writes.get(record.runId);
    const write = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(async () => {
      const current = await this.get(record.runId);
      const latest = current && current.capturedAt > record.capturedAt ? current : record;
      return this.writeRecord({
        ...current,
        ...latest,
        ...((latest.workers ?? current?.workers) ? { workers: latest.workers ?? current?.workers } : {}),
        ...((latest.review ?? current?.review) ? { review: latest.review ?? current?.review } : {}),
        ...((latest.fullReview ?? current?.fullReview) ? { fullReview: latest.fullReview ?? current?.fullReview } : {}),
      });
    });
    const settled = write.then(
      () => undefined,
      () => undefined,
    );
    this.writes.set(record.runId, settled);
    void settled.then(() => {
      if (this.writes.get(record.runId) === settled) this.writes.delete(record.runId);
    });
    return write;
  }

  private async writeRecord(record: RunEvidenceRecord) {
    const directory = join(this.dataDir, 'run-evidence');
    await this.ensureDirectory(directory);
    const target = this.path(record.runId);
    // Runs without checks still need a real, confined log compartment for the Codex MCP binding.
    await this.ensureDirectory(this.logDirectory(record.runId));
    const temp = target + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
    await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    await rename(temp, target);
    await chmod(target, 0o600);
    return target;
  }

  async get(runId: string): Promise<RunEvidenceRecord | undefined> {
    try {
      await this.verifyDirectoryChain(join(this.dataDir, 'run-evidence'));
      return JSON.parse(await readFile(this.path(runId), 'utf8')) as RunEvidenceRecord;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  /** Per-run capability MCP endpoint: callers cannot select another run or arbitrary files. */
  mcpServer(runId: string) {
    const file = this.path(runId);
    const logDirectory = this.logDirectory(runId);
    const code = `const fs=require('node:fs'),path=require('node:path');let b='';const file=process.env.ADELIC_RUN_EVIDENCE_FILE,dir=process.env.ADELIC_RUN_EVIDENCE_LOG_DIR;function send(x){process.stdout.write(JSON.stringify(x)+'\\n')}function handle(m){if(m.method==='initialize')return send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'adelic-run-evidence',version:'0.5.4'}}});if(m.method==='notifications/initialized')return;if(m.method==='tools/list')return send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'get_run_evidence',description:'Recupera evidências persistidas desta execução; sem argumentos retorna índice compacto, review:true pagina a revisão completa sob demanda e checkEventId recupera o log daquele check.',inputSchema:{type:'object',properties:{checkEventId:{type:'string'},review:{type:'boolean'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:12000}},additionalProperties:false}}]}});if(m.method==='tools/call'){try{const x=JSON.parse(fs.readFileSync(file,'utf8'));const args=m.params?.arguments||{},id=args.checkEventId,offset=Math.max(0,Math.floor(Number(args.offset)||0)),limit=Math.min(12000,Math.max(1,Math.floor(Number(args.limit)||12000)));let value;if(args.review===true){const full=x.fullReview||'';const page=full.slice(offset,offset+limit);value={review:page,totalChars:full.length,nextOffset:offset+page.length<full.length?offset+page.length:null}}else if(id){if(!/^[0-9a-f-]{36}$/i.test(id))throw 0;const c=x.checks.find(c=>c.eventId===id);if(!c)value={available:false,reason:'check evidence not found'};else{let output;try{const p=path.join(dir,id+'.log');if(path.dirname(p)!==dir)throw 0;const full=fs.readFileSync(p,'utf8');output=full.slice(offset,offset+limit);var totalChars=full.length,nextOffset=offset+output.length<full.length?offset+output.length:null}catch{}value={...c,output:output??c.output??'',completeLogAvailable:output!==undefined&&c.operationalLog?.status==='available',totalChars:totalChars??(c.output||'').length,nextOffset:nextOffset??null}}}else value={runId:x.runId,sessionId:x.sessionId,capturedAt:x.capturedAt,source:x.source,environment:x.environment,artifacts:x.artifacts,outcome:x.outcome,checks:x.checks.map(({eventId,name,status,exitCode,command,truncated,detail,operationalLog,source,environment})=>({eventId,name,status,exitCode,command,truncated,detail,operationalLog,source,environment})),workers:x.workers,review:x.review};send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:JSON.stringify(value)}],isError:false}})}catch(e){send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'Evidence unavailable or unreadable'}],isError:true}})}return}if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}})}process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;for(;;){const i=b.indexOf('\\n');if(i<0)break;const l=b.slice(0,i);b=b.slice(i+1);if(l)try{handle(JSON.parse(l))}catch{}}});`;
    return {
      name: 'adelic-run-evidence',
      command: process.execPath,
      args: ['-e', code],
      env: { ADELIC_RUN_EVIDENCE_FILE: file, ADELIC_RUN_EVIDENCE_LOG_DIR: logDirectory },
      passEnv: [],
      tools: ['get_run_evidence'],
    };
  }
}
