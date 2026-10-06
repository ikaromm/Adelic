import { describe, expect, it } from 'vitest';
import {
  JsonRpcResponseSchema,
  PageSchema,
  SearchResultSchema,
  ToolCallResultSchema,
  ToolsListSchema,
  parseService,
} from '../server/memory-protocol.js';

describe('ai-memory protocol parsing', () => {
  it('normalizes search hits from the shapes different servers use', () => {
    expect(parseService(SearchResultSchema, { hits: [{ path: 'a.md', title: 'A', snippet: 'x' }] }, 'q')).toEqual([
      { path: 'a.md', title: 'A', snippet: 'x' },
    ]);
    expect(parseService(SearchResultSchema, [{ relative_path: 'b.md', name: 'B', excerpt: 'y' }], 'q')).toEqual([
      { path: 'b.md', title: 'B', snippet: 'y' },
    ]);
    expect(parseService(SearchResultSchema, { results: [{ path: 'c.md' }] }, 'q')).toEqual([
      { path: 'c.md', title: 'c.md', snippet: '' },
    ]);
    expect(parseService(SearchResultSchema, { other: 1 }, 'q')).toEqual([]);
    expect(parseService(SearchResultSchema, [{ path: 'd.md', snippet: 'z'.repeat(700) }], 'q')[0].snippet).toHaveLength(
      600,
    );
  });
  it('accepts unknown extra fields from newer servers', () => {
    const tools = parseService(
      ToolsListSchema,
      {
        tools: [
          { name: 'memory_query', annotations: { readOnly: true }, inputSchema: { properties: {}, required: [] } },
        ],
      },
      'tools/list',
    );
    expect(tools.tools[0].name).toBe('memory_query');
    expect(parseService(PageSchema, { path: 'a.md', body: 'x', supersedes: 'y' }, 'read').body).toBe('x');
  });
  it('turns malformed responses into a clear 502 instead of undefined behavior', () => {
    for (const [schema, value] of [
      [ToolsListSchema, { tools: [{ description: 'no name' }] }],
      [ToolCallResultSchema, { isError: 'yes' }],
      [JsonRpcResponseSchema, { error: { code: 'x' } }],
      [PageSchema, { body: 42 }],
    ] as const)
      expect(() => parseService(schema, value, 'teste')).toThrow(
        expect.objectContaining({
          status: 502,
          message: expect.stringMatching(/Resposta incompatível do ai-memory \(teste\)/),
        }),
      );
  });
});
