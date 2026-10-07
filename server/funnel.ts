import { execFile } from 'node:child_process';
import type { TailscaleState } from '../shared/remote-access.js';

// Tailscale Funnel for the Adelic (docs/specs/remote-access.md). Every call goes through an
// injected runner so tests never touch the real `tailscale`. Commands verified against
// tailscale 1.102 (`tailscale funnel --help` and the CLI source):
//   on:     tailscale funnel --bg --yes --https=443 --set-path=/ http://127.0.0.1:<port>
//   off:    tailscale funnel --yes --https=443 --set-path=/ off
//   status: tailscale funnel status --json   /   tailscale status --json
// The serve config is changed only after an explicit request from this computer.

export type TailscaleRunner = (
  args: string[],
  options: { timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

/** Runs the real CLI with a timeout, no shell and stdin closed (it must never prompt). */
export const runTailscale: TailscaleRunner = (args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      'tailscale',
      args,
      { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout, stderr) => {
        if (error)
          reject(
            Object.assign(error, {
              stdout: String(stdout ?? ''),
              stderr: String(stderr ?? ''),
            }),
          );
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
    child.stdin?.end();
  });

export const FUNNEL_HTTPS_PORT = 443;
export const funnelTarget = (localPort: number) => `http://127.0.0.1:${localPort}`;
export function funnelOnArgs(localPort: number) {
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error('Porta local inválida');
  return ['funnel', '--bg', '--yes', `--https=${FUNNEL_HTTPS_PORT}`, '--set-path=/', funnelTarget(localPort)];
}
export const funnelOffArgs = () => ['funnel', '--yes', `--https=${FUNNEL_HTTPS_PORT}`, '--set-path=/', 'off'];

const ADMIN_DNS = 'https://login.tailscale.com/admin/dns';
const ADMIN_ACLS = 'https://login.tailscale.com/admin/acls/file';
const CAP_HTTPS = 'https';
const CAP_FUNNEL = 'funnel';
const CAP_FUNNEL_PORTS = 'https://tailscale.com/cap/funnel-ports';

interface StatusJson {
  BackendState?: string;
  Version?: string;
  Self?: { DNSName?: string; Capabilities?: string[]; CapMap?: Record<string, unknown> };
}
interface ServeJson {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
}

function failureText(error: unknown) {
  const e = error as { stderr?: string; stdout?: string; message?: string; code?: unknown; killed?: boolean };
  if (e?.code === 'ENOENT') return 'O comando tailscale não foi encontrado neste computador.';
  if (e?.killed) return 'O comando tailscale não respondeu a tempo.';
  const text = `${e?.stderr ?? ''}\n${e?.stdout ?? ''}`.trim() || e?.message || String(error);
  return text.replace(/\s+\n/g, '\n').slice(0, 1200);
}

/** Explains a CLI failure in pt-BR, keeping the original text, with the admin page to fix it. */
export function explainTailscaleError(text: string): { text: string; url?: string } {
  if (/Access denied|checkprefs access denied|serve config denied|use 'sudo tailscale|--operator/i.test(text))
    return {
      text: `Seu usuário não pode alterar a configuração do Tailscale. Rode uma vez "sudo tailscale set --operator=$USER" e tente de novo. Erro: ${text}`,
    };
  if (/HTTPS must be enabled|https feature|enable HTTPS/i.test(text))
    return {
      text: `A tailnet ainda não permite certificados HTTPS. Ative "HTTPS Certificates" em DNS no console da Tailscale. Erro: ${text}`,
      url: ADMIN_DNS,
    };
  if (/funnel.*node attribute|no-funnel|Funnel not available|not allowed for funnel/i.test(text))
    return {
      text: `A política da tailnet não concede Funnel a este dispositivo. Adicione o atributo "funnel" (nodeAttrs) para ele no arquivo de acesso. Erro: ${text}`,
      url: ADMIN_ACLS,
    };
  if (/shields-up/i.test(text))
    return { text: `O Tailscale está com "shields up"; o Funnel não pode ser ligado assim. Erro: ${text}` };
  return { text };
}

export function parseCapabilities(self: StatusJson['Self']) {
  const caps = new Set<string>([...(self?.Capabilities ?? []), ...Object.keys(self?.CapMap ?? {})]);
  const portAttrs = [...caps].filter((c) => c.startsWith(`${CAP_FUNNEL_PORTS}?`));
  let port443 = true;
  // Same rule as the CLI: with funnel-ports attributes present, 443 must be in one of them.
  if (portAttrs.length)
    port443 = portAttrs.some((attr) => {
      const ports = new URL(attr).searchParams.get('ports') ?? '';
      return ports.split(',').some((part) => {
        const [from, to] = part.split('-').map(Number);
        return to ? from <= 443 && 443 <= to : from === 443;
      });
    });
  return { https: caps.has(CAP_HTTPS), funnel: caps.has(CAP_FUNNEL), port443 };
}

export class FunnelService {
  constructor(
    private readonly run: TailscaleRunner = runTailscale,
    private readonly timeoutMs = 15_000,
  ) {}

  /**
   * `previousPort`: the port saved by an earlier "Publicar" (ADELIC_FUNNEL_PORT may have changed
   * since); a mount pointing there still counts as this Adelic's, not as a conflict.
   */
  async status(localPort: number, previousPort?: number): Promise<TailscaleState> {
    const base: TailscaleState = {
      installed: false,
      loggedIn: false,
      https: false,
      funnelAllowed: false,
      port443Allowed: false,
      funnelOn: false,
      requirements: [],
    };
    try {
      const version = await this.run(['version'], { timeoutMs: 5000 });
      base.installed = true;
      base.version = version.stdout.split('\n')[0]?.trim();
    } catch (error) {
      return { ...base, error: failureText(error), requirements: [{ text: 'Instale o Tailscale neste computador.' }] };
    }
    let status: StatusJson;
    try {
      status = JSON.parse((await this.run(['status', '--json'], { timeoutMs: 5000 })).stdout) as StatusJson;
    } catch (error) {
      return { ...base, error: failureText(error), requirements: [{ text: 'Inicie o Tailscale (tailscale up).' }] };
    }
    const state: TailscaleState = {
      ...base,
      backendState: status.BackendState,
      loggedIn: status.BackendState === 'Running',
    };
    const dnsName = status.Self?.DNSName?.replace(/\.$/, '');
    if (dnsName) state.dnsName = dnsName;
    const caps = parseCapabilities(status.Self);
    state.https = caps.https;
    state.funnelAllowed = caps.funnel;
    state.port443Allowed = caps.port443;
    if (!state.loggedIn) state.requirements.push({ text: 'Entre na sua tailnet com "tailscale up".' });
    if (!dnsName) state.requirements.push({ text: 'Ative MagicDNS na tailnet.', url: ADMIN_DNS });
    if (!caps.https)
      state.requirements.push({
        text: 'Ative "HTTPS Certificates" nas configurações de DNS da tailnet.',
        url: ADMIN_DNS,
      });
    if (!caps.funnel)
      state.requirements.push({
        text: 'Conceda o atributo "funnel" a este dispositivo (nodeAttrs no arquivo de acesso da tailnet).',
        url: ADMIN_ACLS,
      });
    else if (!caps.port443)
      state.requirements.push({ text: 'Permita a porta 443 em funnel-ports para este dispositivo.', url: ADMIN_ACLS });
    try {
      const serve = JSON.parse(
        (await this.run(['funnel', 'status', '--json'], { timeoutMs: 5000 })).stdout || '{}',
      ) as ServeJson;
      const mine = dnsName ? this.inspect(serve, dnsName, localPort, previousPort) : { on: false, stale: false };
      state.funnelOn = mine.on;
      state.stale = mine.stale;
      if (mine.conflict) state.conflict = mine.conflict;
    } catch (error) {
      state.error = failureText(error);
    }
    if (dnsName) state.publicUrl = `https://${dnsName}/`;
    return state;
  }

  /** Whether https://<dns>:443/ is published by Funnel to this Adelic, or to something else. */
  private inspect(serve: ServeJson, dnsName: string, localPort: number, previousPort?: number) {
    const hp = `${dnsName}:${FUNNEL_HTTPS_PORT}`;
    const root = serve.Web?.[hp]?.Handlers?.['/'];
    const target = root?.Proxy ?? root?.Path ?? (root?.Text !== undefined ? 'text' : undefined);
    const current = root?.Proxy === funnelTarget(localPort);
    const ours = current || (previousPort !== undefined && root?.Proxy === funnelTarget(previousPort));
    const funnel = serve.AllowFunnel?.[hp] === true;
    return {
      // On only when it points to the current listener; a stale port is re-applied by enable().
      on: current && funnel,
      stale: ours && !current,
      ...(target && !ours ? { conflict: target } : {}),
    };
  }

  /** Publishes the funnel listener; refuses to replace another service on the same address. */
  async enable(localPort: number, previousPort?: number) {
    const before = await this.status(localPort, previousPort);
    if (!before.installed || !before.loggedIn) throw this.failure(before.error ?? 'O Tailscale não está conectado.');
    if (before.conflict)
      throw this.failure(
        `https://${before.dnsName}/ já publica outro destino (${before.conflict}). Desligue-o antes com "tailscale funnel --https=443 off" ou "tailscale serve --https=443 off".`,
      );
    if (before.funnelOn) return before;
    try {
      await this.run(funnelOnArgs(localPort), { timeoutMs: this.timeoutMs });
    } catch (error) {
      throw this.failure(failureText(error));
    }
    const after = await this.status(localPort, previousPort);
    if (!after.funnelOn)
      throw this.failure(after.error ?? 'O Tailscale não confirmou o Funnel; confira "tailscale funnel status".');
    return after;
  }

  /** Removes only the "/" mount on 443 when it points to this Adelic; anything else is left alone. */
  async disable(localPort: number, previousPort?: number) {
    const before = await this.status(localPort, previousPort);
    if (!before.funnelOn && !before.stale) return before;
    try {
      await this.run(funnelOffArgs(), { timeoutMs: this.timeoutMs });
    } catch (error) {
      throw this.failure(failureText(error));
    }
    return this.status(localPort, previousPort);
  }

  private failure(text: string) {
    const explained = explainTailscaleError(text);
    return Object.assign(new Error(explained.text), { status: 502, url: explained.url });
  }
}
