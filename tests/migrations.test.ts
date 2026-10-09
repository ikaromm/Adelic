import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  migrate,
  migrations,
  restoreBackup,
  schemaVersion,
  userVersion,
  type Migration,
} from '../server/migrations.js';
import { Store } from '../server/store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-migrations-'));
  dirs.push(dir);
  return dir;
};
const tableRows = (db: DatabaseSync, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();

describe('SQLite schema migrations', () => {
  it('creates a new database at the latest version without a backup', () => {
    const dir = tempDir();
    const store = new Store(dir);
    expect(store.migration).toMatchObject({ from: 0, to: schemaVersion, applied: migrations.map((m) => m.version) });
    expect(store.migration.backupPath).toBeUndefined();
    expect(userVersion(store.db)).toBe(schemaVersion);
    store.close();
    expect(existsSync(join(dir, 'backups'))).toBe(false);
  });

  it('adopts an existing unversioned v0.3.0 database, preserving every row and backing it up first', () => {
    const dir = tempDir();
    const first = new Store(dir);
    first.db.exec('PRAGMA user_version=0;');
    first.putProject({ id: 'p', name: 'P', path: '/tmp', createdAt: 'now', memoryWorkspace: 'w', memoryProject: 'p' });
    const before = ['projects', 'sessions', 'settings', 'skills'].map((t) => tableRows(first.db, t));
    first.close();
    const reopened = new Store(dir);
    expect(reopened.migration).toMatchObject({ from: 0, to: schemaVersion, applied: migrations.map((m) => m.version) });
    expect(['projects', 'sessions', 'settings', 'skills'].map((t) => tableRows(reopened.db, t))).toEqual(before);
    const backup = new DatabaseSync(reopened.migration.backupPath!, { readOnly: true });
    expect(tableRows(backup, 'projects')).toEqual(before[0]);
    expect(userVersion(backup)).toBe(0);
    expect(statSync(reopened.migration.backupPath!).mode & 0o777).toBe(0o600);
    backup.close();
    reopened.close();
    const again = new Store(dir);
    expect(again.migration).toEqual({ from: schemaVersion, to: schemaVersion, applied: [] });
    again.close();
  });

  it('refuses a database from a newer Adelic without modifying it', () => {
    const dir = tempDir();
    const db = new DatabaseSync(join(dir, 'adelic.sqlite'));
    db.exec(
      `PRAGMA user_version=${schemaVersion + 1}; CREATE TABLE marker(x TEXT); INSERT INTO marker VALUES('kept');`,
    );
    db.close();
    expect(() => new Store(dir)).toThrow(/versão mais nova.*não foi alterada/);
    const check = new DatabaseSync(join(dir, 'adelic.sqlite'), { readOnly: true });
    expect(userVersion(check)).toBe(schemaVersion + 1);
    expect(tableRows(check, 'marker')).toEqual([{ x: 'kept' }]);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name='projects'").all()).toEqual([]);
    check.close();
  });

  it('rolls back a failing migration, keeps the previous version and reports the backup', () => {
    const dir = tempDir();
    const db = new DatabaseSync(join(dir, 'adelic.sqlite'));
    migrate(db, dir);
    db.exec(`INSERT INTO projects VALUES('p','{}');`);
    const broken: Migration[] = [
      ...migrations,
      {
        version: schemaVersion + 1,
        description: 'falha sintética',
        up(target) {
          target.exec(`CREATE TABLE half_done(x TEXT); DELETE FROM projects;`);
          throw new Error('boom');
        },
      },
    ];
    expect(() => migrate(db, dir, broken)).toThrow(
      new RegExp(`Falha na migração .*continua no esquema ${schemaVersion} e há uma cópia em`),
    );
    expect(userVersion(db)).toBe(schemaVersion);
    expect(tableRows(db, 'projects')).toEqual([{ id: 'p', data: '{}' }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='half_done'").all()).toEqual([]);
    db.close();
  });

  it('keeps only the newest five backups and can restore one', () => {
    const dir = tempDir();
    const db = new DatabaseSync(join(dir, 'adelic.sqlite'));
    migrate(db, dir);
    db.exec(`INSERT INTO projects VALUES('p','{"v":1}');`);
    const step = (version: number): Migration => ({ version, description: `passo ${version}`, up: () => undefined });
    let list = [...migrations];
    for (let v = schemaVersion + 1; v <= schemaVersion + 7; v++) {
      list = [...list, step(v)];
      const result = migrate(db, dir, list);
      // Distinct mtimes so retention order is deterministic.
      utimesSync(result.backupPath!, v, v);
    }
    const backups = readdirSync(join(dir, 'backups'));
    expect(backups).toHaveLength(5);
    const latest = migrate(db, dir, [...list, step(schemaVersion + 8)]).backupPath!;
    db.exec(`UPDATE projects SET data='{"v":2}'`);
    db.close();
    restoreBackup(latest, join(dir, 'adelic.sqlite'));
    const restored = new DatabaseSync(join(dir, 'adelic.sqlite'), { readOnly: true });
    expect(tableRows(restored, 'projects')).toEqual([{ id: 'p', data: '{"v":1}' }]);
    restored.close();
  });

  it('upgrades a version 2 database through the attachments and message queue schemas', () => {
    const dir = tempDir();
    const db = new DatabaseSync(join(dir, 'adelic.sqlite'));
    migrate(
      db,
      dir,
      migrations.filter((m) => m.version <= 2),
    );
    db.exec(`INSERT INTO sessions VALUES('s',NULL,'{}');`);
    const result = migrate(db, dir);
    expect(result).toMatchObject({
      from: 2,
      to: schemaVersion,
      applied: [3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    });
    db.exec(`PRAGMA foreign_keys=ON; INSERT INTO message_queue VALUES('q','s',0,'{}'); DELETE FROM sessions;`);
    expect(tableRows(db, 'message_queue')).toEqual([]);
    db.close();
  });

  it('upgrades a version 4 database through the commands (5) and plans (6) tables', () => {
    const dir = tempDir();
    const db = new DatabaseSync(join(dir, 'adelic.sqlite'));
    migrate(
      db,
      dir,
      migrations.filter((m) => m.version <= 4),
    );
    db.exec(`INSERT INTO sessions VALUES('s',NULL,'{}'); INSERT INTO message_queue VALUES('q','s',0,'{}');`);
    const result = migrate(db, dir);
    expect(result).toMatchObject({
      from: 4,
      to: schemaVersion,
      applied: [5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    });
    expect(result.backupPath).toBeTruthy();
    expect(tableRows(db, 'message_queue')).toHaveLength(1);
    expect(migrations.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    db.exec(`PRAGMA foreign_keys=ON; INSERT INTO plans VALUES('p','s','{}');`);
    expect(() => db.exec(`INSERT INTO plans VALUES('x','missing','{}')`)).toThrow();
    db.exec(`DELETE FROM sessions;`);
    expect(tableRows(db, 'plans')).toEqual([]);
    db.close();
  });

  it('adds project_hooks (9), removed together with its project', () => {
    const dir = tempDir();
    const db = new DatabaseSync(join(dir, 'adelic.sqlite'));
    migrate(
      db,
      dir,
      migrations.filter((m) => m.version <= 8),
    );
    db.exec(`INSERT INTO projects VALUES('p','{}');`);
    expect(migrate(db, dir)).toMatchObject({ from: 8, to: schemaVersion, applied: [9, 10, 11, 12, 13, 14, 15, 16] });
    db.exec(`PRAGMA foreign_keys=ON; INSERT INTO project_hooks VALUES('p','{}');`);
    expect(() => db.exec(`INSERT INTO project_hooks VALUES('nao','{}')`)).toThrow();
    db.exec(`DELETE FROM projects;`);
    expect(tableRows(db, 'project_hooks')).toEqual([]);
    db.close();
  });

  it('adds the remote login tables (12) to an existing database, keeping its data', () => {
    const dir = tempDir();
    const db = new DatabaseSync(join(dir, 'adelic.sqlite'));
    migrate(
      db,
      dir,
      migrations.filter((m) => m.version <= 11),
    );
    db.exec(`INSERT INTO projects VALUES('p','{"name":"kept"}');`);
    const result = migrate(db, dir);
    expect(result).toMatchObject({ from: 11, to: schemaVersion, applied: [12, 13, 14, 15, 16] });
    expect(result.backupPath && existsSync(result.backupPath)).toBe(true);
    expect(tableRows(db, 'projects')).toEqual([{ id: 'p', data: '{"name":"kept"}' }]);
    for (const table of ['remote_users', 'remote_sessions', 'remote_logins']) expect(tableRows(db, table)).toEqual([]);
    db.exec(`INSERT INTO remote_sessions VALUES('h','owner','{}'); INSERT INTO remote_logins(data) VALUES('{}');`);
    expect(tableRows(db, 'remote_logins')).toEqual([{ id: 1, data: '{}' }]);
    db.close();
  });

  it('backfills historical run summaries and trace spans without copying raw errors', () => {
    const dir = tempDir();
    const db = new DatabaseSync(join(dir, 'adelic.sqlite'));
    migrate(
      db,
      dir,
      migrations.filter((migration) => migration.version <= 13),
    );
    db.exec(`INSERT INTO sessions VALUES('s',NULL,'{}');`);
    db.prepare('INSERT INTO runs(id,session_id,data) VALUES(?,?,?)').run(
      'legacy-run',
      's',
      JSON.stringify({
        id: 'legacy-run',
        sessionId: 's',
        providerId: 'codex',
        status: 'failed',
        startedAt: '2026-10-01T00:00:00.000Z',
        completedAt: '2026-10-01T00:00:00.040Z',
        durationMs: 40,
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 20,
        reasoningOutputTokens: 8,
        error: 'PRIVATE_LEGACY_FAILURE',
      }),
    );
    migrate(db, dir);
    expect(tableRows(db, 'observability_runs')).toEqual([
      expect.objectContaining({
        run_id: 'legacy-run',
        status: 'error',
        duration_ms: 40,
        input_tokens: 100,
        output_tokens: 20,
        cached_input_tokens: 40,
        reasoning_output_tokens: 8,
        error_kind: 'failed',
      }),
    ]);
    const span = db.prepare('SELECT * FROM observability_events WHERE run_id=?').get('legacy-run') as {
      id: string;
      attributes: string;
    };
    expect(span.id).toBe('run:legacy-run');
    expect(span.attributes).not.toContain('PRIVATE_LEGACY_FAILURE');
    db.close();
  });
});
