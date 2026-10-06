import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api';

afterEach(() => vi.unstubAllGlobals());

describe('shared memory HTTP errors', () => {
  it('retains HTTP 409 status and server detail for readable editor conflict handling', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'A versão da nota mudou.' }), { status: 409 })));
    await expect(api.saveSharedMemory({ workspace: 'w', project: 'p' }, 'note.md', 'draft', 'v1'))
      .rejects.toMatchObject({ message: 'A versão da nota mudou.', status: 409 });
  });
});
