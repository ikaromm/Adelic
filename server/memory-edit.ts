import type { MemoryScope } from '../shared/contracts.js';

// Planning for edits of existing notes through the ai-memory service writers.
//
// Neither service writer accepts an arbitrary frontmatter object. `/admin/write-page`
// rebuilds it from title/kind/tier/tags/pinned and `memory_write_page` from
// title/tier/tags/pinned/expires_at; the server then derives `type`, `stale_after`
// and the `generated` provenance block. An edit is therefore only allowed when every
// key of the current frontmatter is reproduced exactly by one of the writers, and
// the result is verified after saving. Anything else fails before writing.

/** Keys the service owns and rewrites on every content change (provenance, authorship). */
export const SERVER_MANAGED = new Set(['generated', 'last_modified_by']);

export type EditPlan =
  | { writer: 'admin'; args: { title?: string; kind?: string; tier: string; tags: string[]; pinned: boolean } }
  | { writer: 'mcp'; args: { title?: string; tier: string; tags: string[]; pinned: boolean; expires_at: string } };

const TIERS = new Set(['working', 'episodic', 'semantic', 'procedural']);
const FAMILIES: Record<string, string> = {
  sessions: 'Session Summary', _rules: 'Rule', gotchas: 'Gotcha', decisions: 'Decision', procedures: 'Procedure',
  concepts: 'Concept', notes: 'Note', runbooks: 'Runbook', _slots: 'State', _lint: 'Lint Report', _pending: 'Pending Note',
};
const KIND_TYPES: Record<string, string> = { fact: 'Fact', note: 'Note', procedure: 'Procedure', decision: 'Decision' };

/** Mirrors ai-memory's OKF `derive_type` (2.1.x–2.5.x): explicit kind first, then path family. */
export function derivedType(path: string, frontmatter: Record<string, unknown>): string {
  const kind = frontmatter.kind;
  if (typeof kind === 'string' && KIND_TYPES[kind]) return KIND_TYPES[kind];
  const slot = frontmatter.slot_kind;
  if (slot === 'invariant') return 'Invariant';
  if (slot === 'state') return 'State';
  return FAMILIES[path.split('/')[0]] ?? 'Note';
}

const blocked = (reason: string): never => { throw Object.assign(new Error(`Edição bloqueada para preservar os metadados: ${reason}`), { status: 422 }); };
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Chooses a writer that reproduces the current frontmatter, or throws before any write. */
export function planExistingEdit(scope: MemoryScope, path: string, frontmatter: Record<string, unknown>): EditPlan {
  if (scope.project === '_global') blocked('o escopo _global é somente leitura');
  const fm = frontmatter;
  const { tier, tags, pinned, title, kind, expires_at: expires, type, stale_after: staleAfter } = fm;
  if (typeof tier !== 'string' || !TIERS.has(tier)) blocked('tier ausente ou desconhecido');
  if (tags !== undefined && (!isStringArray(tags) || tags.length === 0)) blocked('tags em formato que o serviço não reproduz');
  if (pinned !== undefined && pinned !== true) blocked('pinned diferente de true');
  if (title !== undefined && (typeof title !== 'string' || !title.trim())) blocked('title em formato não suportado');
  if (kind !== undefined && (typeof kind !== 'string' || !kind.trim() || kind !== kind.trim())) blocked('kind em formato não suportado');
  if (expires !== undefined && (typeof expires !== 'string' || !expires.trim() || expires !== expires.trim())) blocked('expires_at em formato não suportado');
  if (type !== undefined && type !== derivedType(path, fm)) blocked(`type personalizado (${String(type)})`);
  if (staleAfter !== undefined && staleAfter !== expires) blocked('stale_after diferente de expires_at');
  const generated = fm.generated;
  if (generated !== undefined && (typeof generated !== 'object' || generated === null || Array.isArray(generated) || Object.keys(generated).some((k) => k !== 'by' && k !== 'at'))) blocked('bloco generated com campos extras');
  const known = new Set(['tier', 'tags', 'pinned', 'title', 'kind', 'expires_at', 'type', 'stale_after', ...SERVER_MANAGED]);
  const unknown = Object.keys(fm).filter((key) => !known.has(key));
  if (unknown.length) blocked(`campos que nenhum writer do ai-memory preserva (${unknown.sort().join(', ')})`);
  const base = { tier: tier as string, tags: (tags as string[] | undefined) ?? [], pinned: pinned === true, ...(title === undefined ? {} : { title: title as string }) };
  if (expires !== undefined) {
    if (kind !== undefined) blocked('kind e expires_at juntos (nenhum writer do ai-memory aceita os dois)');
    return { writer: 'mcp', args: { ...base, expires_at: expires as string } };
  }
  return { writer: 'admin', args: { ...base, ...(kind === undefined ? {} : { kind: kind as string }) } };
}

/**
 * Frontmatter the user owns, for before/after comparison: drops server provenance and
 * the keys the server derives deterministically (`type` from kind/path, `stale_after`
 * from `expires_at`) when they hold the derived value.
 */
export function preservedFrontmatter(path: string, frontmatter: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(frontmatter).filter(([key, value]) => !SERVER_MANAGED.has(key)
    && !(key === 'type' && value === derivedType(path, frontmatter))
    && !(key === 'stale_after' && value === frontmatter.expires_at)));
}
