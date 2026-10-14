import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { ProviderRegistry } from '../shared/contracts.js';
import { createBackend } from '../server/index.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { applicableSkillContext } from '../server/orchestrator.js';
import { SKILL_BODY_MAX, SKILL_CATALOG_MAX, SKILL_REFERENCES_MAX, SkillManifestSchema } from '../shared/schemas.js';

const dirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-skills-'));
  dirs.push(dir);
  return dir;
}
function writeSkill(root: string, id: string, body: string, manifest: Record<string, unknown> = {}) {
  const dir = join(root, 'skills', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'skill.json'),
    JSON.stringify({ id, name: 'Revisão de protocolo', description: 'Revisar protocolo e contratos', ...manifest }),
  );
  writeFileSync(join(dir, 'SKILL.md'), body);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('local skill catalog', () => {
  it('discovers a new skill without editing a fixed ID list and loads its intact body only on demand', () => {
    const dataDir = tempDir();
    writeSkill(dataDir, 'protocol-review', 'Primeira instrução.\nSegunda instrução íntegra.');
    const store = new Store(dataDir);
    try {
      const entry = store.listSkills().find((skill) => skill.id === 'protocol-review');
      expect(entry).toMatchObject({
        name: 'Revisão de protocolo',
        description: 'Revisar protocolo e contratos',
        enabled: true,
      });
      expect(entry).not.toHaveProperty('body');
      expect(store.getSkill('protocol-review')?.body).toBe('Primeira instrução.\nSegunda instrução íntegra.');
      expect(store.getSkillCatalogDiagnostics()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('selects full bodies on demand by task metadata and declared role', () => {
    const dataDir = tempDir();
    writeSkill(
      dataDir,
      'navigation-profile',
      'Use symbol search, then read only relevant file ranges. Preserve full instructions.',
      {
        name: 'Navegar arquivos',
        description: 'Localiza símbolos para editar arquivos de forma pontual',
        roles: ['worker'],
      },
    );
    const store = new Store(dataDir);
    const getSkill = vi.spyOn(store, 'getSkill');
    const deepToolPlan = { level: 'deep', reason: 'test', tools: true, memory: false, contextBudget: 10000 } as const;
    try {
      expect(applicableSkillContext(store, 'Qual é a previsão do tempo?', deepToolPlan)).toBe('');
      expect(getSkill).not.toHaveBeenCalled();

      const selected = applicableSkillContext(store, 'Navegar arquivos e localizar símbolos', deepToolPlan, 'worker');
      expect(selected).toContain('Preserve full instructions.');
      expect(selected).toContain('Use symbol search, then read only relevant file ranges.');
      expect(applicableSkillContext(store, 'Navegar arquivos e localizar símbolos', deepToolPlan, 'planner')).toBe('');
    } finally {
      store.close();
    }
  });

  it('keeps generic deep requests from activating a large metadata catalog', () => {
    const dataDir = tempDir();
    const discoveredSkillCount = 80;
    for (let index = 0; index < discoveredSkillCount; index++) {
      const id = `skill-${String(index).padStart(2, '0')}`;
      writeSkill(dataDir, id, 'x'.repeat(10_000), {
        name: `Rotina especializada ${index}`,
        description: 'Orientação para implementar projeto',
      });
    }
    const store = new Store(dataDir);
    const getSkill = vi.spyOn(store, 'getSkill');
    const deepToolPlan = { level: 'deep', reason: 'test', tools: true, memory: false, contextBudget: 10000 } as const;
    try {
      const prompt = applicableSkillContext(store, 'Implemente o projeto', deepToolPlan);
      expect(prompt).toBe('');
      expect(store.listSkills().filter((skill) => skill.id.startsWith('skill-'))).toHaveLength(discoveredSkillCount);
      expect(store.getSkillCatalogDiagnostics()).not.toContainEqual(expect.objectContaining({ code: 'catalog_limit' }));
      expect(getSkill).not.toHaveBeenCalled();
      expect(store.getSkillCatalogDiagnostics()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('activates only exact name-token matches and bounds selected bodies as a whole', () => {
    const dataDir = tempDir();
    const names = [
      'Revisão protocolo',
      'Navegação arquivos',
      'Análise contratos',
      'Busca símbolos',
      'Leitura fontes',
      'Teste regressão',
    ];
    for (const [index, name] of names.entries())
      writeSkill(dataDir, `match-${index}`, `body-${index}:${'x'.repeat(10_000)}`, {
        name,
        description: 'Orientação para implementar projeto',
      });
    const store = new Store(dataDir);
    const deepToolPlan = { level: 'deep', reason: 'test', tools: true, memory: false, contextBudget: 10000 } as const;
    try {
      const irrelevant = applicableSkillContext(store, 'Qual é a previsão do tempo?', deepToolPlan);
      expect(irrelevant).toBe('');
      const nearMatches = applicableSkillContext(
        store,
        'Revisões protocolos, navegações arquivamento, análise contratual, busca símbolo, leitura fonte e teste regressões',
        deepToolPlan,
      );
      expect(nearMatches).toBe('');
      let omittedByThisRun = 0;
      const selected = applicableSkillContext(
        store,
        'Revisão protocolo, navegação arquivos, análise contratos, busca símbolos, leitura fontes e teste regressão',
        deepToolPlan,
        'worker',
        (count) => {
          omittedByThisRun = count;
        },
      );
      expect(selected.match(/^- /gm)).toHaveLength(2);
      expect(selected).toContain('body-0:' + 'x'.repeat(10_000));
      expect(selected).toContain('body-1:' + 'x'.repeat(10_000));
      expect(selected).not.toContain('body-2:');
      expect(selected.length).toBeLessThanOrEqual(24_000);
      expect(omittedByThisRun).toBe(4);
      expect(store.getSkillCatalogDiagnostics()).not.toContainEqual(
        expect.objectContaining({ code: 'activation_limit' }),
      );
    } finally {
      store.close();
    }
  });

  it('uses dynamically discovered skill metadata for activation without a fixed ID list', () => {
    const dataDir = tempDir();
    writeSkill(dataDir, 'new-protocol-skill', 'Complete dynamic skill instructions.', {
      name: 'Auditoria protocolo',
      description: 'Orientação para implementar projeto',
    });
    const store = new Store(dataDir);
    const deepToolPlan = { level: 'deep', reason: 'test', tools: true, memory: false, contextBudget: 10000 } as const;
    try {
      const selected = applicableSkillContext(store, 'Preciso de auditoria de protocolo.', deepToolPlan);
      expect(selected).toContain('Complete dynamic skill instructions.');
      expect(store.listSkills()).toContainEqual(expect.objectContaining({ id: 'new-protocol-skill' }));
    } finally {
      store.close();
    }
  });

  it('rejects oversized bodies and catalog overflow explicitly instead of silently truncating', () => {
    const dataDir = tempDir();
    writeSkill(dataDir, 'large-body', 'x'.repeat(SKILL_BODY_MAX + 1));
    const store = new Store(dataDir);
    try {
      expect(store.listSkills().some((skill) => skill.id === 'large-body')).toBe(true);
      expect(store.getSkill('large-body')).toBeUndefined();
      expect(store.getSkillCatalogDiagnostics()).toContainEqual(
        expect.objectContaining({ code: 'body_limit', skillId: 'large-body' }),
      );
      store.listSkills();
      expect(store.getSkillCatalogDiagnostics()).toContainEqual(
        expect.objectContaining({ code: 'body_limit', skillId: 'large-body' }),
      );
      expect(store.bootstrap([], []).skillDiagnostics).toContainEqual(
        expect.objectContaining({ code: 'body_limit', skillId: 'large-body' }),
      );
      writeFileSync(join(dataDir, 'skills', 'large-body', 'SKILL.md'), 'Repaired complete body.');
      expect(store.getSkill('large-body')?.body).toBe('Repaired complete body.');
      expect(store.getSkillCatalogDiagnostics()).not.toContainEqual(
        expect.objectContaining({ code: 'body_limit', skillId: 'large-body' }),
      );

      const manyDataDir = tempDir();
      const manyStore = new Store(manyDataDir);
      try {
        for (let index = 0; index <= SKILL_CATALOG_MAX; index++)
          writeSkill(manyDataDir, `extra-${String(index).padStart(3, '0')}`, 'Body íntegro.');
        const listed = manyStore.listSkills();
        expect(listed.filter((skill) => skill.id.startsWith('extra-'))).toHaveLength(SKILL_CATALOG_MAX);
        expect(manyStore.getSkillCatalogDiagnostics()).toContainEqual(
          expect.objectContaining({ code: 'catalog_limit' }),
        );
      } finally {
        manyStore.close();
      }
    } finally {
      store.close();
    }
  });

  it('loads a valid 20k-character body intact without including it in catalog metadata', () => {
    const dataDir = tempDir();
    const body = `Keep every instruction.\\n${'x'.repeat(20_000)}`;
    writeSkill(dataDir, 'twenty-k-body', body);
    const store = new Store(dataDir);
    try {
      expect(store.listSkills().find((skill) => skill.id === 'twenty-k-body')).not.toHaveProperty('body');
      expect(store.getSkill('twenty-k-body')?.body).toBe(body);
      expect(store.getSkillCatalogDiagnostics()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('exports persisted skill bodies in the backup without adding bodies to the catalog', () => {
    const dataDir = tempDir();
    const store = new Store(dataDir);
    const skill = {
      id: 'export-skill',
      name: 'Export skill',
      description: 'A persisted procedure',
      body: 'Complete persisted body with all instructions.',
      enabled: true,
    };
    try {
      store.setSkill(skill);
      expect(store.listSkills().find((entry) => entry.id === skill.id)).not.toHaveProperty('body');
      expect(store.exportData().skills).toContainEqual(skill);

      writeSkill(dataDir, 'file-backed-export', 'File-backed instructions.');
      const loaded = store.getSkill('file-backed-export')!;
      store.setSkill({ ...loaded, enabled: false });
      expect(store.getSkill('file-backed-export')).toMatchObject({ body: 'File-backed instructions.', enabled: false });
      expect(store.exportData().skills).toContainEqual({
        ...loaded,
        body: 'File-backed instructions.',
        enabled: false,
      });
    } finally {
      store.close();
    }
  });

  it('bounds optional reference declarations and never returns undeclared references', () => {
    expect(
      SkillManifestSchema.safeParse({
        id: 'bounded',
        name: 'Skill',
        description: 'Description',
        references: Array.from({ length: SKILL_REFERENCES_MAX + 1 }, (_, index) => `ref-${index}.md`),
      }).success,
    ).toBe(false);

    const dataDir = tempDir();
    writeSkill(dataDir, 'ref-check', 'Body', { references: ['references/checklist.md'] });
    const refDir = join(dataDir, 'skills', 'ref-check', 'references');
    mkdirSync(refDir);
    writeFileSync(join(refDir, 'checklist.md'), 'Reference content.');
    const store = new Store(dataDir);
    try {
      expect(store.loadSkillReference('ref-check', 'references/checklist.md')).toBe('Reference content.');
      expect(store.loadSkillReference('ref-check', '../outside.md')).toBeUndefined();
      expect(store.loadSkillReference('ref-check', 'undeclared.md')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('bounds stored diagnostics across repeated scans of many invalid manifests', () => {
    const dataDir = tempDir();
    const root = join(dataDir, 'skills');
    for (let index = 0; index < 1000; index++) {
      const dir = join(root, `broken-${String(index).padStart(4, '0')}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'skill.json'), '{invalid');
    }
    const store = new Store(dataDir);
    try {
      for (let index = 0; index < 1000; index++) store.listSkills();
      const diagnostics = store.getSkillCatalogDiagnostics();
      expect(diagnostics.length).toBeLessThanOrEqual(100);
      expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid_manifest' }));
    } finally {
      store.close();
    }
  });

  it('disables cataloged skills over the real HTTP route without loading invalid bodies', async () => {
    const dataDir = tempDir();
    const missingDir = join(dataDir, 'skills', 'missing-body');
    mkdirSync(missingDir, { recursive: true });
    writeFileSync(
      join(missingDir, 'skill.json'),
      JSON.stringify({ id: 'missing-body', name: 'Missing body', description: 'A valid catalog entry' }),
    );
    writeSkill(dataDir, 'oversized-body', 'x'.repeat(SKILL_BODY_MAX + 1));
    writeSkill(dataDir, 'valid-body', 'Complete valid instructions.');
    const store = new Store(dataDir);
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'stub',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [{ id: 'm1', name: 'm1', isDefault: true }],
            defaultModel: 'm1',
            capabilities: { fast: true, tools: true, approvals: true, cancel: true },
          },
        ];
      },
      async run() {
        return { text: 'ok', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const backend = createBackend(store, providers);
    const server: Server = createServer(backend.app);
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const patch = async (id: string, enabled: boolean) => {
        const response = await fetch(`${base}/api/skills/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', origin: base },
          body: JSON.stringify({ enabled }),
        });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
      };

      const disabledMissing = await patch('missing-body', false);
      expect(disabledMissing.status).toBe(200);
      expect(disabledMissing.body).toMatchObject({ id: 'missing-body', enabled: false });
      expect(disabledMissing.body).not.toHaveProperty('body');
      expect(store.listSkills().find((skill) => skill.id === 'missing-body')?.enabled).toBe(false);

      const disabledOversized = await patch('oversized-body', false);
      expect(disabledOversized.status).toBe(200);
      expect(disabledOversized.body).toMatchObject({ id: 'oversized-body', enabled: false });
      expect(disabledOversized.body).not.toHaveProperty('body');
      expect(store.listSkills().find((skill) => skill.id === 'oversized-body')?.enabled).toBe(false);

      const enabledOversized = await patch('oversized-body', true);
      expect(enabledOversized.status).toBe(400);
      expect(store.listSkills().find((skill) => skill.id === 'oversized-body')?.enabled).toBe(false);

      const metadata = await fetch(`${base}/api/bootstrap`, { headers: { origin: base } });
      const bootstrap = (await metadata.json()) as { skills: Record<string, unknown>[] };
      expect(bootstrap.skills.every((skill) => !('body' in skill))).toBe(true);
    } finally {
      await backend.orchestrator.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  });

  it('drops stale file-backed metadata and permissions after toggling an invalid or removed manifest', () => {
    const dataDir = tempDir();
    const skillDir = writeSkill(dataDir, 'stale-metadata', 'Instructions.', {
      name: 'Trusted name',
      description: 'Trusted description',
      references: ['references/allowed.md'],
    });
    const referencesDir = join(skillDir, 'references');
    mkdirSync(referencesDir);
    writeFileSync(join(referencesDir, 'allowed.md'), 'Allowed while the manifest is valid.');
    const store = new Store(dataDir);
    try {
      expect(store.setSkillEnabled('stale-metadata', false)).toMatchObject({ enabled: false });
      expect(store.setSkillEnabled('stale-metadata', true)).toMatchObject({ enabled: true });
      writeFileSync(join(skillDir, 'skill.json'), '{invalid');
      expect(store.listSkills().some((skill) => skill.id === 'stale-metadata')).toBe(false);
      expect(store.loadSkillReference('stale-metadata', 'references/allowed.md')).toBeUndefined();
      expect(store.getSkillCatalogDiagnostics()).toContainEqual(
        expect.objectContaining({ code: 'invalid_manifest', skillId: 'stale-metadata' }),
      );

      writeFileSync(
        join(skillDir, 'skill.json'),
        JSON.stringify({
          id: 'stale-metadata',
          name: 'Recovered name',
          description: 'Recovered description',
          references: ['references/recovered.md'],
        }),
      );
      writeFileSync(join(referencesDir, 'recovered.md'), 'Recovered reference permission.');
      expect(store.listSkills()).toContainEqual(
        expect.objectContaining({ id: 'stale-metadata', name: 'Recovered name', enabled: true }),
      );
      expect(store.loadSkillReference('stale-metadata', 'references/allowed.md')).toBeUndefined();
      expect(store.loadSkillReference('stale-metadata', 'references/recovered.md')).toBe(
        'Recovered reference permission.',
      );
      expect(store.getSkillCatalogDiagnostics()).not.toContainEqual(
        expect.objectContaining({ code: 'invalid_manifest', skillId: 'stale-metadata' }),
      );

      rmSync(join(skillDir, 'skill.json'));
      expect(store.listSkills().some((skill) => skill.id === 'stale-metadata')).toBe(false);
      expect(store.loadSkillReference('stale-metadata', 'references/recovered.md')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('keeps reference errors isolated until that exact reference recovers', () => {
    const dataDir = tempDir();
    const skillDir = writeSkill(dataDir, 'reference-errors', 'Instructions.', {
      references: ['references/first.md', 'references/second.md'],
    });
    const refDir = join(skillDir, 'references');
    mkdirSync(refDir);
    writeFileSync(join(refDir, 'second.md'), 'Second reference remains valid.');
    const store = new Store(dataDir);
    try {
      expect(store.loadSkillReference('reference-errors', 'references/first.md')).toBeUndefined();
      expect(store.loadSkillReference('reference-errors', 'references/second.md')).toBe(
        'Second reference remains valid.',
      );
      expect(store.getSkillCatalogDiagnostics()).toContainEqual(
        expect.objectContaining({ code: 'unreadable', skillId: 'reference-errors' }),
      );

      writeFileSync(join(refDir, 'first.md'), 'First reference recovered.');
      expect(store.loadSkillReference('reference-errors', 'references/first.md')).toBe('First reference recovered.');
      expect(store.getSkillCatalogDiagnostics()).not.toContainEqual(
        expect.objectContaining({ code: 'unreadable', skillId: 'reference-errors' }),
      );
    } finally {
      store.close();
    }
  });
});
