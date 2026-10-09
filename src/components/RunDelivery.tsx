import {
  ArrowUpRight,
  Download,
  FolderOpen,
  Terminal,
  Monitor,
  CircleHelp,
  CircleCheck,
  CircleX,
  LoaderCircle,
} from 'lucide-react';
import { useRef, useState } from 'react';
import type { RunArtifactsSnapshot } from '../../shared/contracts';
import type { CheckResult } from '../../shared/hooks';

export type RunDeliveryCheck = CheckResult;
export interface RunArtifactFileContent {
  path: string;
  content: string;
  truncated: boolean;
}
export interface RunDeliveryLabels {
  title: string;
  changes: string;
  contentNote: string;
  noChanges: string;
  initializeGit: string;
  initializeGitConfirm: string;
  unknown: string;
  truncated: string;
  contentTruncated: string;
  checkResults: string;
  noChecks: string;
  unverified: string;
  openPath: string;
  download: string;
  terminal: string;
  preview: string;
  project: string;
  added: string;
  modified: string;
  deleted: string;
  passed: string;
  failed: string;
  running: string;
  timeout: string;
  cancelled: string;
  error: string;
  unknownStatus: string;
  claimsUnverified: string;
  unverifiedClaims: string;
  filesSummary: string;
  checksSummary: string;
  checksUnknown: string;
  checkOutput: string;
  retryLoad: string;
  loading: string;
  nextSteps: string;
}
const defaultLabels: RunDeliveryLabels = {
  title: 'Entrega da execução',
  changes: 'Arquivos criados, alterados ou removidos',
  contentNote: 'O conteúdo aberto ou baixado é a versão atual do projeto; este registro não é uma cópia de segurança.',
  noChanges: 'Nenhuma alteração de arquivo foi observada.',
  initializeGit: 'Inicializar Git neste projeto',
  initializeGitConfirm: 'Criar o repositório Git local neste projeto? Isso não cria commits nem envia dados.',
  unknown: 'Não foi possível verificar as alterações deste projeto.',
  truncated: 'A lista atingiu o limite; alguns arquivos podem não aparecer.',
  contentTruncated: 'O conteúdo foi limitado a 256 KiB.',
  checkResults: 'Verificações executadas',
  noChecks: 'Nenhuma verificação configurada foi executada.',
  unverified: 'Não há evidência automática de interface além das verificações listadas.',
  openPath: 'Ver conteúdo',
  download: 'Baixar texto',
  terminal: 'Abrir terminal',
  preview: 'Abrir prévia',
  project: 'Abrir pasta do projeto',
  added: 'Criado',
  modified: 'Alterado',
  deleted: 'Removido',
  passed: 'Passou',
  failed: 'Falhou',
  running: 'Em andamento',
  timeout: 'Tempo esgotado',
  cancelled: 'Cancelada',
  error: 'Erro',
  unknownStatus: 'Resultado desconhecido',
  claimsUnverified:
    'Relatos do agente são declarações; somente resultados executados acima comprovam estas verificações.',
  unverifiedClaims: 'Relato do agente (não verificado)',
  filesSummary: '{count} arquivos observados',
  checksSummary: '{passed} passaram · {failed} falharam · {unknown} não verificadas',
  checksUnknown: 'Não há resultados de verificações para confirmar.',
  checkOutput: 'Ver saída',
  retryLoad: 'Tentar carregar novamente',
  loading: 'Carregando…',
  nextSteps: 'Próximos passos',
};

