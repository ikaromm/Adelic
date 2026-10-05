export interface UtilityChild {
  readonly pid: number | undefined;
  postMessage(message: unknown): void;
  kill(): boolean;
  once(event: 'exit', listener: (code: number) => void): this;
  off(event: 'exit', listener: (code: number) => void): this;
}

export interface UtilityState {
  spawned: boolean;
  exited: boolean;
  stopping?: boolean;
}

export interface StopOptions {
  gracefulMs?: number;
  terminateMs?: number;
  reapMs?: number;
  forceKill?: (pid: number) => void;
}

function waitForExit(child: UtilityChild, state: UtilityState, timeoutMs: number) {
  if (state.exited) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (didExit: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off('exit', onExit);
      resolve(didExit);
    };
    const onExit = () => {
      state.exited = true;
      finish(true);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    if (state.exited) finish(true);
  });
}

/** Stop a utility process while accounting for the interval before its spawn event. */
export async function stopUtilityProcess(child: UtilityChild, state: UtilityState, options: StopOptions = {}) {
  const gracefulMs = options.gracefulMs ?? 12_000;
  const terminateMs = options.terminateMs ?? 3_000;
  const reapMs = options.reapMs ?? 3_000;
  if (state.exited) return true;
  state.stopping = true;

  if (state.spawned && child.pid !== undefined) {
    try { child.postMessage({ type: 'shutdown' }); } catch { /* The utility may be exiting already. */ }
  } else {
    child.kill();
  }
  if (await waitForExit(child, state, gracefulMs)) return true;

  child.kill();
  if (await waitForExit(child, state, terminateMs)) return true;

  const pid = child.pid;
  if (pid !== undefined) {
    try { (options.forceKill || ((targetPid) => process.kill(targetPid, 'SIGKILL')))(pid); }
    catch { /* The process may exit between reading its PID and signaling it. */ }
  }
  return waitForExit(child, state, reapMs);
}
