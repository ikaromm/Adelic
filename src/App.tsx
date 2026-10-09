import { RunProgressBanner } from './components/RunProgressBanner';
import { ComposerSurface } from './components/ComposerSurface';
import { ComposerAccessMenu } from './components/ComposerAccessMenu';
import { ExecutionProfile } from './components/ExecutionProfile';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  CircleHelp,
  Folder,
  LoaderCircle,
  MessageSquare,
  Plus,
  Shield,
  Sparkles,
  Square,
  X,
  Brain,
  PanelLeftClose,
  PanelLeftOpen,
  Menu,
  Search,
  Download,
  ListPlus,
  ClipboardList,
  ArrowRightLeft,
  CornerDownRight,
  SquareTerminal,
  GitBranch,
  Archive,
  ArchiveRestore,
} from 'lucide-react';
import type {
  AttachmentMeta,
  ApprovalMode,
  Bootstrap,
  GraphifyQueryResult,
  GraphifyStatus,
  HandoffSummaryMode,
  Message,
  OrchestrationConfig,
  ProjectFolder,
  ProjectCoordination,
  Session,
  SessionDetail,
  StreamEvent,
} from '../shared/contracts';
import type { RemoteHost } from '../shared/remote-hosts';
import { api, eventsUrl, reportClientEvent } from './api';
import SharedMemoryPage from './MemoryPage';
import { BrandMark } from './BrandMark';
import { ErrorBoundary } from './ErrorBoundary';
import { bootstrapSelection, sidebarSessions } from './selection';
import { compatibleThinking, supportedThinking, thinkingLabel } from './reasoning';
import { ChoiceMenu, ConversationMenu, ModelMenu } from './ComposerMenus';
import { Markdown } from './Markdown';
import { newConversationShortcut } from './format';
import { useNow } from './useNow';
import { useAutosize } from './hooks/useAutosize';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts';
import { useStickToBottom } from './hooks/useStickToBottom';
import { useTaskOutputs } from './hooks/useTaskOutputs';
import { notificationsEnabled, useRunNotifications } from './hooks/useRunNotifications';
import { useComposerAttachments } from './hooks/useComposerAttachments';
import { AttachButton, PendingAttachments } from './components/ComposerAttachments';
import { useVoiceDictation } from './hooks/useVoiceDictation';
import { VoiceButton } from './components/VoiceButton';
import { insertDictation } from '../shared/voice';
import { composerKeyAction, useMessageQueue } from './hooks/useMessageQueue';
import { useSlashCommands } from './hooks/useSlashCommands';
import { CommandPopup } from './components/CommandPopup';
import { useFileMentions } from './hooks/useFileMentions';
import { MentionPopup } from './components/MentionPopup';
import { MessageQueue } from './components/MessageQueue';
import { usePlans } from './hooks/usePlans';
import { PlanCard } from './components/PlanCard';
import { projectOrchestration } from '../shared/contracts';
import { ActivityPage } from './components/ActivityPage';
import { AutomationsPage } from './components/AutomationsPage';
import { ConversationSearch } from './components/ConversationSearch';
import { CommandPalette } from './components/CommandPalette';
import { downloadExport, useCommandPalette } from './hooks/useCommandPalette';
import { ProjectForm, type NewProject } from './components/ProjectForm';
import { MessageCard, RetryNotice, RunActivityPanel, RunEventRow } from './components/Chat';
import { retryAlternatives } from '../shared/model-fallback';
import { BranchOrigin, MessageEditActions, MessageEditor } from './components/EditBranch';
import { useEditBranch } from './hooks/useEditBranch';
import { CompactingNotice, CompactionCard, ConversationActions } from './components/CompactionCard';
import { timelineSegments, upsertCompaction } from './compaction-timeline';
import { compactCommand } from '../shared/compaction';
import { SettingsPage } from './components/SettingsPage';
import { GitPanel, useGitRepo } from './components/GitPanel';
import { RemoteGitPanel } from './components/RemoteGitPanel';
import { HandoffDialog, type HandoffTarget } from './components/HandoffDialog';
import { LimitNotice, SpendWarningBanner } from './components/SpendLimits';
import { isLimitError, useUsage } from './hooks/useUsage';
import type { ApiError, SpendLimitsPatch } from './api';
import {
  SIDEBAR_LIMIT,
  SessionItem,
  SidebarNav,
  UpdateNotice,
  type Page,
  type SessionSidebarPatch,
} from './components/Sidebar';
import { ToolsPanel, type ToolsTab } from './components/ToolsPanel';
import { WorktreePanel } from './components/WorktreePanel';
import { ProjectFolders } from './components/ProjectFolders';
import { SessionFolderMenu } from './components/SessionFolderMenu';
import { uuid } from './uuid';
import { setLanguagePreference, t as translate, useI18n, type LanguagePreference } from './i18n';
import { useAccessKind } from './RemoteGate';

type LocalStream = { runId: string; messageId: string; content: string; updatedAt?: number };

function providerForRemoteProject(preferred: string, providers: Bootstrap['providers']) {
  const supported = providers.filter((provider) => provider.id === 'codex' || provider.id === 'kiro');
  if (
    (preferred === 'codex' || preferred === 'kiro') &&
    supported.find((provider) => provider.id === preferred)?.available
  )
    return preferred;
  return supported.find((provider) => provider.available)?.id;
}

