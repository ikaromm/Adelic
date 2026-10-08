// Saved slash commands (docs/specs/saved-commands.md). Sources, highest precedence first:
// project commands (SQLite), repository files (`<project>/.adelic/commands/*.md`, read-only),
// global commands (SQLite) and built-ins. Repository files are prompt text only: nothing in
// them is executed, and they are read with realpath containment so symlinks cannot escape.
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  COMMAND_DESCRIPTION_MAX,
  COMMAND_NAME,
  COMMAND_PRECEDENCE,
  COMMAND_TEMPLATE_MAX,
  COMMAND_RESERVED,
  RESERVED_COMMAND_NAMES,
  REPO_COMMANDS_MAX_FILES,
  commandModes,
  expandTemplate,
  parseSlash,
  runModeFor,
  type CommandEntry,
  type CommandIssue,
  type CommandList,
  type CommandMode,
  type SavedCommand,
} from '../shared/commands.js';
import type { Mode, Project } from '../shared/contracts.js';
import type { Store } from './store.js';

/** Read-only commands shipped with Adelic; a user or repository command with the same name wins. */
export const builtinCommands: CommandEntry[] = [
  {
    name: 'revisar',
    description: 'Revisa as alterações atuais do projeto: correção, segurança e testes, sem editar arquivos.',
    mode: 'deep',
    template:
      'Revise as alterações atuais deste projeto (git status e git diff, incluindo arquivos novos ainda não rastreados). ' +
      'Avalie correção, segurança e testes: aponte defeitos reproduzíveis, regressões, validações ausentes e testes que faltam, ' +
      'citando arquivo e linha. Separe problemas de sugestões opcionais e diga o que não conseguiu verificar. ' +
      'Não edite, crie nem apague arquivos.',
  },
  {
    name: 'testes',
    description: 'Encontra e roda os testes do projeto e resume as falhas, sem editar arquivos.',
    mode: 'deep',
    template:
      'Encontre como os testes deste projeto são executados (scripts, configuração e documentação) e rode-os. ' +
      'Resuma o resultado: quantos passaram e, para cada falha, o teste, a mensagem e a causa provável, com arquivo e linha. ' +
      'Não edite arquivos, a menos que eu peça explicitamente.',
  },
  {
    name: 'explicar',
    description: 'Explica o código, arquivo ou área indicados depois do comando.',
    template:
      'Explique o código, arquivo ou área indicados abaixo: o que faz, como os dados fluem e quais são os pontos de atenção, ' +
      'com referências a arquivos e funções. Diferencie o que leu no código do que está inferindo. ' +
      'Se nada for indicado, pergunte o que devo explicar.',
  },
  {
    name: 'compactar',
    description: 'Resume a conversa; o resumo passa a ser o ponto de partida das próximas mensagens.',
    template:
      'Ação embutida, não é enviada ao agente como mensagem: uma chamada somente leitura resume a conversa ' +
      '(objetivo, decisões, estado atual, arquivos e comandos, perguntas em aberto e próximos passos) e as ' +
      'próximas execuções recebem o resumo no lugar das mensagens anteriores. Use sozinho, sem texto depois.',
  },
].map((command) => ({
  ...command,
  id: `builtin:${command.name}`,
  mode: command.mode as CommandMode | undefined,
  source: 'builtin' as const,
  projectId: null,
  readOnly: true,
  active: true,
}));

const REPO_DIR = join('.adelic', 'commands');
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);

/** Minimal front-matter: `---` lines around `key: value` pairs; only description and mode matter. */
function frontMatter(text: string): { fields: Record<string, string>; body: string } | { error: string } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) return { fields: {}, body: normalized };
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return { error: 'Cabeçalho (---) sem fechamento' };
  const after = normalized.slice(end + 4);
  if (after && !after.startsWith('\n')) return { error: 'Cabeçalho (---) sem fechamento' };
  const fields: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) return { error: `Linha inválida no cabeçalho: ${line.slice(0, 60)}` };
    fields[match[1].toLowerCase()] = match[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return { fields, body: after.slice(1) };
}

/**
 * Commands from `<project>/.adelic/commands/*.md`. The file name (without `.md`) is the
 * command name. At most REPO_COMMANDS_MAX_FILES files are read, each up to
 * COMMAND_TEMPLATE_MAX characters; invalid files are skipped and reported in `issues`.
 */
