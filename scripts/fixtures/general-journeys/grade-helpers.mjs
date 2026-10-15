import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

async function inventoryFiles(workspace) {
  const files = [];
  async function walk(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!prefix && entry.name === '.git') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) {
        if (!(await walk(join(dir, entry.name), rel))) return false;
      } else if (entry.isFile()) files.push(rel);
      else return false;
    }
    return true;
  }
  if (!(await walk(workspace))) return null;
  return files.sort();
}

export async function filesExactly(workspace, expectedPaths) {
  const files = await inventoryFiles(workspace);
  if (!files) return false;
  return files.sort().join('\n') === [...expectedPaths].sort().join('\n');
}

export async function starterFilesUnchanged(workspace, taskId, paths) {
  for (const path of paths) {
    const starter = new URL(`./${taskId}/starter/${path}`, import.meta.url);
    const before = await readFile(starter);
    const after = await readFile(join(workspace, path));
    if (createHash('sha256').update(before).digest('hex') !== createHash('sha256').update(after).digest('hex'))
      return false;
  }
  return true;
}
