import { describe, expect, it } from 'vitest';
import { boundedRemoteResult } from '../server/providers/remote-tools.js';

describe('remote process output contract', () => {
  it('preserves output capture metadata in the JSON text passed to MCP providers', () => {
    const result = {
      exitCode: 0,
      stdout: 'done',
      stderr: '',
      stdoutCapture: { observedBytes: 4, retainedBytes: 4, truncated: false, state: 'complete' },
      stderrCapture: { observedBytes: 0, retainedBytes: 0, truncated: false, state: 'complete' },
    };

    expect(JSON.parse(boundedRemoteResult(result))).toEqual(result);
  });
});
