import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Versioned schema migrations, tracked in `PRAGMA user_version`.
 *
 * Rules: never edit a published migration; append a new one. Each migration runs in
 * its own transaction and bumps `user_version` in it, so a failure leaves the
 * database at the previous version. Databases that already hold data are copied to
 * `<dataDir>/backups/` before the first pending migration runs. A database whose
 * version is newer than this build (opened by an older Adelic) is refused instead of
 * being modified.
 */
export interface Migration {
  version: number;
  description: string;
  /** Runs inside a transaction, with foreign keys disabled when `rebuildsTables` is set. */
  up(db: DatabaseSync): void;
  /** Table rebuilds need `PRAGMA foreign_keys=OFF`, which SQLite ignores inside a transaction. */
  rebuildsTables?: boolean;
}

const baseSchema = `
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
  CREATE TABLE IF NOT EXISTS project_briefs(project_id TEXT PRIMARY KEY, data TEXT NOT NULL);`;

function projectIdIsNotNull(db: DatabaseSync, table: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[];
  return columns.find((c) => c.name === 'project_id')?.notnull === 1;
}

export const migrations: Migration[] = [
  {
    version: 1,
    description: 'Esquema da v0.3.0: tabelas base e project_id opcional em sessions/delegated_tasks',
    rebuildsTables: true,
    up(db) {
      db.exec(baseSchema);
      // Databases from v0.1.0 had NOT NULL project_id (no detached conversations).
      if (projectIdIsNotNull(db, 'sessions')) {
        db.exec(`CREATE TABLE sessions_new(id TEXT PRIMARY KEY, project_id TEXT, data TEXT NOT NULL, FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE);
          INSERT INTO sessions_new(id,project_id,data) SELECT id,project_id,data FROM sessions;
          DROP TABLE sessions;
          ALTER TABLE sessions_new RENAME TO sessions;`);
      }
      if (projectIdIsNotNull(db, 'delegated_tasks')) {
        db.exec(`CREATE TABLE delegated_tasks_new(id TEXT PRIMARY KEY, project_id TEXT, session_id TEXT NOT NULL, run_id TEXT NOT NULL, data TEXT NOT NULL);
          INSERT INTO delegated_tasks_new(id,project_id,session_id,run_id,data) SELECT id,project_id,session_id,run_id,data FROM delegated_tasks;
          DROP TABLE delegated_tasks;
          ALTER TABLE delegated_tasks_new RENAME TO delegated_tasks;`);
      }
    },
  },
  {
    version: 2,
    description: 'Busca nas conversas: índice FTS5 sobre o conteúdo das mensagens',
    up(db) {
      // External-content FTS over messages.data's content field, kept in sync by triggers.
      // remove_diacritics so "configuracao" finds "configuração".
      // Idempotent: rebuilt from scratch, so re-running it (or a partial earlier attempt) is safe.
      db.exec(`
        DROP TRIGGER IF EXISTS messages_fts_ai;
        DROP TRIGGER IF EXISTS messages_fts_ad;
        DROP TRIGGER IF EXISTS messages_fts_au;
        DROP TABLE IF EXISTS messages_fts;
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          content, session_id UNINDEXED, message_id UNINDEXED,
          tokenize = "unicode61 remove_diacritics 2"
        );
        INSERT INTO messages_fts(rowid, content, session_id, message_id)
          SELECT rowid, json_extract(data, '$.content'), session_id, id FROM messages;
        CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content, session_id, message_id)
            VALUES (new.rowid, json_extract(new.data, '$.content'), new.session_id, new.id);
        END;
        CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
          DELETE FROM messages_fts WHERE rowid = old.rowid;
        END;
        CREATE TRIGGER messages_fts_au AFTER UPDATE OF data ON messages BEGIN
          DELETE FROM messages_fts WHERE rowid = old.rowid;
          INSERT INTO messages_fts(rowid, content, session_id, message_id)
            VALUES (new.rowid, json_extract(new.data, '$.content'), new.session_id, new.id);
        END;`);
    },
  },
  {
    version: 3,
    description: 'Anexos de mensagens: tabela attachments ligada à conversa',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS attachments(
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          data TEXT NOT NULL,
          FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS attachments_session ON attachments(session_id);`);
    },
  },
  {
    version: 4,
    description: 'Fila de mensagens por conversa e estado de pausa da fila',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS message_queue(
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL,
          FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS message_queue_session ON message_queue(session_id, position);
        CREATE TABLE IF NOT EXISTS message_queue_state(
          session_id TEXT PRIMARY KEY, data TEXT NOT NULL,
          FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE);`);
    },
  },
  {
    version: 5,
    description: 'Comandos salvos: globais (project_id nulo) ou por projeto',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS commands(
          id TEXT PRIMARY KEY, project_id TEXT, data TEXT NOT NULL,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS commands_project ON commands(project_id);`);
    },
  },
  {
    version: 6,
    description: 'Modo de planejamento: planos por conversa',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plans(
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL,
          FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS plans_session ON plans(session_id);`);
    },
  },
  // Version 7 is reserved for a parallel branch.
  {
    version: 8,
    description: 'Compactação de conversas: resumos por conversa',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS compactions(
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL,
          FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS compactions_session ON compactions(session_id);`);
    },
  },
  {
    version: 9,
    description: 'Verificações e bloqueios por projeto (hooks)',
    up(db) {
      // Separate table instead of a field in projects.data: the hooks hold commands Adelic
      // executes, and a project PATCH or export must not carry or overwrite them by accident.
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_hooks(
          project_id TEXT PRIMARY KEY, data TEXT NOT NULL,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE);`);
    },
  },
  {
    version: 10,
    description: 'Automações agendadas: uma linha por automação, ligada ao projeto',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS automations(
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS automations_project ON automations(project_id);`);
    },
  },
  {
    version: 11,
    description: 'Catálogo de servidores MCP (opt-in por projeto)',
    up(db) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS mcp_servers(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, data TEXT NOT NULL);`,
      );
    },
  },
  {
    version: 12,
    description: 'Acesso remoto com usuário e senha: conta, sessões de login e últimos acessos',
    up(db) {
      // Separate tables, outside settings and exports: they hold the password hash and the
      // SHA-256 of session cookies (docs/specs/remote-access.md). remote_logins is a bounded log.
      db.exec(`
        CREATE TABLE IF NOT EXISTS remote_users(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS remote_sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS remote_sessions_user ON remote_sessions(user_id);
        CREATE TABLE IF NOT EXISTS remote_logins(id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);`);
    },
  },
  {
    version: 13,
    description: 'Servidores SSH: chaves públicas fixadas e executor sem credenciais',
    up(db) {
      db.exec('CREATE TABLE IF NOT EXISTS ssh_hosts(id TEXT PRIMARY KEY, data TEXT NOT NULL);');
    },
  },
  {
    version: 14,
    description: 'Traces locais de observabilidade com retenção limitada',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS observability_runs(
          run_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, session_id TEXT NOT NULL,
          project_id TEXT, provider_id TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL,
          completed_at TEXT, duration_ms INTEGER, first_token_ms INTEGER,
          input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, error_kind TEXT
        );
        CREATE INDEX IF NOT EXISTS observability_runs_started ON observability_runs(started_at DESC);
        CREATE INDEX IF NOT EXISTS observability_runs_project_started ON observability_runs(project_id,started_at DESC);
        CREATE INDEX IF NOT EXISTS observability_runs_session_started ON observability_runs(session_id,started_at DESC);
        CREATE INDEX IF NOT EXISTS observability_runs_provider_started ON observability_runs(provider_id,started_at DESC);
        CREATE INDEX IF NOT EXISTS observability_runs_status_started ON observability_runs(status,started_at DESC);
        CREATE TABLE IF NOT EXISTS observability_events(
          id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_id TEXT, run_id TEXT NOT NULL,
          session_id TEXT NOT NULL, project_id TEXT, at TEXT NOT NULL, name TEXT NOT NULL,
          component TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
          duration_ms INTEGER, attributes TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS observability_events_trace_at ON observability_events(trace_id,at);
        CREATE INDEX IF NOT EXISTS observability_events_run_component ON observability_events(run_id,component,status);
        CREATE INDEX IF NOT EXISTS observability_events_at ON observability_events(at);
        INSERT INTO observability_runs(run_id,trace_id,session_id,project_id,provider_id,status,started_at,completed_at,duration_ms,first_token_ms,input_tokens,output_tokens,cost_usd,error_kind)
          SELECT r.id,r.id,r.session_id,s.project_id,json_extract(r.data,'$.providerId'),
            CASE json_extract(r.data,'$.status') WHEN 'completed' THEN 'success' WHEN 'failed' THEN 'error' WHEN 'interrupted' THEN 'error' WHEN 'cancelled' THEN 'cancelled' ELSE 'running' END,
            COALESCE(json_extract(r.data,'$.startedAt'),'1970-01-01T00:00:00.000Z'),json_extract(r.data,'$.completedAt'),json_extract(r.data,'$.durationMs'),json_extract(r.data,'$.firstTokenMs'),
            json_extract(r.data,'$.inputTokens'),json_extract(r.data,'$.outputTokens'),json_extract(r.data,'$.costUsd'),
            CASE WHEN json_extract(r.data,'$.status') IN ('failed','interrupted') THEN 'failed' ELSE NULL END
          FROM runs r JOIN sessions s ON s.id=r.session_id;
        INSERT INTO observability_events(id,trace_id,parent_id,run_id,session_id,project_id,at,name,component,kind,status,duration_ms,attributes)
          SELECT 'run:'||r.id,r.id,NULL,r.id,r.session_id,s.project_id,
            COALESCE(json_extract(r.data,'$.completedAt'),json_extract(r.data,'$.startedAt'),'1970-01-01T00:00:00.000Z'),'run','orchestration','span',
            CASE json_extract(r.data,'$.status') WHEN 'completed' THEN 'success' WHEN 'failed' THEN 'error' WHEN 'interrupted' THEN 'error' WHEN 'cancelled' THEN 'cancelled' ELSE 'running' END,
            json_extract(r.data,'$.durationMs'),json_object('providerId',json_extract(r.data,'$.providerId'))
          FROM runs r JOIN sessions s ON s.id=r.session_id;
      `);
    },
  },
  {
    version: 15,
    description: 'Pastas virtuais de conversas vinculadas a projetos',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_folders(
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          parent_id TEXT,
          name TEXT NOT NULL,
          data TEXT NOT NULL,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
          FOREIGN KEY(parent_id) REFERENCES project_folders(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS project_folders_project_parent ON project_folders(project_id,parent_id);
        CREATE UNIQUE INDEX IF NOT EXISTS project_folders_root_name
          ON project_folders(project_id,name COLLATE NOCASE) WHERE parent_id IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS project_folders_child_name
          ON project_folders(project_id,parent_id,name COLLATE NOCASE) WHERE parent_id IS NOT NULL;
      `);
    },
  },
  {
    version: 16,
    description: 'Uso em cache e tokens de raciocínio na observabilidade',
    up(db) {
      const columns = new Set(
        (db.prepare('PRAGMA table_info(observability_runs)').all() as { name: string }[]).map((column) => column.name),
      );
      if (!columns.has('cached_input_tokens'))
        db.exec('ALTER TABLE observability_runs ADD COLUMN cached_input_tokens INTEGER;');
      if (!columns.has('reasoning_output_tokens'))
        db.exec('ALTER TABLE observability_runs ADD COLUMN reasoning_output_tokens INTEGER;');
      db.exec(`UPDATE observability_runs
        SET cached_input_tokens=(SELECT json_extract(r.data,'$.cachedInputTokens') FROM runs r WHERE r.id=observability_runs.run_id),
            reasoning_output_tokens=(SELECT json_extract(r.data,'$.reasoningOutputTokens') FROM runs r WHERE r.id=observability_runs.run_id);`);
    },
  },
];

