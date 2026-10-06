import { describe, expect, it } from 'vitest';
import { parseJsonRpcLine } from '../server/providers/process.js';
import { DeltaParams, ItemParams, TurnParams, parseParams } from '../server/providers/codex-protocol.js';

describe('JSON-RPC line parsing', () => {
  it('accepts requests, notifications and responses, with extra fields', () => {
    expect(parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"method":"x","params":{}}')).toMatchObject({ id: 1, method: 'x' });
    expect(parseJsonRpcLine('{"method":"turn/started","params":{"threadId":"t"},"extra":true}')).toMatchObject({
      method: 'turn/started',
    });
    expect(parseJsonRpcLine('{"id":"a","result":{"ok":1}}')).toMatchObject({ id: 'a' });
  });
  it('skips banners, logs and non-envelope JSON', () => {
    for (const line of [
      'Codex starting…',
      '[]',
      '"text"',
      '{"foo":1}',
      '{"id":{"x":1},"method":"m"}',
      '{"error":{"code":"x"},"id":1}',
    ])
      expect(parseJsonRpcLine(line)).toBeUndefined();
  });
});

describe('Codex notification params', () => {
  it('reads the fields Adelic acts on and tolerates new ones', () => {
    expect(parseParams(DeltaParams, { threadId: 't', delta: 'oi', seq: 3 })).toMatchObject({ delta: 'oi' });
    expect(
      parseParams(ItemParams, {
        threadId: 't',
        item: { id: 7, type: 'commandExecution', command: 'pwd', newField: {} },
      })?.item,
    ).toMatchObject({ id: '7', type: 'commandExecution', command: 'pwd' });
    expect(parseParams(TurnParams, { threadId: 't', turn: { id: 'x', status: 'interrupted' } })?.turn?.status).toBe(
      'interrupted',
    );
  });
  it('ignores events missing what they need instead of half-applying them', () => {
    expect(parseParams(DeltaParams, { threadId: 't', delta: 5 })).toBeUndefined();
    expect(parseParams(ItemParams, { threadId: 't', item: { command: 'pwd' } })).toBeUndefined();
    expect(parseParams(TurnParams, { turn: {} })).toBeUndefined();
  });
});
