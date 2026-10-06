import { useState } from 'react';
import { Check, ClipboardCopy, Download, ExternalLink, LoaderCircle, RefreshCw, Stethoscope } from 'lucide-react';
import { api, type Diagnostics, type UpdateInfo } from '../api';

const field = (label: string, value: string | number | null | undefined) => (
  <div className="diagnostics-row" key={label}>
    <dt>{label}</dt>
    <dd>{value === null || value === undefined || value === '' ? '—' : value}</dd>
  </div>
);

/** Settings card that loads /api/diagnostics on demand and lets the user copy or save it. */
export function DiagnosticsCard({
  updateCheck,
  onUpdateCheck,
}: {
  updateCheck: boolean;
  onUpdateCheck: (enabled: boolean) => void;
}) {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const checkNow = async () => {
    setChecking(true);
    try {
      setUpdate(await api.updates(true));
    } catch (e) {
      setUpdate({ enabled: true, error: (e as Error).message });
    } finally {
      setChecking(false);
    }
  };
  const [report, setReport] = useState<Diagnostics | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const load = async () => {
    setBusy(true);
    setError('');
    try {
      setReport(await api.diagnostics());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const json = report ? JSON.stringify(report, null, 2) : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Não foi possível copiar; use Baixar.');
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `adelic-diagnostico-${report!.generatedAt.slice(0, 19).replace(/[:T]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section className="settings-card" aria-labelledby="diagnostics-title">
      <div className="settings-card-heading">
        <div className="settings-card-icon">
          <Stethoscope size={17} />
        </div>
        <div>
          <h2 id="diagnostics-title">Diagnóstico</h2>
          <p>Versões, caminhos e estado dos serviços para relatar problemas. Não inclui credenciais nem conversas.</p>
        </div>
      </div>
      <div className="setting-row">
        <div>
          <strong>Verificar novas versões</strong>
          <span>Consulta a última release no GitHub ao abrir o Adelic. Nunca baixa nem instala nada.</span>
        </div>
        <button
          className={`toggle ${updateCheck ? 'on' : ''}`}
          role="switch"
          aria-checked={updateCheck}
          aria-label="Verificar novas versões"
          onClick={() => onUpdateCheck(!updateCheck)}
        >
          <span />
        </button>
      </div>
      <div className="diagnostics-actions">
        <button type="button" className="secondary-button" onClick={() => void checkNow()} disabled={checking}>
          {checking ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />} Verificar agora
        </button>
      </div>
      {update && (
        <p className="diagnostics-note" role="status">
          {update.error ? (
            update.error
          ) : update.available ? (
            <>
              Nova versão {update.latest} disponível (você usa {update.current}).{' '}
              <a href={update.url} target="_blank" rel="noreferrer">
                Abrir a release <ExternalLink size={12} />
              </a>
            </>
          ) : (
            `Você está na versão mais recente (${update.current}).`
          )}
        </p>
      )}
      <div className="diagnostics-actions">
        <button type="button" className="secondary-button" onClick={() => void load()} disabled={busy}>
          {busy ? <LoaderCircle size={14} className="spin" /> : <Stethoscope size={14} />}
          {report ? 'Atualizar diagnóstico' : 'Gerar diagnóstico'}
        </button>
        {report && (
          <>
            <button type="button" className="secondary-button" onClick={() => void copy()}>
              {copied ? <Check size={14} /> : <ClipboardCopy size={14} />} {copied ? 'Copiado' : 'Copiar'}
            </button>
            <button type="button" className="secondary-button" onClick={download}>
              <Download size={14} /> Baixar JSON
            </button>
          </>
        )}
      </div>
      {error && (
        <div className="inline-notice error-notice" role="alert">
          {error}
        </div>
      )}
      {report && (
        <div className="diagnostics-body">
          <dl>
            {field('Adelic', report.app.version)}
            {field('Node', report.app.node)}
            {field('Electron', report.app.electron)}
            {field('Sistema', `${report.system.platform} ${report.system.arch} · ${report.system.kernel}`)}
            {field('Dados', report.data.dir)}
            {field('Esquema da base', `${report.data.schema.current} (suportado: ${report.data.schema.supported})`)}
            {field(
              'Conteúdo',
              `${report.data.counts.sessions} conversas · ${report.data.counts.messages} mensagens · ${report.data.counts.runs} execuções`,
            )}
            {field(
              'Cópias da base',
              report.data.backups.length
                ? `${report.data.backups.length} (mais recente ${report.data.backups[0].at.slice(0, 10)})`
                : 'nenhuma',
            )}
            {field('Bubblewrap', report.sandbox.bubblewrap ?? 'não encontrado')}
            {field(
              'ai-memory',
              report.memory.reachable
                ? `${report.memory.version ?? 'versão desconhecida'} · ${report.memory.notes ?? '?'} notas · ${report.memory.url}`
                : `indisponível em ${report.memory.url}`,
            )}
          </dl>
          <h3>Agentes</h3>
          <dl>
            {report.providers.map((p) =>
              field(
                p.id,
                `${p.available ? 'disponível' : 'indisponível'} · ${p.models} modelos · ${p.version ?? 'versão desconhecida'}${p.binary ? ` · ${p.binary}` : ''}`,
              ),
            )}
          </dl>
          {!report.memory.reachable && report.memory.detail && (
            <p className="diagnostics-note">{report.memory.detail}</p>
          )}
        </div>
      )}
    </section>
  );
}