/** Delivery evidence for one run. The callbacks must use the app's safe project/file viewers. */
export function RunDelivery({
  artifacts,
  checks,
  unverifiedClaims = [],
  onOpenPath,
  onLoadFile,
  onOpenProject,
  onOpenTerminal,
  onOpenPreview,
  canInitializeGit = false,
  onInitializeGit,
  labels = defaultLabels,
}: {
  artifacts?: RunArtifactsSnapshot;
  checks: RunDeliveryCheck[];
  unverifiedClaims?: string[];
  onOpenPath?: (path: string) => void;
  onLoadFile: (path: string) => Promise<RunArtifactFileContent>;
  onOpenProject: () => void;
  onOpenTerminal?: () => void;
  onOpenPreview?: () => void;
  canInitializeGit?: boolean;
  onInitializeGit?: () => Promise<void>;
  labels?: Partial<RunDeliveryLabels>;
}) {
  const text = { ...defaultLabels, ...labels };
  const [gitState, setGitState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [gitError, setGitError] = useState('');
  const [files, setFiles] = useState<Record<string, RunArtifactFileContent | { error: string }>>({});
  const [loadingFiles, setLoadingFiles] = useState<Set<string>>(() => new Set());
  const loadingFilesRef = useRef(new Set<string>());
  const loadFile = async (path: string) => {
    if (loadingFilesRef.current.has(path)) return;
    loadingFilesRef.current.add(path);
    setLoadingFiles((current) => new Set(current).add(path));
    try {
      const content = await onLoadFile(path);
      setFiles((current) => ({ ...current, [path]: content }));
      return content;
    } catch (error) {
      const failure = { error: error instanceof Error ? error.message : String(error) };
      setFiles((current) => ({ ...current, [path]: failure }));
      return failure;
    } finally {
      loadingFilesRef.current.delete(path);
      setLoadingFiles((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
    }
  };
  const openFile = async (path: string) => {
    const loaded = await loadFile(path);
    if (loaded && !('error' in loaded)) onOpenPath?.(path);
  };
  const downloadFile = async (path: string) => {
    const loaded = await loadFile(path);
    if (!loaded || 'error' in loaded) return;
    const url = URL.createObjectURL(new Blob([loaded.content], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = path.split('/').at(-1) || 'artifact.txt';
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const observedFiles = artifacts?.status === 'available' ? artifacts.files.length : null;
  const passed = checks.filter((check) => check.status === 'passed').length;
  const failed = checks.filter((check) => ['failed', 'timeout', 'error'].includes(check.status)).length;
  const unverified = checks.filter((check) => !['passed', 'failed', 'timeout', 'error'].includes(check.status)).length;
  return (
    <section className="run-delivery" aria-label={text.title}>
      <h3>{text.title}</h3>
      <section aria-label={text.changes}>
        <h4>{text.changes}</h4>
        {observedFiles !== null && (
          <p className="run-delivery-summary">{text.filesSummary.replace('{count}', String(observedFiles))}</p>
        )}
        {artifacts?.status !== 'available' ? (
          <p role="status">{artifacts?.reason ? `${text.unknown} ${artifacts.reason}` : text.unknown}</p>
        ) : artifacts.files.length ? (
          <ul>
            {artifacts.files.map((file) => (
              <ArtifactRow
                key={`${file.path}:${file.status}`}
                file={file}
                labels={text}
                loaded={files[file.path]}
                loading={loadingFiles.has(file.path)}
                onOpenFile={() => void openFile(file.path)}
                onDownload={() => void downloadFile(file.path)}
              />
            ))}
          </ul>
        ) : (
          <p role="status">{text.noChanges}</p>
        )}
        {artifacts?.truncated && <p role="status">{text.truncated}</p>}
        {artifacts?.files.some((file) => file.status !== 'deleted') && <p>{text.contentNote}</p>}
        {gitError && <p role="alert">{gitError}</p>}
        {canInitializeGit && onInitializeGit && (
          <button
            type="button"
            disabled={gitState !== 'idle'}
            onClick={async () => {
              if (!window.confirm(text.initializeGitConfirm)) return;
              setGitState('busy');
              setGitError('');
              try {
                await onInitializeGit();
                setGitState('done');
              } catch (error) {
                setGitState('idle');
                setGitError(error instanceof Error ? error.message : String(error));
              }
            }}
          >
            {text.initializeGit}
          </button>
        )}
      </section>
      <section aria-label={text.checkResults}>
        <h4>{text.checkResults}</h4>
        <p className="run-delivery-summary">
          {checks.length
            ? text.checksSummary
                .replace('{passed}', String(passed))
                .replace('{failed}', String(failed))
                .replace('{unknown}', String(unverified))
            : text.checksUnknown}
        </p>
        {checks.length ? (
          <ul>
            {checks.map((check, index) => (
              <li className={`run-delivery-check ${checkTone(check.status)}`} key={`${check.name}:${index}`}>
                <div>
                  <strong>{check.name}</strong>
                  <span>{statusText(check.status, text)}</span>
                  {check.command && <code>{check.command}</code>}
                  {check.exitCode !== undefined && check.exitCode !== null && <small>exit {check.exitCode}</small>}
                  {check.durationMs !== undefined && <small>{check.durationMs} ms</small>}
                </div>
                {(check.output || check.detail) && (
                  <details>
                    <summary>{text.checkOutput}</summary>
                    <pre>{check.output || check.detail}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p>{text.noChecks}</p>
        )}
        <p className="run-delivery-unverified" role="note">
          <CircleHelp size={14} aria-hidden="true" /> {text.unverified}
        </p>
        <p className="run-delivery-unverified" role="note">
          <CircleHelp size={14} aria-hidden="true" /> {text.claimsUnverified}
        </p>
      </section>
      {unverifiedClaims.length > 0 && (
        <section aria-label={text.unverifiedClaims}>
          <h4>{text.unverifiedClaims}</h4>
          <ul>
            {unverifiedClaims.map((claim, index) => (
              <li key={`${index}:${claim}`}>{claim}</li>
            ))}
          </ul>
        </section>
      )}
      <section className="run-delivery-next" aria-label={text.nextSteps}>
        <h4>{text.nextSteps}</h4>
        <div className="run-delivery-shortcuts" aria-label={text.project}>
          <button type="button" onClick={onOpenProject}>
            <FolderOpen size={14} aria-hidden="true" /> {text.project}
          </button>
          {onOpenTerminal && (
            <button type="button" onClick={onOpenTerminal}>
              <Terminal size={14} aria-hidden="true" /> {text.terminal}
            </button>
          )}
          {onOpenPreview && (
            <button type="button" onClick={onOpenPreview}>
              <Monitor size={14} aria-hidden="true" /> {text.preview}
            </button>
          )}
        </div>
      </section>
    </section>
  );
}
function ArtifactRow({
  file,
  labels,
  loaded,
  loading,
  onOpenFile,
  onDownload,
}: {
  file: RunArtifactsSnapshot['files'][number];
  labels: RunDeliveryLabels;
  loaded?: RunArtifactFileContent | { error: string };
  loading: boolean;
  onOpenFile: () => void;
  onDownload: () => void;
}) {
  const canOpen = file.status !== 'deleted';
  return (
    <li className={`run-delivery-file ${file.status}`}>
      <span>{labels[file.status]}</span>
      <code>{file.path}</code>
      {canOpen && (
        <>
          <button type="button" aria-label={`${labels.openPath}: ${file.path}`} onClick={onOpenFile} disabled={loading}>
            {loading ? <LoaderCircle className="spin" size={13} /> : <ArrowUpRight size={13} aria-hidden="true" />}{' '}
            {loading ? labels.loading : labels.openPath}
          </button>
          <button type="button" aria-label={`${labels.download}: ${file.path}`} onClick={onDownload} disabled={loading}>
            <Download size={13} aria-hidden="true" /> {labels.download}
          </button>
        </>
      )}
      {loaded &&
        ('error' in loaded ? (
          <div role="alert">
            <p>{loaded.error}</p>
            <button type="button" onClick={onOpenFile} disabled={loading}>
              {labels.retryLoad}
            </button>
          </div>
        ) : (
          <>
            <pre aria-label={file.path}>{loaded.content}</pre>
            {loaded.truncated && <small role="status">{labels.contentTruncated}</small>}
          </>
        ))}
    </li>
  );
}
function checkTone(status: RunDeliveryCheck['status']) {
  if (status === 'passed') return 'passed';
  if (status === 'running') return 'running';
  if (status === 'failed' || status === 'timeout' || status === 'error') return 'failed';
  return 'unknown';
}
function statusText(status: RunDeliveryCheck['status'], labels: RunDeliveryLabels) {
  if (status === 'passed')
    return (
      <>
        <CircleCheck size={13} aria-hidden="true" /> {labels.passed}
      </>
    );
  if (status === 'running') return <>{labels.running}</>;
  if (status === 'failed')
    return (
      <>
        <CircleX size={13} aria-hidden="true" /> {labels.failed}
      </>
    );
  if (status === 'timeout')
    return (
      <>
        <CircleX size={13} aria-hidden="true" /> {labels.timeout}
      </>
    );
  if (status === 'cancelled') return <>{labels.cancelled}</>;
  if (status === 'error')
    return (
      <>
        <CircleX size={13} aria-hidden="true" /> {labels.error}
      </>
    );
  return <>{labels.unknownStatus}</>;
}
