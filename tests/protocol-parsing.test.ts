import { describe, expect, it } from 'vitest';
import { parseJsonRpcLine } from '../server/providers/process.js';
import {
  DeltaParams,
  ItemParams,
  TokenUsageParams,
  TurnParams,
  CodexThreadUsage,
  parseParams,
} from '../server/providers/codex-protocol.js';

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

describe('Codex token usage', () => {
  it('reads the last-turn counts as Codex 0.160 sends them', () => {
    const params = {
      threadId: 't',
      turnId: 'u',
      tokenUsage: {
        total: {
          totalTokens: 4611,
          inputTokens: 4606,
          cachedInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 0,
        },
        last: { totalTokens: 4611, inputTokens: 4606, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
        modelContextWindow: 258400,
      },
    };
    expect(parseParams(TokenUsageParams, params)?.tokenUsage.last).toMatchObject({
      inputTokens: 4606,
      outputTokens: 5,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
    });
    expect(parseParams(TokenUsageParams, params)?.tokenUsage.total).toMatchObject({
      inputTokens: 4606,
      cachedInputTokens: 0,
      outputTokens: 5,
      reasoningOutputTokens: 0,
    });
    expect(parseParams(TokenUsageParams, { threadId: 't', tokenUsage: { last: { inputTokens: -1 } } })).toBeUndefined();
  });

  it('turns cumulative thread totals into retry-safe turn totals and preserves cache/reasoning separately', () => {
    const usage = new CodexThreadUsage();
    usage.beginTurn('grade-school');
    // Captured Codex 0.160 usage snapshots, with thread/turn ids and prompt data omitted.
    const capturedSnapshots = [
      { inputTokens: 5_572, cachedInputTokens: 0, outputTokens: 47, reasoningOutputTokens: 19 },
      { inputTokens: 11_244, cachedInputTokens: 0, outputTokens: 79, reasoningOutputTokens: 19 },
      { inputTokens: 17_351, cachedInputTokens: 4_864, outputTokens: 532, reasoningOutputTokens: 111 },
      { inputTokens: 23_950, cachedInputTokens: 10_752, outputTokens: 687, reasoningOutputTokens: 136 },
      { inputTokens: 30_742, cachedInputTokens: 15_616, outputTokens: 776, reasoningOutputTokens: 169 },
    ];
    const finalSnapshot = capturedSnapshots.map((snapshot) => usage.update('grade-school', snapshot)).at(-1);
    expect(finalSnapshot).toEqual({
      inputTokens: 30_742,
      cachedInputTokens: 15_616,
      outputTokens: 776,
      reasoningOutputTokens: 169,
    });
    // A repeated notification is a snapshot, so the consumer replaces its current value.
    expect(usage.update('grade-school', capturedSnapshots.at(-1))).toEqual({
      inputTokens: 30_742,
      cachedInputTokens: 15_616,
      outputTokens: 776,
      reasoningOutputTokens: 169,
    });
    usage.beginTurn('grade-school');
    expect(
      usage.update('grade-school', {
        inputTokens: 35_000,
        cachedInputTokens: 18_816,
        outputTokens: 900,
        reasoningOutputTokens: 269,
      }),
    ).toEqual({ inputTokens: 4_258, cachedInputTokens: 3_200, outputTokens: 124, reasoningOutputTokens: 100 });
  });
});
