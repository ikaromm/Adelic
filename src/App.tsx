import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity, ArrowDown, ArrowUp, Bot, Check, ChevronDown, CircleHelp, Clock3, Code2,
  Command, FileText, Folder, FolderPlus, Gauge, History, Layers3, LoaderCircle,
  GitBranch, MessageSquare, Plus, RefreshCw, Search, Settings as SettingsIcon, Shield, Sparkles, Square,
  X, Zap, Brain, PanelLeftClose, PanelLeftOpen, Menu,
} from 'lucide-react';
import type { Bootstrap, DelegatedTask, GraphifyQueryResult, GraphifyStatus, Message, Mode, OrchestrationConfig, Project, ProjectCoordination, Run, Session, SessionDetail, StreamEvent, Thinking } from '../shared/contracts';
import { api } from './api';
import SharedMemoryPage from './MemoryPage';
import { bootstrapSelection } from './selection';
import { activityForRun, activityIsVisible, actionNeedsDisclosure, commandTitle, runStatusLabel, statusLabel } from './run-activity';
import { compatibleThinking, supportedThinking, thinkingLabel } from './reasoning';
import { ChoiceMenu, ModelMenu } from './ComposerMenus';
import { projectOrchestration } from '../shared/contracts';

type Page = 'chat' | 'activity' | 'memory' | 'settings';
type LocalStream = { runId: string; messageId: string; content: string };
const MODE_LABELS: Record<Mode, string> = { auto: 'Auto', fast: 'Rápido', deep: 'Completo' };

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
  const bottomRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [detail?.messages.length, stream?.content]);

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

  return <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-mobile-open' : ''}`}>
      <div className="brand-row">
        <div className="brand-mark"><span>A</span></div><span className="brand-name">adelic</span>
        <button className="icon-button sidebar-collapse" aria-label="Recolher navegação" onClick={() => setSidebarCollapsed(!sidebarCollapsed)}><PanelLeftClose size={16} /></button>
      </div>
      <button className="new-chat-button" onClick={() => void newConversation()} disabled={busy}>
        <Plus size={17} /><span>Nova conversa</span><kbd>⌘ K</kbd>
      </button>
      <div className="sidebar-section-label">ESPAÇO DE TRABALHO</div>
      <nav className="main-nav" aria-label="Navegação principal">
        <button className={page === 'activity' ? 'nav-item active' : 'nav-item'} onClick={() => { setPage('activity'); setSidebarOpen(false); }}><Activity size={16} /><span>Atividade</span></button>
        <button className={page === 'memory' ? 'nav-item active' : 'nav-item'} onClick={() => { setMemoryVisited(true); setPage('memory'); setSidebarOpen(false); }}><Brain size={16} /><span>Memória</span></button>
        <button className={page === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => { setPage('settings'); setSidebarOpen(false); }}><SettingsIcon size={16} /><span>Configurações</span></button>
      </nav>
      <div className="sidebar-group-heading"><span>CONVERSAS AVULSAS</span></div>
      <div className="session-list detached-conversations">
        {detachedSessions.map((itemSession) => <button key={itemSession.id} className={`session-item ${itemSession.id === selectedSession ? 'selected' : ''}`} onClick={() => { selectConversation(itemSession.id); setPage('chat'); setSidebarOpen(false); }}><MessageSquare size={13} /><span>{itemSession.title || 'Nova conversa'}</span></button>)}
        {detachedSessions.length === 0 && <p className="sidebar-empty">Sem conversas avulsas.</p>}
      </div>
      <div className="sidebar-group-heading"><span>PROJETOS</span><button className="subtle-icon" aria-label="Adicionar projeto" onClick={() => setProjectForm(true)}><Plus size={15} /></button></div>
      <div className="project-list">
        {data?.projects.map((item) => <div key={item.id} className="project-wrap">
          <div className="project-row"><button className={`project-item ${item.id === selectedProject ? 'selected' : ''}`} onClick={() => { const firstSession = data.sessions.find((s) => s.projectId === item.id); selectProject(item.id); selectSession(firstSession?.id || ''); setPage('chat'); }}>
            <Folder size={15} /><span>{item.name}</span><ChevronDown size={13} className="project-chevron" />
          </button><button className="project-new-chat" aria-label={`Nova conversa em ${item.name}`} title={`Nova conversa em ${item.name}`} disabled={busy} onClick={() => void newConversation(item.id)}><Plus size={14} /></button></div>
          {item.id === selectedProject && projectSessions.length > 0 && <div className="session-list">
            {projectSessions.map((itemSession) => <button key={itemSession.id} className={`session-item ${itemSession.id === selectedSession ? 'selected' : ''}`} onClick={() => { selectConversation(itemSession.id); setPage('chat'); setSidebarOpen(false); }}><MessageSquare size={13} /><span>{itemSession.title || 'Nova conversa'}</span></button>)}
          </div>}
        </div>)}
        {data?.projects.length === 0 && <p className="sidebar-empty">Nenhum projeto cadastrado.</p>}
      </div>
      <div className="sidebar-bottom">
        <div className="integration-status"><span className={`status-dot ${data?.integrations.some((item) => item.kind === 'memory' && item.status === 'ready') ? 'green' : 'muted'}`} /><span>Memória</span><span className="status-caption">{data?.integrations.find((item) => item.kind === 'memory')?.status === 'ready' ? 'conectada' : data?.integrations.find((item) => item.kind === 'memory')?.status === 'planned' ? 'verificando' : 'indisponível'}</span></div>
        <div className="user-profile"><div className="avatar-small">I</div><div className="profile-copy"><strong>Workspace local</strong><span>somente neste computador</span></div><button className="subtle-icon" aria-label="Ajuda" onClick={() => setHelpOpen(true)}><CircleHelp size={16} /></button></div>
      </div>
    </aside>
    {sidebarOpen && <button className="mobile-scrim" aria-label="Fechar navegação" onClick={() => setSidebarOpen(false)} />}

    <main className="main-area">
      <header className="topbar">
        <div className="topbar-left"><button className="icon-button mobile-menu" aria-label="Abrir navegação" onClick={() => setSidebarOpen(true)}><Menu size={19} /></button><div className="breadcrumbs"><span>{page === 'chat' ? (session ? conversationProject?.name || 'Conversa avulsa' : project?.name || 'Conversas') : page === 'activity' ? 'Atividade' : page === 'memory' ? 'Memória' : 'Configurações'}</span>{page === 'chat' && session && <><span className="crumb-separator">/</span><strong>{session.title || 'Nova conversa'}</strong></>}</div></div>
        <div className="topbar-right"><div className="local-badge"><span className="status-dot green" />Local</div><button className="icon-button help-button" aria-label="Ajuda" onClick={() => setHelpOpen(true)}><CircleHelp size={18} /></button></div>
      </header>

      {!data && <div className="loading-screen"><LoaderCircle className="spin" size={24} /><span>Conectando ao Adelic…</span>{notice && <p className="error-text">{notice}</p>}</div>}
      {data && page === 'chat' && <>
        {!session ? <div className="welcome-view">
          <div className="welcome-orb"><Sparkles size={24} /></div><div className="eyebrow">SEU ESPAÇO DE TRABALHO</div><h1>O que vamos construir hoje?</h1><p>Comece sem uma pasta ou escolha um projeto depois.</p>
          <button className="primary-button" onClick={() => void newConversation()} disabled={busy}><Plus size={17} /> Começar uma conversa</button>
          <div className="welcome-suggestions">{['Resuma uma ideia para mim', 'Encontre um caminho para começar', 'Revise uma ideia que estou explorando'].map((suggestion) => <button key={suggestion} onClick={() => void startSuggestedPrompt(suggestion)} disabled={busy}>{suggestion}<ArrowUp size={14} /></button>)}</div>
        </div> : <>
          <section className="conversation" aria-label="Conversa">
            <div className="message-column">
              {messages.length === 0 && !stream && <div className="conversation-empty"><div className="empty-icon"><MessageSquare size={19} /></div><h2>Uma boa conversa começa com uma pergunta.</h2><p>{conversationProject ? <>O agente usa o contexto de <strong>{conversationProject.name}</strong> quando necessário.</> : 'Você pode conversar livremente ou anexar um projeto nas opções da conversa.'}</p><div className="prompt-chips">{(conversationProject ? ['Explique a estrutura deste projeto', 'Quais são os próximos passos?', 'Me ajude a resolver um problema'] : ['Explique o que é recursão', 'Me ajude a organizar uma ideia', 'Me ajude a resolver um problema']).map((text) => <button key={text} onClick={() => void sendMessage(text)}>{text}<ArrowUp size={13} /></button>)}</div></div>}
              {messages.filter((message) => message.id !== stream?.messageId).map((message) => <div className="timeline-message" key={message.id}><MessageCard message={message} providerName={data.providers.find((p) => p.id === (message.providerId || session.providerId))?.name || 'Adelic'} />{message.role === 'user' && message.runId && <RunActivityPanel runId={message.runId} runStatus={currentDetail?.runs.find((run) => run.id === message.runId)?.status} tasks={activityTasks} events={activityEvents} providers={data.providers} active={session.activeRunId === message.runId} taskOutputs={taskOutputs} loadingTaskOutputs={loadingTaskOutputs} onLoadTaskOutput={loadTaskOutput} />}</div>)}
              {stream && <div className="message-row assistant-row"><div className="assistant-avatar"><Sparkles size={15} /></div><div className="message-body"><div className="message-author">{provider?.name || 'Agente'} <span className="streaming-label"><i /> escrevendo</span></div><div className="markdown-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{stream.content || ' '}</ReactMarkdown>{!stream.content && <span className="typing-caret" />}</div></div></div>}
              {activityEvents.filter((item) => item.type === 'error' && !messages.some((message) => message.role === 'user' && message.runId === item.runId)).map((item) => <RunEventRow key={item.id} event={item} />)}
              {currentDetail?.approvals.filter((item) => item.status === 'pending').map((approval) => <div className="approval-card" key={approval.id}><div className="approval-icon"><Shield size={17} /></div><div className="approval-copy"><strong>{approval.title || 'Aprovação necessária'}</strong><p>{approval.detail}</p><span>{approval.kind === 'command' ? 'Comando' : approval.kind === 'file' ? 'Arquivo' : 'Ferramenta'} · confirme esta ação para continuar</span></div><div className="approval-actions"><button className="secondary-button" onClick={() => void api.approve(approval.id, 'deny').then(() => refreshDetail(session.id)).catch((e: Error) => setNotice(e.message))}>Negar</button><button className="primary-button compact" onClick={() => void api.approve(approval.id, 'approve').then(() => refreshDetail(session.id)).catch((e: Error) => setNotice(e.message))}><Check size={14} /> Aprovar</button></div></div>)}
              <div ref={bottomRef} />
            </div>
          </section>
          <div className="composer-wrap">
            {notice && <div className="inline-notice error-notice"><span>{notice}</span><button className="subtle-icon" onClick={() => setNotice('')} aria-label="Dispensar aviso"><X size={15} /></button></div>}
            {activeRun && <div className="run-strip"><span className="run-pulse" />{activeRun.route.level === 'fast' ? 'Modo rápido' : 'Modo completo'} · {activeRun.route.reason}<span className="run-start">iniciado às {timeLabel(activeRun.startedAt)}</span></div>}
            <details className="composer-options">
              <summary>Opções · Projeto: {conversationProject?.name || 'Sem projeto'} · Modo: {MODE_LABELS[session.mode]}</summary>
              <div className="composer-options-content">
                <label className="select-wrap project-select"><Folder size={14} /><select aria-label="Projeto da conversa" value={session.projectId || ''} disabled={busy || Boolean(session.activeRunId)} onChange={(event) => void changeSession({ projectId: event.target.value || null })}><option value="">Sem projeto</option>{data.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={13} /></label>
                <div className="mode-switch" role="group" aria-label="Modo de resposta">{(['auto', 'fast', 'deep'] as Mode[]).map((mode) => <button key={mode} className={session.mode === mode ? 'selected' : ''} onClick={() => void changeSession({ mode })} disabled={busy || Boolean(session.activeRunId)}>{mode === 'auto' ? <Sparkles size={12} /> : mode === 'fast' ? <Zap size={12} /> : <Layers3 size={12} />}{MODE_LABELS[mode]}</button>)}</div>
                <div className="composer-context">
                  <span className={`coordination-dot ${conversationProject?.orchestration?.enabled === false ? 'muted' : ''}`} />
                  <span>{conversationProject ? conversationProject.orchestration?.enabled === false ? 'Execução direta, sem delegação.' : `Orquestração ativa: ${provider?.name || 'agente da conversa'} coordena tarefas com contexto enxuto.` : 'Conversa avulsa: sem contexto ou configuração de projeto.'}</span>
                  {conversationProject && <button type="button" onClick={() => { selectProject(conversationProject.id); setPage('settings'); setSidebarOpen(false); }}>Configurar projeto</button>}
                </div>
              </div>
            </details>
            <div className="composer-box">
              <div className="composer-controls">
                <ModelMenu providers={data.providers} providerId={session.providerId} sessionId={session.id} modelId={session.model} disabled={busy || Boolean(session.activeRunId)} onChange={(providerId, model) => void changeSession(providerId === session.providerId ? { model: model || null } : { providerId, model: model || null })} />
                <ChoiceMenu label="Thinking para próximas mensagens" icon={<Brain size={14} />} value={session.thinking || 'auto'} options={thinkingOptions.map((value) => ({ value, label: thinkingLabel(value), detail: value === 'auto' && thinkingOptions.length === 1 ? reasoningUnavailable ? 'Este agente não oferece ajuste. O esforço Automático fica a cargo do runtime.' : 'O catálogo deste modelo não anuncia níveis adicionais; Automático usa o padrão do runtime.' : 'Define o esforço de raciocínio das próximas mensagens.' }))} disabled={busy || Boolean(session.activeRunId)} onChange={(value) => void changeSession({ thinking: value })} />
                <ChoiceMenu label="Permissões" icon={<Shield size={14} />} value={`${data.settings.sandbox}|${data.settings.approvalMode || 'auto-safe'}`} disabled={settingsPending} options={[{ value: 'read-only|auto-safe', label: 'Leitura · Auto', detail: 'Confirmação automática quando disponível.' }, { value: 'read-only|manual', label: 'Leitura · Manual', detail: 'Pede confirmação quando o agente oferece essa opção.' }, { value: 'workspace-write|auto-safe', label: 'Escrita · Auto', detail: 'Alterações permitidas no projeto.' }, { value: 'workspace-write|manual', label: 'Escrita · Manual', detail: 'Pede confirmação quando o agente oferece essa opção.' }]} hint={<>O Codex aprova leituras reconhecidas. No Kiro, os pedidos ainda exigem confirmação; Claude não oferece confirmação pelo Adelic. Leituras e alterações feitas sem solicitação e scripts podem alterar ou excluir arquivos.</>} onChange={(value) => { const [sandbox, approvalMode] = value.split('|') as ['read-only' | 'workspace-write', 'auto-safe' | 'manual']; void updatePermissions(sandbox, approvalMode); }} />
              </div>
              {reasoningUnavailable && <span className="visually-hidden">Este agente não oferece ajustes de Thinking; somente Automático está disponível.</span>}
              <textarea ref={composerRef} value={composer} onChange={(event) => setDrafts((current) => ({ ...current, [session.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder="Escreva sua mensagem…" aria-label="Mensagem para o agente" rows={1} disabled={Boolean(session.activeRunId)} />
              <div className="composer-bottom"><div className="composer-hints"><span><kbd>↵</kbd> enviar</span><span><kbd>⇧ ↵</kbd> nova linha</span>{session.mode === 'auto' && <span className="auto-hint"><Sparkles size={12} /> escolhe o modo por você</span>}</div><button className={`send-button ${canCancelCurrentSend ? 'stop' : ''}`} aria-label={canCancelCurrentSend ? 'Cancelar execução' : 'Enviar mensagem'} onClick={() => session.activeRunId ? void api.cancel(session.id).then(() => refreshDetail(session.id)).catch((e: Error) => setNotice(e.message)) : pendingSendForSession ? void cancelPendingSend(session.id) : void sendMessage()} disabled={canCancelCurrentSend ? false : !composer.trim() || busy || settingsPending}>{canCancelCurrentSend ? <Square size={14} fill="currentColor" /> : busy ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={17} />}</button></div>
            </div><div className="composer-footnote"><Shield size={12} /> Execução local no computador <span>·</span> confira ações de escrita antes de aprovar</div>
          </div>
        </>}
      </>}

      {data && page === 'activity' && <ActivityPage runs={data.runs} providers={data.providers} />}
      {data && memoryVisited && <SharedMemoryPage activated={memoryVisited} visible={page === 'memory'} />}

      {data && page === 'settings' && <SettingsPage key={project?.id || 'global'} data={data} project={project} coordination={coordination} graphifyStatus={graphifyStatus} graphQueryResult={graphQueryResult} projectQuery={projectQuery} projectBusy={projectBusy} coordinatorProviderId={session && session.projectId === project?.id ? session.providerId : data.settings.defaultProviderId} onProjectQueryChange={setProjectQuery} onProjectQuery={queryProjectGraph} onOrchestration={(patch) => project && void changeProjectOrchestration(project.id, patch)} onGraphifyEnabled={(enabled) => project && void changeGraphifyEnabled(project.id, enabled)} onIndexGraphify={() => project && void indexProject(project.id)} onRefreshProject={() => project && void refreshProjectViews(project.id)} onProjectMemoryScope={(workspace, memoryProject) => project && void changeProjectMemoryScope(project.id, workspace, memoryProject)} onSetting={updateSetting} onSkill={async (id, enabled) => { try { const result = await api.skill(id, enabled); setData((current) => current ? { ...current, skills: current.skills.map((skill) => skill.id === id ? result : skill) } : current); } catch (error) { setNotice((error as Error).message); } }} notice={notice} />}
    </main>

    {projectForm && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setProjectForm(false); }}><form className="modal-card" onSubmit={(event) => void createProject(event)}><div className="modal-heading"><div className="project-avatar"><FolderPlus size={17} /></div><div><h2>Novo projeto</h2><p>Conecte uma pasta do seu computador.</p></div><button type="button" className="icon-button" aria-label="Fechar" onClick={() => setProjectForm(false)}><X size={17} /></button></div><label>Nome do projeto<input autoFocus value={projectName} onChange={(event) => { setProjectName(event.target.value); if (!projectMemoryProjectCustom) setProjectMemoryProject(event.target.value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')); }} placeholder="Ex.: Meu aplicativo" required /></label><label>Caminho da pasta<input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder="/home/voce/projetos/app" required /></label><div className="memory-scope-modal"><div><Brain size={14} /> Escopo de memória explícito</div><label>Workspace<input value={projectMemoryWorkspace} onChange={(event) => setProjectMemoryWorkspace(event.target.value)} placeholder="pessoal" required /></label><label>Projeto na memória<input value={projectMemoryProject} onChange={(event) => { setProjectMemoryProject(event.target.value); setProjectMemoryProjectCustom(true); }} placeholder="identificador único" required /></label><small>O identificador começa pelo nome do projeto e pode ser ajustado.</small></div><div className="modal-note"><Shield size={14} /> O agente usará esta pasta conforme a permissão definida.</div>{notice && <div className="form-error">{notice}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setProjectForm(false)}>Cancelar</button><button type="submit" className="primary-button" disabled={busy || !projectName.trim() || !projectPath.trim() || !projectMemoryWorkspace.trim() || !projectMemoryProject.trim()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} Criar projeto</button></div></form></div>}
    {helpOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHelpOpen(false); }}><div className="modal-card help-card" role="dialog" aria-modal="true" aria-labelledby="help-title"><div className="modal-heading"><div className="project-avatar"><CircleHelp size={17} /></div><div><h2 id="help-title">Como usar o Adelic</h2><p>Um espaço local para trabalhar com seus agentes.</p></div><button type="button" className="icon-button" aria-label="Fechar ajuda" onClick={() => setHelpOpen(false)}><X size={17} /></button></div><div className="help-items"><p><strong>Comece por um projeto.</strong> Selecione a pasta e defina o escopo da memória.</p><p><strong>Escolha um modo.</strong> Auto adapta o caminho ao pedido. Rápido prioriza respostas diretas e pode consultar o computador quando necessário.</p><p><strong>Revise aprovações.</strong> Ações que o agente pedir aparecem na conversa para você aceitar ou negar.</p><p><strong>Interrompa quando precisar.</strong> O botão quadrado cancela a execução atual.</p></div><button type="button" className="primary-button help-done" onClick={() => setHelpOpen(false)}>Entendi</button></div></div>}
  </div>;
}

function MessageCard({ message, providerName }: { message: Message; providerName: string }) {
  const isUser = message.role === 'user';
  return <div className={`message-row ${isUser ? 'user-row' : 'assistant-row'}`}>
    {isUser ? <div className="user-avatar">I</div> : <div className="assistant-avatar"><Sparkles size={15} /></div>}
    <div className="message-body"><div className="message-author">{isUser ? 'Você' : providerName}{!isUser && message.route && <span className="route-pill" title={message.route.reason}>{message.route.level === 'fast' ? 'Rápido' : 'Completo'} · Thinking {thinkingLabel(message.route.effort)}</span>}<time>{timeLabel(message.createdAt)}</time></div>
      <div className={isUser ? 'user-content' : 'markdown-content'}>{isUser ? message.content : <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content || (message.status === 'failed' ? 'A execução falhou antes de gerar uma resposta.' : '')}</ReactMarkdown>}</div>
      {!isUser && message.status === 'failed' && <div className="message-error"><X size={13} /> Execução falhou</div>}
    </div>
  </div>;
}

function RunActivityPanel({ runId, runStatus, tasks, events, providers, active, taskOutputs, loadingTaskOutputs, onLoadTaskOutput }: {
  runId: string;
  runStatus?: Run['status'];
  tasks: DelegatedTask[];
  events: SessionDetail['events'];
  providers: Bootstrap['providers'];
  active: boolean;
  taskOutputs: Record<string, string | null>;
  loadingTaskOutputs: Set<string>;
  onLoadTaskOutput: (task: DelegatedTask) => Promise<void>;
}) {
  const activity = activityForRun(runId, tasks, events);
  const outcome = runStatusLabel(runStatus) || (active ? 'Em andamento' : null);
  if (!activityIsVisible(activity) && !outcome) return null;
  return <section className="run-activity" aria-label="Atividade desta execução">
    {activity.errors.map((event) => <RunEventRow key={event.id} event={event} />)}
    {activityIsVisible(activity) ? <details>
      <summary><Activity size={13} /><span>Atividade · {activity.tasks.length} {activity.tasks.length === 1 ? 'tarefa' : 'tarefas'} · {activity.actions.length} {activity.actions.length === 1 ? 'ação' : 'ações'}</span>{outcome && <span className={`activity-outcome ${runStatus || 'running'}`}>{runStatus === 'running' || (!runStatus && active) ? <i /> : null}{outcome}</span>}<ChevronDown className="activity-chevron" size={12} /></summary>
      <div className="run-activity-content">
        {activity.tasks.map((task) => {
          const hasCachedOutput = Object.hasOwn(taskOutputs, task.id);
          const loadingOutput = loadingTaskOutputs.has(task.id);
          return <article className="activity-task" key={task.id}>
            <div className="activity-task-heading"><i className={`run-status-dot ${task.status}`} /><strong>{task.title}</strong><span>{taskStatusName(task.status)}</span></div>
            <div className="activity-meta">{taskRoleName(task.role)} · {providers.find((item) => item.id === task.providerId)?.name || task.providerId}{task.model ? ` / ${task.model}` : ''}{task.effort ? ` · Thinking ${thinkingLabel(task.effort)}` : ''}</div>
            {task.summary && <details className="activity-summary"><summary>Ver resumo</summary><p>{task.summary}</p></details>}
            {task.scope.length > 0 && <div className="activity-scope">Escopo: {task.scope.slice(0, 3).join(' · ')}{task.scope.length > 3 ? ` · +${task.scope.length - 3}` : ''}</div>}
            {hasCachedOutput ? <details className="activity-output"><summary>Ver saída completa</summary><pre>{taskOutputs[task.id] || 'Saída vazia.'}</pre></details> : task.status !== 'running' && task.status !== 'queued' ? <button className="task-output-button" onClick={() => void onLoadTaskOutput(task)} disabled={loadingOutput}>{loadingOutput ? <LoaderCircle className="spin" size={12} /> : <FileText size={12} />}{loadingOutput ? 'Carregando saída…' : 'Carregar saída completa'}</button> : null}
          </article>;
        })}
        {activity.actions.map((event) => actionNeedsDisclosure(event) ? <details className="activity-command" key={event.id}><summary><Code2 size={12} />{commandTitle(event.toolName)} · {statusLabel(event.status)}<time>{timeLabel(event.createdAt)}</time></summary><pre>{event.text}</pre></details> : <div className="activity-action" key={event.id}><Code2 size={12} /><span>{event.text}</span><small>{statusLabel(event.status)}</small></div>)}
        {activity.events.map((event) => <div className="activity-event" key={event.id}><Activity size={12} /><span>{event.text}</span><time>{timeLabel(event.createdAt)}</time></div>)}
      </div>
    </details> : outcome ? <div className={`run-progress ${runStatus || 'running'}`}><span className={`activity-outcome ${runStatus || 'running'}`}>{runStatus === 'running' || (!runStatus && active) ? <i /> : null}{outcome}</span>{runStatus === 'running' || (!runStatus && active) ? <span>Preparando resposta</span> : null}</div> : null}
  </section>;
}

function RunEventRow({ event }: { event: SessionDetail['events'][number] }) {
  return <div className="run-event error"><span className="run-event-icon"><X size={12} /></span><span>{event.text}</span><time>{timeLabel(event.createdAt)}</time></div>;
}

function ActivityPage({ runs, providers }: { runs: Run[]; providers: Bootstrap['providers'] }) {
  const completed = runs.filter((run) => run.status === 'completed');
  const durations = runs.flatMap((run) => run.durationMs != null ? [run.durationMs] : []);
  const firstTokens = runs.flatMap((run) => run.firstTokenMs != null ? [run.firstTokenMs] : []);
  const avg = (numbers: number[]) => numbers.length ? numbers.reduce((sum, item) => sum + item, 0) / numbers.length : null;
  const meanDuration = avg(durations), meanFirst = avg(firstTokens);
  return <section className="page-content"><div className="page-heading"><div><div className="eyebrow">USO E EXECUÇÕES</div><h1>Atividade</h1><p>Acompanhe execuções reais dos seus agentes.</p></div><span className="period-chip"><History size={14} /> Todo o histórico</span></div>
    <div className="metrics-grid"><MetricCard icon={<Activity size={17} />} label="Execuções" value={String(runs.length)} hint={`${completed.length} concluídas`} /><MetricCard icon={<Zap size={17} />} label="1ª resposta média" value={meanFirst == null ? '—' : `${(meanFirst / 1000).toFixed(1)} s`} hint={meanFirst == null ? 'Sem medição disponível' : 'até o primeiro texto'} /><MetricCard icon={<Clock3 size={17} />} label="Duração média" value={meanDuration == null ? '—' : `${(meanDuration / 1000).toFixed(1)} s`} hint={meanDuration == null ? 'Sem medição disponível' : 'das execuções registradas'} /><MetricCard icon={<Gauge size={17} />} label="Custo" value="—" hint="Indisponível pelo provedor" /> </div>
    <div className="activity-section"><div className="section-title-row"><div><h2>Execuções recentes</h2><p>Os dados são registrados localmente.</p></div><span className="count-chip">{runs.length}</span></div>{runs.length === 0 ? <div className="empty-panel activity-empty"><div className="empty-icon"><Activity size={18} /></div><strong>Nenhuma execução ainda</strong><span>As conversas concluídas aparecerão aqui.</span></div> : <div className="run-table"><div className="run-table-head"><span>AGENTE / MODO</span><span>STATUS</span><span>HORÁRIO</span><span>DURAÇÃO</span><span>CUSTO</span></div>{[...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map((run) => <div className="run-table-row" key={run.id}><div className="run-provider-cell"><div className="provider-avatar"><Bot size={15} /></div><span><strong>{providers.find((p) => p.id === run.providerId)?.name || run.providerId}</strong><small>{run.route.level === 'fast' ? 'Rápido' : 'Completo'} · {run.route.reason}</small></span></div><span><i className={`run-status-dot ${run.status}`} />{statusName(run.status)}</span><span>{shortDate(run.startedAt)} às {timeLabel(run.startedAt)}</span><span>{run.durationMs == null ? '—' : `${(run.durationMs / 1000).toFixed(1)} s`}</span><span>{run.costUsd == null ? '—' : `$${run.costUsd.toFixed(4)}`}</span></div>)}</div>}</div>
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
      <div className="project-overview"><div className="project-overview-heading"><strong>Contexto do coordenador</strong><button className="icon-button" title="Atualizar visão do projeto" aria-label="Atualizar visão do projeto" onClick={onRefreshProject}><RefreshCw size={14} /></button></div>{coordination?.brief ? <><p className="brief-objective">{coordination.brief.objective || 'Objetivo ainda não registrado.'}</p><p>{coordination.brief.summary || 'Sem resumo disponível.'}</p><div className="brief-paths">{coordination.brief.paths.slice(0, 8).map((path) => <code key={path}>{path}</code>)}{coordination.brief.paths.length > 8 && <span>+{coordination.brief.paths.length - 8} caminhos</span>}</div>{coordination.brief.truncated && <small>Mapa limitado ao contexto relevante.</small>}</> : <p className="muted-empty">Ainda não há mapa ou resumo do projeto.</p>}
        {coordination?.tasks.length ? <div className="recent-project-tasks"><strong>Tarefas recentes</strong>{coordination.tasks.slice(0, 4).map((task) => <div key={task.id}><span className={`run-status-dot ${task.status}`} /><span>{task.title}</span><small>{taskStatusName(task.status)}</small>{task.summary && <p>{task.summary}</p>}</div>)}</div> : null}</div>
    </section>
    <section className="settings-card graphify-card">
      <div className="settings-card-heading"><div className="settings-card-icon blue"><GitBranch size={17} /></div><div><h2>Mapa de código (Graphify)</h2><p>Índice local usado como mapa inicial pelo coordenador e pelos executores.</p></div></div>
      <div className="setting-row"><div><strong>Usar mapa do projeto</strong><span>O índice contém estrutura de código, sem enviar arquivos para fora.</span></div><button className={`toggle ${graphEnabled ? 'on' : ''}`} role="switch" aria-checked={graphEnabled} aria-label="Ativar mapa do projeto" onClick={() => onGraphifyEnabled(!graphEnabled)} disabled={projectBusy}><span /></button></div>
      <div className="graph-status-row"><span className={`run-status-dot ${status === 'ready' ? 'completed' : status === 'error' ? 'failed' : status === 'indexing' ? 'running' : ''}`} /><strong>{graphStatusName(status)}</strong><span>{graphifyStatus?.nodes != null && graphifyStatus.edges != null ? `${graphifyStatus.nodes} nós · ${graphifyStatus.edges} relações` : graphifyStatus?.detail || (graphEnabled ? 'Aguardando estado do índice.' : 'Desativado')}</span>{graphifyStatus?.updatedAt && <small>Atualizado {shortDate(graphifyStatus.updatedAt)}</small>}</div>
      {graphifyStatus?.detail && graphifyStatus.status !== 'ready' && <p className="graph-detail">{graphifyStatus.detail}</p>}
      <div className="graph-actions"><button className="secondary-button" onClick={onIndexGraphify} disabled={!graphEnabled || projectBusy || status === 'indexing'}>{projectBusy ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{status === 'ready' || status === 'stale' ? 'Indexar novamente' : 'Criar índice'}</button></div>
      {graphEnabled && <form className="graph-query" onSubmit={onProjectQuery}><label htmlFor="graph-query-input">Consultar mapa</label><div><input id="graph-query-input" value={projectQuery} onChange={(event) => onProjectQueryChange(event.target.value)} placeholder="Ex.: onde ficam as rotas da API?" /><button type="submit" disabled={projectBusy || !projectQuery.trim() || status !== 'ready'}>{projectBusy ? <LoaderCircle className="spin" size={13} /> : <Search size={13} />}Consultar</button></div></form>}
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
