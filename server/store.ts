import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  projectOrchestration,
  type Approval,
  type Bootstrap,
  type DelegatedTask,
  type Message,
  type Project,
  type ProjectBrief,
  type Run,
  type RunEvent,
  type Session,
  type Settings,
  type Skill,
  type ConversationSearchHit,
  type StoredAttachment,
  type MessageQueue,
  type QueuePause,
  type QueuedMessage,
  QUEUE_LIMIT,
} from '../shared/contracts.js';
import { migrate, type MigrationResult } from './migrations.js';

const defaults: Settings = {
  defaultProviderId: 'codex',
  defaultMode: 'auto',
  memoryEnabled: false,
  sandbox: 'read-only',
  responseStyle: 'balanced',
  approvalMode: 'auto-safe',
};
const seedSkills: Skill[] = [
  {
    id: 'read-project',
    name: 'Ler projeto',
    description: 'Inspeciona estrutura e documentação antes de responder sobre o projeto.',
    body: 'Leia os arquivos relevantes do projeto antes de responder. Cite caminhos e diferencie fatos observados de inferências.',
    enabled: true,
  },
  {
    id: 'review-change',
    name: 'Revisar alteração',
    description: 'Procura erros de fluxo, regressões e validações ausentes.',
    body: 'Revise a alteração pelos fluxos reais. Priorize defeitos reproduzíveis, regressões e falhas de validação; separe sugestões opcionais.',
    enabled: true,
  },
  {
    id: 'explain-code',
    name: 'Explicar código',
    description: 'Explica comportamento com referências concretas ao código.',
    body: 'Explique o comportamento com referências aos arquivos e funções relevantes. Não afirme que executou algo sem evidência.',
    enabled: true,
  },
  {
    id: 'web-current',
    name: 'Pesquisa atual',
    description: 'Orienta consultas que dependem de informação atual.',
    body: 'Quando a informação puder ter mudado, use as ferramentas disponíveis para verificar fontes atuais e cite as fontes.',
    enabled: true,
  },
];

