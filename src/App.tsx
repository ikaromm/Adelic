import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
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
} from 'lucide-react';
import type {
  AttachmentMeta,
  Bootstrap,
  GraphifyQueryResult,
  GraphifyStatus,
  Message,
  OrchestrationConfig,
  ProjectCoordination,
  Session,
  SessionDetail,
  StreamEvent,
} from '../shared/contracts';
import { api } from './api';
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
import { ConversationSearch } from './components/ConversationSearch';
import { CommandPalette } from './components/CommandPalette';
import { downloadExport, useCommandPalette } from './hooks/useCommandPalette';
import { ProjectForm, type NewProject } from './components/ProjectForm';
import { MessageCard, RetryNotice, RunActivityPanel, RunEventRow } from './components/Chat';
import { retryAlternatives } from '../shared/model-fallback';
import { SettingsPage } from './components/SettingsPage';
import { SIDEBAR_LIMIT, SessionItem, SidebarNav, UpdateNotice, type Page } from './components/Sidebar';

type LocalStream = { runId: string; messageId: string; content: string };

export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [coordination, setCoordination] = useState<ProjectCoordination | null>(null);
  const [graphifyStatus, setGraphifyStatus] = useState<GraphifyStatus | null>(null);
  const [selectedSession, setSelectedSession] = useState('');
  const [selectedProject, setSelectedProject] = useState('');
  const [page, setPage] = useState<Page>('chat');
  const [memoryVisited, setMemoryVisited] = useState(false);
  const [stream, setStream] = useState<LocalStream | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [projectForm, setProjectForm] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [projectQuery, setProjectQuery] = useState('');
  const [graphQueryResult, setGraphQueryResult] = useState<GraphifyQueryResult | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);
  const focusComposerRef = useRef(false);
  const [expandedLists, setExpandedLists] = useState<Record<string, boolean>>({});
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
    approvalMode: 'auto-safe' | 'manual';
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
  const plans = usePlans(selectedSession, setNotice);
  const { apply: applyPlan, reload: reloadPlans } = plans;
  const selectSession = (id: string) => {
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
                  detail:
                    health.memory === 'ready' ? 'Servidor MCP local disponível' : 'Servidor MCP local indisponível',
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
          : 'Não foi possível carregar o resumo do projeto.',
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
    const events = new EventSource('/api/events');
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
      if (event.type === 'queue') {
        applyQueue(event.queue);
        return;
      }
      if (event.type === 'plan') {
        applyPlan(event.plan);
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
            ? { ...current, content: current.content + event.text }
            : { runId: event.runId, messageId: event.messageId, content: event.text },
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
  const projectSessions = useMemo(
    () => data?.sessions.filter((s) => s.projectId === selectedProject) || [],
    [data?.sessions, selectedProject],
  );
  const detachedSessions = useMemo(() => data?.sessions.filter((s) => s.projectId === null) || [], [data?.sessions]);
  const conversationProject = data?.projects.find((item) => item.id === session?.projectId);
  const messages = currentDetail?.messages || [];
  const activityEvents = currentDetail?.events || [];
  const activityTasks = currentDetail?.tasks || [];
  // "Tentar de novo" is offered only on the latest answer, and only if it failed.
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const lastFailedMessageId = lastAssistant?.status === 'failed' ? lastAssistant.id : undefined;

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
  );
  useEffect(() => {
    if (!focusComposerRef.current || page !== 'chat') return;
    const element = composerRef.current;
    if (!element || element.disabled) return;
    focusComposerRef.current = false;
    element.focus();
  }, [selectedSession, page, currentDetail?.session.id, composerRef]);

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
    setBusy(true);
    setNotice('');
    try {
      const created = await api.createSession({
        projectId,
        providerId: data.settings.defaultProviderId,
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
      setBusy(false);
    }
  }

  async function startSuggestedPrompt(text: string) {
    if (!data || busy || settingsPendingRef.current) return;
    setBusy(true);
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
      await api.send(created.id, text, crypto.randomUUID());
      await refreshDetail(created.id);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** `explicit` resends given attachments (retry, suggestions) instead of the composer's. */
  async function sendMessage(value = composer, explicit?: AttachmentMeta[]) {
    const content = value.trim();
    if (!content || !session || busy || session.activeRunId || settingsPendingRef.current) return;
    if (!explicit && attachments.uploading) return setNotice('Aguarde o envio dos anexos terminar.');
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
    conversationScroll.stick();
    const optimistic: Message = {
      id: `local-${crypto.randomUUID()}`,
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
        crypto.randomUUID(),
        sentAttachments.map((item) => item.id),
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
        if (selectedSessionRef.current === sessionId)
          setNotice('Mensagem enviada. Reconectando para acompanhar a resposta.');
      }
    } catch (error) {
      if (!accepted) {
        setDetail((current) =>
          current?.session.id === sessionId
            ? { ...current, messages: current.messages.filter((message) => message.id !== optimistic.id) }
            : current,
        );
        setDrafts((current) => ({
          ...current,
          [sessionId]: current[sessionId] ? `${content}\n${current[sessionId]}` : content,
        }));
        if (selectedSessionRef.current === sessionId) setNotice((error as Error).message);
      }
    } finally {
      if (pendingSendRef.current === pendingSend) {
        pendingSendRef.current = null;
        setPendingSendSession('');
      }
      setBusy(false);
    }
  }

  /** Enter while the agent works: the message waits on the server and starts on its own. */
  async function queueMessage() {
    const content = composer.trim();
    if (!content || !session) return;
    if (attachments.uploading) return setNotice('Aguarde o envio dos anexos terminar.');
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
  async function retryWithModel(runId: string, target: { providerId: string; model: string }) {
    if (!session || busy || session.activeRunId) return;
    const sessionId = session.id;
    setBusy(true);
    setNotice('');
    conversationScroll.stick();
    try {
      const started = await api.retryRun(runId, target);
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
      if (selectedSessionRef.current === sessionId) setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function changeSession(
    patch: Partial<Pick<Session, 'providerId' | 'mode' | 'projectId' | 'thinking' | 'planFirst'>> & {
      model?: string | null;
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
      if (thinkingWasReset && selectedSessionRef.current === sessionId)
        setNotice('O nível de Thinking não existe no modelo escolhido; ajustado para Automático.');
    } catch (error) {
      if (selectedSessionRef.current === sessionId) setNotice((error as Error).message);
    } finally {
      if (sessionWriteRef.current.get(sessionId) === settled) sessionWriteRef.current.delete(sessionId);
      setBusy(false);
    }
  }

  async function changeProjectOrchestration(projectId: string, patch: Partial<OrchestrationConfig>) {
    const previous = projectWriteRef.current.get(projectId) || Promise.resolve();
    const request = previous.then(async () => {
      const current = projectSnapshotRef.current?.projects.find((item) => item.id === projectId);
      if (!current) throw new Error('Projeto não encontrado.');
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
      | 'autoRetry'
      | 'notifications',
    value: string | boolean,
  ) {
    if (!data) return;
    if (key === 'sandbox' || key === 'approvalMode') {
      const current = permissionTargetRef.current || {
        sandbox: data.settings.sandbox,
        approvalMode: data.settings.approvalMode || 'auto-safe',
      };
      void updatePermissions(
        key === 'sandbox' ? (value as 'read-only' | 'workspace-write') : current.sandbox,
        key === 'approvalMode' ? (value as 'auto-safe' | 'manual') : current.approvalMode,
      );
      return;
    }
    await enqueueSettingsPatch({ [key]: value } as never);
  }

  async function updatePermissions(sandbox: 'read-only' | 'workspace-write', approvalMode: 'auto-safe' | 'manual') {
    if (!data) return;
    permissionTargetRef.current = { sandbox, approvalMode };
    await enqueueSettingsPatch({ sandbox, approvalMode });
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

  const shortcut = newConversationShortcut();
  const memoryIntegration = data?.integrations.find((item) => item.kind === 'memory');
  const memoryStatus =
    memoryIntegration?.status === 'ready'
      ? 'conectada'
      : memoryIntegration?.status === 'planned'
        ? 'verificando'
        : 'indisponível';
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
      (data?.sessions || []).filter((item) => item.projectId === projectId),
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
  const conversationContext = conversationProject
    ? conversationProject.orchestration?.enabled === false
      ? 'Execução direta, sem delegação.'
      : `Orquestração ativa: ${provider?.name || 'agente da conversa'} coordena tarefas com contexto enxuto.`
    : 'Conversa avulsa: sem contexto ou configuração de projeto.';
  const pageTitle =
    page === 'chat'
      ? session
        ? conversationProject?.name || 'Conversa avulsa'
        : project?.name || 'Conversas'
      : page === 'activity'
        ? 'Atividade'
        : page === 'memory'
          ? 'Memória'
          : 'Configurações';

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className={`sidebar ${sidebarOpen ? 'sidebar-mobile-open' : ''}`} aria-label="Barra lateral">
        <div className="sidebar-header">
          <div className="brand">
            <BrandMark />
            <span className="brand-name">adelic</span>
          </div>
          <button
            className="icon-button sidebar-collapse"
            aria-label={sidebarCollapsed ? 'Expandir navegação' : 'Recolher navegação'}
            title={sidebarCollapsed ? 'Expandir navegação' : 'Recolher navegação'}
            aria-expanded={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
          <button
            className="icon-button sidebar-close"
            aria-label="Fechar navegação"
            title="Fechar navegação"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={16} />
          </button>
        </div>
        <button
          className="new-chat-button"
          title={`Nova conversa (${shortcut})`}
          onClick={() => void newConversation()}
          disabled={busy}
        >
          <Plus size={16} />
          <span className="sidebar-label">Nova conversa</span>
          <kbd>{shortcut}</kbd>
        </button>
        <button
          className="nav-item sidebar-search"
          title="Buscar nas conversas (Ctrl+Shift+F)"
          onClick={() => setSearchOpen(true)}
        >
          <Search size={16} aria-hidden="true" />
          <span className="sidebar-label">Buscar conversas</span>
        </button>
        <div className="sidebar-scroll">
          <section className="sidebar-section sidebar-detached" aria-labelledby="sidebar-detached-title">
            <div className="sidebar-section-heading">
              <h2 id="sidebar-detached-title" className="sidebar-label">
                Conversas avulsas
              </h2>
            </div>
            <div className="session-list detached-conversations">
              {detachedList.items.map((itemSession) => (
                <SessionItem
                  key={itemSession.id}
                  session={itemSession}
                  selected={itemSession.id === selectedSession}
                  now={now}
                  onSelect={() => openConversation(itemSession.id)}
                />
              ))}
              {detachedList.hidden > 0 && (
                <button type="button" className="sidebar-more" onClick={() => toggleList('detached', true)}>
                  Mostrar mais ({detachedList.hidden})
                </button>
              )}
              {expandedLists.detached && detachedSessions.length > SIDEBAR_LIMIT && (
                <button type="button" className="sidebar-more" onClick={() => toggleList('detached', false)}>
                  Mostrar menos
                </button>
              )}
              {detachedSessions.length === 0 && <p className="sidebar-empty">Nenhuma conversa avulsa.</p>}
            </div>
          </section>
          <section className="sidebar-section sidebar-projects" aria-labelledby="sidebar-projects-title">
            <div className="sidebar-section-heading">
              <h2 id="sidebar-projects-title" className="sidebar-label">
                Projetos
              </h2>
              <button
                className="icon-button sidebar-add"
                aria-label="Adicionar projeto"
                title="Adicionar projeto"
                onClick={() => setProjectForm(true)}
              >
                <Plus size={15} />
              </button>
            </div>
            <div className="project-list">
              {data?.projects.map((item) => {
                const expanded = item.id === selectedProject;
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
                        <span className="sidebar-label">{item.name}</span>
                        <ChevronRight size={14} className="project-chevron" aria-hidden="true" />
                      </button>
                      <button
                        className="project-new-chat"
                        aria-label={`Nova conversa em ${item.name}`}
                        title={`Nova conversa em ${item.name}`}
                        disabled={busy}
                        onClick={() => void newConversation(item.id)}
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                    {expanded && projectSessions.length > 0 && (
                      <div className="session-list">
                        {projectList.items.map((itemSession) => (
                          <SessionItem
                            key={itemSession.id}
                            session={itemSession}
                            selected={itemSession.id === selectedSession}
                            now={now}
                            onSelect={() => openConversation(itemSession.id)}
                          />
                        ))}
                        {projectList.hidden > 0 && (
                          <button type="button" className="sidebar-more" onClick={() => toggleList(item.id, true)}>
                            Mostrar mais ({projectList.hidden})
                          </button>
                        )}
                        {expandedLists[item.id] && projectSessions.length > SIDEBAR_LIMIT && (
                          <button type="button" className="sidebar-more" onClick={() => toggleList(item.id, false)}>
                            Mostrar menos
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {data?.projects.length === 0 && <p className="sidebar-empty">Nenhum projeto cadastrado.</p>}
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
        <button className="mobile-scrim" aria-label="Fechar navegação" onClick={() => setSidebarOpen(false)} />
      )}

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button mobile-menu"
              aria-label="Abrir navegação"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={18} />
            </button>
            <div className="breadcrumbs">
              <span className="crumb">{pageTitle}</span>
              {page === 'chat' && session && (
                <>
                  <span className="crumb-separator" aria-hidden="true">
                    /
                  </span>
                  <strong title={session.title || 'Nova conversa'}>{session.title || 'Nova conversa'}</strong>
                </>
              )}
            </div>
          </div>
          <div className="topbar-right">
            {page === 'chat' && session && (
              <a
                className="icon-button"
                href={`/api/sessions/${encodeURIComponent(session.id)}/export`}
                download
                aria-label="Exportar conversa em Markdown"
                title="Exportar conversa em Markdown"
              >
                <Download size={16} />
              </a>
            )}
            <span className="local-badge" title="Executa neste computador; o servidor escuta somente em 127.0.0.1">
              <span className="status-dot ready" aria-hidden="true" />
              Local
            </span>
            <button
              className="icon-button help-button"
              aria-label="Ajuda"
              title="Ajuda"
              onClick={() => setHelpOpen(true)}
            >
              <CircleHelp size={17} />
            </button>
          </div>
        </header>

        {!data && (
          <div className="loading-screen">
            <LoaderCircle className="spin" size={22} />
            <span>Conectando ao Adelic…</span>
            {notice && <p className="error-text">{notice}</p>}
          </div>
        )}
        {data && page === 'chat' && (
          <ErrorBoundary scope="a conversa" resetKey={session?.id ?? 'welcome'}>
            {!session ? (
              <div className="welcome-view">
                <div className="welcome-orb" aria-hidden="true">
                  <Sparkles size={22} />
                </div>
                <h1>O que vamos construir hoje?</h1>
                <p>Comece sem uma pasta ou escolha um projeto depois.</p>
                <button className="primary-button" onClick={() => void newConversation()} disabled={busy}>
                  <Plus size={16} /> Começar uma conversa
                </button>
                <div className="welcome-suggestions">
                  {[
                    'Resuma uma ideia para mim',
                    'Encontre um caminho para começar',
                    'Revise uma ideia que estou explorando',
                  ].map((suggestion) => (
                    <button key={suggestion} onClick={() => void startSuggestedPrompt(suggestion)} disabled={busy}>
                      <span>{suggestion}</span>
                      <ArrowUp size={14} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="chat-view">
                <section
                  className="conversation"
                  aria-label="Conversa"
                  ref={conversationScroll.ref}
                  onScroll={conversationScroll.onScroll}
                >
                  <div className="message-column">
                    {messages.length === 0 && !stream && (
                      <div className="conversation-empty">
                        <div className="empty-icon" aria-hidden="true">
                          <MessageSquare size={18} />
                        </div>
                        <h2>Uma boa conversa começa com uma pergunta.</h2>
                        <p>
                          {conversationProject ? (
                            <>
                              O agente usa o contexto de <strong>{conversationProject.name}</strong> quando necessário.
                            </>
                          ) : (
                            'Converse livremente ou vincule um projeto no menu de projeto e modo, junto ao campo de mensagem.'
                          )}
                        </p>
                        <div className="prompt-chips">
                          {(conversationProject
                            ? [
                                'Explique a estrutura deste projeto',
                                'Quais são os próximos passos?',
                                'Me ajude a resolver um problema',
                              ]
                            : [
                                'Explique o que é recursão',
                                'Me ajude a organizar uma ideia',
                                'Me ajude a resolver um problema',
                              ]
                          ).map((text) => (
                            <button key={text} onClick={() => void sendMessage(text, [])}>
                              <span>{text}</span>
                              <ArrowUp size={13} aria-hidden="true" />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {messages
                      .filter((message) => message.id !== stream?.messageId)
                      .map((message) => (
                        <div className="timeline-message" key={message.id}>
                          <MessageCard
                            message={message}
                            providerName={
                              data.providers.find((p) => p.id === (message.providerId || session.providerId))?.name ||
                              'Adelic'
                            }
                            body={(() => {
                              const plan =
                                message.role === 'assistant' && plans.plans.find((p) => p.runId === message.runId);
                              return plan ? (
                                <PlanCard
                                  plan={plan}
                                  api={plans}
                                  busy={Boolean(session.activeRunId)}
                                  canSave={session.projectId !== null}
                                />
                              ) : undefined;
                            })()}
                          />
                          {message.role === 'assistant' &&
                            message.status === 'failed' &&
                            message.id === lastFailedMessageId && (
                              <RetryNotice
                                run={currentDetail?.runs.find((run) => run.id === message.runId)}
                                disabled={busy || Boolean(session.activeRunId)}
                                onRetry={() => {
                                  const prompt = messages.find((m) => m.role === 'user' && m.runId === message.runId);
                                  if (prompt) void sendMessage(prompt.content, prompt.attachments ?? []);
                                }}
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
                              providers={data.providers}
                              active={session.activeRunId === message.runId}
                              taskOutputs={taskOutputs.outputs}
                              loadingTaskOutputs={taskOutputs.loading}
                              onLoadTaskOutput={taskOutputs.load}
                              busy={Boolean(session.activeRunId)}
                            />
                          )}
                        </div>
                      ))}
                    {stream && (
                      <div className="message-row assistant-row streaming">
                        <div className="message-author">
                          <span className="assistant-glyph" aria-hidden="true">
                            <Sparkles size={12} />
                          </span>
                          <strong>{provider?.name || 'Agente'}</strong>
                          <span className="streaming-label">
                            <i aria-hidden="true" />
                            escrevendo
                          </span>
                        </div>
                        {stream.content ? (
                          <Markdown>{stream.content}</Markdown>
                        ) : (
                          <div className="markdown-content">
                            <span className="typing-caret" aria-hidden="true" />
                          </div>
                        )}
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
                          aria-label={approval.title || 'Aprovação necessária'}
                        >
                          <div className="approval-icon" aria-hidden="true">
                            <Shield size={16} />
                          </div>
                          <div className="approval-copy">
                            <strong>{approval.title || 'Aprovação necessária'}</strong>
                            <p>{approval.detail}</p>
                            <span>
                              {approval.kind === 'command'
                                ? 'Comando'
                                : approval.kind === 'file'
                                  ? 'Arquivo'
                                  : 'Ferramenta'}{' '}
                              · confirme esta ação para continuar
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
                              Negar
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
                              <Check size={14} /> Aprovar
                            </button>
                          </div>
                        </div>
                      ))}
                  </div>
                </section>
                <div className="composer-wrap">
                  {conversationScroll.showJump && (
                    <button
                      type="button"
                      className="jump-to-latest"
                      aria-label="Ir para a mensagem mais recente"
                      title="Ir para a mensagem mais recente"
                      onClick={conversationScroll.scrollToLatest}
                    >
                      <ArrowDown size={16} />
                    </button>
                  )}
                  {notice && (
                    <div className="inline-notice error-notice" role="alert">
                      <span>{notice}</span>
                      <button className="icon-button" onClick={() => setNotice('')} aria-label="Dispensar aviso">
                        <X size={15} />
                      </button>
                    </div>
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
                    <PendingAttachments items={attachments.items} disabled={busy} onRemove={attachments.remove} />
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
                        session.activeRunId
                          ? 'O agente está trabalhando… Enter coloca na fila, Ctrl+Enter envia agora.'
                          : session.planFirst
                            ? 'Descreva o que quer fazer; o agente planeja antes de executar…'
                            : 'Escreva uma mensagem…'
                      }
                      aria-label="Mensagem para o agente"
                      rows={1}
                    />
                    <div className="composer-toolbar">
                      <div className="composer-controls">
                        <AttachButton disabled={busy} full={attachments.full} onFiles={attachments.add} />
                        <ModelMenu
                          providers={data.providers}
                          providerId={session.providerId}
                          sessionId={session.id}
                          modelId={session.model}
                          disabled={busy || Boolean(session.activeRunId)}
                          onChange={(providerId, model) =>
                            void changeSession(
                              providerId === session.providerId
                                ? { model: model || null }
                                : { providerId, model: model || null },
                            )
                          }
                        />
                        <ChoiceMenu
                          label="Thinking para próximas mensagens"
                          icon={<Brain size={14} />}
                          value={session.thinking || 'auto'}
                          options={thinkingOptions.map((value) => ({
                            value,
                            label: thinkingLabel(value),
                            detail:
                              value === 'auto'
                                ? thinkingOptions.length === 1
                                  ? reasoningUnavailable
                                    ? 'Este agente não oferece ajuste. O esforço Automático fica a cargo do runtime.'
                                    : 'O catálogo deste modelo não anuncia níveis adicionais; Automático usa o padrão do runtime.'
                                  : 'Escolhido pela rota de cada pedido.'
                                : undefined,
                          }))}
                          hint={
                            thinkingOptions.length > 1
                              ? 'Define o esforço de raciocínio das próximas mensagens. Os níveis seguem o catálogo do modelo escolhido.'
                              : undefined
                          }
                          disabled={busy || Boolean(session.activeRunId)}
                          onChange={(value) => void changeSession({ thinking: value })}
                        />
                        <ChoiceMenu
                          label="Permissões"
                          icon={<Shield size={14} />}
                          width={340}
                          value={`${data.settings.sandbox}|${data.settings.approvalMode || 'auto-safe'}`}
                          disabled={settingsPending}
                          options={[
                            {
                              value: 'read-only|auto-safe',
                              label: 'Leitura · Auto',
                              detail: 'Confirmação automática quando disponível.',
                            },
                            {
                              value: 'read-only|manual',
                              label: 'Leitura · Manual',
                              detail: 'Pede confirmação quando o agente oferece essa opção.',
                            },
                            {
                              value: 'workspace-write|auto-safe',
                              label: 'Escrita · Auto',
                              detail: 'Alterações permitidas no projeto.',
                            },
                            {
                              value: 'workspace-write|manual',
                              label: 'Escrita · Manual',
                              detail: 'Pede confirmação quando o agente oferece essa opção.',
                            },
                          ]}
                          hint={
                            <>
                              O Codex aprova leituras reconhecidas. No Kiro, os pedidos ainda exigem confirmação; Claude
                              não oferece confirmação pelo Adelic. Leituras e alterações feitas sem solicitação e
                              scripts podem alterar ou excluir arquivos.
                            </>
                          }
                          onChange={(value) => {
                            const [sandbox, approvalMode] = value.split('|') as [
                              'read-only' | 'workspace-write',
                              'auto-safe' | 'manual',
                            ];
                            void updatePermissions(sandbox, approvalMode);
                          }}
                        />
                        <ConversationMenu
                          projects={data.projects}
                          projectId={session.projectId}
                          mode={session.mode}
                          disabled={busy || Boolean(session.activeRunId)}
                          context={conversationContext}
                          onProject={(projectId) => void changeSession({ projectId })}
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
                        <button
                          type="button"
                          className={`composer-pill plan-first-toggle ${session.planFirst ? 'active' : ''}`}
                          aria-pressed={Boolean(session.planFirst)}
                          title="Planejar antes: cada mensagem gera primeiro um plano somente leitura para você aprovar. Para uma mensagem só, comece com /plano."
                          disabled={busy || Boolean(session.activeRunId)}
                          onClick={() => void changeSession({ planFirst: !session.planFirst })}
                        >
                          <ClipboardList size={14} />
                          <span className="composer-pill-label">Planejar antes</span>
                        </button>
                      </div>
                      {session.activeRunId && composer.trim() && (
                        <button
                          type="button"
                          className="queue-button"
                          aria-label="Adicionar à fila"
                          title="Adicionar à fila (Enter)"
                          onClick={() => void queueMessage()}
                        >
                          <ListPlus size={16} />
                        </button>
                      )}
                      <button
                        className={`send-button ${canCancelCurrentSend ? 'stop' : ''}`}
                        aria-label={canCancelCurrentSend ? 'Cancelar execução' : 'Enviar mensagem'}
                        title={canCancelCurrentSend ? 'Cancelar execução' : 'Enviar (Enter)'}
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
                            : !composer.trim() || busy || settingsPending || attachments.uploading
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
                    </div>
                    {reasoningUnavailable && (
                      <span className="visually-hidden">
                        Este agente não oferece ajustes de Thinking; somente Automático está disponível.
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </ErrorBoundary>
        )}

        {data && page === 'activity' && (
          <ErrorBoundary scope="a atividade" resetKey={page}>
            <ActivityPage runs={data.runs} providers={data.providers} />
          </ErrorBoundary>
        )}
        {data && memoryVisited && (
          <ErrorBoundary scope="a memória" resetKey={page}>
            <SharedMemoryPage activated={memoryVisited} visible={page === 'memory'} />
          </ErrorBoundary>
        )}

        {data && page === 'settings' && (
          <ErrorBoundary scope="as configurações" resetKey={project?.id || 'global'}>
            <SettingsPage
              key={project?.id || 'global'}
              data={data}
              project={project}
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
          error={notice}
          onSubmit={(fields) => void createProject(fields)}
          onClose={() => setProjectForm(false)}
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
                <h2 id="help-title">Como usar o Adelic</h2>
                <p>Um espaço local para trabalhar com seus agentes.</p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Fechar ajuda"
                onClick={() => setHelpOpen(false)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="help-items">
              <p>
                <strong>Comece por uma conversa.</strong> Nova conversa cria uma conversa avulsa; o + ao lado de um
                projeto cria uma conversa vinculada à pasta e ao escopo de memória dele.
              </p>
              <p>
                <strong>Ajuste a conversa no campo de mensagem.</strong> Escolha agente, modelo, thinking, permissões,
                projeto e modo. Auto adapta o caminho ao pedido; Rápido prioriza respostas diretas e pode consultar o
                computador quando necessário.
              </p>
              <p>
                <strong>Revise aprovações.</strong> A execução acontece neste computador. Confira ações de escrita antes
                de aprovar.
              </p>
              <p>
                <strong>Interrompa quando precisar.</strong> O botão de parar cancela a execução atual.
              </p>
              <p>
                <strong>Escreva enquanto o agente trabalha.</strong> Enter coloca a mensagem na fila; ela começa quando
                a resposta atual terminar. Se a execução for cancelada ou falhar, a fila pausa até você retomá-la.
              </p>
            </div>
            <dl className="shortcut-list">
              <div>
                <dt>Enviar mensagem</dt>
                <dd>
                  <kbd>Enter</kbd>
                </dd>
              </div>
              <div>
                <dt>Colocar na fila (com o agente trabalhando)</dt>
                <dd>
                  <kbd>Enter</kbd>
                </dd>
              </div>
              <div>
                <dt>Enviar agora (interrompe a resposta)</dt>
                <dd>
                  <kbd>Ctrl</kbd>
                  <kbd>Enter</kbd>
                </dd>
              </div>
              <div>
                <dt>Nova linha</dt>
                <dd>
                  <kbd>Shift</kbd>
                  <kbd>Enter</kbd>
                </dd>
              </div>
              <div>
                <dt>Nova conversa</dt>
                <dd>
                  <kbd>{shortcut}</kbd>
                </dd>
              </div>
              <div>
                <dt>Paleta de comandos</dt>
                <dd>
                  <kbd>{shortcut.startsWith('⌘') ? '⌘P' : 'Ctrl P'}</kbd>
                </dd>
              </div>
              <div>
                <dt>Fechar menus e janelas</dt>
                <dd>
                  <kbd>Esc</kbd>
                </dd>
              </div>
            </dl>
            <button type="button" className="primary-button help-done" onClick={() => setHelpOpen(false)}>
              Entendi
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
