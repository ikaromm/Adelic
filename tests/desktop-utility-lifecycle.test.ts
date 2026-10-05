import { describe, expect, it } from 'vitest';
import { stopUtilityProcess, type UtilityChild, type UtilityState } from '../desktop/utility-lifecycle.js';

class FakeUtility implements UtilityChild {
  readonly messages: unknown[] = [];
  killCalls = 0;
  private exitListeners = new Set<(code: number) => void>();

  constructor(readonly state: UtilityState, public pid: number | undefined) {}

  postMessage(message: unknown) { this.messages.push(message); }

  kill() {
    this.killCalls++;
    return true;
  }

  once(_event: 'exit', listener: (code: number) => void) {
    this.exitListeners.add(listener);
    return this;
  }

  off(_event: 'exit', listener: (code: number) => void) {
    this.exitListeners.delete(listener);
    return this;
  }

  exit() {
    this.state.exited = true;
    for (const listener of this.exitListeners) listener(0);
    this.exitListeners.clear();
    this.pid = undefined;
  }
}

describe('desktop utility process shutdown', () => {
  it('waits for an unspawned utility to exit instead of treating missing pid as already stopped', async () => {
    const state: UtilityState = { spawned: false, exited: false };
    const child = new FakeUtility(state, undefined);
    child.kill = () => {
      child.killCalls++;
      if (child.killCalls === 1) {
        setTimeout(() => {
          state.spawned = true;
          child.pid = 2142;
          setTimeout(() => child.exit(), 5);
        }, 5);
      }
      return true;
    };

    await expect(stopUtilityProcess(child, state, { gracefulMs: 80, terminateMs: 30, reapMs: 30 })).resolves.toBe(true);
    expect(child.killCalls).toBe(1);
    expect(state.exited).toBe(true);
  });

  it('requests runtime shutdown before escalating to process termination', async () => {
    const state: UtilityState = { spawned: true, exited: false };
    const child = new FakeUtility(state, 2143);
    child.kill = () => {
      child.killCalls++;
      setTimeout(() => child.exit(), 5);
      return true;
    };

    await expect(stopUtilityProcess(child, state, { gracefulMs: 5, terminateMs: 50, reapMs: 20 })).resolves.toBe(true);
    expect(child.messages).toEqual([{ type: 'shutdown' }]);
    expect(child.killCalls).toBe(1);
    expect(state.exited).toBe(true);
  });

  it('uses SIGKILL as the last resort and waits for the exit event to reap the child', async () => {
    const state: UtilityState = { spawned: true, exited: false };
    const child = new FakeUtility(state, 2144);
    const forceKill = (pid: number) => { expect(pid).toBe(2144); child.exit(); };

    await expect(stopUtilityProcess(child, state, { gracefulMs: 1, terminateMs: 1, reapMs: 20, forceKill })).resolves.toBe(true);
    expect(child.killCalls).toBe(1);
    expect(state.exited).toBe(true);
  });
});
