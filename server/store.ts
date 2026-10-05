import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { projectOrchestration, type Approval, type Bootstrap, type DelegatedTask, type Message, type Project, type ProjectBrief, type Run, type RunEvent, type Session, type Settings, type Skill } from '../shared/contracts.js';

const defaults: Settings = { defaultProviderId: 'codex', defaultMode: 'auto', memoryEnabled: false, sandbox: 'read-only', responseStyle: 'balanced' };
const seedSkills: Skill[] = [
  { id: 'read-project', name: 'Ler projeto', description: 'Inspeciona estrutura e documentação antes de responder sobre o projeto.', body: 'Leia os arquivos relevantes do projeto antes de responder. Cite caminhos e diferencie fatos observados de inferências.', enabled: true },
  { id: 'review-change', name: 'Revisar alteração', description: 'Procura erros de fluxo, regressões e validações ausentes.', body: 'Revise a alteração pelos fluxos reais. Priorize defeitos reproduzíveis, regressões e falhas de validação; separe sugestões opcionais.', enabled: true },
  { id: 'explain-code', name: 'Explicar código', description: 'Explica comportamento com referências concretas ao código.', body: 'Explique o comportamento com referências aos arquivos e funções relevantes. Não afirme que executou algo sem evidência.', enabled: true },
  { id: 'web-current', name: 'Pesquisa atual', description: 'Orienta consultas que dependem de informação atual.', body: 'Quando a informação puder ter mudado, use as ferramentas disponíveis para verificar fontes atuais e cite as fontes.', enabled: true },
];

