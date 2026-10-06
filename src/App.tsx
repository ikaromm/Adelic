import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Activity, ArrowDown, ArrowUp, Bot, Check, ChevronDown, ChevronRight, CircleHelp, Clock3, Code2,
  Command, FileText, Folder, FolderPlus, Gauge, History, Layers3, LoaderCircle,
  GitBranch, MessageSquare, Plus, RefreshCw, Search, Settings as SettingsIcon, Shield, Sparkles, Square,
  X, Zap, Brain, PanelLeftClose, PanelLeftOpen, Menu,
} from 'lucide-react';
import type { Bootstrap, DelegatedTask, GraphifyQueryResult, GraphifyStatus, Message, OrchestrationConfig, Project, ProjectCoordination, Run, Session, SessionDetail, StreamEvent } from '../shared/contracts';
import { api } from './api';
import SharedMemoryPage from './MemoryPage';
import { BrandMark } from './BrandMark';
import { bootstrapSelection, sidebarSessions } from './selection';
import { activityForRun, activityIsVisible, actionNeedsDisclosure, commandPreview, commandTitle, runStatusLabel, statusLabel } from './run-activity';
import { compatibleThinking, supportedThinking, thinkingLabel } from './reasoning';
import { ChoiceMenu, ConversationMenu, ModelMenu } from './ComposerMenus';
import { CopyButton, Markdown } from './Markdown';
import { formatDuration, newConversationShortcut, relativeTime } from './format';
import { useNow } from './useNow';
import { projectOrchestration } from '../shared/contracts';

type Page = 'chat' | 'activity' | 'memory' | 'settings';
type LocalStream = { runId: string; messageId: string; content: string };

