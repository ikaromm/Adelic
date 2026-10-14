import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../server/store.js';
import { skillsMcpRunServer } from '../server/mcp.js';
import { bubblewrap, mcpCommandBindings, skillsSnapshotBindings } from '../server/providers/sandbox.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('skills MCP service', () => {
  it('completes initialize, tools/list and tools/call from a cwd outside the application root', async () => {
    const dataDir = await mkdtemp('/tmp/adelic-mcp-skills-data-');
    const clientCwd = await mkdtemp('/tmp/adelic-mcp-skills-client-');
    temporaryDirectories.push(dataDir, clientCwd);
    const skillDir = join(dataDir, 'skills', 'protocol-review');
    await mkdir(join(skillDir, 'references'), { recursive: true });
    await writeFile(
      join(skillDir, 'skill.json'),
      JSON.stringify({
        id: 'protocol-review',
        name: 'Revisão de protocolo',
        description: 'Revisar contratos de protocolo',
        roles: ['worker'],
        references: ['references/checklist.md'],
      }),
    );
    const completeBody = 'instrução'.repeat(2_500);
    await writeFile(join(skillDir, 'SKILL.md'), completeBody);
    await writeFile(join(skillDir, 'references', 'checklist.md'), 'Checklist declarado integral.');
    const addRestrictedSkill = async (id: string, roles: string[]) => {
      const directory = join(dataDir, 'skills', id);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'skill.json'), JSON.stringify({ id, name: id, description: id, roles }));
      await writeFile(join(directory, 'SKILL.md'), `Body for ${id}.`);
    };
    await addRestrictedSkill('planner-only', ['planner']);
    await addRestrictedSkill('disabled-skill', ['worker']);
    for (let index = 0; index < 75; index++)
      await addRestrictedSkill(`catalog-${String(index).padStart(2, '0')}`, ['worker']);
    const catalogStore = new Store(dataDir);
    catalogStore.setSkillEnabled('disabled-skill', false);
    const skills = skillsMcpRunServer('worker', catalogStore);
    const snapshot = skills.env.ADELIC_SKILLS_SNAPSHOT!;
    temporaryDirectories.push(dirname(snapshot));
    catalogStore.close();
    // Exercise the real stdio executable inside bubblewrap, with only the MCP runtime
    // and the role-filtered snapshot bound in. This verifies initialize/tools/call across
    // the same read-only sandbox boundary used by isolated providers (not config alone).
    const bindings = [
      ...(await mcpCommandBindings([skills.command], clientCwd)),
      ...(await skillsSnapshotBindings([snapshot])),
    ];
    const wrapped = await bubblewrap(skills.command, skills.args, clientCwd, 'read-only', [], bindings);
    const child = spawn(wrapped.command, wrapped.args, {
      cwd: clientCwd,
      // Deliberately reproduce the host's external scratch TMPDIR; bubblewrap must remap
      // the child to its own writable /tmp instead of exposing the project or host dataDir.
      env: { ...process.env, ...skills.env, TMPDIR: '/var/tmp' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout });
    let childStderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (childStderr += chunk));
    const pendingResponses: {
      resolve: (response: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }[] = [];
    lines.on('line', (line) => {
      const pending = pendingResponses.shift();
      if (!pending) return;
      clearTimeout(pending.timer);
      try {
        pending.resolve(JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        pending.reject(error as Error);
      }
    });
    const failPending = (error: Error) => {
      for (const pending of pendingResponses.splice(0)) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
    };
    child.once('error', failPending);
    child.once('close', (code, signal) =>
      failPending(new Error(`MCP process exited before responding (code=${code}, signal=${signal}): ${childStderr}`)),
    );
    const readResponse = () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = pendingResponses.findIndex((pending) => pending.resolve === resolve);
          if (index >= 0) pendingResponses.splice(index, 1);
          reject(new Error(`MCP response timed out: ${childStderr}`));
        }, 5000);
        pendingResponses.push({ resolve, reject, timer });
      });
    const request = async (id: number, method: string, params?: unknown) => {
      const response = readResponse();
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n',
      );
      return response;
    };

    try {
      const initialized = await request(1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      });
      expect(initialized.result).toMatchObject({ capabilities: { tools: {} }, serverInfo: { name: 'adelic-skills' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

      const listedTools = await request(2, 'tools/list');
      const tools = (listedTools.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
      expect(tools).toEqual(['list_skills', 'get_skill_body', 'get_skill_reference']);

      const catalog = await request(3, 'tools/call', { name: 'list_skills', arguments: {} });
      const catalogEntries: { id: string }[] = [];
      let cursor: string | null = null;
      let response = catalog;
      let requestId = 3;
      do {
        const page = JSON.parse((response.result as { content: { text: string }[] }).content[0]!.text) as {
          skills: { id: string }[];
          nextCursor: string | null;
        };
        catalogEntries.push(...page.skills);
        cursor = page.nextCursor;
        if (cursor) response = await request(++requestId, 'tools/call', { name: 'list_skills', arguments: { cursor } });
      } while (cursor);
      expect(catalogEntries).toHaveLength(80);
      expect(catalogEntries.map((entry) => entry.id)).toContain('protocol-review');
      expect(catalogEntries.map((entry) => entry.id)).not.toContain('planner-only');
      expect(catalogEntries.map((entry) => entry.id)).not.toContain('disabled-skill');

      const body = await request(4, 'tools/call', {
        name: 'get_skill_body',
        arguments: { skillId: 'protocol-review' },
      });
      expect(body.result).toMatchObject({ isError: false, content: [{ type: 'text', text: completeBody }] });

      const reference = await request(5, 'tools/call', {
        name: 'get_skill_reference',
        arguments: { skillId: 'protocol-review', reference: 'references/checklist.md' },
      });
      expect(reference.result).toMatchObject({
        isError: false,
        content: [{ type: 'text', text: 'Checklist declarado integral.' }],
      });
      const undeclared = await request(6, 'tools/call', {
        name: 'get_skill_reference',
        arguments: { skillId: 'protocol-review', reference: 'references/private.md' },
      });
      expect(undeclared.result).toMatchObject({ isError: true });
      expect(clientCwd).not.toBe(process.cwd());
      const wrongRole = await request(7, 'tools/call', {
        name: 'get_skill_body',
        arguments: { skillId: 'planner-only' },
      });
      expect(wrongRole.result).toMatchObject({ isError: true });
      const disabled = await request(8, 'tools/call', {
        name: 'get_skill_body',
        arguments: { skillId: 'disabled-skill' },
      });
      expect(disabled.result).toMatchObject({ isError: true });
    } finally {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill();
        await exited;
      }
    }
  }, 20_000);
});