export default function App() {
  const { t, tRich } = useI18n();
  const accessKind = useAccessKind();
  const [data, setData] = useState<Bootstrap | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [coordination, setCoordination] = useState<ProjectCoordination | null>(null);
  const [graphifyStatus, setGraphifyStatus] = useState<GraphifyStatus | null>(null);
  const [remoteHosts, setRemoteHosts] = useState<RemoteHost[]>([]);
  const [selectedSession, setSelectedSession] = useState('');
  const [selectedProject, setSelectedProject] = useState('');
  const [page, setPage] = useState<Page>('chat');
  const previousPageRef = useRef<Page>(page);
  useEffect(() => {
    if (previousPageRef.current !== page) reportClientEvent('ui.navigation');
    previousPageRef.current = page;
  }, [page]);
  const [memoryVisited, setMemoryVisited] = useState(false);
  // Bumped by `automations` stream events so the Automações page reloads its list.
  const [automationsVersion, setAutomationsVersion] = useState(0);
  const [stream, setStream] = useState<LocalStream | null>(null);
  const [eventsConnected, setEventsConnected] = useState(true);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessionCreationPending, setSessionCreationPending] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [projectForm, setProjectForm] = useState(false);
  const [projectSetupPaused, setProjectSetupPaused] = useState(false);
  const [settingsSearchRequest, setSettingsSearchRequest] = useState<{ id: number; query: string }>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [projectQuery, setProjectQuery] = useState('');
  const [graphQueryResult, setGraphQueryResult] = useState<GraphifyQueryResult | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);
  // "Continuar com outro agente": open dialog (with the provider picked in the model menu, if any).
  const [handoff, setHandoff] = useState<{ sessionId: string; target?: HandoffTarget } | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState('');
  // Terminal / Preview panel of the project in context (docs/specs/terminal-preview.md).
  const [toolsTab, setToolsTab] = useState<ToolsTab | null>(null);
  const [handoffLimited, setHandoffLimited] = useState(false);
  // A request refused by a usage limit (409): its message and the same request with
  // "Continuar mesmo assim" (overrideLimit for that one request only; never stored).
  const [limitBlock, setLimitBlock] = useState<{
    sessionId: string;
    message: string;
    retry: () => Promise<unknown>;
  } | null>(null);
  const [limitRetrying, setLimitRetrying] = useState(false);
  const [usageWarningHidden, setUsageWarningHidden] = useState('');
  const focusComposerRef = useRef(false);
  const [expandedLists, setExpandedLists] = useState<Record<string, boolean>>({});
  const [showArchivedLists, setShowArchivedLists] = useState<Record<string, boolean>>({});
  const now = useNow(60_000);
  const activeRunIdRef = useRef<string | undefined>(undefined);
  const bootstrapRequestRef = useRef(0);
  const detailRequestRef = useRef(new Map<string, number>());
  const detailSnapshotRef = useRef<SessionDetail | null>(null);
  const projectRequestRef = useRef(new Map<string, number>());
  const graphActionRef = useRef(0);
  const projectWriteRef = useRef(new Map<string, Promise<void>>());
  const projectRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const projectSnapshotRef = useRef<Bootstrap | null>(null);
  const sessionWriteRef = useRef(new Map<string, Promise<void>>());
  const settingsWriteRef = useRef<Promise<void>>(Promise.resolve());
  const settingsPendingRef = useRef(0);
  const permissionTargetRef = useRef<{
    sandbox: 'read-only' | 'workspace-write';
    approvalMode: ApprovalMode;
  } | null>(null);
  const [settingsPending, setSettingsPending] = useState(false);
  const [pendingSendSession, setPendingSendSession] = useState('');
  const pendingSendRef = useRef<{
    sessionId: string;
    cancelRequested: boolean;
    accepted: boolean;
    cancelSucceeded?: boolean;
    cancelPromise?: Promise<void>;
    cancelError?: Error;
  } | null>(null);
  const selectedProjectRef = useRef(selectedProject);
  selectedProjectRef.current = selectedProject;
  const selectedSessionRef = useRef(selectedSession);
  selectedSessionRef.current = selectedSession;
  projectSnapshotRef.current = data;
  detailSnapshotRef.current = detail;
  const taskOutputs = useTaskOutputs(selectedSessionRef, detailSnapshotRef, setNotice);
  const messageQueue = useMessageQueue(selectedSession, setNotice);
  const { apply: applyQueue, reload: reloadQueue } = messageQueue;
  const plans = usePlans(selectedSession, setNotice, (error, retry) => blockedByLimit(error, retry));
  const { apply: applyPlan, reload: reloadPlans } = plans;
  const selectSession = (id: string) => {
    if (id !== selectedSessionRef.current) setToolsTab(null);
    selectedSessionRef.current = id;
    setSelectedSession(id);
  };
  const invalidateBootstrapRefreshes = () => {
    bootstrapRequestRef.current++;
  };
  const selectConversation = (id: string) => {
    const next = projectSnapshotRef.current?.sessions.find((item) => item.id === id);
    selectProject(next?.projectId || '');
    selectSession(id);
  };
  const selectProject = (id: string) => {
    if (id !== selectedProjectRef.current) {
      setToolsTab(null);
      selectedProjectRef.current = id;
      graphActionRef.current++;
      setProjectBusy(false);
    }
    setSelectedProject(id);
  };
  const notifyRun = useRunNotifications({
    enabled: data ? notificationsEnabled(data.settings) : false,
    titleOf: (id) => projectSnapshotRef.current?.sessions.find((item) => item.id === id)?.title,
    onOpen: (id) => {
      selectConversation(id);
      setPage('chat');
      setSidebarOpen(false);
    },
  });

  const refreshBootstrap = useCallback(async (preserveSelection = true) => {
    const requestId = ++bootstrapRequestRef.current;
    let next = await api.bootstrap();
    try {
      const health = await api.health();
      const memory = next.integrations.find((item) => item.kind === 'memory');
      if (memory)
        next = {
          ...next,
          integrations: next.integrations.map((item) =>
            item === memory
              ? {
                  ...item,
                  status: health.memory as typeof item.status,
                  detail: health.memory === 'ready' ? translate('app.memoryReady') : translate('app.memoryUnavailable'),
                }
              : item,
          ),
        };
    } catch {
      /* Keep the bootstrap snapshot when health is temporarily unavailable. */
    }
    if (requestId !== bootstrapRequestRef.current) return;
    const preserveSettings = settingsPendingRef.current > 0;
    setData((current) => (preserveSettings && current ? { ...next, settings: current.settings } : next));
    const { projectId, sessionId } = bootstrapSelection(
      next,
      selectedProjectRef.current,
      selectedSessionRef.current,
      preserveSelection,
    );
    selectProject(projectId);
    selectSession(sessionId);
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    if (!id) {
      setDetail(null);
      return;
    }
    if (id !== selectedSessionRef.current) return;
    const requestId = (detailRequestRef.current.get(id) || 0) + 1;
    detailRequestRef.current.set(id, requestId);
    const next = await api.detail(id);
    if (detailRequestRef.current.get(id) !== requestId || id !== selectedSessionRef.current) return;
    setDetail(next);
    setData((current) =>
      current
        ? {
            ...current,
            sessions: current.sessions.map((session) => (session.id === next.session.id ? next.session : session)),
            runs: [
              ...current.runs.filter((run) => !next.runs.some((incoming) => incoming.id === run.id)),
              ...next.runs,
            ],
          }
        : current,
    );
    if (next.session.activeRunId) {
      const runId = next.session.activeRunId;
      const partial = next.messages.find((message) => message.role === 'assistant' && message.runId === runId);
      setStream((current) => {
        if (current && current.runId === runId) {
          return partial && partial.content.length > current.content.length
            ? { ...current, messageId: partial.id, content: partial.content }
            : current;
        }
        return partial ? { runId, messageId: partial.id, content: partial.content } : null;
      });
    } else setStream(null);
  }, []);

  useEffect(() => {
    void refreshBootstrap(false).catch((error: Error) => setNotice(error.message));
  }, [refreshBootstrap]);

  const remoteHostIds = useMemo(
    () =>
      [...new Set((data?.projects ?? []).flatMap((item) => (item.remote ? [item.remote.hostId] : [])))]
        .sort()
        .join(','),
    [data?.projects],
  );
  useEffect(() => {
    if (!remoteHostIds) {
      setRemoteHosts([]);
      return;
    }
    let active = true;
    void api
      .remoteHosts()
      .then((hosts) => active && setRemoteHosts(hosts))
      .catch(() => active && setRemoteHosts([]));
    return () => {
      active = false;
    };
  }, [remoteHostIds]);

  useEffect(() => {
    setDetail(null);
    setStream(null);
    if (!selectedSession) return;
    void refreshDetail(selectedSession).catch((error: Error) => setNotice(error.message));
  }, [selectedSession, refreshDetail]);

  const refreshProjectViews = useCallback(async (id: string) => {
    if (!id || id !== selectedProjectRef.current) return;
    const requestId = (projectRequestRef.current.get(id) || 0) + 1;
    projectRequestRef.current.set(id, requestId);
    const [coordinationResult, graphifyResult] = await Promise.allSettled([api.coordination(id), api.graphify(id)]);
    if (projectRequestRef.current.get(id) !== requestId || id !== selectedProjectRef.current) return;
    if (coordinationResult.status === 'fulfilled') setCoordination(coordinationResult.value);
    else
      setNotice(
        coordinationResult.reason instanceof Error
          ? coordinationResult.reason.message
          : translate('app.coordinationFailed'),
      );
    if (graphifyResult.status === 'fulfilled') setGraphifyStatus(graphifyResult.value);
    else setGraphifyStatus(null);
  }, []);

  useEffect(() => {
    setCoordination(null);
    setGraphifyStatus(null);
    setGraphQueryResult(null);
    setProjectQuery('');
    if (selectedProject) void refreshProjectViews(selectedProject);
    return () => {
      if (projectRefreshTimerRef.current) clearTimeout(projectRefreshTimerRef.current);
    };
  }, [selectedProject, refreshProjectViews]);

  useEffect(() => {
    const events = new EventSource(eventsUrl('/api/events'));
    events.onopen = () => setEventsConnected(true);
    const reconcile = () => {
      void refreshBootstrap().catch((error: Error) => setNotice(error.message));
      if (selectedSession) void refreshDetail(selectedSession).catch(() => undefined);
    };
    events.onmessage = (message) => {
      let event: StreamEvent;
      try {
        event = JSON.parse(message.data) as StreamEvent;
      } catch {
        return;
      }
      notifyRun(event);
      if (event.type === 'automations') {
        setAutomationsVersion((value) => value + 1);
        return;
      }
      if (event.type === 'queue') {
        applyQueue(event.queue);
        return;
      }
      if (event.type === 'plan') {
        applyPlan(event.plan);
        return;
      }
      if (event.type === 'compaction') {
        setDetail((current) =>
          current?.session.id === event.compaction.sessionId
            ? {
                ...current,
                compactions: upsertCompaction(current.compactions, event.compaction, current.session.id),
              }
            : current,
        );
        return;
      }
      if (event.type === 'refresh') {
        reconcile();
        void reloadQueue();
        void reloadPlans();
        if (selectedProjectRef.current) void refreshProjectViews(selectedProjectRef.current);
        return;
      }
      const eventSessionId =
        event.type === 'message'
          ? event.message.sessionId
          : event.type === 'event'
            ? event.event.sessionId
            : event.type === 'approval'
              ? event.approval.sessionId
              : event.type === 'session'
                ? event.session.id
                : event.type === 'run'
                  ? event.run.sessionId
                  : event.type === 'task'
                    ? event.task.sessionId
                    : event.type === 'delta'
                      ? event.sessionId
                      : undefined;
      if (eventSessionId === selectedSession) {
        detailRequestRef.current.set(selectedSession, (detailRequestRef.current.get(selectedSession) || 0) + 1);
      }
      if (event.type === 'session') {
        if (event.session.id === selectedSession) activeRunIdRef.current = event.session.activeRunId;
        // Runs can start without this tab sending them (the queue, another device).
        setDetail((current) =>
          current?.session.id === event.session.id ? { ...current, session: event.session } : current,
        );
        setData((current) =>
          current
            ? { ...current, sessions: current.sessions.map((s) => (s.id === event.session.id ? event.session : s)) }
            : current,
        );
      }
      if (event.type === 'run') {
        setData((current) =>
          current
            ? { ...current, runs: [...current.runs.filter((run) => run.id !== event.run.id), event.run] }
            : current,
        );
        if (event.run.sessionId === selectedSession && event.run.status !== 'running') {
          setTimeout(() => {
            void refreshDetail(selectedSession).catch(() => undefined);
          }, 120);
        }
      }
      if (event.type === 'task') {
        if (event.task.sessionId === selectedSession)
          setTimeout(() => {
            void refreshDetail(event.task.sessionId).catch(() => undefined);
          }, 100);
        const taskProjectId = event.task.projectId;
        if (taskProjectId && taskProjectId === selectedProjectRef.current) {
          if (projectRefreshTimerRef.current) clearTimeout(projectRefreshTimerRef.current);
          projectRefreshTimerRef.current = setTimeout(() => {
            void refreshProjectViews(taskProjectId);
          }, 180);
        }
      }
      if (event.type === 'message' && event.message.sessionId === selectedSession) {
        setDetail((current) =>
          current
            ? {
                ...current,
                // The server's copy of a just-sent message may arrive before the send request
                // resolves; it replaces the optimistic `local-` bubble instead of showing twice.
                messages: [
                  ...current.messages.filter(
                    (m) =>
                      m.id !== event.message.id &&
                      !(
                        event.message.role === 'user' &&
                        m.role === 'user' &&
                        m.id.startsWith('local-') &&
                        m.content === event.message.content
                      ),
                  ),
                  event.message,
                ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
              }
            : current,
        );
        if (event.message.role === 'assistant') setStream(null);
      }
      if (event.type === 'delta' && event.sessionId === selectedSession) {
        if (event.runId !== activeRunIdRef.current) return;
        setStream((current) =>
          current?.messageId === event.messageId
            ? { ...current, content: current.content + event.text, updatedAt: Date.now() }
            : { runId: event.runId, messageId: event.messageId, content: event.text, updatedAt: Date.now() },
        );
      }
      if (
        (event.type === 'event' && event.event.sessionId === selectedSession) ||
        (event.type === 'approval' && event.approval.sessionId === selectedSession)
      ) {
        void refreshDetail(selectedSession).catch(() => undefined);
      }
    };
    events.onerror = () => {
      setEventsConnected(false);
      /* EventSource reconnects; the server sends a fresh snapshot signal. */
    };
    return () => events.close();
  }, [
    refreshBootstrap,
    refreshDetail,
    refreshProjectViews,
    selectedSession,
    notifyRun,
    applyQueue,
    reloadQueue,
    applyPlan,
    reloadPlans,
  ]);

  // Follow new content only while the reader is at the end; reading history is never interrupted.
  // Approvals, tasks and error rows count as new content too, not only messages and streamed text.
  const pendingApprovalCount = detail?.approvals.filter((item) => item.status === 'pending').length ?? 0;
  const conversationScroll = useStickToBottom<HTMLElement>(
    [selectedSession, page],
    [
      detail?.messages.length,
      detail?.session.id,
      detail?.tasks?.length,
      detail?.events.length,
      pendingApprovalCount,
      stream?.content,
    ],
  );

  const project = data?.projects.find((p) => p.id === selectedProject);
  const currentDetail = detail?.session.id === selectedSession ? detail : null;
  const session = currentDetail?.session || data?.sessions.find((s) => s.id === selectedSession);
  const composer = drafts[selectedSession] || '';
  const pendingSendForSession = pendingSendSession === session?.id;
  const canCancelCurrentSend = Boolean(session?.activeRunId) || pendingSendForSession;
  const provider = data?.providers.find((p) => p.id === (session?.providerId || data?.settings.defaultProviderId));
  const thinkingOptions = supportedThinking(provider, session?.model);
  const reasoningUnavailable = provider?.capabilities.reasoning === false;
  activeRunIdRef.current = session?.activeRunId;
  // Usage limits (docs/specs/spend-limits.md): the report of the open project (Settings) or of
  // the conversation's project (chat banner), reloaded when a run finishes or a limit changes.
  const limitsEnabled = data?.settings.spendLimits?.enabled === true;
  const usageScope = page === 'settings' ? project?.id : (session?.projectId ?? undefined);
  const usageVersion = useMemo(
    () =>
      JSON.stringify([
        data?.settings.spendLimits,
        data?.projects.find((p) => p.id === usageScope)?.spendLimits,
        data?.runs.reduce(
          (latest, run) => (run.completedAt && run.completedAt > latest ? run.completedAt : latest),
          '',
        ),
      ]),
    [data?.settings.spendLimits, data?.projects, data?.runs, usageScope],
  );
  const usage = useUsage(usageScope, usageVersion, page === 'settings' || limitsEnabled);
  // Dismissing the banner hides it until another limit (or a limit being reached) appears.
  const usageWarningKey = (usage.report?.warnings ?? [])
    .map((w) => `${w.kind}:${w.used >= w.limit ? 'reached' : 'warn'}`)
    .join(',');
  const projectSessions = useMemo(
    () => data?.sessions.filter((s) => s.projectId === selectedProject && !s.archivedAt) || [],
    [data?.sessions, selectedProject],
  );
  const detachedSessions = useMemo(
    () => data?.sessions.filter((s) => s.projectId === null && !s.archivedAt) || [],
    [data?.sessions],
  );
  const archivedDetachedSessions = useMemo(
    () => data?.sessions.filter((s) => s.projectId === null && Boolean(s.archivedAt)) || [],
    [data?.sessions],
  );
  const conversationProject = data?.projects.find((item) => item.id === session?.projectId);
  const cwdProject = page === 'chat' && session ? conversationProject : project;
  const cwdHost = cwdProject?.remote ? remoteHosts.find((host) => host.id === cwdProject.remote?.hostId) : undefined;
  // The Git page follows the selected project (a linked conversation selects its project).
  const projectIsGit = useGitRepo(project?.remote ? undefined : project?.id);
  const messages = currentDetail?.messages || [];
  const activeConversationRun = [...(currentDetail?.runs || []), ...(data?.runs || [])].find(
    (run) => run.id === session?.activeRunId,
  );
  const activityEvents = currentDetail?.events || [];
  const activityTasks = currentDetail?.tasks || [];
  // "Tentar de novo" is offered only on the latest answer, and only if it failed.
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const lastFailedMessageId = lastAssistant?.status === 'failed' ? lastAssistant.id : undefined;

  const editBranch = useEditBranch({
    session,
    messages,
    plans: plans.plans,
    busy: busy || pendingSendForSession,
    onError: setNotice,
    onLimit: (error, retry) => blockedByLimit(error, retry),
    onEdited: (sessionId, keep, started) => {
      setStream(null);
      setDetail((current) =>
        current?.session.id === sessionId
          ? { ...current, session: { ...current.session, activeRunId: started.runId }, messages: keep }
          : current,
      );
      void refreshDetail(sessionId).catch(() => undefined);
    },
    onBranched: (created) => {
      invalidateBootstrapRefreshes();
      setData((current) => (current ? { ...current, sessions: [created, ...current.sessions] } : current));
      selectProject(created.projectId || '');
      selectSession(created.id);
      setPage('chat');
    },
  });

  const composerRef = useAutosize([composer, selectedSession, page, session?.activeRunId]);
  const attachments = useComposerAttachments(session?.id, setNotice);
  const slash = useSlashCommands(session?.projectId, composer, (value) =>
    setDrafts((current) => ({ ...current, [selectedSessionRef.current]: value })),
  );
  // `@file` mentions; never at the same time as the saved commands list.
  const mentions = useFileMentions(
    session?.projectId,
    composer,
    (value) => setDrafts((current) => ({ ...current, [selectedSessionRef.current]: value })),
    composerRef,
    slash.open,
    session?.worktree ? session.id : undefined,
  );
  // Dictated text goes to the conversation where the recording started, at its caret.
  const dictationTargetRef = useRef('');
  const dictationCaretRef = useRef<{ session: string; value: string; caret: number } | undefined>(undefined);
  const voiceEnabled = data?.settings.voiceDictation !== false;
  const voice = useVoiceDictation({
    enabled: voiceEnabled,
    onError: setNotice,
    onText: (text) => {
      const target = dictationTargetRef.current;
      if (!target) return;
      const element = selectedSessionRef.current === target ? composerRef.current : null;
      if (!element) {
        // Another conversation is open: append to the recording's own draft.
        setDrafts((current) => {
          const value = current[target] || '';
          return { ...current, [target]: insertDictation(value, value.length, value.length, text).value };
        });
        return;
      }
      // The open composer mirrors its draft, so its value and selection are current.
      const next = insertDictation(element.value, element.selectionStart, element.selectionEnd, text);
      dictationCaretRef.current = { session: target, value: next.value, caret: next.caret };
      setDrafts((current) => ({ ...current, [target]: next.value }));
    },
  });
  // Once the dictated draft is rendered: focus with the caret right after the inserted text.
  useLayoutEffect(() => {
    const pending = dictationCaretRef.current;
    const element = composerRef.current;
    if (!pending || !element || pending.session !== selectedSession || element.value !== pending.value) return;
    dictationCaretRef.current = undefined;
    if (element.disabled) return;
    element.focus();
    element.setSelectionRange(pending.caret, pending.caret);
  }, [composer, selectedSession, composerRef]);

  const palette = useCommandPalette({
    projectId: session?.projectId,
    state: {
      page,
      session,
      running: busy || Boolean(session?.activeRunId),
      sessions: data?.sessions || [],
      projects: data?.projects || [],
      providers: data?.providers || [],
      sidebarCollapsed,
      isMac: newConversationShortcut().startsWith('⌘'),
    },
    callbacks: {
      newConversation: () => void newConversation(),
      search: () => setSearchOpen(true),
      goTo: (next) => goTo(next),
      toggleSidebar: () =>
        window.matchMedia?.('(max-width: 820px)').matches
          ? setSidebarOpen((open) => !open)
          : setSidebarCollapsed((collapsed) => !collapsed),
      exportConversation: downloadExport,
      openConversation: (id) => openConversation(id),
      openProject: (id) => {
        selectProject(id);
        selectSession(latestSession(id)?.id || '');
        setPage('chat');
        setSidebarOpen(false);
      },
      setModel: (providerId, model) =>
        void changeSession(
          providerId === session?.providerId ? { model: model || null } : { providerId, model: model || null },
        ),
      setMode: (mode) => void changeSession({ mode }),
      insertCommand: (name) => {
        if (!session) return;
        const value = `/${name} `;
        setDrafts((current) => ({ ...current, [session.id]: value }));
        setPage('chat');
        setSidebarOpen(false);
        // After the draft and page render: caret at the end, ready for the arguments.
        window.setTimeout(() => {
          const element = composerRef.current;
          if (!element || element.disabled) return;
          element.focus();
          element.setSelectionRange(value.length, value.length);
        });
      },
    },
  });

  useEffect(() => {
    if (!focusComposerRef.current || page !== 'chat') return;
    // Keep the pending composer focus until the topmost dialog closes. In particular,
    // creating a conversation can resolve after the search dialog has already opened.
    if (searchOpen || helpOpen || projectForm || handoff || palette.open) return;
    const element = composerRef.current;
    if (!element || element.disabled) return;
    focusComposerRef.current = false;
    element.focus();
  }, [
    selectedSession,
    page,
    currentDetail?.session.id,
    composerRef,
    searchOpen,
    helpOpen,
    projectForm,
    handoff,
    palette.open,
    sessionCreationPending,
  ]);

  useGlobalShortcuts({
    newConversation: () => void newConversation(),
    search: () => setSearchOpen(true),
    palette: () => {
      // One dialog at a time: the palette replaces search and help.
      setSearchOpen(false);
      setHelpOpen(false);
      palette.toggle();
    },
    dismiss: () => {
      if (palette.open) palette.close();
      setSearchOpen(false);
      setProjectForm(false);
      setProjectSetupPaused(false);
      setSettingsSearchRequest(undefined);
      setHelpOpen(false);
      setSidebarOpen(false);
    },
  });

  async function createProject(fields: NewProject) {
    setBusy(true);
    setNotice('');
    try {
      const created = await api.createProject(fields);
      invalidateBootstrapRefreshes();
      setProjectForm(false);
      setProjectSetupPaused(false);
      setSettingsSearchRequest(undefined);
      await refreshBootstrap(false);
      selectProject(created.id);
      selectSession('');
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function newConversation(projectId: string | null = null) {
    if (!data || busy) return;
    const remoteProject = projectId ? data.projects.find((item) => item.id === projectId)?.remote : undefined;
    const providerId = remoteProject
      ? providerForRemoteProject(data.settings.defaultProviderId, data.providers)
      : data.settings.defaultProviderId;
    if (!providerId) {
      setNotice(t('remoteHosts.providerRequired'));
      return;
    }
    setBusy(true);
    setSessionCreationPending(true);
    setNotice('');
    try {
      const created = await api.createSession({
        projectId,
        providerId,
        mode: data.settings.defaultMode,
      });
      invalidateBootstrapRefreshes();
      setData((current) => (current ? { ...current, sessions: [created, ...current.sessions] } : current));
      focusComposerRef.current = true;
      selectProject(created.projectId || '');
      selectSession(created.id);
      setPage('chat');
      setSidebarOpen(false);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setSessionCreationPending(false);
      setBusy(false);
    }
  }

  async function startSuggestedPrompt(text: string) {
    if (!data || busy || settingsPendingRef.current) return;
    setBusy(true);
    setSessionCreationPending(true);
    setNotice('');
    try {
      const created = await api.createSession({
        projectId: null,
        providerId: data.settings.defaultProviderId,
        mode: data.settings.defaultMode,
        title: text.trim().split(/\s+/).slice(0, 6).join(' '),
      });
      invalidateBootstrapRefreshes();
      setData((current) => (current ? { ...current, sessions: [created, ...current.sessions] } : current));
      selectProject('');
      selectSession(created.id);
      setPage('chat');
      setSidebarOpen(false);
      await api.send(created.id, text, uuid());
      await refreshDetail(created.id);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setSessionCreationPending(false);
      setBusy(false);
    }
  }

  /** Shows the limit notice for the open conversation with its "Continuar mesmo assim" action. */
  function blockedByLimit(error: ApiError, retry: () => Promise<unknown>) {
    const sessionId = selectedSessionRef.current;
    setNotice('');
    setLimitBlock({ sessionId, message: error.message, retry });
    void usage.reload();
  }
  async function continueDespiteLimit() {
    const block = limitBlock;
    if (!block || limitRetrying) return;
    setLimitRetrying(true);
    setLimitBlock(null);
    try {
      await block.retry();
    } finally {
      setLimitRetrying(false);
    }
  }

  /** `explicit` resends given attachments (retry, suggestions) instead of the composer's. */
  async function sendMessage(value = composer, explicit?: AttachmentMeta[], overrideLimit = false) {
    const content = value.trim();
    if (!content || !session || session.archivedAt || busy || session.activeRunId || settingsPendingRef.current) return;
    if (!explicit && attachments.uploading) return setNotice(t('app.waitUploads'));
    // `/compactar` alone is an action, not a turn: no bubble, just the summary card.
    if (compactCommand(content) === 'compact' && !(explicit ?? attachments.ready).length) {
      setDrafts((current) => ({ ...current, [session.id]: '' }));
      if (!(await compactConversation(overrideLimit)))
        setDrafts((current) => ({ ...current, [session.id]: current[session.id] || content }));
      return;
    }
    const sessionId = session.id;
    const sentAttachments = explicit ?? attachments.ready;
    const pendingSend: NonNullable<typeof pendingSendRef.current> = {
      sessionId,
      cancelRequested: false,
      accepted: false,
    };
    pendingSendRef.current = pendingSend;
    setPendingSendSession(sessionId);
    setDrafts((current) => ({ ...current, [sessionId]: '' }));
    setBusy(true);
    setNotice('');
    setLimitBlock(null);
    conversationScroll.stick();
    const optimistic: Message = {
      id: `local-${uuid()}`,
      sessionId,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
      ...(sentAttachments.length ? { attachments: sentAttachments } : {}),
    };
    setDetail((current) =>
      current?.session.id === sessionId ? { ...current, messages: [...current.messages, optimistic] } : current,
    );
    let accepted = false;
    try {
      const acceptedRun = await api.send(
        sessionId,
        content,
        uuid(),
        sentAttachments.map((item) => item.id),
        overrideLimit,
      );
      accepted = true;
      if (!explicit) attachments.clear(sessionId);
      pendingSend.accepted = true;
      setDetail((current) =>
        current?.session.id === sessionId
          ? {
              ...current,
              session: { ...current.session, activeRunId: acceptedRun.runId },
              messages: [
                ...current.messages.filter(
                  (message) => message.id !== optimistic.id && message.id !== acceptedRun.messageId,
                ),
                {
                  ...optimistic,
                  id: acceptedRun.messageId,
                  runId: acceptedRun.runId,
                  status: 'running',
                  providerId: session.providerId,
                },
              ],
            }
          : current,
      );
      setData((current) =>
        current
          ? {
              ...current,
              sessions: current.sessions.map((item) =>
                item.id === sessionId ? { ...item, activeRunId: acceptedRun.runId } : item,
              ),
            }
          : current,
      );
      if (pendingSend.cancelRequested) {
        if (pendingSend.cancelPromise) await pendingSend.cancelPromise.catch(() => undefined);
        if (!pendingSend.cancelSucceeded) {
          try {
            await api.cancel(sessionId);
          } catch (error) {
            if (selectedSessionRef.current === sessionId) setNotice((error as Error).message);
          }
        }
      }
      try {
        await refreshDetail(sessionId);
      } catch {
        if (selectedSessionRef.current === sessionId) setNotice(t('app.reconnecting'));
      }
    } catch (error) {
      if (!accepted) {
        setDetail((current) =>
          current?.session.id === sessionId
            ? { ...current, messages: current.messages.filter((message) => message.id !== optimistic.id) }
            : current,
        );
        if (selectedSessionRef.current === sessionId && isLimitError(error)) {
          // The text leaves the composer only once "Continuar mesmo assim" sends it.
          setDrafts((current) => ({ ...current, [sessionId]: current[sessionId] || content }));
          blockedByLimit(error, async () => {
            setDrafts((current) => (current[sessionId] === content ? { ...current, [sessionId]: '' } : current));
            await sendMessage(content, sentAttachments, true);
          });
        } else {
          setDrafts((current) => ({
            ...current,
            [sessionId]: current[sessionId] ? `${content}\n${current[sessionId]}` : content,
          }));
          if (selectedSessionRef.current === sessionId) setNotice((error as Error).message);
        }
      }
    } finally {
      if (pendingSendRef.current === pendingSend) {
        pendingSendRef.current = null;
        setPendingSendSession('');
      }
      setBusy(false);
    }
  }

  /** "Compactar conversa" (docs/specs/compaction.md); true when the server accepted it. */
  async function compactConversation(overrideLimit = false) {
    if (!session || busy || session.activeRunId) return false;
    const sessionId = session.id;
    setBusy(true);
    setNotice('');
    setLimitBlock(null);
    conversationScroll.stick();
    try {
      const { runId } = await api.compact(sessionId, overrideLimit);
      setDetail((current) =>
        current?.session.id === sessionId
          ? { ...current, session: { ...current.session, activeRunId: runId } }
          : current,
      );
      await refreshDetail(sessionId).catch(() => undefined);
      return true;
    } catch (error) {
      if (selectedSessionRef.current === sessionId) {
        if (isLimitError(error)) blockedByLimit(error, () => compactConversation(true));
        else setNotice((error as Error).message);
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Enter while the agent works: the message waits on the server and starts on its own. */
  async function queueMessage() {
    const content = composer.trim();
    if (!content || !session || session.archivedAt) return;
    if (attachments.uploading) return setNotice(t('app.waitUploads'));
    const sessionId = session.id;
    setDrafts((current) => ({ ...current, [sessionId]: '' }));
    setNotice('');
    const result = await messageQueue.add(
      content,
      attachments.ready.map((item) => item.id),
    );
    if (result) attachments.clear(sessionId);
    else
      setDrafts((current) => ({
        ...current,
        [sessionId]: current[sessionId] ? `${content}\n${current[sessionId]}` : content,
      }));
  }

  /** Add the draft to the queue, then deliver it to runtimes that accept in-turn steering. */
  async function steerComposer() {
    const content = composer.trim();
    if (
      !content ||
      !session ||
      session.archivedAt ||
      !session.activeRunId ||
      !provider?.capabilities.steer ||
      attachments.uploading
    )
      return;
    const sessionId = session.id;
    setDrafts((current) => ({ ...current, [sessionId]: '' }));
    setNotice('');
    const result = await messageQueue.add(content);
    if (!result) {
      setDrafts((current) => ({
        ...current,
        [sessionId]: current[sessionId] ? `${content}\n${current[sessionId]}` : content,
      }));
      return;
    }
    attachments.clear(sessionId);
    // The queue insertion is bound to the captured session, but the hook's next call targets
    // whichever conversation is selected then. Leave the item queued if navigation changed.
    if (result.item && selectedSessionRef.current === sessionId) await messageQueue.steer(result.item.id);
  }

  async function cancelPendingSend(sessionId: string) {
    const pending = pendingSendRef.current;
    if (!pending || pending.sessionId !== sessionId || session?.id !== sessionId) return;
    pending.cancelRequested = true;
    pending.cancelPromise = api.cancel(sessionId);
    try {
      await pending.cancelPromise;
      pending.cancelSucceeded = true;
    } catch (error) {
      pending.cancelError = error as Error;
      if (pending.accepted && selectedSessionRef.current === sessionId) setNotice(pending.cancelError.message);
    }
  }

  /** "Tentar com outro modelo": the server switches the conversation and starts the new run. */
  async function retryWithModel(
    runId: string,
    target: { providerId?: string; model?: string } = {},
    overrideLimit = false,
  ) {
    if (!session || busy || session.activeRunId) return;
    const sessionId = session.id;
    setBusy(true);
    setNotice('');
    setLimitBlock(null);
    conversationScroll.stick();
    try {
      const started = await api.retryRun(runId, target, overrideLimit);
      invalidateBootstrapRefreshes();
      const updated = { ...started.session, activeRunId: started.session.activeRunId ?? started.runId };
      setDetail((current) => (current?.session.id === sessionId ? { ...current, session: updated } : current));
      setData((current) =>
        current
          ? { ...current, sessions: current.sessions.map((item) => (item.id === sessionId ? updated : item)) }
          : current,
      );
      await refreshDetail(sessionId);
    } catch (error) {
      if (selectedSessionRef.current === sessionId) {
        if (isLimitError(error)) blockedByLimit(error, () => retryWithModel(runId, target, true));
        else setNotice((error as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function changeSession(
    patch: Partial<Pick<Session, 'providerId' | 'mode' | 'projectId' | 'folderId' | 'thinking' | 'planFirst'>> & {
      model?: string | null;
      approvalMode?: ApprovalMode | null;
    },
  ) {
    if (!session || busy || session.activeRunId) return;
    const sessionId = session.id;
    setBusy(true);
    setNotice('');
    const targetProviderId = patch.providerId || session.providerId;
    const targetProvider = data?.providers.find((item) => item.id === targetProviderId);
    const modelWasChanged = Object.hasOwn(patch, 'model');
    const providerWasChanged = targetProviderId !== session.providerId;
    const targetModel = modelWasChanged
      ? patch.model || undefined
      : providerWasChanged
        ? targetProvider?.defaultModel
        : session.model || targetProvider?.defaultModel;
    const writePatch = { ...patch };
    const thinkingWasReset =
      (providerWasChanged || modelWasChanged) &&
      Boolean(session.thinking && !supportedThinking(targetProvider, targetModel).includes(session.thinking));
    if (providerWasChanged && !modelWasChanged) writePatch.model = null;
    if (Object.hasOwn(patch, 'thinking') || providerWasChanged || modelWasChanged) {
      writePatch.thinking = compatibleThinking(patch.thinking || session.thinking, targetProvider, targetModel);
    }
    const request = (sessionWriteRef.current.get(sessionId) || Promise.resolve()).then(() =>
      api.updateSession(sessionId, writePatch),
    );
    const settled = request.then(
      () => undefined,
      () => undefined,
    );
    sessionWriteRef.current.set(sessionId, settled);
    try {
      const updated = await request;
      invalidateBootstrapRefreshes();
      setDetail((current) =>
        current?.session.id === sessionId && selectedSessionRef.current === sessionId
          ? { ...current, session: { ...updated, activeRunId: current.session.activeRunId ?? updated.activeRunId } }
          : current,
      );
      setData((current) =>
        current
          ? {
              ...current,
              sessions: current.sessions.map((s) =>
                s.id === sessionId ? { ...updated, activeRunId: s.activeRunId ?? updated.activeRunId } : s,
              ),
            }
          : current,
      );
      if (selectedSessionRef.current === sessionId && Object.hasOwn(patch, 'projectId'))
        selectProject(updated.projectId || '');
      if (thinkingWasReset && selectedSessionRef.current === sessionId) setNotice(t('app.thinkingAdjusted'));
    } catch (error) {
      if (selectedSessionRef.current === sessionId) setNotice((error as Error).message);
    } finally {
      if (sessionWriteRef.current.get(sessionId) === settled) sessionWriteRef.current.delete(sessionId);
      setBusy(false);
    }
  }

  function applySession(updated: Session) {
    setDetail((current) =>
      current?.session.id === updated.id
        ? { ...current, session: { ...updated, activeRunId: updated.activeRunId ?? current.session.activeRunId } }
        : current,
    );
    setData((current) =>
      current
        ? {
            ...current,
            sessions: current.sessions.map((s) =>
              s.id === updated.id ? { ...updated, activeRunId: updated.activeRunId ?? s.activeRunId } : s,
            ),
          }
        : current,
    );
  }

  async function updateSidebarConversation(id: string, patch: SessionSidebarPatch) {
    if (busy) throw new Error(t('sidebarActions.busy'));
    setBusy(true);
    setNotice('');
    try {
      const updated = await api.updateSession(id, patch);
      invalidateBootstrapRefreshes();
      applySession(updated);
      if (selectedSessionRef.current === id) {
        if (Object.hasOwn(patch, 'projectId')) selectProject(updated.projectId || '');
        await refreshDetail(id);
      }
    } catch (error) {
      setNotice((error as Error).message);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function setConversationArchived(archived: boolean) {
    if (!session || busy || session.activeRunId || Boolean(session.archivedAt) === archived) return;
    setBusy(true);
    setNotice('');
    try {
      const updated = await api.updateSession(session.id, { archived });
      invalidateBootstrapRefreshes();
      applySession(updated);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createProjectFolder(projectId: string, name: string, parentId: string | null): Promise<ProjectFolder> {
    try {
      const folder = await api.createProjectFolder(projectId, { name, parentId });
      setData((current) =>
        current ? { ...current, projectFolders: [...(current.projectFolders || []), folder] } : current,
      );
      setNotice('');
      return folder;
    } catch (error) {
      setNotice((error as Error).message);
      throw error;
    }
  }

  async function renameProjectFolder(id: string, name: string) {
    try {
      const folder = await api.renameProjectFolder(id, { name });
      setData((current) =>
        current
          ? {
              ...current,
              projectFolders: (current.projectFolders || []).map((item) => (item.id === id ? folder : item)),
            }
          : current,
      );
      setNotice('');
    } catch (error) {
      setNotice((error as Error).message);
      throw error;
    }
  }

  async function deleteProjectFolder(id: string) {
    try {
      await api.deleteProjectFolder(id);
      await refreshBootstrap();
      if (selectedSessionRef.current) await refreshDetail(selectedSessionRef.current);
      setNotice('');
    } catch (error) {
      setNotice((error as Error).message);
      throw error;
    }
  }

  /** Opens the handoff dialog; `target` comes from the model menu (a different provider). */
  function openHandoff(target?: HandoffTarget) {
    if (!session || busy || session.activeRunId) return;
    setHandoffError('');
    setHandoffLimited(false);
    setHandoff({ sessionId: session.id, ...(target ? { target } : {}) });
  }

  async function confirmHandoff(target: HandoffTarget, summary: HandoffSummaryMode, overrideLimit = false) {
    if (!handoff) return;
    const sessionId = handoff.sessionId;
    setHandoffBusy(true);
    setBusy(true);
    setHandoffError('');
    setHandoffLimited(false);
    try {
      const result = await api.handoff(sessionId, { ...target, summary }, overrideLimit);
      invalidateBootstrapRefreshes();
      applySession(result.session);
      const added = result.message;
      if (added)
        setDetail((current) =>
          current?.session.id === sessionId && !current.messages.some((m) => m.id === added.id)
            ? { ...current, messages: [...current.messages, added] }
            : current,
        );
      setHandoff(null);
      if (added?.handoff?.fallback && selectedSessionRef.current === sessionId)
        setNotice(t('app.localSummary', { reason: added.handoff.fallback }));
      focusComposerRef.current = true;
    } catch (error) {
      setHandoffError((error as Error).message);
      setHandoffLimited(isLimitError(error));
    } finally {
      setHandoffBusy(false);
      setBusy(false);
    }
  }

  async function changeProjectOrchestration(projectId: string, patch: Partial<OrchestrationConfig>) {
    const previous = projectWriteRef.current.get(projectId) || Promise.resolve();
    const request = previous.then(async () => {
      const current = projectSnapshotRef.current?.projects.find((item) => item.id === projectId);
      if (!current) throw new Error(t('app.projectNotFound'));
      const orchestration = { ...projectOrchestration(current), ...patch };
      const updated = await api.updateProject(projectId, { orchestration });
      const snapshot = projectSnapshotRef.current;
      if (snapshot) {
        const next = {
          ...snapshot,
          projects: snapshot.projects.map((item) => (item.id === projectId ? updated : item)),
        };
        projectSnapshotRef.current = next;
        setData(next);
      }
      if (selectedProjectRef.current === projectId) void refreshProjectViews(projectId);
    });
    const settled = request.then(
      () => undefined,
      () => undefined,
    );
    projectWriteRef.current.set(projectId, settled);
    try {
      await request;
    } catch (error) {
      if (selectedProjectRef.current === projectId) setNotice((error as Error).message);
    } finally {
      if (projectWriteRef.current.get(projectId) === settled) projectWriteRef.current.delete(projectId);
    }
  }

  async function changeProjectApprovalMode(projectId: string, approvalMode: ApprovalMode | null) {
    try {
      const updated = await api.updateProject(projectId, { approvalMode });
      const snapshot = projectSnapshotRef.current;
      if (snapshot) {
        const next = {
          ...snapshot,
          projects: snapshot.projects.map((item) => (item.id === projectId ? updated : item)),
        };
        projectSnapshotRef.current = next;
        setData(next);
      }
    } catch (error) {
      if (selectedProjectRef.current === projectId) setNotice((error as Error).message);
    }
  }

  async function changeGraphifyEnabled(projectId: string, enabled: boolean) {
    const action = ++graphActionRef.current;
    setProjectBusy(true);
    setNotice('');
    try {
      const updated = await api.updateProject(projectId, { graphify: { enabled } });
      if (selectedProjectRef.current === projectId && graphActionRef.current === action) {
        setData((snapshot) =>
          snapshot
            ? { ...snapshot, projects: snapshot.projects.map((item) => (item.id === projectId ? updated : item)) }
            : snapshot,
        );
        await refreshProjectViews(projectId);
      }
    } catch (error) {
      if (selectedProjectRef.current === projectId && graphActionRef.current === action)
        setNotice((error as Error).message);
    } finally {
      if (graphActionRef.current === action) setProjectBusy(false);
    }
  }

  async function changeProjectMemoryScope(projectId: string, memoryWorkspace: string, memoryProject: string) {
    try {
      const updated = await api.updateProject(projectId, { memoryWorkspace, memoryProject });
      setData((current) =>
        current
          ? { ...current, projects: current.projects.map((item) => (item.id === projectId ? updated : item)) }
          : current,
      );
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function indexProject(projectId: string) {
    const action = ++graphActionRef.current;
    setProjectBusy(true);
    setNotice('');
    try {
      const status = await api.indexGraphify(projectId);
      if (selectedProjectRef.current === projectId && graphActionRef.current === action) setGraphifyStatus(status);
    } catch (error) {
      if (selectedProjectRef.current === projectId && graphActionRef.current === action) {
        setNotice((error as Error).message);
        void refreshProjectViews(projectId);
      }
    } finally {
      if (graphActionRef.current === action) setProjectBusy(false);
    }
  }

  async function queryProjectGraph(event: FormEvent) {
    event.preventDefault();
    if (!project || !projectQuery.trim()) return;
    const projectId = project.id;
    const action = ++graphActionRef.current;
    setProjectBusy(true);
    setNotice('');
    setGraphQueryResult(null);
    try {
      const result = await api.queryGraphify(projectId, projectQuery.trim());
      if (selectedProjectRef.current === projectId && graphActionRef.current === action) {
        setGraphQueryResult(result);
        setGraphifyStatus(result.status);
      }
    } catch (error) {
      if (selectedProjectRef.current === projectId && graphActionRef.current === action)
        setNotice((error as Error).message);
    } finally {
      if (graphActionRef.current === action) setProjectBusy(false);
    }
  }

  async function updateSetting(
    key:
      | 'defaultProviderId'
      | 'defaultMode'
      | 'memoryEnabled'
      | 'sandbox'
      | 'responseStyle'
      | 'approvalMode'
      | 'updateCheck'
      | 'updateChannel'
      | 'autoRetry'
      | 'notifications'
      | 'autoCompact'
      | 'autoCompactTokens'
      | 'voiceDictation'
      | 'terminalRemote'
      | 'internetManualApproval'
      | 'automations'
      | 'language',
    value: string | boolean | number,
  ) {
    if (!data) return;
    if (key === 'sandbox' || key === 'approvalMode') {
      const current = permissionTargetRef.current || {
        sandbox: data.settings.sandbox,
        approvalMode: data.settings.approvalMode || 'auto-safe',
      };
      void updatePermissions(
        key === 'sandbox' ? (value as 'read-only' | 'workspace-write') : current.sandbox,
        key === 'approvalMode' ? (value as ApprovalMode) : current.approvalMode,
      );
      return;
    }
    await enqueueSettingsPatch({ [key]: value } as never);
  }

  async function updatePermissions(sandbox: 'read-only' | 'workspace-write', approvalMode: ApprovalMode) {
    if (!data) return;
    permissionTargetRef.current = { sandbox, approvalMode };
    await enqueueSettingsPatch({ sandbox, approvalMode });
  }

  async function changeSpendLimits(patch: SpendLimitsPatch) {
    await enqueueSettingsPatch({ spendLimits: patch });
  }

  async function changeProjectSpendLimits(
    projectId: string,
    patch: { monthlyTokens?: number | null; monthlyCostUsd?: number | null },
  ) {
    try {
      const updated = await api.updateProject(projectId, { spendLimits: patch });
      setData((current) =>
        current
          ? { ...current, projects: current.projects.map((item) => (item.id === projectId ? updated : item)) }
          : current,
      );
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function enqueueSettingsPatch(patch: Parameters<typeof api.settings>[0]) {
    settingsPendingRef.current++;
    setSettingsPending(true);
    invalidateBootstrapRefreshes();
    const request = settingsWriteRef.current.then(() => api.settings(patch));
    settingsWriteRef.current = request.then(
      () => undefined,
      () => undefined,
    );
    try {
      const settings = await request;
      setData((current) => (current ? { ...current, settings } : current));
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      invalidateBootstrapRefreshes();
      settingsPendingRef.current = Math.max(0, settingsPendingRef.current - 1);
      if (!settingsPendingRef.current) {
        permissionTargetRef.current = null;
        setSettingsPending(false);
      }
    }
  }

  // From the internet the server runs everything with manual approval unless the computer turned
  // that off (server/http/auth.ts forceManualApproval); the composer shows the effective mode.
  const internetForcesManual = accessKind === 'internet' && data?.settings.internetManualApproval !== false;
  const inheritedApprovalMode: ApprovalMode =
    project?.remote && data?.settings.approvalMode === 'automatic'
      ? 'manual'
      : data?.settings.approvalMode || 'auto-safe';
  const configuredApprovalMode = session?.approvalMode ?? project?.approvalMode;
  const effectiveApprovalMode: ApprovalMode = internetForcesManual
    ? 'manual'
    : project?.remote
      ? configuredApprovalMode === 'automatic'
        ? 'automatic'
        : 'manual'
      : (configuredApprovalMode ?? inheritedApprovalMode);
  const localApprovalControls = accessKind === 'local';
  const supportsAutomaticApproval =
    (provider?.id === 'codex' || provider?.id === 'kiro') && provider.capabilities.tools;
  // Settings.language is the source of truth; localStorage mirrors it for the login screen.
  const serverLanguage = data?.settings.language;
  const hasData = Boolean(data);
  useEffect(() => {
    if (hasData) setLanguagePreference((serverLanguage ?? 'auto') as LanguagePreference);
  }, [hasData, serverLanguage]);
  const shortcut = newConversationShortcut();
  const memoryIntegration = data?.integrations.find((item) => item.kind === 'memory');
  const memoryStatus =
    memoryIntegration?.status === 'ready'
      ? t('sidebar.memory.ready')
      : memoryIntegration?.status === 'planned'
        ? t('sidebar.memory.checking')
        : t('sidebar.memory.unavailable');
  const detachedList = sidebarSessions(
    detachedSessions,
    SIDEBAR_LIMIT,
    Boolean(expandedLists.detached),
    selectedSession,
  );
  const projectList = sidebarSessions(
    projectSessions,
    SIDEBAR_LIMIT,
    Boolean(expandedLists[selectedProject]),
    selectedSession,
  );
  const latestSession = (projectId: string) =>
    sidebarSessions(
      (data?.sessions || []).filter((item) => item.projectId === projectId && !item.archivedAt),
      1,
      false,
      '',
    ).items[0];
  const goTo = (next: Page) => {
    if (next === 'memory') setMemoryVisited(true);
    setPage(next);
    setSidebarOpen(false);
  };
  const openConversation = (id: string) => {
    selectConversation(id);
    setPage('chat');
    setSidebarOpen(false);
  };
  const toggleList = (key: string, expanded: boolean) =>
    setExpandedLists((current) => ({ ...current, [key]: expanded }));
  // Detached conversations search the scope chosen in Settings › Memória, when memory is on.
  const detachedMemoryScope =
    data?.settings.memoryEnabled && data.settings.detachedMemory
      ? `${data.settings.detachedMemory.workspace}/${data.settings.detachedMemory.project}`
      : undefined;
  const conversationContext = conversationProject
    ? conversationProject.remote || conversationProject.orchestration?.enabled === false
      ? t('composer.context.direct')
      : t('composer.context.orchestrated', { agent: provider?.name || t('composer.context.agentFallback') })
    : detachedMemoryScope
      ? t('memorySettings.composer.context', { scope: detachedMemoryScope })
      : t('composer.context.detached');
  // The conversation's project, or the selected project on the start screen; detached
  // conversations have no project folder for the terminal.
  const toolsProject = page === 'chat' ? (session ? conversationProject : project) : undefined;
  const pageTitle =
    page === 'chat'
      ? session
        ? conversationProject?.name || t('shell.crumb.detached')
        : project?.name || t('shell.crumb.conversations')
      : page === 'activity'
        ? t('sidebar.activity')
        : page === 'automations'
          ? t('sidebar.automations')
          : page === 'memory'
            ? t('sidebar.memory')
            : page === 'git'
              ? t('app.crumb.git', { project: project?.name ?? '' })
              : t('sidebar.settings');

  /** One message of the conversation, with its retry notice and activity panel. */
  function renderTimelineMessage(message: Message) {
    if (!data || !session) return null;
    const timelineRun = currentDetail?.runs.find((run) => run.id === message.runId);
    const sameProjectRoot = Boolean(conversationProject && timelineRun?.artifactRoot === conversationProject.path);
    return (
      <div className="timeline-message" key={message.id}>
        <MessageCard
          message={message}
          providerName={
            data.providers.find((p) => p.id === (message.providerId || session.providerId))?.name || 'Adelic'
          }
          body={(() => {
            const plan = message.role === 'assistant' && plans.plans.find((p) => p.runId === message.runId);
            return plan ? (
              <PlanCard
                plan={plan}
                api={plans}
                busy={Boolean(session.activeRunId)}
                canSave={session.projectId !== null}
              />
            ) : undefined;
          })()}
          actions={
            message.id.startsWith('local-') ? undefined : (
              <MessageEditActions
                message={message}
                disabledReason={editBranch.disabledReason}
                onEdit={() => editBranch.startEditing(message.id)}
                onBranch={() => void editBranch.branch(message)}
              />
            )
          }
          editor={
            editBranch.editingId === message.id ? (
              <MessageEditor
                message={message}
                laterCount={editBranch.laterCount(message.id)}
                disabledReason={editBranch.disabledReason}
                onCancel={editBranch.cancelEditing}
                onSave={(content, kept) => editBranch.save(message, content, kept)}
              />
            ) : undefined
          }
        />
        {message.role === 'assistant' && message.status === 'failed' && message.id === lastFailedMessageId && (
          <RetryNotice
            run={currentDetail?.runs.find((run) => run.id === message.runId)}
            disabled={busy || Boolean(session.activeRunId)}
            onRetry={() => message.runId && void retryWithModel(message.runId)}
            alternatives={retryAlternatives(
              data.providers,
              currentDetail?.runs.find((run) => run.id === message.runId),
            )}
            onSwitch={(target) => message.runId && void retryWithModel(message.runId, target)}
          />
        )}
        {message.role === 'user' && message.runId && (
          <RunActivityPanel
            runId={message.runId}
            run={currentDetail?.runs.find((run) => run.id === message.runId)}
            tasks={activityTasks}
            events={activityEvents}
            approvals={currentDetail?.approvals.filter((approval) => approval.runId === message.runId) || []}
            streamUpdatedAt={stream?.runId === message.runId ? stream.updatedAt : undefined}
            eventsConnected={eventsConnected}
            providers={data.providers}
            active={session.activeRunId === message.runId}
            taskOutputs={taskOutputs.outputs}
            loadingTaskOutputs={taskOutputs.loading}
            onLoadTaskOutput={taskOutputs.load}
            onRecoveryRefresh={() => refreshDetail(selectedSession)}
            busy={Boolean(session.activeRunId)}
            onOpenTerminal={sameProjectRoot ? () => setToolsTab('terminal') : undefined}
            onOpenPreview={sameProjectRoot ? () => setToolsTab('preview') : undefined}
            onOpenProject={() =>
              setNotice(
                currentDetail?.runs.find((run) => run.id === message.runId)?.artifactRoot ||
                  conversationProject?.path ||
                  '',
              )
            }
            onInitializeGit={
              conversationProject && sameProjectRoot && !session.activeRunId && !conversationProject.remote
                ? async () => {
                    try {
                      await api.initProjectGit(conversationProject.id);
                      setNotice(t('delivery.gitInitialized'));
                      await refreshDetail(session.id);
                    } catch (e) {
                      setNotice((e as Error).message);
                      throw e;
                    }
                  }
                : undefined
            }
          />
        )}
      </div>
    );
  }

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className={`sidebar ${sidebarOpen ? 'sidebar-mobile-open' : ''}`} aria-label={t('sidebar.label')}>
        <div className="sidebar-header">
          <div className="brand">
            <BrandMark />
            <span className="brand-name">adelic</span>
          </div>
          <button
            className="icon-button sidebar-collapse"
            aria-label={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
            title={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
            aria-expanded={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
          <button
            className="icon-button sidebar-close"
            aria-label={t('sidebar.close')}
            title={t('sidebar.close')}
            onClick={() => setSidebarOpen(false)}
          >
            <X size={16} />
          </button>
        </div>
        <button
          className="new-chat-button"
          title={t('sidebar.newTitle', { shortcut })}
          onClick={() => void newConversation()}
          disabled={busy || !data}
        >
          <Plus size={16} />
          <span className="sidebar-label">{t('sidebar.new')}</span>
          <kbd>{shortcut}</kbd>
        </button>
        <button
          className="nav-item sidebar-search"
          title={t('sidebar.searchTitle')}
          onClick={() => setSearchOpen(true)}
        >
          <Search size={16} aria-hidden="true" />
          <span className="sidebar-label">{t('sidebar.search')}</span>
        </button>
        <div className="sidebar-scroll">
          <section className="sidebar-section sidebar-detached" aria-labelledby="sidebar-detached-title">
            <div className="sidebar-section-heading">
              <h2 id="sidebar-detached-title" className="sidebar-label">
                {t('sidebar.detached')}
              </h2>
            </div>
            <div className="session-list detached-conversations">
              {detachedList.items.map((itemSession) => (
                <SessionItem
                  key={itemSession.id}
                  session={itemSession}
                  selected={itemSession.id === selectedSession}
                  now={now}
                  projects={data?.projects || []}
                  folders={data?.projectFolders || []}
                  disabled={busy}
                  onUpdate={(patch) => updateSidebarConversation(itemSession.id, patch)}
                  onSelect={() => openConversation(itemSession.id)}
                />
              ))}
              {detachedList.hidden > 0 && (
                <button type="button" className="sidebar-more" onClick={() => toggleList('detached', true)}>
                  {t('sidebar.showMore', { count: detachedList.hidden })}
                </button>
              )}
              {expandedLists.detached && detachedSessions.length > SIDEBAR_LIMIT && (
                <button type="button" className="sidebar-more" onClick={() => toggleList('detached', false)}>
                  {t('sidebar.showLess')}
                </button>
              )}
              {detachedSessions.length === 0 && <p className="sidebar-empty">{t('sidebar.detachedEmpty')}</p>}
              {archivedDetachedSessions.length > 0 && (
                <>
                  <button
                    type="button"
                    className="sidebar-archive-toggle"
                    aria-expanded={Boolean(showArchivedLists.detached)}
                    onClick={() => setShowArchivedLists((current) => ({ ...current, detached: !current.detached }))}
                  >
                    <Archive size={13} aria-hidden="true" />
                    {showArchivedLists.detached
                      ? t('sidebar.hideArchived')
                      : t('sidebar.showArchived', { count: archivedDetachedSessions.length })}
                  </button>
                  {showArchivedLists.detached &&
                    [...archivedDetachedSessions]
                      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                      .map((itemSession) => (
                        <SessionItem
                          key={itemSession.id}
                          session={itemSession}
                          selected={itemSession.id === selectedSession}
                          now={now}
                          projects={data?.projects || []}
                          folders={data?.projectFolders || []}
                          disabled={busy}
                          onUpdate={(patch) => updateSidebarConversation(itemSession.id, patch)}
                          onSelect={() => openConversation(itemSession.id)}
                        />
                      ))}
                </>
              )}
            </div>
          </section>
          <section className="sidebar-section sidebar-projects" aria-labelledby="sidebar-projects-title">
            <div className="sidebar-section-heading">
              <h2 id="sidebar-projects-title" className="sidebar-label">
                {t('sidebar.projects')}
              </h2>
              <button
                className="icon-button sidebar-add"
                aria-label={t('sidebar.addProject')}
                title={t('sidebar.addProject')}
                onClick={() => {
                  setProjectForm(true);
                  setProjectSetupPaused(false);
                  setNotice('');
                }}
              >
                <Plus size={15} />
              </button>
            </div>
            <div className="project-list">
              {data?.projects.map((item) => {
                const expanded = item.id === selectedProject;
                const archivedSessionsForProject = (data?.sessions || []).filter(
                  (session) => session.projectId === item.id && Boolean(session.archivedAt),
                );
                return (
                  <div key={item.id} className="project-group">
                    <div className={`project-row ${expanded ? 'selected' : ''}`}>
                      <button
                        className="project-item"
                        aria-expanded={expanded}
                        title={item.name}
                        onClick={() => {
                          const latest = latestSession(item.id);
                          selectProject(item.id);
                          selectSession(latest?.id || '');
                          setPage('chat');
                        }}
                      >
                        <Folder size={15} className="project-icon" aria-hidden="true" />
                        <span className="sidebar-project-copy">
                          <span className="sidebar-label">{item.name}</span>
                          {item.remote && (
                            <small>
                              {remoteHosts.find((host) => host.id === item.remote?.hostId)?.name ||
                                t('remoteHosts.remote')}{' '}
                              ·{' '}
                              {remoteHosts.find((host) => host.id === item.remote?.hostId)?.target ||
                                item.remote.hostId}{' '}
                              · {item.remote.path}
                            </small>
                          )}
                        </span>
                        <ChevronRight size={14} className="project-chevron" aria-hidden="true" />
                      </button>
                      <button
                        className="project-new-chat"
                        aria-label={t('sidebar.newIn', { project: item.name })}
                        title={t('sidebar.newIn', { project: item.name })}
                        disabled={busy || !data}
                        onClick={() => void newConversation(item.id)}
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                    {expanded && (
                      <div className="session-list">
                        <ProjectFolders
                          folders={(data?.projectFolders || []).filter((folder) => folder.projectId === item.id)}
                          sessions={projectList.items}
                          selectedSession={selectedSession}
                          now={now}
                          onSelect={openConversation}
                          onCreate={(name, parentId) => createProjectFolder(item.id, name, parentId)}
                          projects={data?.projects || []}
                          allFolders={data?.projectFolders || []}
                          onSessionUpdate={updateSidebarConversation}
                          onRename={renameProjectFolder}
                          onDelete={deleteProjectFolder}
                          disabled={busy}
                        />
                        {projectList.hidden > 0 && (
                          <button type="button" className="sidebar-more" onClick={() => toggleList(item.id, true)}>
                            {t('sidebar.showMore', { count: projectList.hidden })}
                          </button>
                        )}
                        {expandedLists[item.id] && projectSessions.length > SIDEBAR_LIMIT && (
                          <button type="button" className="sidebar-more" onClick={() => toggleList(item.id, false)}>
                            {t('sidebar.showLess')}
                          </button>
                        )}
                        {archivedSessionsForProject.length > 0 && (
                          <>
                            <button
                              type="button"
                              className="sidebar-archive-toggle"
                              aria-expanded={Boolean(showArchivedLists[item.id])}
                              onClick={() =>
                                setShowArchivedLists((current) => ({ ...current, [item.id]: !current[item.id] }))
                              }
                            >
                              <Archive size={13} aria-hidden="true" />
                              {showArchivedLists[item.id]
                                ? t('sidebar.hideArchived')
                                : t('sidebar.showArchived', { count: archivedSessionsForProject.length })}
                            </button>
                            {showArchivedLists[item.id] &&
                              [...archivedSessionsForProject]
                                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                                .map((itemSession) => (
                                  <SessionItem
                                    key={itemSession.id}
                                    session={itemSession}
                                    selected={itemSession.id === selectedSession}
                                    now={now}
                                    projects={data?.projects || []}
                                    folders={data?.projectFolders || []}
                                    disabled={busy}
                                    onUpdate={(patch) => updateSidebarConversation(itemSession.id, patch)}
                                    onSelect={() => openConversation(itemSession.id)}
                                  />
                                ))}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {data?.projects.length === 0 && <p className="sidebar-empty">{t('sidebar.projectsEmpty')}</p>}
            </div>
          </section>
        </div>
        <UpdateNotice enabled={data?.settings.updateCheck === true} />
        <SidebarNav
          page={page}
          goTo={goTo}
          memoryStatus={memoryStatus}
          memoryReady={memoryIntegration?.status === 'ready'}
        />
      </aside>
      {sidebarOpen && (
        <button className="mobile-scrim" aria-label={t('sidebar.close')} onClick={() => setSidebarOpen(false)} />
      )}

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button mobile-menu"
              aria-label={t('sidebar.open')}
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={18} />
            </button>
            <div className="breadcrumbs">
              <span className="crumb">{pageTitle}</span>
              {cwdProject?.remote && (
                <span className="remote-cwd-label" title={t('remoteHosts.cwdLabel')}>
                  <span>{cwdHost?.name || t('remoteHosts.remote')}</span>
                  <span>{cwdHost?.target || cwdProject.remote.hostId}</span>
                  {cwdProject.remote.path}
                </span>
              )}
              {page === 'chat' && session && (
                <>
                  <span className="crumb-separator" aria-hidden="true">
                    /
                  </span>
                  <strong title={session.title || t('app.untitled')}>{session.title || t('app.untitled')}</strong>
                  <BranchOrigin session={session} sessions={data?.sessions ?? []} onOpen={selectConversation} />
                </>
              )}
            </div>
          </div>
          <div className="topbar-right">
            {toolsProject && (
              <button
                type="button"
                className={`icon-button ${toolsTab ? 'active' : ''}`}
                aria-label={t('app.tools')}
                title={t('app.tools')}
                aria-pressed={Boolean(toolsTab)}
                onClick={() => setToolsTab((current) => (current ? null : 'terminal'))}
              >
                <SquareTerminal size={16} />
              </button>
            )}
            {page === 'chat' &&
              project &&
              (project.remote || projectIsGit) &&
              (!session || session.projectId === project.id) && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t('app.git', { project: project.name })}
                  title={t('app.gitTitle')}
                  onClick={() => goTo('git')}
                >
                  <GitBranch size={16} />
                </button>
              )}
            {page === 'chat' && session?.projectId && (
              <SessionFolderMenu
                folders={(data?.projectFolders || []).filter((folder) => folder.projectId === session.projectId)}
                folderId={session.folderId}
                disabled={busy || Boolean(session.activeRunId) || Boolean(session.archivedAt)}
                onMove={(folderId) => void changeSession({ folderId })}
              />
            )}
            {page === 'chat' && session && (
              <button
                type="button"
                className="icon-button"
                aria-label={session.archivedAt ? t('app.restoreConversation') : t('app.archiveConversation')}
                title={session.archivedAt ? t('app.restoreConversation') : t('app.archiveConversation')}
                disabled={busy || Boolean(session.activeRunId) || Boolean(messageQueue.queue?.items.length)}
                onClick={() => void setConversationArchived(!session.archivedAt)}
              >
                {session.archivedAt ? <ArchiveRestore size={16} /> : <Archive size={16} />}
              </button>
            )}
            {page === 'chat' && session && (
              <button
                type="button"
                className="icon-button"
                aria-label={t('app.handoff')}
                title={t('app.handoff')}
                disabled={busy || Boolean(session.activeRunId)}
                onClick={() => openHandoff()}
              >
                <ArrowRightLeft size={16} />
              </button>
            )}
            {page === 'chat' && session && (
              <ConversationActions
                disabled={busy || Boolean(session.activeRunId) || !messages.some((m) => m.content.trim())}
                onCompact={() => void compactConversation()}
              />
            )}
            {page === 'chat' && session && (
              <a
                className="icon-button"
                href={`/api/sessions/${encodeURIComponent(session.id)}/export`}
                download
                aria-label={t('app.export')}
                title={t('app.export')}
              >
                <Download size={16} />
              </a>
            )}
            <span
              className={`local-badge connection-${accessKind}`}
              title={t(`shell.connection.${accessKind}.title`)}
              data-kind={accessKind}
            >
              <span className={`status-dot connection-dot ${accessKind}`} aria-hidden="true" />
              {t(`shell.connection.${accessKind}`)}
            </span>
            <button
              className="icon-button help-button"
              aria-label={t('app.help')}
              title={t('app.help')}
              onClick={() => setHelpOpen(true)}
            >
              <CircleHelp size={17} />
            </button>
          </div>
        </header>

        {!data && (
          <div className="loading-screen">
            <LoaderCircle className="spin" size={22} />
            <span>{t('app.connecting')}</span>
            {notice && <p className="error-text">{notice}</p>}
          </div>
        )}
        {data && page === 'chat' && (
          <ErrorBoundary scope={t('app.scope.conversation')} resetKey={session?.id ?? 'welcome'}>
            {!session ? (
              <div className="welcome-view">
                <div className="welcome-orb" aria-hidden="true">
                  <Sparkles size={22} />
                </div>
                <h1>{t('app.welcome.title')}</h1>
                <p>{t('app.welcome.text')}</p>
                <button className="primary-button" onClick={() => void newConversation()} disabled={busy || !data}>
                  <Plus size={16} /> {t('app.welcome.start')}
                </button>
                <div className="welcome-suggestions">
                  {[t('app.welcome.suggestion1'), t('app.welcome.suggestion2'), t('app.welcome.suggestion3')].map(
                    (suggestion) => (
                      <button
                        key={suggestion}
                        onClick={() => void startSuggestedPrompt(suggestion)}
                        disabled={busy || !data}
                      >
                        <span>{suggestion}</span>
                        <ArrowUp size={14} aria-hidden="true" />
                      </button>
                    ),
                  )}
                </div>
              </div>
            ) : (
              <div className="chat-view">
                {!conversationProject?.remote && (
                  <WorktreePanel
                    session={session}
                    running={Boolean(session.activeRunId) || pendingSendForSession}
                    onSession={(next) => {
                      setDetail((current) =>
                        current?.session.id === next.id ? { ...current, session: next } : current,
                      );
                      setData((current) =>
                        current
                          ? { ...current, sessions: current.sessions.map((s) => (s.id === next.id ? next : s)) }
                          : current,
                      );
                    }}
                  />
                )}
                <section
                  className="conversation"
                  aria-label={t('app.conversation')}
                  ref={conversationScroll.ref}
                  onScroll={conversationScroll.onScroll}
                >
                  <div className="message-column">
                    {messages.length === 0 && !stream && (
                      <div className="conversation-empty">
                        <div className="empty-icon" aria-hidden="true">
                          <MessageSquare size={18} />
                        </div>
                        <h2>{t('app.empty.title')}</h2>
                        <p>
                          {conversationProject
                            ? tRich('app.empty.project', { project: <strong>{conversationProject.name}</strong> })
                            : t('app.empty.detached')}
                        </p>
                        <div className="prompt-chips">
                          {(conversationProject
                            ? [t('app.empty.projectPrompt1'), t('app.empty.projectPrompt2'), t('app.empty.prompt3')]
                            : [t('app.empty.detachedPrompt1'), t('app.empty.detachedPrompt2'), t('app.empty.prompt3')]
                          ).map((text) => (
                            <button key={text} onClick={() => void sendMessage(text, [])}>
                              <span>{text}</span>
                              <ArrowUp size={13} aria-hidden="true" />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {timelineSegments(
                      messages.filter((message) => message.id !== stream?.messageId),
                      currentDetail?.compactions,
                    ).map((segment) =>
                      segment.kind === 'messages' ? (
                        segment.messages.map(renderTimelineMessage)
                      ) : (
                        <div className="timeline-compaction" key={segment.compaction.id}>
                          {segment.earlier.length > 0 && (
                            <details className="compacted-messages">
                              <summary>{t('app.earlierMessages', { count: segment.earlier.length })}</summary>
                              {segment.earlier.map(renderTimelineMessage)}
                            </details>
                          )}
                          <CompactionCard compaction={segment.compaction} latest={segment.latest} />
                        </div>
                      ),
                    )}
                    {currentDetail?.runs.some((run) => run.compaction && run.status === 'running') && (
                      <CompactingNotice />
                    )}
                    {stream?.content && (
                      <div className="message-row assistant-row streaming">
                        <div className="message-author">
                          <span className="assistant-glyph" aria-hidden="true">
                            <Sparkles size={12} />
                          </span>
                          <strong>{provider?.name || t('app.agentFallback')}</strong>
                          <span className="streaming-label">
                            <i aria-hidden="true" />
                            {t('app.writing')}
                          </span>
                        </div>
                        <Markdown>{stream.content}</Markdown>
                      </div>
                    )}
                    {activityEvents
                      .filter(
                        (item) =>
                          item.type === 'error' &&
                          !messages.some((message) => message.role === 'user' && message.runId === item.runId),
                      )
                      .map((item) => (
                        <RunEventRow key={item.id} event={item} />
                      ))}
                    {currentDetail?.approvals
                      .filter((item) => item.status === 'pending')
                      .map((approval) => (
                        <div
                          className={`approval-card ${approval.kind}`}
                          key={approval.id}
                          role="region"
                          aria-label={approval.title || t('app.approval.title')}
                        >
                          <div className="approval-icon" aria-hidden="true">
                            <Shield size={16} />
                          </div>
                          <div className="approval-copy">
                            <strong>{approval.title || t('app.approval.title')}</strong>
                            <p>{approval.detail}</p>
                            <span>
                              {approval.kind === 'command'
                                ? t('app.approval.command')
                                : approval.kind === 'file'
                                  ? t('app.approval.file')
                                  : t('app.approval.tool')}
                            </span>
                          </div>
                          <div className="approval-actions">
                            <button
                              className="secondary-button"
                              onClick={() =>
                                void api
                                  .approve(approval.id, 'deny')
                                  .then(() => refreshDetail(session.id))
                                  .catch((e: Error) => setNotice(e.message))
                              }
                            >
                              {t('app.approval.deny')}
                            </button>
                            <button
                              className="primary-button"
                              onClick={() =>
                                void api
                                  .approve(approval.id, 'approve')
                                  .then(() => refreshDetail(session.id))
                                  .catch((e: Error) => setNotice(e.message))
                              }
                            >
                              <Check size={14} /> {t('app.approval.approve')}
                            </button>
                          </div>
                        </div>
                      ))}
                  </div>
                </section>
                <div className="composer-wrap">
                  {activeConversationRun && (
                    <RunProgressBanner
                      run={activeConversationRun}
                      events={activityEvents}
                      tasks={activityTasks}
                      approvals={currentDetail?.approvals || []}
                      streamUpdatedAt={stream?.runId === activeConversationRun.id ? stream.updatedAt : undefined}
                      eventsConnected={eventsConnected}
                      onShowActivity={() => {
                        const activity = document.getElementById(`run-activity-${activeConversationRun.id}`);
                        activity?.querySelector('details')?.setAttribute('open', '');
                        activity?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                      }}
                    />
                  )}
                  {conversationScroll.showJump && (
                    <button
                      type="button"
                      className="jump-to-latest"
                      aria-label={t('app.jumpLatest')}
                      title={t('app.jumpLatest')}
                      onClick={conversationScroll.scrollToLatest}
                    >
                      <ArrowDown size={16} />
                    </button>
                  )}
                  {notice && (
                    <div className="inline-notice error-notice" role="alert">
                      <span>{notice}</span>
                      <button className="icon-button" onClick={() => setNotice('')} aria-label={t('app.dismissNotice')}>
                        <X size={15} />
                      </button>
                    </div>
                  )}
                  {session.archivedAt && (
                    <div className="archived-conversation-banner" role="status">
                      <Archive size={15} aria-hidden="true" />
                      <span>{t('app.archivedBanner')}</span>
                    </div>
                  )}
                  {limitBlock && limitBlock.sessionId === session.id ? (
                    <LimitNotice
                      message={limitBlock.message}
                      busy={limitRetrying || busy || Boolean(session.activeRunId)}
                      onContinue={() => void continueDespiteLimit()}
                      onDismiss={() => setLimitBlock(null)}
                    />
                  ) : (
                    usageWarningKey !== usageWarningHidden && (
                      <SpendWarningBanner
                        report={usage.report}
                        onDismiss={() => setUsageWarningHidden(usageWarningKey)}
                      />
                    )
                  )}
                  <MessageQueue
                    queue={messageQueue}
                    running={Boolean(session.activeRunId)}
                    canSteer={provider?.capabilities.steer === true}
                    onSentNow={() => {
                      setDrafts((current) => ({ ...current, [session.id]: '' }));
                      attachments.clear(session.id);
                    }}
                  />
                  <div
                    className={`composer-box ${session.activeRunId ? 'is-running' : ''} ${attachments.dragging ? 'is-dragging' : ''}`}
                    {...attachments.dropHandlers}
                  >
                    <ComposerSurface
                      input={
                        <>
                          <PendingAttachments
                            items={attachments.items}
                            disabled={busy || Boolean(session.archivedAt)}
                            onRemove={attachments.remove}
                          />
                          {slash.open && (
                            <CommandPopup
                              id={slash.listboxId}
                              items={slash.items}
                              activeIndex={slash.activeIndex}
                              optionId={slash.optionId}
                              onSelect={slash.select}
                              onHover={slash.setActiveIndex}
                            />
                          )}
                          <MentionPopup
                            id={mentions.listboxId}
                            state={mentions.state}
                            items={mentions.items}
                            activeIndex={mentions.activeIndex}
                            optionId={mentions.optionId}
                            onSelect={mentions.select}
                            onHover={mentions.setActiveIndex}
                          />
                          <textarea
                            ref={composerRef}
                            className="composer-input"
                            value={composer}
                            onChange={(event) => {
                              mentions.trackCaret(event);
                              setDrafts((current) => ({ ...current, [session.id]: event.target.value }));
                            }}
                            onSelect={mentions.trackCaret}
                            onPaste={attachments.onPaste}
                            {...(mentions.open ? mentions.inputProps : slash.inputProps)}
                            onKeyDown={(event) => {
                              // An open list (commands or files) owns Enter, Tab, arrows and Escape.
                              if (slash.onKeyDown(event)) return;
                              if (mentions.onKeyDown(event)) return;
                              const action = composerKeyAction(
                                { ...event, isComposing: event.nativeEvent.isComposing },
                                Boolean(session.activeRunId),
                              );
                              if (!action) return;
                              event.preventDefault();
                              if (action === 'send') void sendMessage();
                              else if (action === 'queue') void queueMessage();
                              else if (composer.trim() && !attachments.uploading)
                                messageQueue.askSendNow({
                                  content: composer.trim(),
                                  attachmentIds: attachments.ready.map((item) => item.id),
                                });
                            }}
                            placeholder={
                              session.archivedAt
                                ? t('app.archivedBanner')
                                : session.activeRunId
                                  ? t('composer.placeholder.running')
                                  : session.planFirst
                                    ? t('composer.placeholder.planFirst')
                                    : t('composer.placeholder')
                            }
                            aria-label={t('composer.input')}
                            disabled={Boolean(session.archivedAt) || sessionCreationPending}
                            rows={1}
                          />
                        </>
                      }
                      primaryControls={
                        <>
                          <ModelMenu
                            providers={
                              conversationProject?.remote
                                ? data.providers.filter((item) => item.id === 'codex' || item.id === 'kiro')
                                : data.providers
                            }
                            providerId={session.providerId}
                            sessionId={session.id}
                            modelId={session.model}
                            disabled={busy || Boolean(session.activeRunId)}
                            onChange={(providerId, model) => {
                              // A different agent in a conversation with messages asks about a summary first.
                              if (providerId !== session.providerId && messages.some((m) => m.content.trim()))
                                return openHandoff({ providerId, ...(model ? { model } : {}) });
                              void changeSession(
                                providerId === session.providerId
                                  ? { model: model || null }
                                  : { providerId, model: model || null },
                              );
                            }}
                          />
                          <ChoiceMenu
                            label={t('composer.thinking.label')}
                            icon={<Brain size={14} />}
                            value={session.thinking || 'auto'}
                            options={thinkingOptions.map((value) => ({
                              value,
                              label: thinkingLabel(value),
                              detail:
                                value === 'auto'
                                  ? thinkingOptions.length === 1
                                    ? reasoningUnavailable
                                      ? t('composer.thinking.autoUnavailable')
                                      : t('composer.thinking.autoNoLevels')
                                    : t('composer.thinking.autoRoute')
                                  : undefined,
                            }))}
                            hint={thinkingOptions.length > 1 ? t('composer.thinking.hint') : undefined}
                            disabled={busy || Boolean(session.activeRunId)}
                            onChange={(value) => void changeSession({ thinking: value })}
                          />
                          <ComposerAccessMenu
                            sandbox={data.settings.sandbox}
                            remote={Boolean(conversationProject?.remote)}
                            approval={effectiveApprovalMode}
                            configuredApprovalMode={session.approvalMode}
                            approvalScope={
                              internetForcesManual
                                ? 'forced'
                                : session.approvalMode
                                  ? 'session'
                                  : conversationProject?.approvalMode
                                    ? 'project'
                                    : 'settings'
                            }
                            supportsAutomatic={supportsAutomaticApproval}
                            sandboxDisabled={
                              settingsPending || busy || Boolean(session.activeRunId) || Boolean(session.archivedAt)
                            }
                            approvalDisabled={
                              !localApprovalControls ||
                              busy ||
                              Boolean(session.activeRunId) ||
                              Boolean(session.archivedAt)
                            }
                            onPermissions={(sandbox) => void enqueueSettingsPatch({ sandbox })}
                            onApproval={(mode) => void changeSession({ approvalMode: mode })}
                          />
                        </>
                      }
                      actions={
                        <>
                          <AttachButton
                            disabled={busy || Boolean(session.archivedAt)}
                            full={attachments.full}
                            onFiles={attachments.add}
                          />
                          {voiceEnabled && (
                            <VoiceButton
                              state={voice.state}
                              elapsed={voice.elapsed}
                              level={voice.level}
                              blocker={voice.blocker}
                              disabled={(busy || Boolean(session.archivedAt)) && voice.state === 'idle'}
                              onToggle={() => {
                                if (voice.blocker) return setNotice(voice.blocker);
                                if (voice.state === 'idle') dictationTargetRef.current = session.id;
                                voice.toggle();
                              }}
                            />
                          )}
                          {session.activeRunId && composer.trim() && (
                            <>
                              {provider?.capabilities.steer && attachments.ready.length === 0 && (
                                <button
                                  type="button"
                                  className="composer-steer-button"
                                  aria-label={t('composer.steer')}
                                  title={t('composer.steerTitle')}
                                  disabled={busy || Boolean(session.archivedAt) || attachments.uploading}
                                  onClick={() => void steerComposer()}
                                >
                                  <CornerDownRight size={15} />
                                  <span>{t('composer.steer')}</span>
                                </button>
                              )}
                              <button
                                type="button"
                                className="queue-button"
                                aria-label={t('composer.queue')}
                                title={t('composer.queueTitle')}
                                onClick={() => void queueMessage()}
                                disabled={busy || Boolean(session.archivedAt) || attachments.uploading}
                              >
                                <ListPlus size={16} />
                              </button>
                            </>
                          )}
                          <button
                            className={`send-button ${canCancelCurrentSend ? 'stop' : ''}`}
                            aria-label={canCancelCurrentSend ? t('composer.cancel') : t('composer.send')}
                            title={canCancelCurrentSend ? t('composer.cancel') : t('composer.sendTitle')}
                            onClick={() =>
                              session.activeRunId
                                ? void api
                                    .cancel(session.id)
                                    .then(() => refreshDetail(session.id))
                                    .catch((e: Error) => setNotice(e.message))
                                : pendingSendForSession
                                  ? void cancelPendingSend(session.id)
                                  : void sendMessage()
                            }
                            disabled={
                              canCancelCurrentSend
                                ? false
                                : !composer.trim() ||
                                  busy ||
                                  settingsPending ||
                                  attachments.uploading ||
                                  Boolean(session.archivedAt)
                            }
                          >
                            {canCancelCurrentSend ? (
                              <Square size={12} fill="currentColor" />
                            ) : busy ? (
                              <LoaderCircle className="spin" size={16} />
                            ) : (
                              <ArrowUp size={17} />
                            )}
                          </button>
                        </>
                      }
                      context={
                        <>
                          <ConversationMenu
                            projects={data.projects}
                            projectId={session.projectId}
                            mode={session.mode}
                            disabled={busy || Boolean(session.activeRunId)}
                            context={conversationContext}
                            memoryScope={session.projectId === null ? detachedMemoryScope : undefined}
                            onProject={(projectId) => {
                              const destination = data.projects.find((item) => item.id === projectId);
                              if (!destination?.remote) return void changeSession({ projectId });
                              const providerId = providerForRemoteProject(session.providerId, data.providers);
                              if (!providerId) return setNotice(t('remoteHosts.providerRequired'));
                              void changeSession({
                                projectId,
                                ...(providerId !== session.providerId ? { providerId } : {}),
                              });
                            }}
                            onMode={(mode) => void changeSession({ mode })}
                            onConfigure={
                              conversationProject
                                ? () => {
                                    selectProject(conversationProject.id);
                                    setPage('settings');
                                    setSidebarOpen(false);
                                  }
                                : undefined
                            }
                          />
                          {!conversationProject?.remote && (
                            <button
                              type="button"
                              className={`composer-pill plan-first-toggle ${session.planFirst ? 'active' : ''}`}
                              aria-pressed={Boolean(session.planFirst)}
                              title={t('composer.planFirstTitle')}
                              disabled={busy || Boolean(session.activeRunId)}
                              onClick={() => void changeSession({ planFirst: !session.planFirst })}
                            >
                              <ClipboardList size={14} />
                              <span className="composer-pill-label">{t('composer.planFirst')}</span>
                            </button>
                          )}
                          <ExecutionProfile
                            provider={provider?.name || session.providerId}
                            model={session.model}
                            thinking={thinkingLabel(session.thinking || 'auto')}
                            sandbox={data.settings.sandbox}
                            approval={effectiveApprovalMode}
                            delegation={Boolean(
                              !conversationProject?.remote && conversationProject?.orchestration?.enabled !== false,
                            )}
                            graph={Boolean(
                              conversationProject &&
                              !conversationProject.remote &&
                              conversationProject.graphify?.enabled !== false,
                            )}
                            memory={Boolean(
                              data.settings.memoryEnabled && (conversationProject || detachedMemoryScope),
                            )}
                          />
                        </>
                      }
                    />
                    {reasoningUnavailable && <span className="visually-hidden">{t('composer.noThinking')}</span>}
                  </div>
                </div>
              </div>
            )}
          </ErrorBoundary>
        )}

        {data && toolsProject && toolsTab && (
          <ErrorBoundary scope={t('app.scope.terminal')} resetKey={toolsProject.id}>
            <ToolsPanel
              key={toolsProject.id}
              projectId={toolsProject.id}
              projectName={toolsProject.name}
              projectPath={toolsProject.remote?.path ?? toolsProject.path}
              remote={Boolean(toolsProject.remote)}
              sandbox={data.settings.sandbox}
              tab={toolsTab}
              onTab={setToolsTab}
              onClose={() => setToolsTab(null)}
            />
          </ErrorBoundary>
        )}

        {data && page === 'git' && project?.remote && (
          <RemoteGitPanel
            key={project.id}
            project={project}
            remoteHost={remoteHosts.find((host) => host.id === project.remote?.hostId)}
          />
        )}
        {data && page === 'git' && project && !project.remote && (
          <ErrorBoundary scope={t('app.scope.git')} resetKey={project.id}>
            <GitPanel
              key={project.id}
              project={project}
              onProjectUpdated={(updated) =>
                setData((snapshot) =>
                  snapshot
                    ? {
                        ...snapshot,
                        projects: snapshot.projects.map((item) => (item.id === updated.id ? updated : item)),
                      }
                    : snapshot,
                )
              }
            />
          </ErrorBoundary>
        )}
        {data && page === 'git' && !project && (
          <section className="page-content">
            <div className="inline-notice">{t('app.gitNoProject')}</div>
          </section>
        )}
        {data && page === 'activity' && (
          <ErrorBoundary scope={t('app.scope.activity')} resetKey={page}>
            <ActivityPage providers={data.providers} projects={data.projects} sessions={data.sessions} />
          </ErrorBoundary>
        )}
        {data && page === 'automations' && (
          <ErrorBoundary scope={t('app.scope.automations')} resetKey={page}>
            <AutomationsPage
              data={data}
              version={automationsVersion}
              onOpenConversation={openConversation}
              onOpenSettings={() => {
                goTo('settings');
                setSettingsSearchRequest({ id: Date.now(), query: t('settings.automations.label') });
              }}
            />
          </ErrorBoundary>
        )}
        {data && memoryVisited && (
          <ErrorBoundary scope={t('app.scope.memory')} resetKey={page}>
            <SharedMemoryPage activated={memoryVisited} visible={page === 'memory'} />
          </ErrorBoundary>
        )}

        {data && page === 'settings' && (
          <ErrorBoundary scope={t('app.scope.settings')} resetKey={project?.id || 'global'}>
            <SettingsPage
              key={project?.id || 'global'}
              data={data}
              project={project}
              searchRequest={settingsSearchRequest}
              onResumeProject={
                projectSetupPaused
                  ? () => {
                      setProjectSetupPaused(false);
                      setSettingsSearchRequest(undefined);
                    }
                  : undefined
              }
              coordination={coordination}
              graphifyStatus={graphifyStatus}
              graphQueryResult={graphQueryResult}
              projectQuery={projectQuery}
              projectBusy={projectBusy}
              coordinatorProviderId={
                session && session.projectId === project?.id ? session.providerId : data.settings.defaultProviderId
              }
              onProjectQueryChange={setProjectQuery}
              onProjectQuery={queryProjectGraph}
              onOrchestration={(patch) => project && void changeProjectOrchestration(project.id, patch)}
              onGraphifyEnabled={(enabled) => project && void changeGraphifyEnabled(project.id, enabled)}
              onIndexGraphify={() => project && void indexProject(project.id)}
              onRefreshProject={() => project && void refreshProjectViews(project.id)}
              onProjectMemoryScope={(workspace, memoryProject) =>
                project && void changeProjectMemoryScope(project.id, workspace, memoryProject)
              }
              onSetting={updateSetting}
              onModelFallback={(modelFallback) => void enqueueSettingsPatch({ modelFallback })}
              onDetachedMemory={(detachedMemory) =>
                void enqueueSettingsPatch({ detachedMemory: detachedMemory ?? null })
              }
              onProjectUpdated={(updated) =>
                setData((current) =>
                  current
                    ? {
                        ...current,
                        projects: current.projects.map((item) => (item.id === updated.id ? updated : item)),
                      }
                    : current,
                )
              }
              onProjectApprovalMode={(approvalMode) =>
                project && void changeProjectApprovalMode(project.id, approvalMode)
              }
              localApprovalControls={localApprovalControls}
              usage={usage.report}
              usageError={usage.error}
              onSpendLimits={(patch) => void changeSpendLimits(patch)}
              onProjectSpendLimits={(patch) => project && void changeProjectSpendLimits(project.id, patch)}
              onSkill={async (id, enabled) => {
                try {
                  const result = await api.skill(id, enabled);
                  setData((current) =>
                    current
                      ? { ...current, skills: current.skills.map((skill) => (skill.id === id ? result : skill)) }
                      : current,
                  );
                } catch (error) {
                  setNotice((error as Error).message);
                }
              }}
              notice={notice}
            />
          </ErrorBoundary>
        )}
      </main>

      {projectForm && (
        <ProjectForm
          busy={busy}
          hidden={projectSetupPaused}
          onConfigureSSH={() => {
            setProjectSetupPaused(true);
            setPage('settings');
            setSettingsSearchRequest({ id: Date.now(), query: 'SSH' });
          }}
          error={notice}
          onSubmit={(fields) => void createProject(fields)}
          onClose={() => {
            setProjectForm(false);
            setProjectSetupPaused(false);
            setSettingsSearchRequest(undefined);
          }}
        />
      )}
      {searchOpen && (
        <ConversationSearch
          onClose={() => setSearchOpen(false)}
          onOpen={(id) => {
            setSearchOpen(false);
            setSidebarOpen(false);
            setPage('chat');
            selectConversation(id);
          }}
        />
      )}
      {palette.open && (
        <CommandPalette
          actions={palette.actions}
          recents={palette.recents}
          onRun={palette.run}
          onClose={palette.close}
        />
      )}
      {handoff && data && session?.id === handoff.sessionId && (
        <HandoffDialog
          providers={
            conversationProject?.remote
              ? data.providers.filter((item) => item.id === 'codex' || item.id === 'kiro')
              : data.providers
          }
          currentProviderId={session.providerId}
          fixedTarget={handoff.target}
          busy={handoffBusy}
          error={handoffError}
          limitBlocked={handoffLimited}
          onConfirm={(target, summary, overrideLimit) => void confirmHandoff(target, summary, overrideLimit)}
          onCancelRunning={() => void api.cancel(handoff.sessionId).catch(() => undefined)}
          onClose={() => setHandoff(null)}
        />
      )}
      {helpOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setHelpOpen(false);
          }}
        >
          <div className="modal-card help-card" role="dialog" aria-modal="true" aria-labelledby="help-title">
            <div className="modal-heading">
              <div className="project-avatar" aria-hidden="true">
                <CircleHelp size={17} />
              </div>
              <div>
                <h2 id="help-title">{t('app.helpDialog.title')}</h2>
                <p>{t('app.helpDialog.subtitle')}</p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label={t('app.helpDialog.close')}
                onClick={() => setHelpOpen(false)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="help-items">
              {(['start', 'adjust', 'review', 'stop', 'queue'] as const).map((item) => (
                <p key={item}>
                  {tRich(`app.helpDialog.${item}`, { lead: <strong>{t(`app.helpDialog.${item}Lead`)}</strong> })}
                </p>
              ))}
            </div>
            <dl className="shortcut-list">
              <div>
                <dt>{t('app.shortcut.send')}</dt>
                <dd>
                  <kbd>Enter</kbd>
                </dd>
              </div>
              <div>
                <dt>{t('app.shortcut.queue')}</dt>
                <dd>
                  <kbd>Enter</kbd>
                </dd>
              </div>
              <div>
                <dt>{t('app.shortcut.sendNow')}</dt>
                <dd>
                  <kbd>Ctrl</kbd>
                  <kbd>Enter</kbd>
                </dd>
              </div>
              <div>
                <dt>{t('app.shortcut.newline')}</dt>
                <dd>
                  <kbd>Shift</kbd>
                  <kbd>Enter</kbd>
                </dd>
              </div>
              <div>
                <dt>{t('app.shortcut.new')}</dt>
                <dd>
                  <kbd>{shortcut}</kbd>
                </dd>
              </div>
              <div>
                <dt>{t('app.shortcut.palette')}</dt>
                <dd>
                  <kbd>{shortcut.startsWith('⌘') ? '⌘P' : 'Ctrl P'}</kbd>
                </dd>
              </div>
              <div>
                <dt>{t('app.shortcut.close')}</dt>
                <dd>
                  <kbd>Esc</kbd>
                </dd>
              </div>
            </dl>
            <button type="button" className="primary-button help-done" onClick={() => setHelpOpen(false)}>
              {t('app.helpDialog.done')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
