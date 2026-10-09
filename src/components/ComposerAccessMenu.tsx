import { Check, Lock, Shield } from 'lucide-react';
import type { ApprovalMode, Sandbox } from '../../shared/contracts';
import { Popover } from '../ComposerMenus';
import { useI18n } from '../i18n';

export type ApprovalScope = 'session' | 'project' | 'settings' | 'forced';

/**
 * One compact entry point for workspace sandbox and approval policy.
 * The two axes remain independent so the UI never implies that workspace-write grants
 * access beyond the project folder.
 */
export function ComposerAccessMenu({
  sandbox,
  approval,
  approvalScope,
  configuredApprovalMode,
  supportsAutomatic,
  remote = false,
  disabled = false,
  sandboxDisabled = disabled,
  approvalDisabled = disabled,
  onPermissions,
  onApproval,
}: {
  sandbox: Sandbox;
  approval: ApprovalMode;
  approvalScope: ApprovalScope;
  /** The conversation's stored approval override; null means inherit. */
  configuredApprovalMode?: ApprovalMode | null;
  /** True only when this runtime supports automatic approval with tools. */
  supportsAutomatic: boolean;
  /** SSH project: auto-safe asks for approval and has effective Manual behavior. */
  remote?: boolean;
  disabled?: boolean;
  sandboxDisabled?: boolean;
  approvalDisabled?: boolean;
  onPermissions: (sandbox: Sandbox) => void;
  onApproval: (approval: ApprovalMode | null) => void;
}) {
  const { t } = useI18n();
  const sandboxName = t(sandbox === 'workspace-write' ? 'profile.write' : 'profile.read');
  const approvalName = t(
    approval === 'automatic'
      ? 'composer.autonomy.mode.automatic'
      : approval === 'manual'
        ? 'composer.autonomy.mode.manual'
        : 'composer.autonomy.mode.autoSafe',
  );
  const summary = sandboxName;
  const scopeKeys = {
    session: 'composer.access.scope.session',
    project: 'composer.access.scope.project',
    settings: 'composer.access.scope.settings',
    forced: 'composer.access.scope.forced',
  } as const;
  const scopeLabel = t(scopeKeys[approvalScope]);
  const approvalOptions: { value: ApprovalMode; label: string; detail: string; disabled?: boolean }[] = [
    {
      value: 'auto-safe',
      label: t('composer.autonomy.mode.autoSafe'),
      detail: remote ? t('composer.access.remoteAutoSafe') : t('composer.permissions.autoDetail'),
      disabled: approvalScope === 'forced',
    },
    {
      value: 'manual',
      label: t('composer.autonomy.mode.manual'),
      detail: t('composer.permissions.manualDetail'),
    },
    ...(configuredApprovalMode === 'automatic' || supportsAutomatic
      ? [
          {
            value: 'automatic' as const,
            label: t('composer.autonomy.mode.automatic'),
            detail: supportsAutomatic
              ? t('composer.permissions.automaticDetail')
              : t('composer.autonomy.automaticUnavailable'),
            disabled: !supportsAutomatic || approvalScope === 'forced',
          },
        ]
      : []),
  ];

  return (
    <Popover
      className="access-pill"
      label={t('composer.access.label')}
      icon={approvalScope === 'forced' ? <Lock size={14} /> : <Shield size={14} />}
      summary={summary}
      title={`${summary} · ${approvalName} · ${scopeLabel}`}
      disabled={disabled}
      focusFirst
      width={350}
    >
      {(close) => (
        <div className="choice-menu composer-access-menu">
          <strong className="choice-menu-title">{t('composer.access.workspace')}</strong>
          <p className="composer-access-scope">{t('composer.access.workspaceScope')}</p>
          <button
            type="button"
            className="choice-option"
            aria-pressed={sandbox === 'read-only'}
            disabled={sandboxDisabled}
            onClick={() => {
              onPermissions('read-only');
              close();
            }}
          >
            <span>
              <b>{t('profile.read')}</b>
              <small>{t('composer.access.readDetail')}</small>
            </span>
            {sandbox === 'read-only' && (
              <span className="composer-access-check" aria-hidden="true">
                <Check size={14} strokeWidth={2.5} />
              </span>
            )}
          </button>
          <button
            type="button"
            className="choice-option"
            aria-pressed={sandbox === 'workspace-write'}
            disabled={sandboxDisabled}
            onClick={() => {
              onPermissions('workspace-write');
              close();
            }}
          >
            <span>
              <b>{t('profile.write')}</b>
              <small>{t(remote ? 'composer.access.remoteWriteDetail' : 'composer.access.writeDetail')}</small>
            </span>
            {sandbox === 'workspace-write' && (
              <span className="composer-access-check" aria-hidden="true">
                <Check size={14} strokeWidth={2.5} />
              </span>
            )}
          </button>

          <strong className="choice-menu-title composer-access-approval-title">{t('composer.access.approval')}</strong>
          <p className="composer-access-scope">
            {t('composer.access.current', { approval: approvalName, scope: scopeLabel })}
          </p>
          <button
            type="button"
            className="choice-option"
            aria-pressed={configuredApprovalMode == null}
            disabled={approvalDisabled || approvalScope === 'forced'}
            onClick={() => {
              onApproval(null);
              close();
            }}
          >
            <span>
              <b>{t('composer.access.inherit')}</b>
              <small>{t('composer.access.inheritDetail')}</small>
            </span>
            {configuredApprovalMode == null && (
              <span className="composer-access-check" aria-hidden="true">
                <Check size={14} strokeWidth={2.5} />
              </span>
            )}
          </button>
          {approvalOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className="choice-option"
              aria-pressed={configuredApprovalMode === option.value}
              disabled={approvalDisabled || option.disabled}
              onClick={() => {
                onApproval(option.value);
                close();
              }}
            >
              <span>
                <b>{option.label}</b>
                <small>{option.detail}</small>
              </span>
              {configuredApprovalMode === option.value && (
                <span className="composer-access-check" aria-hidden="true">
                  <Check size={14} strokeWidth={2.5} />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}
