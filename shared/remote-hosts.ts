/** SSH executors have no model credentials. All remote data is untrusted. */
export interface RemoteHost {
  id: string;
  name: string;
  target: string;
  port: number;
  fingerprint: string;
  /** Public host-key line, pinned in Adelic's private known_hosts. */
  hostKey: string;
  runnerPath: string;
  createdAt: string;
}
export interface RemoteProject {
  hostId: string;
  path: string;
}
export interface RemoteProbe {
  target: string;
  port: number;
  hostname: string;
  fingerprint: string;
  hostKey: string;
}
export type RemoteToolName =
  'exec' | 'read_file' | 'write_file' | 'replace_text' | 'list' | 'stat' | 'search' | 'git' | 'diagnose';
/** Raw-byte capture status. `complete` means the reader reached EOF, not that output was untruncated. */
export interface RemoteStreamCapture {
  observedBytes: number;
  retainedBytes: number;
  truncated: boolean;
  state: 'complete' | 'incomplete' | 'error';
}
/** Optional because installed protocol-1 runners may predate capture metadata. */
export interface RemoteExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutCapture?: RemoteStreamCapture;
  stderrCapture?: RemoteStreamCapture;
}
export interface RemoteRuntime {
  label: string;
  root: string;
  executionKind?: 'ssh' | 'isolated-local';
  /** Fixed tool executor; each call follows the captured run approval policy. */
  call(tool: RemoteToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
