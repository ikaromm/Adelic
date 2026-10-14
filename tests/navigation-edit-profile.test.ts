import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applicableSkillContext } from '../server/orchestrator.js';
import { Store } from '../server/store.js';
import { SkillManifestSchema } from '../shared/schemas.js';

const skillDir = resolve(process.cwd(), 'skills/navigation-edit');
const temporaryDirs: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('navigation/edit profile', () => {
  it('loads the valid profile manifest and intact instructions for permitted worker tasks only', () => {
    const manifest = SkillManifestSchema.parse(
      JSON.parse(readFileSync(resolve(skillDir, 'skill.json'), 'utf8')) as unknown,
    );
    expect(manifest).toMatchObject({ id: 'navigation-edit', roles: ['worker'] });

    const dataDir = mkdtempSync(join(tmpdir(), 'adelic-navigation-profile-'));
    temporaryDirs.push(dataDir);
    const localSkillDir = join(dataDir, 'skills', manifest.id);
    mkdirSync(localSkillDir, { recursive: true });
    const body = readFileSync(resolve(skillDir, 'SKILL.md'), 'utf8');
    writeFileSync(join(localSkillDir, 'skill.json'), JSON.stringify(manifest));
    writeFileSync(join(localSkillDir, 'SKILL.md'), body);

    const store = new Store(dataDir);
    try {
      const catalogEntry = store.listSkills().find((entry) => entry.id === manifest.id);
      expect(catalogEntry).toMatchObject({ id: manifest.id, roles: ['worker'], enabled: true });
      expect(catalogEntry).not.toHaveProperty('body');
      expect(store.getSkill(manifest.id)?.body).toBe(body);

      const task = 'Navegação e edição pontual: localizar um símbolo e editar um trecho de código';
      const plan = { level: 'deep', reason: 'test', tools: true, memory: false, contextBudget: 10000 } as const;
      expect(applicableSkillContext(store, task, plan, 'worker')).toContain(body);
      expect(applicableSkillContext(store, task, plan, 'planner')).not.toContain(body);

      store.setSkillEnabled(manifest.id, false);
      expect(applicableSkillContext(store, task, plan, 'worker')).not.toContain(body);
    } finally {
      store.close();
    }
  });
});
