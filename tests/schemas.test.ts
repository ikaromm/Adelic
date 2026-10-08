import { describe, expect, it } from 'vitest';
import {
  CreateSessionSchema,
  OrchestrationPatchSchema,
  PatchSessionSchema,
  SendMessageSchema,
  SettingsPatchSchema,
  memoryPath,
  parseBody,
} from '../shared/schemas.js';

describe('request schemas', () => {
  it('treats absent fields as unchanged and trims text', () => {
    expect(parseBody(CreateSessionSchema, undefined, 'x')).toEqual({ ok: true, data: {} });
    expect(parseBody(PatchSessionSchema, { title: '  Novo  ', model: null, projectId: null }, 'x')).toEqual({
      ok: true,
      data: { title: 'Novo', model: null, projectId: null },
    });
  });
  it('returns the field message the API used before zod', () => {
    expect(parseBody(CreateSessionSchema, { projectId: 5 }, 'x')).toEqual({ ok: false, message: 'projectId inválido' });
    expect(parseBody(PatchSessionSchema, { title: '' }, 'x')).toEqual({ ok: false, message: 'title inválido' });
    expect(parseBody(SendMessageSchema, {}, 'x')).toEqual({
      ok: false,
      message: 'content obrigatório (máximo 32000 caracteres)',
    });
    expect(parseBody(SendMessageSchema, { content: 'x'.repeat(32001) }, 'x')).toMatchObject({ ok: false });
    expect(parseBody(SettingsPatchSchema, { memoryEnabled: 'yes' }, 'x')).toEqual({
      ok: false,
      message: 'memoryEnabled deve ser booleano',
    });
  });
  it('accepts automatic policy and nullable session overrides', () => {
    expect(parseBody(CreateSessionSchema, { approvalMode: 'automatic' }, 'x')).toMatchObject({
      ok: true,
      data: { approvalMode: 'automatic' },
    });
    expect(parseBody(PatchSessionSchema, { approvalMode: null }, 'x')).toMatchObject({
      ok: true,
      data: { approvalMode: null },
    });
    expect(parseBody(SettingsPatchSchema, { approvalMode: 'automatic' }, 'x')).toMatchObject({
      ok: true,
      data: { approvalMode: 'automatic' },
    });
  });
  it('reports the first invalid field in declaration order', () => {
    expect(parseBody(PatchSessionSchema, { mode: 'x', title: '' }, 'x')).toEqual({
      ok: false,
      message: 'title inválido',
    });
  });
  it('validates orchestration patches strictly and allows null to clear optional fields', () => {
    expect(OrchestrationPatchSchema.safeParse({ maxWorkers: 3, workerProviderId: null }).success).toBe(true);
    for (const bad of [{ maxWorkers: 4 }, { foo: 1 }, { workerProviderId: 'x' }, { workerModel: ' ' }, []])
      expect(OrchestrationPatchSchema.safeParse(bad).success).toBe(false);
  });
  it('accepts only relative markdown note paths', () => {
    for (const ok of ['a.md', 'notas/b.md']) expect(memoryPath.safeParse(ok).success).toBe(true);
    for (const bad of ['/a.md', '../a.md', 'a/../b.md', 'a.txt', 'a\\b.md', ''])
      expect(memoryPath.safeParse(bad).success).toBe(false);
  });
});
