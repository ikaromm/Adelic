import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Brain, FileText, Plus, RefreshCw, Search } from 'lucide-react';
import type { MemoryCatalog, MemoryHit, MemoryPage as MemoryNote, MemoryScope } from '../shared/contracts';
import { api } from './api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Note = MemoryNote;
export default function MemoryPage({ visible = true, activated = true }: { visible?: boolean; activated?: boolean }) {
  const [catalog, setCatalog] = useState<MemoryCatalog | null>(null);
  const [scope, setScope] = useState<MemoryScope | null>(null);
  const [listing, setListing] = useState<MemoryHit[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [note, setNote] = useState<Note | null>(null);
  const [draft, setDraft] = useState('');
  const [path, setPath] = useState('');
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MemoryHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [external, setExternal] = useState<Note | null>(null);
  const generation = useRef(0);
  const initialized = useRef(false);
  const running = useRef(false);
  const appliedQuery = useRef('');
  const busyRef = useRef(false);
  const dirty = editing && (creating ? draft.length > 0 || path.length > 0 : draft !== note?.body);
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const scopeKey = scope ? `${scope.workspace}/${scope.project}` : '';
  const pollState = useRef({ note, offset, editing, creating });
  pollState.current = { note, offset, editing, creating };
  const scopes = catalog?.scopes || [];
  const readOnly = scope?.project === '_global';
  const canSwitchAllowed = () => !dirtyRef.current || window.confirm('Descartar as alterações não salvas?');
  const canSwitch = (action: () => void) => { if (busyRef.current) return; if (!dirtyRef.current || window.confirm('Descartar as alterações não salvas?')) action(); };
  const loadCatalog = useCallback(async (generationId = generation.current) => { try { const result = await api.memoryCatalog(); if (generationId !== generation.current) return null; setCatalog(result); setError(''); setScope((current) => { if (current) return current; let remembered = ''; try { remembered = localStorage.getItem('adelic-memory-scope') || ''; } catch { /* storage optional */ } return result.scopes.find((s) => `${s.workspace}\0${s.project}` === remembered) || result.scopes.find((s) => s.workspace === 'pessoal' && s.project === 'ambiente-ikaromm') || result.scopes[0] || null; }); return result; } catch (e) { if (generationId === generation.current) setError((e as Error).message); return null; } }, []);
  const loadList = useCallback(async (current: MemoryScope, start = 0, generationId = generation.current) => {
    try { const result = await api.memoryList(current, start); if (generationId !== generation.current) return; setListing(result.pages); setTotal(result.total); setOffset(result.offset); setError(''); }
    catch (e) { if (generationId === generation.current) setError((e as Error).message); }
  }, []);
  useEffect(() => { if (!activated || initialized.current) return; initialized.current = true; void loadCatalog(); }, [activated, loadCatalog]);
  const wasVisible = useRef(false);
  const visibilityObserved = useRef(false);
  useEffect(() => {
    if (!visibilityObserved.current) {
      visibilityObserved.current = true;
      wasVisible.current = visible;
      return;
    }
    if (visible && !wasVisible.current && initialized.current) void refresh();
    wasVisible.current = visible;
  }, [visible]);
  useEffect(() => { if (!scope) return; const id = ++generation.current; busyRef.current = true; setBusy(true); setListing([]); setTotal(0); setOffset(0); setNote(null); setEditing(false); setCreating(false); setExternal(null); setHits(null); setQuery(''); appliedQuery.current = ''; void (async () => { try { await loadList(scope, 0, id); } finally { if (id === generation.current) { busyRef.current = false; setBusy(false); } } })(); }, [scopeKey, loadList]);
  const selectScope = (value: string) => { const found = scopes.find((s) => `${s.workspace}\0${s.project}` === value); if (found && !busyRef.current && canSwitchAllowed()) { generation.current++; setListing([]); setTotal(0); setOffset(0); setHits(null); setQuery(''); appliedQuery.current = ''; setNote(null); setDraft(''); setPath(''); setEditing(false); setCreating(false); setExternal(null); setError(''); try { localStorage.setItem('adelic-memory-scope', value); } catch { /* storage optional */ } setScope({ workspace: found.workspace, project: found.project }); } };
  const openNote = async (item: MemoryHit) => {
    if (!scope || busyRef.current || !canSwitchAllowed()) return;
    const id = ++generation.current; const requestedScope = scope;
    busyRef.current = true; setBusy(true); setError('');
    try { const n = await api.sharedMemoryPage(requestedScope, item.path); if (id !== generation.current) return; setNote(n); setDraft(n.body); setPath(n.path); setEditing(false); setCreating(false); setExternal(null); }
    catch (e) { if (id === generation.current) setError((e as Error).message); }
    finally { if (id === generation.current) { busyRef.current = false; setBusy(false); } }
  };
  const refresh = async () => { if (busyRef.current || running.current) return; const id = ++generation.current; busyRef.current = true; setBusy(true); try { const result = await loadCatalog(id); if (id !== generation.current || !result) return; const activeScope = scope ?? result.scopes.find((s) => s.workspace === 'pessoal' && s.project === 'ambiente-ikaromm') ?? result.scopes[0] ?? null; if (!activeScope) return; if (appliedQuery.current) { const found = await api.sharedMemorySearch(activeScope, appliedQuery.current); if (id === generation.current) setHits(found.hits); } else await loadList(activeScope, offset, id); if (note && !dirtyRef.current && id === generation.current) { const latest = await api.sharedMemoryPage(activeScope, note.path); if (id === generation.current && !dirtyRef.current) { if (editing) { if (latest.version !== note.version) setExternal(latest); } else { setNote(latest); setDraft(latest.body); } } } } catch (e) { if (id === generation.current) setError((e as Error).message); } finally { if (id === generation.current) { busyRef.current = false; setBusy(false); } } };
  useEffect(() => { if (!visible || !initialized.current || typeof document === 'undefined') return; const timer = window.setInterval(() => { if (document.visibilityState !== 'visible' || busyRef.current || running.current) return; const id = generation.current; const { note: noteAtStart, offset: currentOffset, editing: isEditing, creating: isCreating } = pollState.current; const scopeAtStart = scope; running.current = true; void (async () => { try { const catalogResult = await loadCatalog(id); if (id !== generation.current || !catalogResult) return; const activeScope = scopeAtStart ?? catalogResult.scopes.find((s) => s.workspace === 'pessoal' && s.project === 'ambiente-ikaromm') ?? catalogResult.scopes[0] ?? null; if (!activeScope) return; if (appliedQuery.current) { const found = await api.sharedMemorySearch(activeScope, appliedQuery.current); if (id === generation.current) setHits(found.hits); } else await loadList(activeScope, currentOffset, id); if (noteAtStart) { const latest = await api.sharedMemoryPage(activeScope, noteAtStart.path); if (id !== generation.current) return; if (!dirtyRef.current && !isEditing && !isCreating) { setNote(latest); setDraft(latest.body); } else if (latest.version !== noteAtStart.version) setExternal(latest); } } catch (e) { if (id === generation.current) setError((e as Error).message); } finally { running.current = false; } })(); }, 5000); return () => window.clearInterval(timer); }, [scopeKey, loadList, loadCatalog, visible]);
  useEffect(() => { const before = (e: BeforeUnloadEvent) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', before); return () => window.removeEventListener('beforeunload', before); }, []);
  const search = async (event: FormEvent) => { event.preventDefault(); if (!scope || busyRef.current) return; const value = query.trim(); const id = ++generation.current; setBusy(true); busyRef.current = true; try { if (!value) { appliedQuery.current = ''; setHits(null); await loadList(scope, 0, id); return; } const result = await api.sharedMemorySearch(scope, value); if (id === generation.current) { appliedQuery.current = value; setHits(result.hits); setError(''); } } catch (e) { if (id === generation.current) setError((e as Error).message); } finally { if (id === generation.current) { setBusy(false); busyRef.current = false; } } };
  const paginate = async (start: number) => { if (!scope || busyRef.current) return; const id = ++generation.current; busyRef.current = true; setBusy(true); try { await loadList(scope, start, id); } finally { if (id === generation.current) { busyRef.current = false; setBusy(false); } } };
  const save = async (event: FormEvent) => { event.preventDefault(); if (readOnly || !scope || busyRef.current || !path.trim() || !draft.trim() || external) return; const id = ++generation.current; busyRef.current = true; setBusy(true); try { const saved = await api.saveSharedMemory(scope, path.trim(), draft, creating ? null : note?.version || null); if (id !== generation.current) return; setNote(saved); setDraft(saved.body); setPath(saved.path); setCreating(false); setEditing(false); setExternal(null); await loadList(scope, offset, id); } catch (e) { if (id !== generation.current) return; const failure = e as Error & { status?: number }; setError(failure.status === 409 ? 'Conflito de edição: a nota foi alterada desde a leitura. Seu rascunho foi preservado; recarregue a versão externa somente se quiser descartá-lo.' : failure.message); if (failure.status === 409 && note && scope) { try { const latest = await api.sharedMemoryPage(scope, note.path); if (id === generation.current && latest.version !== note.version) setExternal(latest); } catch { /* preserve the original save error and draft */ } } } finally { if (id === generation.current) { setBusy(false); busyRef.current = false; } } };
  const items = hits ?? listing;
  return <section className="page-content shared-memory" hidden={!visible}><div className="page-heading"><div><div className="eyebrow">FONTE COMPARTILHADA</div><h1>Memória</h1><p>Biblioteca comum com T3 e Codex. Navegar aqui não altera o contexto das conversas.</p></div><div className="memory-toolbar"><button className="secondary-button" onClick={() => void refresh()} disabled={busy}><RefreshCw size={15}/> Atualizar</button><button className="primary-button" onClick={() => canSwitch(() => { generation.current++; setNote(null); setPath(''); setDraft(''); setCreating(true); setEditing(true); setExternal(null); })} disabled={!scope || busy || readOnly}><Plus size={15}/> Nova nota</button></div></div>
    {error && <div className="inline-notice error-notice" role="alert">{error}</div>}{catalog && !scopes.length && <div className="empty-panel">Nenhum escopo disponível no catálogo.</div>}
    {!catalog && !error && <div className="empty-panel">Carregando biblioteca…</div>}
    {scope && <><div className="memory-library-scope"><label>{scope.project === '_global' ? 'Escopo global (somente leitura)' : 'Workspace e projeto'}<select disabled={busy} value={`${scope.workspace}\0${scope.project}`} onChange={(e) => selectScope(e.target.value)}>{scopes.map((s) => <option key={`${s.workspace}/${s.project}`} value={`${s.workspace}\0${s.project}`}>{s.workspace} / {s.project}{s.project === '_global' ? ' (somente leitura)' : ''} ({s.pageCount})</option>)}</select></label><span>{scopes.find((s) => s.workspace === scope.workspace && s.project === scope.project)?.pageCount ?? total} notas no catálogo</span></div>
    <div className="memory-layout"><aside className="memory-search-panel"><form className="memory-search" onSubmit={(e) => void search(e)}><Search size={16}/><input disabled={busy} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar neste escopo…" aria-label="Buscar na memória"/><button disabled={busy}>Buscar</button></form><div className="memory-results">{items.map((item) => <button disabled={busy} key={item.path} className={`memory-hit ${note?.path === item.path ? 'selected' : ''}`} onClick={() => void openNote(item)}><FileText size={15}/><span><strong>{item.title}</strong><small>{item.path}</small><em>{item.snippet}</em></span></button>)}{!items.length && <div className="memory-no-results"><Brain size={21}/><strong>{busy ? 'Carregando notas…' : hits ? 'Nenhum resultado' : 'Nenhuma nota neste escopo'}</strong><span>{hits ? 'Tente outra busca.' : 'Crie uma nota ou atualize o catálogo.'}</span></div>}</div>{!hits && total > 50 && <div className="memory-pagination"><button disabled={busy || !offset} onClick={() => void paginate(Math.max(0, offset - 50))}>Anterior</button><span>{offset + 1}–{Math.min(offset + 50, total)} de {total}</span><button disabled={busy || offset + 50 >= total} onClick={() => void paginate(offset + 50)}>Próxima</button></div>}</aside>
    <div className="memory-document">{editing ? <form className="memory-editor" onSubmit={(e) => void save(e)}><div className="memory-editor-head"><div><div className="eyebrow">{creating ? 'NOVA NOTA' : 'EDITAR NOTA'}</div><h2>{creating ? 'Adicionar à memória' : note?.title}</h2></div></div><label>Caminho da nota<input value={path} disabled={!creating || busy} onChange={(e) => setPath(e.target.value)} placeholder="notas/assunto.md" required/></label><label>Conteúdo<textarea value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} rows={12} required/></label>{external && <div className="memory-conflict" role="alert">Esta nota mudou externamente. Seu rascunho foi preservado. <button type="button" disabled={busy} onClick={() => { if (busy) return; if (window.confirm('Recarregar a versão externa e descartar seu rascunho?')) { generation.current++; setNote(external); setDraft(external.body); setExternal(null); } }}>Recarregar versão externa</button></div>}<div className="memory-editor-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => canSwitch(() => { generation.current++; setEditing(false); setCreating(false); setExternal(null); if (note) { setDraft(note.body); setPath(note.path); } })}>Cancelar</button><button className="primary-button" disabled={busy || readOnly || !!external || !path.trim() || !draft.trim()}>{busy ? 'Salvando…' : 'Salvar nota'}</button></div></form> : note ? <article className="memory-article"><div className="eyebrow">NOTA DA MEMÓRIA</div><h2>{note.title}</h2><div className="memory-path"><FileText size={13}/> {note.path}</div><div className="markdown-content memory-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{note.body}</ReactMarkdown></div><button className="secondary-button" onClick={() => { if (readOnly || busy) return; generation.current++; setDraft(note.body); setPath(note.path); setEditing(true); }} disabled={busy || readOnly}>Editar</button></article> : <div className="memory-document-empty"><div className="empty-icon"><FileText size={18}/></div><h2>Escolha uma nota para ler</h2><p>As notas só entram no contexto de conversas vinculadas por buscas apropriadas.</p></div>}</div></div></>}
    </section>;
}