function timeLabel(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function shortDate(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

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
  const [projectForm, setProjectForm] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [projectMemoryWorkspace, setProjectMemoryWorkspace] = useState('pessoal');
  const [projectMemoryProject, setProjectMemoryProject] = useState('');
  const [projectMemoryProjectCustom, setProjectMemoryProjectCustom] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [projectQuery, setProjectQuery] = useState('');
  const [graphQueryResult, setGraphQueryResult] = useState<GraphifyQueryResult | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);
  const [taskOutputs, setTaskOutputs] = useState<Record<string, string | null>>({});
  const [loadingTaskOutputs, setLoadingTaskOutputs] = useState<Set<string>>(() => new Set());
  const conversationRef = useRef<HTMLElement>(null);
  const stickToBottomRef = useRef(true);
  const focusComposerRef = useRef(false);
  const [showJump, setShowJump] = useState(false);
  const [expandedLists, setExpandedLists] = useState<Record<string, boolean>>({});
  const now = useNow(60_000);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const activeRunIdRef = useRef<string | undefined>(undefined);
  const bootstrapRequestRef = useRef(0);
  const detailRequestRef = useRef(new Map<string, number>());
  const detailSnapshotRef = useRef<SessionDetail | null>(null);
  const taskOutputRequestsRef = useRef(new Map<string, number>());
  const projectRequestRef = useRef(new Map<string, number>());
  const graphActionRef = useRef(0);
  const projectWriteRef = useRef(new Map<string, Promise<void>>());
  const projectRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const projectSnapshotRef = useRef<Bootstrap | null>(null);
  const sessionWriteRef = useRef(new Map<string, Promise<void>>());
  const settingsWriteRef = useRef<Promise<void>>(Promise.resolve());
  const settingsPendingRef = useRef(0);
  const permissionTargetRef = useRef<{ sandbox: 'read-only' | 'workspace-write'; approvalMode: 'auto-safe' | 'manual' } | null>(null);
  const [settingsPending, setSettingsPending] = useState(false);
  const [pendingSendSession, setPendingSendSession] = useState('');
  const pendingSendRef = useRef<{ sessionId: string; cancelRequested: boolean; accepted: boolean; cancelSucceeded?: boolean; cancelPromise?: Promise<void>; cancelError?: Error } | null>(null);
  const selectedProjectRef = useRef(selectedProject);
  selectedProjectRef.current = selectedProject;
  const selectedSessionRef = useRef(selectedSession);
  selectedSessionRef.current = selectedSession;
  projectSnapshotRef.current = data;
  detailSnapshotRef.current = detail;
  const selectSession = (id: string) => { selectedSessionRef.current = id; setSelectedSession(id); };
  const invalidateBootstrapRefreshes = () => { bootstrapRequestRef.current++; };
  const selectConversation = (id: string) => {
    const next = projectSnapshotRef.current?.sessions.find((item) => item.id === id);
    selectProject(next?.projectId || '');
    selectSession(id);
  };
  const selectProject = (id: string) => {
    if (id !== selectedProjectRef.current) { selectedProjectRef.current = id; graphActionRef.current++; setProjectBusy(false); }
    setSelectedProject(id);
  };

  const refreshBootstrap = useCallback(async (preserveSelection = true) => {
    const requestId = ++bootstrapRequestRef.current;
    let next = await api.bootstrap();
    try {
      const health = await api.health();
      const memory = next.integrations.find((item) => item.kind === 'memory');
      if (memory) next = { ...next, integrations: next.integrations.map((item) => item === memory ? { ...item, status: health.memory as typeof item.status, detail: health.memory === 'ready' ? 'Servidor MCP local disponível' : 'Servidor MCP local indisponível' } : item) };
    } catch { /* Keep the bootstrap snapshot when health is temporarily unavailable. */ }
    if (requestId !== bootstrapRequestRef.current) return;
    const preserveSettings = settingsPendingRef.current > 0;
    setData((current) => preserveSettings && current ? { ...next, settings: current.settings } : next);
    const { projectId, sessionId } = bootstrapSelection(next, selectedProjectRef.current, selectedSessionRef.current, preserveSelection);
    selectProject(projectId);
    selectSession(sessionId);
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    if (!id) { setDetail(null); return; }
    if (id !== selectedSessionRef.current) return;
    const requestId = (detailRequestRef.current.get(id) || 0) + 1;
    detailRequestRef.current.set(id, requestId);
    const next = await api.detail(id);
    if (detailRequestRef.current.get(id) !== requestId || id !== selectedSessionRef.current) return;
    setDetail(next);
    setData((current) => current ? {
      ...current,
      sessions: current.sessions.map((session) => session.id === next.session.id ? next.session : session),
      runs: [...current.runs.filter((run) => !next.runs.some((incoming) => incoming.id === run.id)), ...next.runs],
    } : current);
    if (next.session.activeRunId) {
      const runId = next.session.activeRunId;
      const partial = next.messages.find((message) => message.role === 'assistant' && message.runId === runId);
      setStream((current) => {
        if (current && current.runId === runId) {
          return partial && partial.content.length > current.content.length
            ? { ...current, messageId: partial.id, content: partial.content } : current;
        }
        return partial ? { runId, messageId: partial.id, content: partial.content } : null;
      });
    }
    else setStream(null);
  }, []);

  useEffect(() => {
    void refreshBootstrap(false).catch((error: Error) => setNotice(error.message));
  }, []);

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
    else setNotice(coordinationResult.reason instanceof Error ? coordinationResult.reason.message : 'Não foi possível carregar o resumo do projeto.');
    if (graphifyResult.status === 'fulfilled') setGraphifyStatus(graphifyResult.value);
    else setGraphifyStatus(null);
  }, []);

  useEffect(() => {
    setCoordination(null);
    setGraphifyStatus(null);
    setGraphQueryResult(null);
    setProjectQuery('');
    if (selectedProject) void refreshProjectViews(selectedProject);
    return () => { if (projectRefreshTimerRef.current) clearTimeout(projectRefreshTimerRef.current); };
  }, [selectedProject, refreshProjectViews]);

  useEffect(() => {
    const events = new EventSource('/api/events');
    const reconcile = () => {
      void refreshBootstrap().catch((error: Error) => setNotice(error.message));
      if (selectedSession) void refreshDetail(selectedSession).catch(() => undefined);
    };
    events.onmessage = (message) => {
      let event: StreamEvent;
      try { event = JSON.parse(message.data) as StreamEvent; } catch { return; }
      if (event.type === 'refresh') { reconcile(); if (selectedProjectRef.current) void refreshProjectViews(selectedProjectRef.current); return; }
      const eventSessionId = event.type === 'message' ? event.message.sessionId
        : event.type === 'event' ? event.event.sessionId
          : event.type === 'approval' ? event.approval.sessionId
            : event.type === 'session' ? event.session.id
              : event.type === 'run' ? event.run.sessionId
                : event.type === 'task' ? event.task.sessionId
                  : event.type === 'delta' ? event.sessionId : undefined;
      if (eventSessionId === selectedSession) {
        detailRequestRef.current.set(selectedSession, (detailRequestRef.current.get(selectedSession) || 0) + 1);
      }
      if (event.type === 'session') {
        if (event.session.id === selectedSession) activeRunIdRef.current = event.session.activeRunId;
        setData((current) => current ? { ...current, sessions: current.sessions.map((s) => s.id === event.session.id ? event.session : s) } : current);
      }
      if (event.type === 'run') {
        setData((current) => current ? { ...current, runs: [...current.runs.filter((run) => run.id !== event.run.id), event.run] } : current);
        if (event.run.sessionId === selectedSession && event.run.status !== 'running') {
          setTimeout(() => { void refreshDetail(selectedSession).catch(() => undefined); }, 120);
        }
      }
      if (event.type === 'task') {
        if (event.task.sessionId === selectedSession) setTimeout(() => { void refreshDetail(event.task.sessionId).catch(() => undefined); }, 100);
        const taskProjectId = event.task.projectId;
        if (taskProjectId && taskProjectId === selectedProjectRef.current) {
          if (projectRefreshTimerRef.current) clearTimeout(projectRefreshTimerRef.current);
          projectRefreshTimerRef.current = setTimeout(() => { void refreshProjectViews(taskProjectId); }, 180);
        }
      }
      if (event.type === 'message' && event.message.sessionId === selectedSession) {
        setDetail((current) => current ? { ...current, messages: [...current.messages.filter((m) => m.id !== event.message.id), event.message].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) } : current);
        if (event.message.role === 'assistant') setStream(null);
      }
      if (event.type === 'delta' && event.sessionId === selectedSession) {
        if (event.runId !== activeRunIdRef.current) return;
        setStream((current) => current?.messageId === event.messageId
          ? { ...current, content: current.content + event.text }
          : { runId: event.runId, messageId: event.messageId, content: event.text });
      }
      if ((event.type === 'event' && event.event.sessionId === selectedSession) || (event.type === 'approval' && event.approval.sessionId === selectedSession)) {
        void refreshDetail(selectedSession).catch(() => undefined);
      }
    };
    events.onerror = () => { /* EventSource reconnects; the server sends a fresh snapshot signal. */ };
    return () => events.close();
  }, [refreshBootstrap, refreshDetail, refreshProjectViews, selectedSession]);

  // Follow new content only while the reader is at the end; reading history is never interrupted.
  // Approvals, tasks and error rows count as new content too, not only messages and streamed text.
  const pendingApprovalCount = detail?.approvals.filter((item) => item.status === 'pending').length ?? 0;
  useLayoutEffect(() => { stickToBottomRef.current = true; setShowJump(false); }, [selectedSession, page]);
  useLayoutEffect(() => {
    const element = conversationRef.current;
    if (element && stickToBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [detail?.messages.length, detail?.session.id, detail?.tasks?.length, detail?.events.length, pendingApprovalCount, stream?.content, selectedSession, page]);
  const onConversationScroll = () => {
    const element = conversationRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
    stickToBottomRef.current = atBottom;
    setShowJump(!atBottom);
  };

  const project = data?.projects.find((p) => p.id === selectedProject);
  const currentDetail = detail?.session.id === selectedSession ? detail : null;
  const session = currentDetail?.session || data?.sessions.find((s) => s.id === selectedSession);
  const composer = drafts[selectedSession] || '';
  const pendingSendForSession = pendingSendSession === session?.id;
  const canCancelCurrentSend = Boolean(session?.activeRunId) || pendingSendForSession;
  const provider = data?.providers.find((p) => p.id === (session?.providerId || data?.settings.defaultProviderId));
  const thinkingOptions = supportedThinking(provider, session?.model);
  const reasoningUnavailable = provider?.capabilities.reasoning === false;
  const activeRun = currentDetail?.runs.find((run) => run.id === session?.activeRunId && run.status === 'running');
  activeRunIdRef.current = session?.activeRunId;
  const projectSessions = useMemo(() => data?.sessions.filter((s) => s.projectId === selectedProject) || [], [data?.sessions, selectedProject]);
  const detachedSessions = useMemo(() => data?.sessions.filter((s) => s.projectId === null) || [], [data?.sessions]);
  const conversationProject = data?.projects.find((item) => item.id === session?.projectId);
  const messages = currentDetail?.messages || [];
  const activityEvents = currentDetail?.events || [];
  const activityTasks = currentDetail?.tasks || [];

  // Grow the message field with its content; CSS caps the height and scrolls beyond it.
  useLayoutEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [composer, selectedSession, page, session?.activeRunId]);
  useEffect(() => {
    if (!focusComposerRef.current || page !== 'chat') return;
    const element = composerRef.current;
    if (!element || element.disabled) return;
    focusComposerRef.current = false;
    element.focus();
  }, [selectedSession, page, currentDetail?.session.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        void newConversation();
      }
      if (event.key === 'Escape') { setProjectForm(false); setHelpOpen(false); setSidebarOpen(false); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [data, busy]);

  async function createProject(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setNotice('');
    try {
      const projectSlug = projectMemoryProject.trim() || projectName.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const created = await api.createProject({ name: projectName.trim(), path: projectPath.trim(), memoryWorkspace: projectMemoryWorkspace.trim(), memoryProject: projectSlug });
      invalidateBootstrapRefreshes();
      setProjectForm(false); setProjectName(''); setProjectPath(''); setProjectMemoryProject(''); setProjectMemoryProjectCustom(false);
      await refreshBootstrap(false); selectProject(created.id); selectSession('');
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  }

  async function newConversation(projectId: string | null = null) {
    if (!data || busy) return;
    setBusy(true); setNotice('');
    try {
      const created = await api.createSession({ projectId, providerId: data.settings.defaultProviderId, mode: data.settings.defaultMode });
      invalidateBootstrapRefreshes();
      setData((current) => current ? { ...current, sessions: [created, ...current.sessions] } : current);
      focusComposerRef.current = true;
      selectProject(created.projectId || ''); selectSession(created.id); setPage('chat'); setSidebarOpen(false);
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  }

  async function startSuggestedPrompt(text: string) {
    if (!data || busy || settingsPendingRef.current) return;
    setBusy(true); setNotice('');
    try {
      const created = await api.createSession({ projectId: null, providerId: data.settings.defaultProviderId, mode: data.settings.defaultMode, title: text.trim().split(/\s+/).slice(0, 6).join(' ') });
      invalidateBootstrapRefreshes();
      setData((current) => current ? { ...current, sessions: [created, ...current.sessions] } : current);
      selectProject(''); selectSession(created.id); setPage('chat'); setSidebarOpen(false);
      await api.send(created.id, text, crypto.randomUUID());
      await refreshDetail(created.id);
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  }

  async function sendMessage(value = composer) {
    const content = value.trim();
    if (!content || !session || busy || session.activeRunId || settingsPendingRef.current) return;
    const sessionId = session.id;
    const pendingSend: NonNullable<typeof pendingSendRef.current> = { sessionId, cancelRequested: false, accepted: false };
    pendingSendRef.current = pendingSend;
    setPendingSendSession(sessionId);
    setDrafts((current) => ({ ...current, [sessionId]: '' })); setBusy(true); setNotice('');
    stickToBottomRef.current = true; setShowJump(false);
    const optimistic: Message = { id: `local-${crypto.randomUUID()}`, sessionId, role: 'user', content, createdAt: new Date().toISOString() };
    setDetail((current) => current?.session.id === sessionId ? { ...current, messages: [...current.messages, optimistic] } : current);
    let accepted = false;
    try {
      const acceptedRun = await api.send(sessionId, content, crypto.randomUUID());
      accepted = true;
      pendingSend.accepted = true;
      setDetail((current) => current?.session.id === sessionId ? {
        ...current,
        session: { ...current.session, activeRunId: acceptedRun.runId },
        messages: [...current.messages.filter((message) => message.id !== optimistic.id && message.id !== acceptedRun.messageId), { ...optimistic, id: acceptedRun.messageId, runId: acceptedRun.runId, status: 'running', providerId: session.providerId }],
      } : current);
      setData((current) => current ? { ...current, sessions: current.sessions.map((item) => item.id === sessionId ? { ...item, activeRunId: acceptedRun.runId } : item) } : current);
      if (pendingSend.cancelRequested) {
        if (pendingSend.cancelPromise) await pendingSend.cancelPromise.catch(() => undefined);
        if (!pendingSend.cancelSucceeded) {
          try { await api.cancel(sessionId); }
          catch (error) { if (selectedSessionRef.current === sessionId) setNotice((error as Error).message); }
        }
      }
      try { await refreshDetail(sessionId); }
      catch { if (selectedSessionRef.current === sessionId) setNotice('Mensagem enviada. Reconectando para acompanhar a resposta.'); }
    } catch (error) {
      if (!accepted) {
        setDetail((current) => current?.session.id === sessionId ? { ...current, messages: current.messages.filter((message) => message.id !== optimistic.id) } : current);
        setDrafts((current) => ({ ...current, [sessionId]: current[sessionId] ? `${content}\n${current[sessionId]}` : content }));
        if (selectedSessionRef.current === sessionId) setNotice((error as Error).message);
      }
    } finally {
      if (pendingSendRef.current === pendingSend) { pendingSendRef.current = null; setPendingSendSession(''); }
      setBusy(false);
    }
  }

  async function cancelPendingSend(sessionId: string) {
    const pending = pendingSendRef.current;
    if (!pending || pending.sessionId !== sessionId || session?.id !== sessionId) return;
    pending.cancelRequested = true;
    pending.cancelPromise = api.cancel(sessionId);
    try { await pending.cancelPromise; pending.cancelSucceeded = true; }
    catch (error) {
      pending.cancelError = error as Error;
      if (pending.accepted && selectedSessionRef.current === sessionId) setNotice(pending.cancelError.message);
    }
  }

  async function changeSession(patch: Partial<Pick<Session, 'providerId' | 'mode' | 'projectId' | 'thinking'>> & { model?: string | null }) {
    if (!session || busy || session.activeRunId) return;
    const sessionId = session.id;
    setBusy(true); setNotice('');
    const targetProviderId = patch.providerId || session.providerId;
    const targetProvider = data?.providers.find((item) => item.id === targetProviderId);
    const modelWasChanged = Object.hasOwn(patch, 'model');
    const providerWasChanged = targetProviderId !== session.providerId;
    const targetModel = modelWasChanged ? patch.model || undefined : providerWasChanged ? targetProvider?.defaultModel : session.model || targetProvider?.defaultModel;
    const writePatch = { ...patch };
    const thinkingWasReset = (providerWasChanged || modelWasChanged) && Boolean(session.thinking && !supportedThinking(targetProvider, targetModel).includes(session.thinking));
    if (providerWasChanged && !modelWasChanged) writePatch.model = null;
    if (Object.hasOwn(patch, 'thinking') || providerWasChanged || modelWasChanged) {
      writePatch.thinking = compatibleThinking(patch.thinking || session.thinking, targetProvider, targetModel);
    }
    const request = (sessionWriteRef.current.get(sessionId) || Promise.resolve()).then(() => api.updateSession(sessionId, writePatch));
    const settled = request.then(() => undefined, () => undefined);
    sessionWriteRef.current.set(sessionId, settled);
    try {
      const updated = await request;
      invalidateBootstrapRefreshes();
      setDetail((current) => current?.session.id === sessionId && selectedSessionRef.current === sessionId ? { ...current, session: { ...updated, activeRunId: current.session.activeRunId ?? updated.activeRunId } } : current);
      setData((current) => current ? { ...current, sessions: current.sessions.map((s) => s.id === sessionId ? { ...updated, activeRunId: s.activeRunId ?? updated.activeRunId } : s) } : current);
      if (selectedSessionRef.current === sessionId && Object.hasOwn(patch, 'projectId')) selectProject(updated.projectId || '');
      if (thinkingWasReset && selectedSessionRef.current === sessionId) setNotice('O nível de Thinking não existe no modelo escolhido; ajustado para Automático.');
    } catch (error) { if (selectedSessionRef.current === sessionId) setNotice((error as Error).message); }
    finally { if (sessionWriteRef.current.get(sessionId) === settled) sessionWriteRef.current.delete(sessionId); setBusy(false); }
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
        const next = { ...snapshot, projects: snapshot.projects.map((item) => item.id === projectId ? updated : item) };
        projectSnapshotRef.current = next;
        setData(next);
      }
      if (selectedProjectRef.current === projectId) void refreshProjectViews(projectId);
    });
    const settled = request.then(() => undefined, () => undefined);
    projectWriteRef.current.set(projectId, settled);
    try { await request; }
    catch (error) { if (selectedProjectRef.current === projectId) setNotice((error as Error).message); }
    finally { if (projectWriteRef.current.get(projectId) === settled) projectWriteRef.current.delete(projectId); }
  }

  async function changeGraphifyEnabled(projectId: string, enabled: boolean) {
    const action = ++graphActionRef.current;
    setProjectBusy(true); setNotice('');
    try {
      const updated = await api.updateProject(projectId, { graphify: { enabled } });
      if (selectedProjectRef.current === projectId && graphActionRef.current === action) {
        setData((snapshot) => snapshot ? { ...snapshot, projects: snapshot.projects.map((item) => item.id === projectId ? updated : item) } : snapshot);
        await refreshProjectViews(projectId);
      }
    } catch (error) { if (selectedProjectRef.current === projectId && graphActionRef.current === action) setNotice((error as Error).message); }
    finally { if (graphActionRef.current === action) setProjectBusy(false); }
  }

  async function changeProjectMemoryScope(projectId: string, memoryWorkspace: string, memoryProject: string) {
    try { const updated = await api.updateProject(projectId, { memoryWorkspace, memoryProject }); setData(current => current ? { ...current, projects: current.projects.map(item => item.id === projectId ? updated : item) } : current); }
    catch (error) { setNotice((error as Error).message); }
  }

  async function indexProject(projectId: string) {
    const action = ++graphActionRef.current;
    setProjectBusy(true); setNotice('');
    try { const status = await api.indexGraphify(projectId); if (selectedProjectRef.current === projectId && graphActionRef.current === action) setGraphifyStatus(status); }
    catch (error) { if (selectedProjectRef.current === projectId && graphActionRef.current === action) { setNotice((error as Error).message); void refreshProjectViews(projectId); } }
    finally { if (graphActionRef.current === action) setProjectBusy(false); }
  }

  async function queryProjectGraph(event: FormEvent) {
    event.preventDefault();
    if (!project || !projectQuery.trim()) return;
    const projectId = project.id;
    const action = ++graphActionRef.current;
    setProjectBusy(true); setNotice(''); setGraphQueryResult(null);
    try { const result = await api.queryGraphify(projectId, projectQuery.trim()); if (selectedProjectRef.current === projectId && graphActionRef.current === action) { setGraphQueryResult(result); setGraphifyStatus(result.status); } }
    catch (error) { if (selectedProjectRef.current === projectId && graphActionRef.current === action) setNotice((error as Error).message); }
    finally { if (graphActionRef.current === action) setProjectBusy(false); }
  }

  async function loadTaskOutput(task: DelegatedTask) {
    if (task.status === 'running' || task.status === 'queued' || Object.hasOwn(taskOutputs, task.id)) return;
    if (selectedSessionRef.current !== task.sessionId) return;
    const detailAtStart = detailSnapshotRef.current;
    if (!detailAtStart?.tasks?.some((item) => item.id === task.id && item.runId === task.runId)) return;
    const requestId = (taskOutputRequestsRef.current.get(task.id) || 0) + 1;
    taskOutputRequestsRef.current.set(task.id, requestId);
    setLoadingTaskOutputs((current) => new Set(current).add(task.id));
    const isCurrent = () => {
      const latest = detailSnapshotRef.current;
      return selectedSessionRef.current === task.sessionId
        && latest?.session.id === task.sessionId
        && latest.tasks?.some((item) => item.id === task.id && item.runId === task.runId);
    };
    try {
      const fullTask = await api.task(task.id);
      if (taskOutputRequestsRef.current.get(task.id) !== requestId || !isCurrent()) return;
      if (fullTask.id !== task.id || fullTask.projectId !== task.projectId || fullTask.sessionId !== task.sessionId || fullTask.runId !== task.runId) return;
      setTaskOutputs((current) => ({ ...current, [task.id]: fullTask.output ?? null }));
    } catch (error) {
      if (taskOutputRequestsRef.current.get(task.id) === requestId && isCurrent()) setNotice((error as Error).message);
    } finally {
      if (taskOutputRequestsRef.current.get(task.id) === requestId) {
        taskOutputRequestsRef.current.delete(task.id);
        setLoadingTaskOutputs((current) => { const next = new Set(current); next.delete(task.id); return next; });
      }
    }
  }

  async function updateSetting(key: 'defaultProviderId' | 'defaultMode' | 'memoryEnabled' | 'sandbox' | 'responseStyle' | 'approvalMode', value: string | boolean) {
    if (!data) return;
    if (key === 'sandbox' || key === 'approvalMode') {
      const current = permissionTargetRef.current || { sandbox: data.settings.sandbox, approvalMode: data.settings.approvalMode || 'auto-safe' };
      void updatePermissions(key === 'sandbox' ? value as 'read-only' | 'workspace-write' : current.sandbox, key === 'approvalMode' ? value as 'auto-safe' | 'manual' : current.approvalMode);
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
    settingsWriteRef.current = request.then(() => undefined, () => undefined);
    try {
      const settings = await request;
      setData((current) => current ? { ...current, settings } : current);
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

  const createTitle = (text: string) => text.trim().split(/\s+/).slice(0, 6).join(' ') || 'Nova conversa';

  const shortcut = newConversationShortcut();
  const memoryIntegration = data?.integrations.find((item) => item.kind === 'memory');
  const memoryStatus = memoryIntegration?.status === 'ready' ? 'conectada' : memoryIntegration?.status === 'planned' ? 'verificando' : 'indisponível';
  const detachedList = sidebarSessions(detachedSessions, SIDEBAR_LIMIT, Boolean(expandedLists.detached), selectedSession);
  const projectList = sidebarSessions(projectSessions, SIDEBAR_LIMIT, Boolean(expandedLists[selectedProject]), selectedSession);
  const latestSession = (projectId: string) => sidebarSessions((data?.sessions || []).filter((item) => item.projectId === projectId), 1, false, '').items[0];
  const goTo = (next: Page) => { if (next === 'memory') setMemoryVisited(true); setPage(next); setSidebarOpen(false); };
  const openConversation = (id: string) => { selectConversation(id); setPage('chat'); setSidebarOpen(false); };
  const toggleList = (key: string, expanded: boolean) => setExpandedLists((current) => ({ ...current, [key]: expanded }));
  const conversationContext = conversationProject ? conversationProject.orchestration?.enabled === false ? 'Execução direta, sem delegação.' : `Orquestração ativa: ${provider?.name || 'agente da conversa'} coordena tarefas com contexto enxuto.` : 'Conversa avulsa: sem contexto ou configuração de projeto.';
  const pageTitle = page === 'chat' ? (session ? conversationProject?.name || 'Conversa avulsa' : project?.name || 'Conversas') : page === 'activity' ? 'Atividade' : page === 'memory' ? 'Memória' : 'Configurações';
  const scrollToLatest = () => {
    const element = conversationRef.current;
    if (!element) return;
    stickToBottomRef.current = true;
    setShowJump(false);
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    element.scrollTo({ top: element.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
  };

  return <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-mobile-open' : ''}`} aria-label="Barra lateral">
      <div className="sidebar-header">
        <div className="brand"><BrandMark /><span className="brand-name">adelic</span></div>
        <button className="icon-button sidebar-collapse" aria-label={sidebarCollapsed ? 'Expandir navegação' : 'Recolher navegação'} title={sidebarCollapsed ? 'Expandir navegação' : 'Recolher navegação'} aria-expanded={!sidebarCollapsed} onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>{sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
        <button className="icon-button sidebar-close" aria-label="Fechar navegação" title="Fechar navegação" onClick={() => setSidebarOpen(false)}><X size={16} /></button>
      </div>
      <button className="new-chat-button" title={`Nova conversa (${shortcut})`} onClick={() => void newConversation()} disabled={busy}>
        <Plus size={16} /><span className="sidebar-label">Nova conversa</span><kbd>{shortcut}</kbd>
      </button>
      <div className="sidebar-scroll">
        <section className="sidebar-section sidebar-detached" aria-labelledby="sidebar-detached-title">
          <div className="sidebar-section-heading"><h2 id="sidebar-detached-title" className="sidebar-label">Conversas avulsas</h2></div>
          <div className="session-list detached-conversations">
            {detachedList.items.map((itemSession) => <SessionItem key={itemSession.id} session={itemSession} selected={itemSession.id === selectedSession} now={now} onSelect={() => openConversation(itemSession.id)} />)}
            {detachedList.hidden > 0 && <button type="button" className="sidebar-more" onClick={() => toggleList('detached', true)}>Mostrar mais ({detachedList.hidden})</button>}
            {expandedLists.detached && detachedSessions.length > SIDEBAR_LIMIT && <button type="button" className="sidebar-more" onClick={() => toggleList('detached', false)}>Mostrar menos</button>}
            {detachedSessions.length === 0 && <p className="sidebar-empty">Nenhuma conversa avulsa.</p>}
          </div>
        </section>
        <section className="sidebar-section sidebar-projects" aria-labelledby="sidebar-projects-title">
          <div className="sidebar-section-heading"><h2 id="sidebar-projects-title" className="sidebar-label">Projetos</h2><button className="icon-button sidebar-add" aria-label="Adicionar projeto" title="Adicionar projeto" onClick={() => setProjectForm(true)}><Plus size={15} /></button></div>
          <div className="project-list">
            {data?.projects.map((item) => {
              const expanded = item.id === selectedProject;
              return <div key={item.id} className="project-group">
                <div className={`project-row ${expanded ? 'selected' : ''}`}>
                  <button className="project-item" aria-expanded={expanded} title={item.name} onClick={() => { const latest = latestSession(item.id); selectProject(item.id); selectSession(latest?.id || ''); setPage('chat'); }}>
                    <Folder size={15} className="project-icon" aria-hidden="true" /><span className="sidebar-label">{item.name}</span><ChevronRight size={14} className="project-chevron" aria-hidden="true" />
                  </button>
                  <button className="project-new-chat" aria-label={`Nova conversa em ${item.name}`} title={`Nova conversa em ${item.name}`} disabled={busy} onClick={() => void newConversation(item.id)}><Plus size={14} /></button>
                </div>
                {expanded && projectSessions.length > 0 && <div className="session-list">
                  {projectList.items.map((itemSession) => <SessionItem key={itemSession.id} session={itemSession} selected={itemSession.id === selectedSession} now={now} onSelect={() => openConversation(itemSession.id)} />)}
                  {projectList.hidden > 0 && <button type="button" className="sidebar-more" onClick={() => toggleList(item.id, true)}>Mostrar mais ({projectList.hidden})</button>}
                  {expandedLists[item.id] && projectSessions.length > SIDEBAR_LIMIT && <button type="button" className="sidebar-more" onClick={() => toggleList(item.id, false)}>Mostrar menos</button>}
                </div>}
              </div>;
            })}
            {data?.projects.length === 0 && <p className="sidebar-empty">Nenhum projeto cadastrado.</p>}
          </div>
        </section>
      </div>
      <nav className="sidebar-footer" aria-label="Navegação principal">
        <button className={`nav-item ${page === 'activity' ? 'active' : ''}`} aria-current={page === 'activity' ? 'page' : undefined} title="Atividade" onClick={() => goTo('activity')}><Activity size={16} aria-hidden="true" /><span className="sidebar-label">Atividade</span></button>
        <button className={`nav-item ${page === 'memory' ? 'active' : ''}`} aria-current={page === 'memory' ? 'page' : undefined} title={`Memória · ${memoryStatus}`} onClick={() => goTo('memory')}><Brain size={16} aria-hidden="true" /><span className="sidebar-label">Memória</span><span className={`nav-status ${memoryIntegration?.status === 'ready' ? 'ready' : 'muted'}`} aria-hidden="true" /><span className="visually-hidden">, {memoryStatus}</span></button>
        <button className={`nav-item ${page === 'settings' ? 'active' : ''}`} aria-current={page === 'settings' ? 'page' : undefined} title="Configurações" onClick={() => goTo('settings')}><SettingsIcon size={16} aria-hidden="true" /><span className="sidebar-label">Configurações</span></button>
      </nav>
    </aside>
    {sidebarOpen && <button className="mobile-scrim" aria-label="Fechar navegação" onClick={() => setSidebarOpen(false)} />}

    <main className="main-area">
      <header className="topbar">
        <div className="topbar-left"><button className="icon-button mobile-menu" aria-label="Abrir navegação" onClick={() => setSidebarOpen(true)}><Menu size={18} /></button><div className="breadcrumbs"><span className="crumb">{pageTitle}</span>{page === 'chat' && session && <><span className="crumb-separator" aria-hidden="true">/</span><strong title={session.title || 'Nova conversa'}>{session.title || 'Nova conversa'}</strong></>}</div></div>
        <div className="topbar-right"><span className="local-badge" title="Executa neste computador; o servidor escuta somente em 127.0.0.1"><span className="status-dot ready" aria-hidden="true" />Local</span><button className="icon-button help-button" aria-label="Ajuda" title="Ajuda" onClick={() => setHelpOpen(true)}><CircleHelp size={17} /></button></div>
      </header>

      {!data && <div className="loading-screen"><LoaderCircle className="spin" size={22} /><span>Conectando ao Adelic…</span>{notice && <p className="error-text">{notice}</p>}</div>}
      {data && page === 'chat' && (!session ? <div className="welcome-view">
        <div className="welcome-orb" aria-hidden="true"><Sparkles size={22} /></div>
        <h1>O que vamos construir hoje?</h1>
        <p>Comece sem uma pasta ou escolha um projeto depois.</p>
        <button className="primary-button" onClick={() => void newConversation()} disabled={busy}><Plus size={16} /> Começar uma conversa</button>
        <div className="welcome-suggestions">{['Resuma uma ideia para mim', 'Encontre um caminho para começar', 'Revise uma ideia que estou explorando'].map((suggestion) => <button key={suggestion} onClick={() => void startSuggestedPrompt(suggestion)} disabled={busy}><span>{suggestion}</span><ArrowUp size={14} aria-hidden="true" /></button>)}</div>
      </div> : <div className="chat-view">
        <section className="conversation" aria-label="Conversa" ref={conversationRef} onScroll={onConversationScroll}>
          <div className="message-column">
            {messages.length === 0 && !stream && <div className="conversation-empty"><div className="empty-icon" aria-hidden="true"><MessageSquare size={18} /></div><h2>Uma boa conversa começa com uma pergunta.</h2><p>{conversationProject ? <>O agente usa o contexto de <strong>{conversationProject.name}</strong> quando necessário.</> : 'Converse livremente ou vincule um projeto no menu de projeto e modo, junto ao campo de mensagem.'}</p><div className="prompt-chips">{(conversationProject ? ['Explique a estrutura deste projeto', 'Quais são os próximos passos?', 'Me ajude a resolver um problema'] : ['Explique o que é recursão', 'Me ajude a organizar uma ideia', 'Me ajude a resolver um problema']).map((text) => <button key={text} onClick={() => void sendMessage(text)}><span>{text}</span><ArrowUp size={13} aria-hidden="true" /></button>)}</div></div>}
            {messages.filter((message) => message.id !== stream?.messageId).map((message) => <div className="timeline-message" key={message.id}><MessageCard message={message} providerName={data.providers.find((p) => p.id === (message.providerId || session.providerId))?.name || 'Adelic'} />{message.role === 'user' && message.runId && <RunActivityPanel runId={message.runId} run={currentDetail?.runs.find((run) => run.id === message.runId)} tasks={activityTasks} events={activityEvents} providers={data.providers} active={session.activeRunId === message.runId} taskOutputs={taskOutputs} loadingTaskOutputs={loadingTaskOutputs} onLoadTaskOutput={loadTaskOutput} />}</div>)}
            {stream && <div className="message-row assistant-row streaming"><div className="message-author"><span className="assistant-glyph" aria-hidden="true"><Sparkles size={12} /></span><strong>{provider?.name || 'Agente'}</strong><span className="streaming-label"><i aria-hidden="true" />escrevendo</span></div>{stream.content ? <Markdown>{stream.content}</Markdown> : <div className="markdown-content"><span className="typing-caret" aria-hidden="true" /></div>}</div>}
            {activityEvents.filter((item) => item.type === 'error' && !messages.some((message) => message.role === 'user' && message.runId === item.runId)).map((item) => <RunEventRow key={item.id} event={item} />)}
            {currentDetail?.approvals.filter((item) => item.status === 'pending').map((approval) => <div className={`approval-card ${approval.kind}`} key={approval.id} role="region" aria-label={approval.title || 'Aprovação necessária'}><div className="approval-icon" aria-hidden="true"><Shield size={16} /></div><div className="approval-copy"><strong>{approval.title || 'Aprovação necessária'}</strong><p>{approval.detail}</p><span>{approval.kind === 'command' ? 'Comando' : approval.kind === 'file' ? 'Arquivo' : 'Ferramenta'} · confirme esta ação para continuar</span></div><div className="approval-actions"><button className="secondary-button" onClick={() => void api.approve(approval.id, 'deny').then(() => refreshDetail(session.id)).catch((e: Error) => setNotice(e.message))}>Negar</button><button className="primary-button" onClick={() => void api.approve(approval.id, 'approve').then(() => refreshDetail(session.id)).catch((e: Error) => setNotice(e.message))}><Check size={14} /> Aprovar</button></div></div>)}
          </div>
        </section>
        <div className="composer-wrap">
          {showJump && <button type="button" className="jump-to-latest" aria-label="Ir para a mensagem mais recente" title="Ir para a mensagem mais recente" onClick={scrollToLatest}><ArrowDown size={16} /></button>}
          {notice && <div className="inline-notice error-notice" role="alert"><span>{notice}</span><button className="icon-button" onClick={() => setNotice('')} aria-label="Dispensar aviso"><X size={15} /></button></div>}
          <div className={`composer-box ${session.activeRunId ? 'is-running' : ''}`}>
            <textarea ref={composerRef} className="composer-input" value={composer} onChange={(event) => setDrafts((current) => ({ ...current, [session.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendMessage(); } }} placeholder={session.activeRunId ? 'Executando… cancele para enviar outra mensagem.' : 'Escreva uma mensagem…'} aria-label="Mensagem para o agente" rows={1} disabled={Boolean(session.activeRunId)} />
            <div className="composer-toolbar">
              <div className="composer-controls">
                <ModelMenu providers={data.providers} providerId={session.providerId} sessionId={session.id} modelId={session.model} disabled={busy || Boolean(session.activeRunId)} onChange={(providerId, model) => void changeSession(providerId === session.providerId ? { model: model || null } : { providerId, model: model || null })} />
                <ChoiceMenu label="Thinking para próximas mensagens" icon={<Brain size={14} />} value={session.thinking || 'auto'} options={thinkingOptions.map((value) => ({ value, label: thinkingLabel(value), detail: value === 'auto' ? thinkingOptions.length === 1 ? reasoningUnavailable ? 'Este agente não oferece ajuste. O esforço Automático fica a cargo do runtime.' : 'O catálogo deste modelo não anuncia níveis adicionais; Automático usa o padrão do runtime.' : 'Escolhido pela rota de cada pedido.' : undefined }))} hint={thinkingOptions.length > 1 ? 'Define o esforço de raciocínio das próximas mensagens. Os níveis seguem o catálogo do modelo escolhido.' : undefined} disabled={busy || Boolean(session.activeRunId)} onChange={(value) => void changeSession({ thinking: value })} />
                <ChoiceMenu label="Permissões" icon={<Shield size={14} />} width={340} value={`${data.settings.sandbox}|${data.settings.approvalMode || 'auto-safe'}`} disabled={settingsPending} options={[{ value: 'read-only|auto-safe', label: 'Leitura · Auto', detail: 'Confirmação automática quando disponível.' }, { value: 'read-only|manual', label: 'Leitura · Manual', detail: 'Pede confirmação quando o agente oferece essa opção.' }, { value: 'workspace-write|auto-safe', label: 'Escrita · Auto', detail: 'Alterações permitidas no projeto.' }, { value: 'workspace-write|manual', label: 'Escrita · Manual', detail: 'Pede confirmação quando o agente oferece essa opção.' }]} hint={<>O Codex aprova leituras reconhecidas. No Kiro, os pedidos ainda exigem confirmação; Claude não oferece confirmação pelo Adelic. Leituras e alterações feitas sem solicitação e scripts podem alterar ou excluir arquivos.</>} onChange={(value) => { const [sandbox, approvalMode] = value.split('|') as ['read-only' | 'workspace-write', 'auto-safe' | 'manual']; void updatePermissions(sandbox, approvalMode); }} />
                <ConversationMenu projects={data.projects} projectId={session.projectId} mode={session.mode} disabled={busy || Boolean(session.activeRunId)} context={conversationContext} onProject={(projectId) => void changeSession({ projectId })} onMode={(mode) => void changeSession({ mode })} onConfigure={conversationProject ? () => { selectProject(conversationProject.id); setPage('settings'); setSidebarOpen(false); } : undefined} />
              </div>
              <button className={`send-button ${canCancelCurrentSend ? 'stop' : ''}`} aria-label={canCancelCurrentSend ? 'Cancelar execução' : 'Enviar mensagem'} title={canCancelCurrentSend ? 'Cancelar execução' : 'Enviar (Enter)'} onClick={() => session.activeRunId ? void api.cancel(session.id).then(() => refreshDetail(session.id)).catch((e: Error) => setNotice(e.message)) : pendingSendForSession ? void cancelPendingSend(session.id) : void sendMessage()} disabled={canCancelCurrentSend ? false : !composer.trim() || busy || settingsPending}>{canCancelCurrentSend ? <Square size={12} fill="currentColor" /> : busy ? <LoaderCircle className="spin" size={16} /> : <ArrowUp size={17} />}</button>
            </div>
            {reasoningUnavailable && <span className="visually-hidden">Este agente não oferece ajustes de Thinking; somente Automático está disponível.</span>}
          </div>
        </div>
      </div>)}

      {data && page === 'activity' && <ActivityPage runs={data.runs} providers={data.providers} />}
      {data && memoryVisited && <SharedMemoryPage activated={memoryVisited} visible={page === 'memory'} />}

      {data && page === 'settings' && <SettingsPage key={project?.id || 'global'} data={data} project={project} coordination={coordination} graphifyStatus={graphifyStatus} graphQueryResult={graphQueryResult} projectQuery={projectQuery} projectBusy={projectBusy} coordinatorProviderId={session && session.projectId === project?.id ? session.providerId : data.settings.defaultProviderId} onProjectQueryChange={setProjectQuery} onProjectQuery={queryProjectGraph} onOrchestration={(patch) => project && void changeProjectOrchestration(project.id, patch)} onGraphifyEnabled={(enabled) => project && void changeGraphifyEnabled(project.id, enabled)} onIndexGraphify={() => project && void indexProject(project.id)} onRefreshProject={() => project && void refreshProjectViews(project.id)} onProjectMemoryScope={(workspace, memoryProject) => project && void changeProjectMemoryScope(project.id, workspace, memoryProject)} onSetting={updateSetting} onSkill={async (id, enabled) => { try { const result = await api.skill(id, enabled); setData((current) => current ? { ...current, skills: current.skills.map((skill) => skill.id === id ? result : skill) } : current); } catch (error) { setNotice((error as Error).message); } }} notice={notice} />}
    </main>

    {projectForm && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setProjectForm(false); }}><form className="modal-card" role="dialog" aria-modal="true" aria-labelledby="project-form-title" onSubmit={(event) => void createProject(event)}><div className="modal-heading"><div className="project-avatar" aria-hidden="true"><FolderPlus size={17} /></div><div><h2 id="project-form-title">Novo projeto</h2><p>Conecte uma pasta do seu computador.</p></div><button type="button" className="icon-button" aria-label="Fechar" onClick={() => setProjectForm(false)}><X size={17} /></button></div><label>Nome do projeto<input autoFocus value={projectName} onChange={(event) => { setProjectName(event.target.value); if (!projectMemoryProjectCustom) setProjectMemoryProject(event.target.value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')); }} placeholder="Ex.: Meu aplicativo" required /></label><label>Caminho da pasta<input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder="/home/voce/projetos/app" required /></label><div className="memory-scope-modal"><div><Brain size={14} /> Escopo de memória explícito</div><label>Workspace<input value={projectMemoryWorkspace} onChange={(event) => setProjectMemoryWorkspace(event.target.value)} placeholder="pessoal" required /></label><label>Projeto na memória<input value={projectMemoryProject} onChange={(event) => { setProjectMemoryProject(event.target.value); setProjectMemoryProjectCustom(true); }} placeholder="identificador único" required /></label><small>O identificador começa pelo nome do projeto e pode ser ajustado.</small></div><div className="modal-note"><Shield size={14} /> O agente usará esta pasta conforme a permissão definida.</div>{notice && <div className="form-error">{notice}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setProjectForm(false)}>Cancelar</button><button type="submit" className="primary-button" disabled={busy || !projectName.trim() || !projectPath.trim() || !projectMemoryWorkspace.trim() || !projectMemoryProject.trim()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} Criar projeto</button></div></form></div>}
    {helpOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHelpOpen(false); }}><div className="modal-card help-card" role="dialog" aria-modal="true" aria-labelledby="help-title"><div className="modal-heading"><div className="project-avatar" aria-hidden="true"><CircleHelp size={17} /></div><div><h2 id="help-title">Como usar o Adelic</h2><p>Um espaço local para trabalhar com seus agentes.</p></div><button type="button" className="icon-button" aria-label="Fechar ajuda" onClick={() => setHelpOpen(false)}><X size={17} /></button></div><div className="help-items"><p><strong>Comece por uma conversa.</strong> Nova conversa cria uma conversa avulsa; o + ao lado de um projeto cria uma conversa vinculada à pasta e ao escopo de memória dele.</p><p><strong>Ajuste a conversa no campo de mensagem.</strong> Escolha agente, modelo, thinking, permissões, projeto e modo. Auto adapta o caminho ao pedido; Rápido prioriza respostas diretas e pode consultar o computador quando necessário.</p><p><strong>Revise aprovações.</strong> A execução acontece neste computador. Confira ações de escrita antes de aprovar.</p><p><strong>Interrompa quando precisar.</strong> O botão de parar cancela a execução atual.</p></div><dl className="shortcut-list"><div><dt>Enviar mensagem</dt><dd><kbd>Enter</kbd></dd></div><div><dt>Nova linha</dt><dd><kbd>Shift</kbd><kbd>Enter</kbd></dd></div><div><dt>Nova conversa</dt><dd><kbd>{shortcut}</kbd></dd></div><div><dt>Fechar menus e janelas</dt><dd><kbd>Esc</kbd></dd></div></dl><button type="button" className="primary-button help-done" onClick={() => setHelpOpen(false)}>Entendi</button></div></div>}
  </div>;
}

const SIDEBAR_LIMIT = 6;

function SessionItem({ session, selected, now, onSelect }: { session: Session; selected: boolean; now: number; onSelect: () => void }) {
  const title = session.title || 'Nova conversa';
  return <button className={`session-item ${selected ? 'selected' : ''}`} aria-current={selected ? 'page' : undefined} title={title} onClick={onSelect}>
    {session.activeRunId ? <span className="session-running" aria-hidden="true" /> : <MessageSquare size={14} className="session-icon" aria-hidden="true" />}
    <span className="session-title">{title}</span>
    {session.activeRunId && <span className="visually-hidden">, em execução</span>}
    <time className="session-time" dateTime={session.updatedAt}>{relativeTime(session.updatedAt, now)}</time>
  </button>;
}

function MessageCard({ message, providerName }: { message: Message; providerName: string }) {
  if (message.role === 'user') return <div className="message-row user-row">
    <div className="user-bubble">{message.content}</div>
    <div className="message-meta"><time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time><CopyButton text={message.content} label="Copiar mensagem" /></div>
  </div>;
  const content = message.content || (message.status === 'failed' ? 'A execução falhou antes de gerar uma resposta.' : '');
  return <div className="message-row assistant-row">
    <div className="message-author"><span className="assistant-glyph" aria-hidden="true"><Sparkles size={12} /></span><strong>{providerName}</strong>{message.route && <span className="route-pill" title={message.route.reason}>{message.route.level === 'fast' ? 'Rápido' : 'Completo'} · Thinking {thinkingLabel(message.route.effort)}</span>}<time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time></div>
    {content && <Markdown>{content}</Markdown>}
    {message.status === 'failed' && <div className="message-error"><X size={13} /> Execução falhou</div>}
    {message.content && <div className="message-actions"><CopyButton text={message.content} label="Copiar resposta" /></div>}
  </div>;
}

function RunActivityPanel({ runId, run, tasks, events, providers, active, taskOutputs, loadingTaskOutputs, onLoadTaskOutput }: {
  runId: string;
  run?: Run;
  tasks: DelegatedTask[];
  events: SessionDetail['events'];
  providers: Bootstrap['providers'];
  active: boolean;
  taskOutputs: Record<string, string | null>;
  loadingTaskOutputs: Set<string>;
  onLoadTaskOutput: (task: DelegatedTask) => Promise<void>;
}) {
  const activity = activityForRun(runId, tasks, events);
  const runStatus = run?.status;
  const running = runStatus === 'running' || (!runStatus && active);
  const now = useNow(1000, running);
  const outcome = runStatusLabel(runStatus) || (active ? 'Em andamento' : null);
  if (!activityIsVisible(activity) && !outcome) return null;
  const startedAt = run?.startedAt ? new Date(run.startedAt).getTime() : Number.NaN;
  const elapsed = formatDuration(running ? (Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : undefined) : run?.durationMs);
  const tone = running ? 'running' : runStatus || 'completed';
  const headline = running ? (elapsed ? `Trabalhando · ${elapsed}` : 'Trabalhando')
    : tone === 'completed' ? (elapsed ? `Trabalhou por ${elapsed}` : 'Atividade')
      : `${outcome}${elapsed ? ` após ${elapsed}` : ''}`;
  const counts = [
    activity.tasks.length ? `${activity.tasks.length} ${activity.tasks.length === 1 ? 'tarefa' : 'tarefas'}` : '',
    activity.actions.length ? `${activity.actions.length} ${activity.actions.length === 1 ? 'ação' : 'ações'}` : '',
  ].filter(Boolean).join(' · ');
  const icon = running ? <LoaderCircle className="spin" size={14} /> : tone === 'completed' ? <Activity size={14} /> : <X size={14} />;
  return <section className={`run-activity ${tone}`} aria-label="Atividade desta execução">
    {activity.errors.map((event) => <RunEventRow key={event.id} event={event} />)}
    {activityIsVisible(activity) ? <details className="activity-details">
      <summary><span className="activity-icon" aria-hidden="true">{icon}</span><span className="activity-headline">{headline}</span>{counts && <span className="activity-counts">{counts}</span>}<ChevronDown className="activity-chevron" size={14} aria-hidden="true" /></summary>
      <div className="run-activity-content">
        {activity.tasks.map((task) => {
          const hasCachedOutput = Object.hasOwn(taskOutputs, task.id);
          const loadingOutput = loadingTaskOutputs.has(task.id);
          return <article className="activity-task" key={task.id}>
            <div className="activity-task-heading"><i className={`run-status-dot ${task.status}`} aria-hidden="true" /><strong>{task.title}</strong><span className="activity-task-status">{taskStatusName(task.status)}</span></div>
            <div className="activity-meta">{taskRoleName(task.role)} · {providers.find((item) => item.id === task.providerId)?.name || task.providerId}{task.model ? ` / ${task.model}` : ''}{task.effort ? ` · Thinking ${thinkingLabel(task.effort)}` : ''}</div>
            {task.summary && <details className="activity-summary"><summary>Ver resumo</summary><p>{task.summary}</p></details>}
            {task.scope.length > 0 && <div className="activity-scope">Escopo: {task.scope.slice(0, 3).join(' · ')}{task.scope.length > 3 ? ` · +${task.scope.length - 3}` : ''}</div>}
            {hasCachedOutput ? <details className="activity-output"><summary>Ver saída completa</summary><pre>{taskOutputs[task.id] || 'Saída vazia.'}</pre></details> : task.status !== 'running' && task.status !== 'queued' ? <button className="task-output-button" onClick={() => void onLoadTaskOutput(task)} disabled={loadingOutput}>{loadingOutput ? <LoaderCircle className="spin" size={12} /> : <FileText size={12} />}{loadingOutput ? 'Carregando saída…' : 'Carregar saída completa'}</button> : null}
          </article>;
        })}
        {activity.actions.map((event) => actionNeedsDisclosure(event)
          ? <details className="activity-command" key={event.id}><summary><Code2 size={13} aria-hidden="true" /><span className="visually-hidden">{commandTitle(event.toolName)}: </span><code className="command-preview">{commandPreview(event.text)}</code><span className={`activity-action-status ${event.status || ''}`}>{statusLabel(event.status)}</span><time>{timeLabel(event.createdAt)}</time></summary><pre>{event.text}</pre></details>
          : <div className="activity-action" key={event.id}><Code2 size={13} aria-hidden="true" /><span>{event.text}</span><small className={`activity-action-status ${event.status || ''}`}>{statusLabel(event.status)}</small></div>)}
        {activity.events.map((event) => <div className="activity-event" key={event.id}><Activity size={13} aria-hidden="true" /><span>{event.text}</span><time>{timeLabel(event.createdAt)}</time></div>)}
      </div>
    </details> : <div className="run-progress"><span className="activity-icon" aria-hidden="true">{icon}</span><span className="activity-headline">{headline}</span>{running && <span className="activity-counts">Preparando resposta</span>}</div>}
  </section>;
}

function RunEventRow({ event }: { event: SessionDetail['events'][number] }) {
  return <div className="run-event error"><span className="run-event-icon" aria-hidden="true"><X size={12} /></span><span>{event.text}</span><time>{timeLabel(event.createdAt)}</time></div>;
}

function ActivityPage({ runs, providers }: { runs: Run[]; providers: Bootstrap['providers'] }) {
  const completed = runs.filter((run) => run.status === 'completed');
  const durations = runs.flatMap((run) => run.durationMs != null ? [run.durationMs] : []);
  const firstTokens = runs.flatMap((run) => run.firstTokenMs != null ? [run.firstTokenMs] : []);
  const avg = (numbers: number[]) => numbers.length ? numbers.reduce((sum, item) => sum + item, 0) / numbers.length : null;
  const meanDuration = avg(durations), meanFirst = avg(firstTokens);
  return <section className="page-content"><div className="page-heading"><div><div className="eyebrow">USO E EXECUÇÕES</div><h1>Atividade</h1><p>Acompanhe execuções reais dos seus agentes.</p></div><span className="period-chip"><History size={14} /> Todo o histórico</span></div>
    <div className="metrics-grid"><MetricCard icon={<Activity size={17} />} label="Execuções" value={String(runs.length)} hint={`${completed.length} concluídas`} /><MetricCard icon={<Zap size={17} />} label="1ª resposta média" value={meanFirst == null ? '—' : formatDuration(meanFirst)} hint={meanFirst == null ? 'Sem medição disponível' : 'até o primeiro texto'} /><MetricCard icon={<Clock3 size={17} />} label="Duração média" value={meanDuration == null ? '—' : formatDuration(meanDuration)} hint={meanDuration == null ? 'Sem medição disponível' : 'das execuções registradas'} /><MetricCard icon={<Gauge size={17} />} label="Custo" value="—" hint="Indisponível pelo provedor" /> </div>
    <div className="activity-section"><div className="section-title-row"><div><h2>Execuções recentes</h2><p>Os dados são registrados localmente.</p></div><span className="count-chip">{runs.length}</span></div>{runs.length === 0 ? <div className="empty-panel activity-empty"><div className="empty-icon"><Activity size={18} /></div><strong>Nenhuma execução ainda</strong><span>As conversas concluídas aparecerão aqui.</span></div> : <div className="run-table"><div className="run-table-head"><span>AGENTE / MODO</span><span>STATUS</span><span>HORÁRIO</span><span>DURAÇÃO</span><span>CUSTO</span></div>{[...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map((run) => <div className="run-table-row" key={run.id}><div className="run-provider-cell"><div className="provider-avatar"><Bot size={15} /></div><span><strong>{providers.find((p) => p.id === run.providerId)?.name || run.providerId}</strong><small>{run.route.level === 'fast' ? 'Rápido' : 'Completo'} · {run.route.reason}</small></span></div><span><i className={`run-status-dot ${run.status}`} />{statusName(run.status)}</span><span>{shortDate(run.startedAt)} às {timeLabel(run.startedAt)}</span><span>{run.durationMs == null ? '—' : formatDuration(run.durationMs)}</span><span>{run.costUsd == null ? '—' : `$${run.costUsd.toFixed(4)}`}</span></div>)}</div>}</div>
  </section>;
}
function MetricCard({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint: string }) { return <div className="metric-card"><div className="metric-top"><span className="metric-icon">{icon}</span><span>{label}</span></div><strong>{value}</strong><small>{hint}</small></div>; }
function statusName(status: Run['status']) { return ({ running: 'Em execução', completed: 'Concluída', cancelled: 'Cancelada', failed: 'Falhou', interrupted: 'Interrompida' })[status]; }

function ProjectTools({ project, data, coordination, graphifyStatus, graphQueryResult, projectQuery, projectBusy, coordinatorProviderId, onProjectQueryChange, onProjectQuery, onOrchestration, onGraphifyEnabled, onIndexGraphify, onRefreshProject }: {
  project: Project; data: Bootstrap; coordination: ProjectCoordination | null; graphifyStatus: GraphifyStatus | null; graphQueryResult: GraphifyQueryResult | null;
  projectQuery: string; projectBusy: boolean; coordinatorProviderId: string; onProjectQueryChange: (value: string) => void; onProjectQuery: (event: FormEvent) => void;
  onOrchestration: (patch: Partial<OrchestrationConfig>) => void; onGraphifyEnabled: (enabled: boolean) => void; onIndexGraphify: () => void; onRefreshProject: () => void;
}) {
  const config = projectOrchestration(project);
  const [briefExpanded, setBriefExpanded] = useState(false);
  const [briefClipped, setBriefClipped] = useState(false);
  const objectiveRef = useRef<HTMLParagraphElement>(null);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  // The brief is clamped by rendered lines (CSS), so overflow must be measured, not guessed from length.
  useLayoutEffect(() => {
    if (briefExpanded) return;
    const nodes = [objectiveRef.current, summaryRef.current].filter((node): node is HTMLParagraphElement => Boolean(node));
    if (!nodes.length) { setBriefClipped(false); return; }
    const measure = () => setBriefClipped(nodes.some((node) => node.scrollHeight > node.clientHeight + 1));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [briefExpanded, coordination?.brief?.objective, coordination?.brief?.summary]);
  const providerFor = (providerId?: string) => data.providers.find((provider) => provider.id === (providerId || coordinatorProviderId));
  const modelOptions = (providerId?: string) => providerFor(providerId)?.models || [];
  const graphEnabled = project.graphify?.enabled !== false;
  const status = graphifyStatus?.status || (graphEnabled ? 'unindexed' : 'disabled');
  return <>
    <section className="settings-card project-orchestration-card">
      <div className="settings-card-heading"><div className="settings-card-icon"><Bot size={17} /></div><div><h2>Orquestração do projeto</h2><p>{project.name} · as mudanças valem no próximo turno. O agente da conversa coordena; executores usam contexto curto.</p></div></div>
      <div className="setting-row"><div><strong>Delegar tarefas</strong><span>{config.enabled ? 'Agente da conversa coordena os executores' : 'Mensagens seguem direto para o agente da conversa'}</span></div><button className={`toggle ${config.enabled ? 'on' : ''}`} role="switch" aria-checked={config.enabled} aria-label="Ativar orquestração do projeto" onClick={() => onOrchestration({ enabled: !config.enabled })}><span /></button></div>
      {config.enabled && <>
        <div className="setting-row"><div><strong>Executores simultâneos</strong><span>Limite de tarefas em paralelo</span></div><select value={config.maxWorkers} onChange={(event) => onOrchestration({ maxWorkers: Number(event.target.value) as OrchestrationConfig['maxWorkers'] })}><option value="1">1 executor</option><option value="2">2 executores</option><option value="3">3 executores</option></select></div>
        <div className="setting-row"><div><strong>Revisão independente</strong><span>Solicitar revisão quando o trabalho exigir</span></div><button className={`toggle ${config.review ? 'on' : ''}`} role="switch" aria-checked={config.review} aria-label="Ativar revisão independente" onClick={() => onOrchestration({ review: !config.review })}><span /></button></div>
        <div className="project-agent-grid">{(['worker', 'reviewer'] as const).map((role) => {
          const isWorker = role === 'worker';
          const selectedProvider = isWorker ? config.workerProviderId : config.reviewerProviderId;
          const selectedModel = isWorker ? config.workerModel : config.reviewerModel;
          const models = modelOptions(selectedProvider);
          const title = isWorker ? 'Executor' : 'Revisor';
          return <div className="project-agent-card" key={role}><strong>{title}</strong><label>{title}<select value={selectedProvider || ''} onChange={(event) => onOrchestration(isWorker ? { workerProviderId: event.target.value as OrchestrationConfig['workerProviderId'] || undefined, workerModel: undefined } : { reviewerProviderId: event.target.value as OrchestrationConfig['reviewerProviderId'] || undefined, reviewerModel: undefined })}><option value="">Herdar agente da conversa</option>{data.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}{provider.available ? '' : ' · indisponível'}</option>)}</select></label><label>Modelo<select value={selectedModel || ''} onChange={(event) => onOrchestration(isWorker ? { workerModel: event.target.value || undefined } : { reviewerModel: event.target.value || undefined })}><option value="">Padrão do agente</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label><small>{selectedProvider ? providerFor(selectedProvider)?.available ? 'Catálogo descoberto neste computador' : 'Agente indisponível neste computador' : `Herdado da conversa (${providerFor()?.name || coordinatorProviderId})`}</small></div>;
        })}</div>
      </>}
      <div className="project-overview"><div className="project-overview-heading"><strong>Contexto do coordenador</strong><button className="icon-button" title="Atualizar visão do projeto" aria-label="Atualizar visão do projeto" onClick={onRefreshProject}><RefreshCw size={14} /></button></div>{coordination?.brief ? <><p ref={objectiveRef} className={`brief-objective ${briefExpanded ? 'expanded' : ''}`}>{coordination.brief.objective || 'Objetivo ainda não registrado.'}</p><p ref={summaryRef} className={`brief-summary ${briefExpanded ? 'expanded' : ''}`}>{coordination.brief.summary || 'Sem resumo disponível.'}</p>{(briefExpanded || briefClipped) && <button type="button" className="link-button brief-toggle" aria-expanded={briefExpanded} onClick={() => setBriefExpanded((value) => !value)}>{briefExpanded ? 'Mostrar menos' : 'Mostrar resumo completo'}</button>}<div className="brief-paths">{coordination.brief.paths.slice(0, 8).map((path) => <code key={path}>{path}</code>)}{coordination.brief.paths.length > 8 && <span>+{coordination.brief.paths.length - 8} caminhos</span>}</div>{coordination.brief.truncated && <small>Mapa limitado ao contexto relevante.</small>}</> : <p className="muted-empty">Ainda não há mapa ou resumo do projeto.</p>}
        {coordination?.tasks.length ? <div className="recent-project-tasks"><strong>Tarefas recentes</strong>{coordination.tasks.slice(0, 4).map((task) => <div key={task.id}><span className={`run-status-dot ${task.status}`} /><span>{task.title}</span><small>{taskStatusName(task.status)}</small>{task.summary && <p>{task.summary}</p>}</div>)}</div> : null}</div>
    </section>
    <section className="settings-card graphify-card">
      <div className="settings-card-heading"><div className="settings-card-icon blue"><GitBranch size={17} /></div><div><h2>Mapa de código (Graphify)</h2><p>Índice local usado como mapa inicial pelo coordenador e pelos executores.</p></div></div>
      <div className="setting-row"><div><strong>Usar mapa do projeto</strong><span>O índice contém estrutura de código, sem enviar arquivos para fora.</span></div><button className={`toggle ${graphEnabled ? 'on' : ''}`} role="switch" aria-checked={graphEnabled} aria-label="Ativar mapa do projeto" onClick={() => onGraphifyEnabled(!graphEnabled)} disabled={projectBusy}><span /></button></div>
      <div className="graph-status-row"><span className={`run-status-dot ${status === 'ready' ? 'completed' : status === 'error' ? 'failed' : status === 'indexing' ? 'running' : ''}`} /><strong>{graphStatusName(status)}</strong><span>{graphifyStatus?.nodes != null && graphifyStatus.edges != null ? `${graphifyStatus.nodes} nós · ${graphifyStatus.edges} relações` : graphifyStatus?.detail || (graphEnabled ? 'Aguardando estado do índice.' : 'Desativado')}</span>{graphifyStatus?.updatedAt && <small>Atualizado {shortDate(graphifyStatus.updatedAt)}</small>}</div>
      {graphifyStatus?.detail && graphifyStatus.status !== 'ready' && <p className="graph-detail">{graphifyStatus.detail}</p>}
      <div className="graph-actions"><button className="secondary-button" onClick={onIndexGraphify} disabled={!graphEnabled || projectBusy || status === 'indexing'}>{projectBusy ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{status === 'ready' || status === 'stale' ? 'Indexar novamente' : 'Criar índice'}</button></div>
      {graphEnabled && <form className="graph-query" onSubmit={onProjectQuery}><label htmlFor="graph-query-input">Consultar mapa</label><div><input id="graph-query-input" value={projectQuery} onChange={(event) => onProjectQueryChange(event.target.value)} placeholder="Ex.: onde ficam as rotas da API?" /><button type="submit" className="secondary-button" disabled={projectBusy || !projectQuery.trim() || status !== 'ready'}>{projectBusy ? <LoaderCircle className="spin" size={13} /> : <Search size={13} />}Consultar</button></div></form>}
      {graphQueryResult && <div className="graph-query-result"><strong>Resultado para “{graphQueryResult.query}”</strong>{graphQueryResult.context ? <pre>{graphQueryResult.context.slice(0, 1800)}{graphQueryResult.context.length > 1800 ? '\n…' : ''}</pre> : <p>O Graphify não retornou contexto para esta consulta.</p>}</div>}
    </section>
  </>;
}

function taskStatusName(status: string) { return ({ queued: 'Na fila', running: 'Em execução', completed: 'Concluída', cancelled: 'Cancelada', failed: 'Falhou', interrupted: 'Interrompida' } as Record<string, string>)[status] || status; }
function taskRoleName(role: string) { return ({ planner: 'Plano', worker: 'Executor', reviewer: 'Revisor', synthesis: 'Síntese' } as Record<string, string>)[role] || role; }
function graphStatusName(status: string) { return ({ missing: 'Graphify ausente', unindexed: 'Ainda não indexado', indexing: 'Indexando', ready: 'Índice pronto', stale: 'Índice desatualizado', error: 'Erro ao indexar', disabled: 'Desativado' } as Record<string, string>)[status] || status; }

function SettingsPage({ data, project, coordination, graphifyStatus, graphQueryResult, projectQuery, projectBusy, coordinatorProviderId, onProjectQueryChange, onProjectQuery, onOrchestration, onGraphifyEnabled, onIndexGraphify, onRefreshProject, onProjectMemoryScope, onSetting, onSkill, notice }: { data: Bootstrap; project?: Project; coordination: ProjectCoordination | null; graphifyStatus: GraphifyStatus | null; graphQueryResult: GraphifyQueryResult | null; projectQuery: string; projectBusy: boolean; coordinatorProviderId: string; onProjectQueryChange: (value: string) => void; onProjectQuery: (event: FormEvent) => void; onOrchestration: (patch: Partial<OrchestrationConfig>) => void; onGraphifyEnabled: (enabled: boolean) => void; onIndexGraphify: () => void; onRefreshProject: () => void; onProjectMemoryScope: (workspace: string, project: string) => void; onSetting: (key: 'defaultProviderId' | 'defaultMode' | 'memoryEnabled' | 'sandbox' | 'responseStyle' | 'approvalMode', value: string | boolean) => void; onSkill: (id: string, enabled: boolean) => void; notice: string }) {
  const [memoryWorkspace, setMemoryWorkspace] = useState(project?.memoryWorkspace || '');
  const [memoryProject, setMemoryProject] = useState(project?.memoryProject || '');
  return <section className="page-content"><div className="page-heading"><div><div className="eyebrow">PREFERÊNCIAS DO WORKSPACE</div><h1>Configurações</h1><p>Defina como os agentes executam tarefas neste computador.</p></div></div>
    {notice && <div className="inline-notice error-notice">{notice}</div>}
    <div className="settings-layout"><div className="settings-main">
      {project && <ProjectTools project={project} data={data} coordination={coordination} graphifyStatus={graphifyStatus} graphQueryResult={graphQueryResult} projectQuery={projectQuery} projectBusy={projectBusy} coordinatorProviderId={coordinatorProviderId} onProjectQueryChange={onProjectQueryChange} onProjectQuery={onProjectQuery} onOrchestration={onOrchestration} onGraphifyEnabled={onGraphifyEnabled} onIndexGraphify={onIndexGraphify} onRefreshProject={onRefreshProject} />}

      {project && <section className="settings-card"><div className="settings-card-heading"><div className="settings-card-icon purple"><Brain size={17} /></div><div><h2>Escopo de memória do projeto</h2><p>Define a biblioteca consultada por conversas vinculadas; não altera o escopo da tela Memória.</p></div></div><label className="setting-row"><strong>Workspace</strong><input value={memoryWorkspace} onChange={e => setMemoryWorkspace(e.target.value)} /></label><label className="setting-row"><strong>Projeto na memória</strong><input value={memoryProject} onChange={e => setMemoryProject(e.target.value)} /></label><button className="secondary-button" disabled={!memoryWorkspace.trim() || !memoryProject.trim()} onClick={() => onProjectMemoryScope(memoryWorkspace.trim(), memoryProject.trim())}>Salvar escopo</button></section>}
      <section className="settings-card"><div className="settings-card-heading"><div className="settings-card-icon"><Bot size={17} /></div><div><h2>Agentes e respostas</h2><p>Escolha os padrões para novas conversas.</p></div></div><div className="setting-row"><div><strong>Agente padrão</strong><span>Usado ao criar uma conversa</span></div><select value={data.settings.defaultProviderId} onChange={(event) => onSetting('defaultProviderId', event.target.value)}>{data.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}{provider.available ? '' : ' · indisponível'}</option>)}</select></div><div className="setting-row"><div><strong>Modo padrão</strong><span>Auto adapta o esforço ao pedido</span></div><select value={data.settings.defaultMode} onChange={(event) => onSetting('defaultMode', event.target.value)}><option value="auto">Auto</option><option value="fast">Rápido</option><option value="deep">Completo</option></select></div><div className="setting-row"><div><strong>Estilo de resposta</strong><span>Como o agente organiza as respostas</span></div><select value={data.settings.responseStyle} onChange={(event) => onSetting('responseStyle', event.target.value)}><option value="concise">Conciso</option><option value="balanced">Equilibrado</option></select></div></section>
      <section className="settings-card"><div className="settings-card-heading"><div className="settings-card-icon purple"><Brain size={17} /></div><div><h2>Memória compartilhada</h2><p>Busca notas do escopo do projeto quando o pedido precisa de contexto anterior.</p></div></div><div className="setting-row"><div><strong>Permitir busca de memória</strong><span>Uma busca só ocorre quando a solicitação indicar contexto relevante.</span></div><button className={`toggle ${data.settings.memoryEnabled ? 'on' : ''}`} role="switch" aria-checked={data.settings.memoryEnabled} aria-label="Permitir busca de memória" onClick={() => onSetting('memoryEnabled', !data.settings.memoryEnabled)}><span /></button></div><div className="integration-list">{data.integrations.filter((item) => item.kind === 'memory' || item.kind === 'sandbox').map((item) => <div className="integration-row" key={item.id}><div className={`integration-icon ${item.kind}`} >{item.kind === 'memory' ? <Brain size={15} /> : <Shield size={15} />}</div><div><strong>{item.name}</strong><span>{item.detail}</span></div><span className={`integration-status-pill ${item.status}`}>{integrationName(item.status)}</span></div>)}</div></section>
      <section className="settings-card"><div className="settings-card-heading"><div className="settings-card-icon amber"><Shield size={17} /></div><div><h2>Permissões de execução</h2><p>Escolha o que o agente pode alterar e quando pedir confirmação.</p></div></div><div className="sandbox-options"><label className={data.settings.sandbox === 'read-only' ? 'sandbox-option selected' : 'sandbox-option'}><input type="radio" name="sandbox" checked={data.settings.sandbox === 'read-only'} onChange={() => onSetting('sandbox', 'read-only')} /><div><strong>Somente leitura</strong><span>O agente pode inspecionar arquivos.</span></div><Shield size={16} /></label><label className={data.settings.sandbox === 'workspace-write' ? 'sandbox-option selected' : 'sandbox-option'}><input type="radio" name="sandbox" checked={data.settings.sandbox === 'workspace-write'} onChange={() => onSetting('sandbox', 'workspace-write')} /><div><strong>Escrita no projeto</strong><span>Permite alterações dentro da pasta de trabalho.</span></div><Code2 size={16} /></label></div><div className="setting-row"><div><strong>{data.settings.approvalMode === 'manual' ? 'Confirmar solicitações' : 'Aprovação automática segura'}</strong><span>{data.settings.approvalMode === 'manual' ? 'Pede confirmação quando o agente oferece essa opção.' : 'Algumas leituras e alterações podem ser aprovadas automaticamente.'}</span></div><button type="button" className="secondary-button" onClick={() => onSetting('approvalMode', data.settings.approvalMode === 'manual' ? 'auto-safe' : 'manual')}>{data.settings.approvalMode === 'manual' ? 'Usar aprovação segura' : 'Confirmar solicitações'}</button></div><p className="permission-limit">O Codex aprova leituras reconhecidas. No Kiro, os pedidos ainda exigem confirmação; Claude não oferece confirmação pelo Adelic. Leituras e alterações feitas sem solicitação e scripts podem alterar ou excluir arquivos.</p></section>
      <section className="settings-card"><div className="settings-card-heading"><div className="settings-card-icon blue"><Layers3 size={17} /></div><div><h2>Skills</h2><p>Procedimentos disponíveis aos agentes, conforme o runtime.</p></div></div>{data.skills.length === 0 ? <div className="muted-empty">Nenhuma skill cadastrada.</div> : <div className="skills-list">{data.skills.map((skill) => <div className="skill-row" key={skill.id}><div className="skill-symbol"><Command size={14} /></div><div className="skill-text"><strong>{skill.name}</strong><span>{skill.description || 'Sem descrição.'}</span></div><button className={`toggle small ${skill.enabled ? 'on' : ''}`} role="switch" aria-checked={skill.enabled} aria-label={`Ativar skill ${skill.name}`} onClick={() => onSkill(skill.id, !skill.enabled)}><span /></button></div>)}</div>}</section>
    </div><aside className="settings-aside"><div className="provider-panel"><div className="provider-panel-title"><span>AGENTES INSTALADOS</span><span className="count-chip">{data.providers.filter((p) => p.available).length}/{data.providers.length}</span></div>{data.providers.map((provider) => <div className="provider-row" key={provider.id}><div className="provider-avatar"><Bot size={15} /></div><div><strong>{provider.name}</strong><span>{provider.detail}</span></div><span className={`provider-state ${provider.available ? 'ready' : 'missing'}`}>{provider.available ? 'Disponível' : 'Indisponível'}</span></div>)}</div><div className="settings-note"><div className="note-icon"><Shield size={15} /></div><p><strong>Seus dados ficam locais.</strong> Projetos, conversas e preferências são mantidos neste computador.</p></div><div className="system-info"><span>Adelic</span><span>Interface local</span></div></aside></div>
  </section>;
}
function integrationName(status: string) { return ({ ready: 'Conectado', missing: 'Ausente', error: 'Erro', planned: 'Planejado' } as Record<string, string>)[status] || 'Desconhecido'; }
