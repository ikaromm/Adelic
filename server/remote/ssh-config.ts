import { glob, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Discover literal aliases only. Never evaluate Match exec, shell commands or credentials. */
export async function sshConfigAliases(configFile = process.env.ADELIC_SSH_CONFIG ?? join(homedir(), '.ssh/config')) {
  const aliases = new Set<string>();
  const visited = new Set<string>();
  const base = join(homedir(), '.ssh');
  const read = async (file: string, depth: number): Promise<void> => {
    if (depth > 16 || visited.size >= 100) throw new Error('SSH config include limit exceeded');
    let canonical: string;
    let contents: string;
    try {
      canonical = await realpath(file);
      if (visited.has(canonical)) return;
      visited.add(canonical);
      contents = await readFile(canonical, 'utf8');
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw new Error('Could not read SSH config', { cause: error });
    }
    if (Buffer.byteLength(contents) > 1024 * 1024) throw new Error('SSH config file is too large');
    for (const line of contents.split(/\r?\n/)) {
      // OpenSSH keywords can be separated from values by whitespace or '='.
      const match = line.match(/^\s*(Host|Include)\s*(?:=\s*|\s+)(.*)$/i);
      if (!match) continue;
      const words = match[2].match(/"(?:[^"\\]|\\.)*"|'[^']*'|#.*$|[^\s#]+/g) ?? [];
      for (let word of words) {
        if (word.startsWith('#')) break;
        if (/^["']/.test(word)) word = word.slice(1, -1);
        if (match[1].toLowerCase() === 'host') {
          if (word.length <= 255 && /^[A-Za-z0-9_.:-]+$/.test(word) && !word.startsWith('-')) aliases.add(word);
          if (aliases.size > 500) throw new Error('SSH config host limit exceeded');
        } else {
          if (word.startsWith('~/')) word = join(homedir(), word.slice(2));
          const pattern = isAbsolute(word) ? word : join(base, word);
          // Relative user Include paths are rooted in ~/.ssh, as in OpenSSH.
          for await (const included of glob(pattern)) await read(included, depth + 1);
        }
      }
    }
  };
  await read(configFile, 0);
  return [...aliases].sort((a, b) => a.localeCompare(b));
}
