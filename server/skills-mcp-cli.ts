import { readFileSync } from 'node:fs';
import type { AgentRole } from '../shared/contracts.js';
import { attachSkillsMcpStdio, createSkillsMcpServerFromSnapshot, type SkillsMcpSnapshot } from './skills-mcp.js';

const snapshotPath = process.env.ADELIC_SKILLS_SNAPSHOT;
const role = process.env.ADELIC_SKILL_ROLE as AgentRole | undefined;
if (!snapshotPath || !role) throw new Error('Skills MCP requires a run-scoped capability snapshot and role.');
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as SkillsMcpSnapshot;
const server = createSkillsMcpServerFromSnapshot(snapshot, role);
attachSkillsMcpStdio(server);
