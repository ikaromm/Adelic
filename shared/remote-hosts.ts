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
export type RemoteToolName = 'exec' | 'read_file' | 'write_file' | 'list' | 'stat' | 'search' | 'git';
export interface RemoteRuntime {
  label: string;
  root: string;
  /** Runs only after the local provider's explicit per-call approval. */
  call(tool: RemoteToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