export class Store {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  constructor(dataDir = process.env.ADELIC_DATA_DIR || join(homedir(), '.local/share/adelic')) {
    this.dataDir = resolve(dataDir); mkdirSync(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(join(this.dataDir, 'adelic.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, project_id TEXT, data TEXT NOT NULL, FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, client_id TEXT, data TEXT NOT NULL, FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE);
      CREATE UNIQUE INDEX IF NOT EXISTS messages_client_unique ON messages(session_id,client_id) WHERE client_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL, FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL, FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL, FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skills(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delegated_tasks(id TEXT PRIMARY KEY, project_id TEXT, session_id TEXT NOT NULL, run_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_briefs(project_id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    this.migrateNullableProjectIds();
    if (!this.getSettings()) this.setSettings(defaults);
    if (!this.listSkills().length) for (const skill of seedSkills) this.put('skills', skill.id, skill);
    this.db.exec("UPDATE runs SET data=json_set(data,'$.status','interrupted','$.completedAt',datetime('now'),'$.error','Servidor reiniciado durante a execução') WHERE json_extract(data,'$.status')='running'");
    this.db.exec("UPDATE messages SET data=json_set(data,'$.status','interrupted') WHERE json_extract(data,'$.status')='running'");
    this.db.exec("UPDATE sessions SET data=json_remove(data,'$.activeRunId') WHERE json_extract(data,'$.activeRunId') IS NOT NULL");
    this.db.exec("UPDATE approvals SET data=json_set(data,'$.status','denied') WHERE json_extract(data,'$.status')='pending'");
    this.db.exec("UPDATE delegated_tasks SET data=json_set(data,'$.status','interrupted','$.completedAt',datetime('now'),'$.error','Servidor reiniciado durante a tarefa') WHERE json_extract(data,'$.status') IN ('running','queued')");
  }
  private migrateNullableProjectIds() {
    const needsRebuild=(table:string)=>((this.db.prepare(`PRAGMA table_info(${table})`).all() as {name:string;notnull:number}[]).find(c=>c.name==='project_id')?.notnull===1);
    if (!needsRebuild('sessions') && !needsRebuild('delegated_tasks')) return;
    this.db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
    try {
      if (needsRebuild('sessions')) {
        this.db.exec(`CREATE TABLE sessions_new(id TEXT PRIMARY KEY, project_id TEXT, data TEXT NOT NULL, FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE);
          INSERT INTO sessions_new(id,project_id,data) SELECT id,project_id,data FROM sessions;
          DROP TABLE sessions;
          ALTER TABLE sessions_new RENAME TO sessions;`);
      }
      if (needsRebuild('delegated_tasks')) {
        this.db.exec(`CREATE TABLE delegated_tasks_new(id TEXT PRIMARY KEY, project_id TEXT, session_id TEXT NOT NULL, run_id TEXT NOT NULL, data TEXT NOT NULL);
          INSERT INTO delegated_tasks_new(id,project_id,session_id,run_id,data) SELECT id,project_id,session_id,run_id,data FROM delegated_tasks;
          DROP TABLE delegated_tasks;
          ALTER TABLE delegated_tasks_new RENAME TO delegated_tasks;`);
      }
      this.db.exec('COMMIT; PRAGMA foreign_keys=ON;');
    } catch(error) { this.db.exec('ROLLBACK; PRAGMA foreign_keys=ON;'); throw error; }
  }
  close() { this.db.close(); }
  private get<T>(table: string, id: string): T | undefined { const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as {data:string}|undefined; return row ? JSON.parse(row.data) as T : undefined; }
  private put<T>(table:string,id:string,data:T) { this.db.prepare(`INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(id,JSON.stringify(data)); }
  private rows<T>(table:string, where = '', values: SQLInputValue[] = []): T[] { return (this.db.prepare(`SELECT data FROM ${table} ${where}`).all(...values) as {data:string}[]).map(r=>JSON.parse(r.data) as T); }
  getProject(id:string) { const p=this.get<Project>('projects',id);return p?{...p,orchestration:projectOrchestration(p)}:undefined; }
  listProjects() { return this.rows<Project>('projects','ORDER BY rowid DESC').map(p=>({...p,orchestration:projectOrchestration(p)})); }
  putProject(p:Project) { p={...p,orchestration:projectOrchestration(p)};this.put('projects',p.id,p); return p; }
  updateProject(p:Project) { return this.putProject(p); }
  putTask(task:DelegatedTask) { this.db.prepare('INSERT INTO delegated_tasks(id,project_id,session_id,run_id,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(task.id,task.projectId,task.sessionId,task.runId,JSON.stringify(task)); return task; }
  getTask(id:string) { const row=this.db.prepare('SELECT data FROM delegated_tasks WHERE id=?').get(id) as {data:string}|undefined; return row ? JSON.parse(row.data) as DelegatedTask : undefined; }
  listTasks(projectId:string,limit=50) { return (this.db.prepare('SELECT data FROM delegated_tasks WHERE project_id=? ORDER BY rowid DESC LIMIT ?').all(projectId,limit) as {data:string}[]).map(r=>JSON.parse(r.data) as DelegatedTask); }
  listSessionTasks(sessionId:string,limit=30) { return (this.db.prepare('SELECT data FROM delegated_tasks WHERE session_id=? ORDER BY rowid DESC LIMIT ?').all(sessionId,limit) as {data:string}[]).map(r=>JSON.parse(r.data) as DelegatedTask); }
  putBrief(brief:ProjectBrief) { this.db.prepare('INSERT INTO project_briefs(project_id,data) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET data=excluded.data').run(brief.projectId,JSON.stringify(brief)); return brief; }
  getBrief(projectId:string) { const row=this.db.prepare('SELECT data FROM project_briefs WHERE project_id=?').get(projectId) as {data:string}|undefined; return row ? JSON.parse(row.data) as ProjectBrief : null; }
  listBriefs() { return (this.db.prepare('SELECT data FROM project_briefs ORDER BY rowid').all() as {data:string}[]).map(r=>JSON.parse(r.data) as ProjectBrief); }
  getSession(id:string) { return this.get<Session>('sessions',id); }
  listSessions() { return this.rows<Session>('sessions','ORDER BY rowid DESC'); }
  putSession(s:Session) { this.db.prepare('INSERT INTO sessions(id,project_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,data=excluded.data').run(s.id,s.projectId,JSON.stringify(s)); return s; }
  deleteSession(id:string) {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('DELETE FROM delegated_tasks WHERE session_id=?').run(id);this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);this.db.exec('COMMIT'); }
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  addMessage(m:Message, clientId?:string) { this.db.prepare('INSERT INTO messages(id,session_id,run_id,client_id,data) VALUES(?,?,?,?,?)').run(m.id,m.sessionId,m.runId ?? null,clientId ?? null,JSON.stringify(m)); return m; }
  createRun(user:Message,assistant:Message,run:Run,session:Session,clientId?:string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.addMessage(user,clientId);
      this.addMessage(assistant);
      this.putRun(run);
      this.putSession(session);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  findClientMessage(sessionId:string, clientId:string) { const row=this.db.prepare('SELECT run_id FROM messages WHERE session_id=? AND client_id=?').get(sessionId,clientId) as {run_id:string|null}|undefined; return row?.run_id ?? undefined; }
  listMessages(sessionId:string) { return this.rows<Message>('messages','WHERE session_id=? ORDER BY rowid',[sessionId]); }
  updateMessage(m:Message) { this.db.prepare('UPDATE messages SET data=? WHERE id=?').run(JSON.stringify(m),m.id); }
  putRun(r:Run) { this.db.prepare('INSERT INTO runs(id,session_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,data=excluded.data').run(r.id,r.sessionId,JSON.stringify(r)); }
  getRun(id:string) { return this.get<Run>('runs',id); }
  listRuns(sessionId?:string) { return sessionId ? this.rows<Run>('runs','WHERE json_extract(data,\'$.sessionId\')=? ORDER BY rowid DESC',[sessionId]) : this.rows<Run>('runs','ORDER BY rowid DESC'); }
  addEvent(e:RunEvent) { this.db.prepare('INSERT INTO events(id,session_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,data=excluded.data').run(e.id,e.sessionId,JSON.stringify(e)); }
  listEvents(sessionId:string) { return this.rows<RunEvent>('events','WHERE json_extract(data,\'$.sessionId\')=? ORDER BY rowid',[sessionId]); }
  putApproval(a:Approval) { this.db.prepare('INSERT INTO approvals(id,session_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,data=excluded.data').run(a.id,a.sessionId,JSON.stringify(a)); }
  getApproval(id:string) { return this.get<Approval>('approvals',id); }
  listApprovals(sessionId:string) { return this.rows<Approval>('approvals','WHERE json_extract(data,\'$.sessionId\')=? ORDER BY rowid',[sessionId]); }
  getSettings() { const row=this.db.prepare('SELECT data FROM settings WHERE id=1').get() as {data:string}|undefined; return row ? JSON.parse(row.data) as Settings : undefined; }
  setSettings(s:Settings) { this.db.prepare('INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(s)); return s; }
  listSkills() { return this.rows<Skill>('skills','ORDER BY rowid'); }
  getSkill(id:string) { return this.get<Skill>('skills',id); }
  setSkill(s:Skill) { this.put('skills',s.id,s); return s; }
  bootstrap(providers: Bootstrap['providers'], integrations: Bootstrap['integrations']):Bootstrap { return { projects:this.listProjects(), sessions:this.listSessions(), providers, settings:this.getSettings()!, integrations, skills:this.listSkills(), runs:this.listRuns().slice(0,100) }; }
  detail(session:Session) { return { session, messages:this.listMessages(session.id), events:this.listEvents(session.id), approvals:this.listApprovals(session.id), runs:this.listRuns(session.id), tasks:this.listSessionTasks(session.id).map(t=>({...t,output:undefined,instructions:t.instructions.slice(0,600)})) }; }
  exportData() { return { projects:this.listProjects(), sessions:this.listSessions(), messages:this.listSessions().flatMap(s=>this.listMessages(s.id)), runs:this.listRuns(), events:this.listSessions().flatMap(s=>this.listEvents(s.id)), tasks:this.rows<DelegatedTask>('delegated_tasks','ORDER BY rowid'), briefs:this.listBriefs(), settings:this.getSettings(), skills:this.listSkills() }; }
}