export const schemaVersion = migrations.at(-1)!.version;
const BACKUPS_KEPT = 5;

export function userVersion(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
}

/** A database that already has tables holds history worth backing up; a new one does not. */
function hasUserData(db: DatabaseSync) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").all().length > 0;
}

/** Consistent copy of a live database (WAL included), keeping the newest few. */
function backup(db: DatabaseSync, dataDir: string, from: number, to: number) {
  const dir = join(dataDir, 'backups');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(dir, `adelic-v${from}-antes-de-v${to}-${stamp}.sqlite`);
  // VACUUM INTO writes a clean, self-contained copy without touching the source file.
  db.prepare('VACUUM INTO ?').run(target);
  chmodSync(target, 0o600);
  const old = readdirSync(dir)
    .filter((name) => name.startsWith('adelic-v') && name.endsWith('.sqlite'))
    .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .slice(BACKUPS_KEPT);
  for (const file of old) rmSync(join(dir, file.name), { force: true });
  return target;
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: number[];
  backupPath?: string;
}

export function migrate(db: DatabaseSync, dataDir: string, list: Migration[] = migrations): MigrationResult {
  const from = userVersion(db);
  const latest = list.at(-1)?.version ?? 0;
  if (from > latest)
    throw new Error(
      `A base de dados do Adelic é de uma versão mais nova (esquema ${from}; este aplicativo conhece até ${latest}). Atualize o Adelic; a base não foi alterada.`,
    );
  const pending = list.filter((m) => m.version > from);
  if (!pending.length) return { from, to: from, applied: [] };
  const backupPath = hasUserData(db) ? backup(db, dataDir, from, latest) : undefined;
  const applied: number[] = [];
  for (const migration of pending) {
    if (migration.rebuildsTables) db.exec('PRAGMA foreign_keys=OFF;');
    db.exec('BEGIN IMMEDIATE;');
    try {
      migration.up(db);
      if (migration.rebuildsTables) {
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length)
          throw new Error(`Migração ${migration.version} deixou ${violations.length} referências inválidas`);
      }
      db.exec(`PRAGMA user_version=${migration.version};`);
      db.exec('COMMIT;');
      applied.push(migration.version);
    } catch (error) {
      db.exec('ROLLBACK;');
      throw new Error(
        `Falha na migração ${migration.version} (${migration.description}); a base continua no esquema ${userVersion(db)}${backupPath ? ` e há uma cópia em ${backupPath}` : ''}.`,
        { cause: error },
      );
    } finally {
      if (migration.rebuildsTables) db.exec('PRAGMA foreign_keys=ON;');
    }
  }
  return { from, to: userVersion(db), applied, backupPath };
}

/** Restores a backup over a closed database file; used by tests and manual recovery. */
export function restoreBackup(backupPath: string, databasePath: string) {
  if (!existsSync(backupPath)) throw new Error(`Cópia não encontrada: ${backupPath}`);
  for (const suffix of ['-wal', '-shm']) rmSync(databasePath + suffix, { force: true });
  copyFileSync(backupPath, databasePath);
}