export function loadRepoCommands(projectPath: string): { commands: CommandEntry[]; issues: CommandIssue[] } {
  const commands: CommandEntry[] = [];
  const issues: CommandIssue[] = [];
  let root: string, dir: string;
  try {
    root = realpathSync(projectPath);
    dir = realpathSync(join(root, REPO_DIR));
  } catch {
    return { commands, issues }; // No folder: nothing to load.
  }
  if (!inside(root, dir))
    return { commands, issues: [{ file: REPO_DIR, reason: 'A pasta aponta para fora do projeto' }] };
  let names: string[];
  try {
    if (!statSync(dir).isDirectory()) return { commands, issues: [{ file: REPO_DIR, reason: 'Não é uma pasta' }] };
    names = readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort();
  } catch (e) {
    return { commands, issues: [{ file: REPO_DIR, reason: `Pasta ilegível: ${(e as Error).message}` }] };
  }
  for (const [index, name] of names.entries()) {
    const file = join(REPO_DIR, name).split(sep).join('/');
    if (index >= REPO_COMMANDS_MAX_FILES) {
      issues.push({ file, reason: `Ignorado: limite de ${REPO_COMMANDS_MAX_FILES} arquivos` });
      continue;
    }
    const issue = (reason: string) => issues.push({ file, reason });
    const commandName = name.slice(0, -3);
    if (!COMMAND_NAME.test(commandName)) {
      issue('Nome de arquivo inválido: use letras minúsculas, números e hífens (até 32)');
      continue;
    }
    if (RESERVED_COMMAND_NAMES.includes(commandName)) {
      issue(COMMAND_RESERVED);
      continue;
    }
    const path = join(dir, name);
    let real: string;
    try {
      real = lstatSync(path).isSymbolicLink() ? realpathSync(path) : path;
    } catch {
      issue('Link simbólico quebrado');
      continue;
    }
    if (!inside(root, real)) {
      issue('Link simbólico aponta para fora do projeto');
      continue;
    }
    let text: string;
    try {
      const info = statSync(real);
      if (!info.isFile()) {
        issue('Não é um arquivo comum');
        continue;
      }
      // UTF-8 uses at most 4 bytes per character: anything larger cannot fit the limit.
      if (info.size > COMMAND_TEMPLATE_MAX * 4) {
        issue(`Arquivo grande demais (máximo ${COMMAND_TEMPLATE_MAX} caracteres)`);
        continue;
      }
      text = readFileSync(real, 'utf8');
    } catch (e) {
      issue(`Arquivo ilegível: ${(e as Error).message}`);
      continue;
    }
    if (text.length > COMMAND_TEMPLATE_MAX) {
      issue(`Arquivo grande demais (máximo ${COMMAND_TEMPLATE_MAX} caracteres)`);
      continue;
    }
    const parsed = frontMatter(text);
    if ('error' in parsed) {
      issue(parsed.error);
      continue;
    }
    const description = parsed.fields.description ?? '';
    if (description.length > COMMAND_DESCRIPTION_MAX) {
      issue(`Descrição com mais de ${COMMAND_DESCRIPTION_MAX} caracteres`);
      continue;
    }
    const mode = parsed.fields.mode;
    if (mode !== undefined && !(commandModes as readonly string[]).includes(mode)) {
      issue('mode deve ser fast, balanced ou deep');
      continue;
    }
    const template = parsed.body.trim();
    if (!template) {
      issue('Modelo vazio');
      continue;
    }
    commands.push({
      id: `repo:${commandName}`,
      name: commandName,
      description,
      template,
      ...(mode ? { mode: mode as CommandMode } : {}),
      source: 'repo',
      projectId: null,
      readOnly: true,
      active: true,
      file: relative(root, path).split(sep).join('/'),
    });
  }
  return { commands, issues };
}

const entryOf = (command: SavedCommand): CommandEntry => ({
  id: command.id,
  name: command.name,
  description: command.description,
  template: command.template,
  ...(command.mode ? { mode: command.mode } : {}),
  source: command.projectId ? 'project' : 'global',
  projectId: command.projectId,
  readOnly: false,
  active: true,
});

/**
 * Every command visible from `project` (or only global and built-in ones without a
 * project), sorted by name, with `active: false` on the ones shadowed by precedence.
 */
export function listCommands(store: Store, project?: Pick<Project, 'id' | 'path' | 'remote'>): CommandList {
  const repo = project && !project.remote ? loadRepoCommands(project.path) : { commands: [], issues: [] };
  const all = [
    ...(project ? store.listCommands(project.id).map(entryOf) : []),
    ...repo.commands.map((c) => ({ ...c, projectId: project!.id })),
    ...store.listCommands(null).map(entryOf),
    ...builtinCommands,
  ];
  // Reserved names always resolve to the built-in action, whatever else uses the name.
  const rank = (c: CommandEntry) =>
    RESERVED_COMMAND_NAMES.includes(c.name) && c.source === 'builtin' ? -1 : COMMAND_PRECEDENCE.indexOf(c.source);
  all.sort((a, b) => a.name.localeCompare(b.name) || rank(a) - rank(b));
  const seen = new Set<string>();
  const commands = all.map((c) => {
    const active = !seen.has(c.name);
    seen.add(c.name);
    return { ...c, active };
  });
  return { commands, issues: repo.issues };
}

/** The winning command named `name`, if any. */
export function findCommand(store: Store, name: string, project?: Pick<Project, 'id' | 'path' | 'remote'>) {
  return listCommands(store, project).commands.find((c) => c.active && c.name === name);
}

export interface ExpandedMessage {
  /** Text sent to the agent (the message itself when it is not a known command). */
  prompt: string;
  /** Per-run mode override from the command. */
  mode?: Mode;
  command?: Pick<CommandEntry, 'name' | 'source'>;
}
/**
 * Expands a message that starts with `/name`. Unknown names, and anything that is not a
 * command, come back unchanged so they are sent as plain text.
 */
export function expandMessage(
  store: Store,
  content: string,
  project?: Pick<Project, 'id' | 'path' | 'remote'>,
): ExpandedMessage {
  const slash = parseSlash(content);
  // Reserved names are actions handled before expansion; their description is never a prompt.
  if (!slash || RESERVED_COMMAND_NAMES.includes(slash.name)) return { prompt: content };
  const command = findCommand(store, slash.name, project);
  if (!command) return { prompt: content };
  return {
    prompt: expandTemplate(command.template, slash.args),
    mode: runModeFor(command.mode),
    command: { name: command.name, source: command.source },
  };
}
