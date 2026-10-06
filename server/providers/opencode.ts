import { CommandScope } from './command';
import { findProviderBinary, hasProviderBinaryOverride, providerBinaryMissingDetail } from './discovery';
import type { ProviderEvent, ProviderInfo, RunInput, RunResult } from '../../shared/contracts';

export class OpenCodeProvider {
  private binary?: string;
  private cache?: { at: number; value: ProviderInfo };
  private shuttingDown = false;
  private commands = new CommandScope();
  async info(): Promise<ProviderInfo> {
    if (this.shuttingDown) return this.shutdownInfo();
    if (this.cache && Date.now() - this.cache.at < 5 * 60_000) return this.cache.value;
    this.binary ??= await findProviderBinary('opencode');
    if (!this.binary) return this.save({ id: 'opencode', name: 'OpenCode', installed: false, available: false, status: hasProviderBinaryOverride('opencode') ? 'error' : 'missing', detail: providerBinaryMissingDetail('opencode'), models: [], capabilities: { fast: false, tools: false, approvals: false, cancel: false, reasoning:false } });

    const providers = await this.commands.run(this.binary, ['providers', 'list', '--pure'], 4000);
    if (this.shuttingDown) return this.shutdownInfo();
    const providerNames = new Set<string>();
    for (const line of stripAnsi(providers.stdout).split(/\r?\n/)) {
      const match = line.match(/[●*]\s*([a-z0-9_-]+)\s+(?:api|oauth|credentials?)/i);
      if (match) providerNames.add(match[1]);
    }
    const modelResult = await this.commands.run(this.binary, ['models'], 5000);
    if (this.shuttingDown) return this.shutdownInfo();
    const models = stripAnsi(modelResult.stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => {
      const slash = line.indexOf('/');
      return slash > 0 && providerNames.has(line.slice(0, slash));
    }).map((id) => ({ id, name: id.slice(id.indexOf('/') + 1) }));

    const configured = providerNames.size > 0;
    const detail = configured
      ? `OpenCode instalado; ${providerNames.size} provider(s) com credencial local e ${models.length} modelo(s) no catálogo. Autenticação e execução ACP ainda não foram verificadas pelo Adelic.`
      : 'OpenCode instalado, mas nenhum provider com credencial local foi descoberto.';
    return this.save({ id: 'opencode', name: 'OpenCode', installed: true, available: false, status: 'unknown', detail, models, capabilities: { fast: false, tools: false, approvals: false, cancel: false, reasoning:false } });
  }
  private save(value: ProviderInfo) { this.cache = { at: Date.now(), value }; return value; }
  private shutdownInfo(): ProviderInfo {
    return { id: 'opencode', name: 'OpenCode', installed: Boolean(this.binary), available: false, status: 'error', detail: 'OpenCode provider is shutting down.', models: [], capabilities: { fast: false, tools: false, approvals: false, cancel: false, reasoning:false } };
  }
  async run(_input: RunInput, _emit: (event: ProviderEvent) => void, _signal: AbortSignal): Promise<RunResult> { if (this.shuttingDown) throw new Error('OpenCode provider is shutting down'); throw new Error('OpenCode está instalado, mas a integração ACP do Adelic ainda não está implementada.'); }
  async approve(_approvalId: string, _decision: 'approve' | 'deny'): Promise<void> { throw new Error('OpenCode ainda não oferece aprovações pela integração do Adelic.'); }
  async shutdown() { this.shuttingDown = true; await this.commands.shutdown(); }
}

function stripAnsi(value: string) { return value.replace(/\u001b\[[0-9;]*m/g, '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, ''); }
