import { afterEach, describe, expect, it, vi } from 'vitest';
import { uuid } from '../src/uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.unstubAllGlobals());

describe('uuid', () => {
  it('uses crypto.randomUUID when the context provides it', () => {
    expect(uuid()).toMatch(V4);
  });

  it('works without crypto.randomUUID, as over plain HTTP on a Tailscale address', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
    expect(globalThis.crypto.randomUUID).toBeUndefined();
    const ids = Array.from({ length: 200 }, () => uuid());
    for (const id of ids) expect(id).toMatch(V4);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