export class Store {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  /** Result of the schema migration run at open time (applied versions, backup path). */
  readonly migration: MigrationResult;
  constructor(dataDir = process.env.ADELIC_DATA_DIR || join(homedir(), '.local/share/adelic')) {
    this.dataDir = resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(join(this.dataDir, 'adelic.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    try {
      this.migration = migrate(this.db, this.dataDir);
    } catch (error) {
      this.db.close();
      throw error;
    }
    if (!this.getSettings()) this.setSettings(defaults);
    if (!this.listSkills().length) for (const skill of seedSkills) this.put('skills', skill.id, skill);
    this.db.exec(
      "UPDATE runs SET data=json_set(data,'$.status','interrupted','$.completedAt',datetime('now'),'$.error','Servidor reiniciado durante a execução') WHERE json_extract(data,'$.status')='running'",
    );
    this.db.exec(
      "UPDATE messages SET data=json_set(data,'$.status','interrupted') WHERE json_extract(data,'$.status')='running'",
    );
    this.db.exec(
      "UPDATE sessions SET data=json_remove(data,'$.activeRunId') WHERE json_extract(data,'$.activeRunId') IS NOT NULL",
    );
    this.db.exec(
      "UPDATE approvals SET data=json_set(data,'$.status','denied') WHERE json_extract(data,'$.status')='pending'",
    );
    this.db.exec(
      "UPDATE delegated_tasks SET data=json_set(data,'$.status','interrupted','$.completedAt',datetime('now'),'$.error','Servidor reiniciado durante a tarefa') WHERE json_extract(data,'$.status') IN ('running','queued')",
    );
    // Nothing drains a queue after a restart on its own: pause it so the UI offers "Retomar fila".
    this.db
      .prepare(
        'INSERT INTO message_queue_state(session_id,data) SELECT DISTINCT session_id, ? FROM message_queue WHERE session_id NOT IN (SELECT session_id FROM message_queue_state)',
      )
      .run(JSON.stringify({ reason: 'interrupted', at: new Date().toISOString() } satisfies QueuePause));
  }
  close() {
    this.db.close();
  }
  private get<T>(table: string, id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }
  private put<T>(table: string, id: string, data: T) {
    this.db
      .prepare(`INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`)
      .run(id, JSON.stringify(data));
  }
  private rows<T>(table: string, where = '', values: SQLInputValue[] = []): T[] {
    return (this.db.prepare(`SELECT data FROM ${table} ${where}`).all(...values) as { data: string }[]).map(
      (r) => JSON.parse(r.data) as T,
    );
  }
  getProject(id: string) {
    const p = this.get<Project>('projects', id);
    return p ? { ...p, orchestration: projectOrchestration(p) } : undefined;
  }
  listProjects() {
    return this.rows<Project>('projects', 'ORDER BY rowid DESC').map((p) => ({
      ...p,
      orchestration: projectOrchestration(p),
    }));
  }
  putProject(p: Project) {
    p = { ...p, orchestration: projectOrchestration(p) };
    this.put('projects', p.id, p);
    return p;
  }
  updateProject(p: Project) {
    return this.putProject(p);
  }
  putTask(task: DelegatedTask) {
    this.db
      .prepare(
        'INSERT INTO delegated_tasks(id,project_id,session_id,run_id,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(task.id, task.projectId, task.sessionId, task.runId, JSON.stringify(task));
    return task;
  }
  getTask(id: string) {
    const row = this.db.prepare('SELECT data FROM delegated_tasks WHERE id=?').get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as DelegatedTask) : undefined;
  }
  listTasks(projectId: string, limit = 50) {
    return (
      this.db
        .prepare('SELECT data FROM delegated_tasks WHERE project_id=? ORDER BY rowid DESC LIMIT ?')
        .all(projectId, limit) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as DelegatedTask);
  }
  listSessionTasks(sessionId: string, limit = 30) {
    return (
      this.db
        .prepare('SELECT data FROM delegated_tasks WHERE session_id=? ORDER BY rowid DESC LIMIT ?')
        .all(sessionId, limit) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as DelegatedTask);
  }
  listSessionTaskMetadata(sessionId: string) {
    return (
      this.db
        .prepare(
          "SELECT json_remove(data,'$.output') AS data FROM delegated_tasks WHERE session_id=? ORDER BY rowid DESC",
        )
        .all(sessionId) as { data: string }[]
    ).map((row) => {
      const task = JSON.parse(row.data) as DelegatedTask;
      return { ...task, output: undefined, instructions: task.instructions.slice(0, 600) };
    });
  }
  putBrief(brief: ProjectBrief) {
    this.db
      .prepare(
        'INSERT INTO project_briefs(project_id,data) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET data=excluded.data',
      )
      .run(brief.projectId, JSON.stringify(brief));
    return brief;
  }
  getBrief(projectId: string) {
    const row = this.db.prepare('SELECT data FROM project_briefs WHERE project_id=?').get(projectId) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ProjectBrief) : null;
  }
  listBriefs() {
    return (this.db.prepare('SELECT data FROM project_briefs ORDER BY rowid').all() as { data: string }[]).map(
      (r) => JSON.parse(r.data) as ProjectBrief,
    );
  }
  getSession(id: string) {
    return this.get<Session>('sessions', id);
  }
  listSessions() {
    return this.rows<Session>('sessions', 'ORDER BY rowid DESC');
  }
  putSession(s: Session) {
    this.db
      .prepare(
        'INSERT INTO sessions(id,project_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,data=excluded.data',
      )
      .run(s.id, s.projectId, JSON.stringify(s));
    return s;
  }
  deleteSession(id: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM delegated_tasks WHERE session_id=?').run(id);
      // attachments rows go with the session (ON DELETE CASCADE); the files are removed below.
      this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    rmSync(this.attachmentDir(id), { recursive: true, force: true });
  }
  /** Folder holding one conversation's attachment files (`<dataDir>/attachments/<sessionId>`). */
  attachmentDir(sessionId: string) {
    if (!/^[\w-]{1,128}$/.test(sessionId)) throw new Error('Identificador de conversa inválido');
    return join(this.dataDir, 'attachments', sessionId);
  }
  /** Absolute path of an attachment's file. */
  attachmentPath(attachment: StoredAttachment) {
    return join(this.attachmentDir(attachment.sessionId), attachment.file);
  }
  /**
   * Writes an attachment file (0600, folders 0700) and its row. The stored name keeps only
   * safe characters; the original name stays in the metadata for display.
   */
  saveAttachment(sessionId: string, name: string, kind: StoredAttachment['kind'], mime: string, bytes: Uint8Array) {
    const id = randomUUID();
    const safe =
      name
        .normalize('NFKD')
        .replace(/[^\w.-]+/g, '_')
        .replace(/^[.]+/, '')
        .slice(-80) || 'arquivo';
    const file = `${id}-${safe}`;
    const root = join(this.dataDir, 'attachments');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const dir = this.attachmentDir(sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, file), bytes, { mode: 0o600, flag: 'wx' });
    const attachment: StoredAttachment = {
      id,
      sessionId,
      name: name.slice(0, 200),
      mime,
      size: bytes.byteLength,
      kind,
      file,
      createdAt: new Date().toISOString(),
    };
    try {
      this.db
        .prepare('INSERT INTO attachments(id,session_id,data) VALUES(?,?,?)')
        .run(id, sessionId, JSON.stringify(attachment));
    } catch (error) {
      rmSync(join(dir, file), { force: true });
      throw error;
    }
    return attachment;
  }
  getAttachment(id: string) {
    return this.get<StoredAttachment>('attachments', id);
  }
  listAttachments(sessionId: string) {
    return this.rows<StoredAttachment>('attachments', 'WHERE session_id=? ORDER BY rowid', [sessionId]);
  }
  addMessage(m: Message, clientId?: string) {
    this.db
      .prepare('INSERT INTO messages(id,session_id,run_id,client_id,data) VALUES(?,?,?,?,?)')
      .run(m.id, m.sessionId, m.runId ?? null, clientId ?? null, JSON.stringify(m));
    return m;
  }
  createRun(user: Message, assistant: Message, run: Run, session: Session, clientId?: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.addMessage(user, clientId);
      this.addMessage(assistant);
      this.putRun(run);
      this.putSession(session);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  findClientMessage(sessionId: string, clientId: string) {
    const row = this.db
      .prepare('SELECT run_id FROM messages WHERE session_id=? AND client_id=?')
      .get(sessionId, clientId) as { run_id: string | null } | undefined;
    return row?.run_id ?? undefined;
  }
  listMessages(sessionId: string) {
    return this.rows<Message>('messages', 'WHERE session_id=? ORDER BY rowid', [sessionId]);
  }
  updateMessage(m: Message) {
    this.db.prepare('UPDATE messages SET data=? WHERE id=?').run(JSON.stringify(m), m.id);
  }
  putRun(r: Run) {
    this.db
      .prepare(
        'INSERT INTO runs(id,session_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,data=excluded.data',
      )
      .run(r.id, r.sessionId, JSON.stringify(r));
  }
  getRun(id: string) {
    return this.get<Run>('runs', id);
  }
  listRuns(sessionId?: string) {
    return sessionId
      ? this.rows<Run>('runs', "WHERE json_extract(data,'$.sessionId')=? ORDER BY rowid DESC", [sessionId])
      : this.rows<Run>('runs', 'ORDER BY rowid DESC');
  }
  addEvent(e: RunEvent) {
    this.db
      .prepare(
        'INSERT INTO events(id,session_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,data=excluded.data',
      )
      .run(e.id, e.sessionId, JSON.stringify(e));
  }
  listEvents(sessionId: string) {
    return this.rows<RunEvent>('events', "WHERE json_extract(data,'$.sessionId')=? ORDER BY rowid", [sessionId]);
  }
  putApproval(a: Approval) {
    this.db
      .prepare(
        'INSERT INTO approvals(id,session_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,data=excluded.data',
      )
      .run(a.id, a.sessionId, JSON.stringify(a));
  }
  getApproval(id: string) {
    return this.get<Approval>('approvals', id);
  }
  listApprovals(sessionId: string) {
    return this.rows<Approval>('approvals', "WHERE json_extract(data,'$.sessionId')=? ORDER BY rowid", [sessionId]);
  }
  getSettings() {
    const row = this.db.prepare('SELECT data FROM settings WHERE id=1').get() as { data: string } | undefined;
    return row ? { approvalMode: 'auto-safe' as const, ...(JSON.parse(row.data) as Settings) } : undefined;
  }
  setSettings(s: Settings) {
    this.db
      .prepare('INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(JSON.stringify(s));
    return s;
  }
  listSkills() {
    return this.rows<Skill>('skills', 'ORDER BY rowid');
  }
  getSkill(id: string) {
    return this.get<Skill>('skills', id);
  }
  setSkill(s: Skill) {
    this.put('skills', s.id, s);
    return s;
  }
  bootstrap(providers: Bootstrap['providers'], integrations: Bootstrap['integrations']): Bootstrap {
    return {
      projects: this.listProjects(),
      sessions: this.listSessions(),
      providers,
      settings: this.getSettings()!,
      integrations,
      skills: this.listSkills(),
      runs: this.listRuns().slice(0, 100),
    };
  }
  detail(session: Session) {
    return {
      session,
      messages: this.listMessages(session.id),
      events: this.listEvents(session.id),
      approvals: this.listApprovals(session.id),
      runs: this.listRuns(session.id),
      tasks: this.listSessionTaskMetadata(session.id),
    };
  }
  /**
   * Full-text search over message content and conversation titles, newest first. Each word
   * is matched as a prefix ("config" finds "configuração"); FTS syntax in the query is
   * neutralised by quoting every term.
   */
  searchConversations(query: string, limit = 30): ConversationSearchHit[] {
    const terms = query
      .normalize('NFC')
      .split(/\s+/)
      .map((t) => t.replace(/["*^:(){}[\]]/g, '').trim())
      .filter(Boolean)
      .slice(0, 8);
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t}"*`).join(' ');
    const rows = this.db
      .prepare(
        `SELECT f.session_id AS sessionId, f.message_id AS messageId,
                snippet(messages_fts, 0, '[[', ']]', '…', 14) AS snippet,
                json_extract(m.data, '$.role') AS role, json_extract(m.data, '$.createdAt') AS createdAt
           FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
          WHERE messages_fts MATCH ?
          ORDER BY m.rowid DESC
          LIMIT ?`,
      )
      .all(match, limit * 4) as {
      sessionId: string;
      messageId: string;
      snippet: string;
      role: Message['role'];
      createdAt: string;
    }[];
    const sessions = new Map(this.listSessions().map((session) => [session.id, session]));
    const folded = (value: string) =>
      value
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase();
    const titleHits = [...sessions.values()].filter((session) =>
      terms.every((t) => folded(session.title).includes(folded(t))),
    );
    const hits = new Map<string, ConversationSearchHit>();
    for (const session of titleHits)
      hits.set(session.id, {
        sessionId: session.id,
        title: session.title,
        projectId: session.projectId,
        updatedAt: session.updatedAt,
        matches: [],
      });
    for (const row of rows) {
      const session = sessions.get(row.sessionId);
      if (!session) continue;
      const hit = hits.get(session.id) ?? {
        sessionId: session.id,
        title: session.title,
        projectId: session.projectId,
        updatedAt: session.updatedAt,
        matches: [],
      };
      if (hit.matches.length < 3)
        hit.matches.push({ messageId: row.messageId, role: row.role, createdAt: row.createdAt, snippet: row.snippet });
      hits.set(session.id, hit);
    }
    return [...hits.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  listQueue(sessionId: string) {
    return this.rows<QueuedMessage>('message_queue', 'WHERE session_id=? ORDER BY position, rowid', [sessionId]);
  }
  getQueue(sessionId: string): MessageQueue {
    const row = this.db.prepare('SELECT data FROM message_queue_state WHERE session_id=?').get(sessionId) as
      { data: string } | undefined;
    return {
      sessionId,
      items: this.listQueue(sessionId),
      ...(row ? { paused: JSON.parse(row.data) as QueuePause } : {}),
    };
  }
  /**
   * Appends an item, or puts it at the front with `front` (a start that failed, or
   * "Enviar agora"). Returns the queued item that already has the same clientId, if any.
   * Throws 409 when the queue is full, unless `ignoreLimit`.
   */
  enqueue(item: QueuedMessage, options: { front?: boolean; ignoreLimit?: boolean } = {}): QueuedMessage {
    return this.transaction(() => {
      const items = this.listQueue(item.sessionId);
      const duplicate = item.clientId ? items.find((i) => i.clientId === item.clientId) : undefined;
      if (duplicate) return duplicate;
      if (!options.ignoreLimit && items.length >= QUEUE_LIMIT)
        throw Object.assign(new Error(`A fila já tem o máximo de ${QUEUE_LIMIT} mensagens`), { status: 409 });
      const bound = this.db
        .prepare(`SELECT ${options.front ? 'MIN' : 'MAX'}(position) AS p FROM message_queue WHERE session_id=?`)
        .get(item.sessionId) as { p: number | null };
      const position = bound.p === null ? 0 : options.front ? bound.p - 1 : bound.p + 1;
      this.db
        .prepare('INSERT INTO message_queue(id,session_id,position,data) VALUES(?,?,?,?)')
        .run(item.id, item.sessionId, position, JSON.stringify(item));
      return item;
    });
  }
  updateQueued(sessionId: string, itemId: string, content: string) {
    const item = this.listQueue(sessionId).find((i) => i.id === itemId);
    if (!item) return undefined;
    const next: QueuedMessage = { ...item, content, updatedAt: new Date().toISOString() };
    this.db
      .prepare('UPDATE message_queue SET data=? WHERE id=? AND session_id=?')
      .run(JSON.stringify(next), itemId, sessionId);
    return next;
  }
  removeQueued(sessionId: string, itemId: string) {
    const result = this.db.prepare('DELETE FROM message_queue WHERE id=? AND session_id=?').run(itemId, sessionId);
    return Number(result.changes) > 0;
  }
  /** Removes and returns the first queued item (or `itemId`), atomically. */
  takeQueued(sessionId: string, itemId?: string) {
    return this.transaction(() => {
      const items = this.listQueue(sessionId);
      const item = itemId ? items.find((i) => i.id === itemId) : items[0];
      if (item) this.db.prepare('DELETE FROM message_queue WHERE id=?').run(item.id);
      return item;
    });
  }
  setQueuePause(sessionId: string, pause: QueuePause | null) {
    if (pause)
      this.db
        .prepare(
          'INSERT INTO message_queue_state(session_id,data) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data',
        )
        .run(sessionId, JSON.stringify(pause));
    else this.db.prepare('DELETE FROM message_queue_state WHERE session_id=?').run(sessionId);
  }
  exportData() {
    return {
      projects: this.listProjects(),
      sessions: this.listSessions(),
      messages: this.listSessions().flatMap((s) => this.listMessages(s.id)),
      runs: this.listRuns(),
      events: this.listSessions().flatMap((s) => this.listEvents(s.id)),
      tasks: this.rows<DelegatedTask>('delegated_tasks', 'ORDER BY rowid'),
      briefs: this.listBriefs(),
      settings: this.getSettings(),
      skills: this.listSkills(),
    };
  }
}
