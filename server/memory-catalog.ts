import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MemoryCatalog, MemoryListing, MemoryScope, MemoryScopeInfo } from '../shared/contracts.js';

const PAGE_DEFAULT=50, PAGE_MAX=100;
export function memoryDataRoot() { return process.env.ADELIC_MEMORY_DATA_DIR || process.env.AI_MEMORY_DATA_DIR
  || join(homedir(), '.local/share/ai-memory'); }
function dbPath() { return join(memoryDataRoot(), 'db', 'memory.sqlite'); }
const uuid=(value:unknown)=>{
  if(!(Buffer.isBuffer(value)||value instanceof Uint8Array)||value.length!==16) throw new Error('ID de escopo ai-memory inválido (esperado BLOB UUID de 16 bytes)');
  const hex=Buffer.from(value).toString('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};
export function memoryScopeIds(scope:MemoryScope):{workspaceId:string;projectId:string} {
  let db:DatabaseSync; try { db=openCatalog(); } catch(e) { throw new Error(`Catálogo ai-memory indisponível: ${e instanceof Error?e.message:String(e)}`); }
  try {
    const ws=db.prepare('SELECT id FROM workspaces WHERE name=?').all(scope.workspace) as {id:unknown}[];
    if(ws.length!==1) throw new Error(`Escopo workspace ausente ou ambíguo: ${scope.workspace}`);
    const projects=db.prepare('SELECT id FROM projects WHERE workspace_id=? AND name=?').all(ws[0].id as Buffer,scope.project) as {id:unknown}[];
    if(projects.length!==1) throw new Error(`Escopo project ausente ou ambíguo: ${scope.workspace}/${scope.project}`);
    return {workspaceId:uuid(ws[0].id),projectId:uuid(projects[0].id)};
  } finally { db.close(); }
}
function openCatalog() {
  const db=new DatabaseSync(dbPath(),{readOnly:true});
  try {
    const tables=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(x=>x.name));
    for(const [table,cols] of Object.entries({workspaces:['id','name'],projects:['id','workspace_id','name'],pages:['workspace_id','project_id','path','title','is_latest','expires_at','updated_at']})) {
      if(!tables.has(table)) throw new Error(`Schema ai-memory incompatível: tabela ${table} ausente`);
      const actual=new Set((db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(x=>x.name));
      if(cols.some(c=>!actual.has(c))) throw new Error(`Schema ai-memory incompatível: colunas de ${table} ausentes`);
    }
    return db;
  } catch(e) { db.close(); throw e; }
}
function validScope(scope:MemoryScope) { return scope.workspace.trim() && scope.project.trim(); }
export function memoryCatalog():MemoryCatalog {
  let db:DatabaseSync; try { db=openCatalog(); } catch(e) { throw new Error(`Catálogo ai-memory indisponível: ${e instanceof Error?e.message:String(e)}`); }
  try {
    const rows=db.prepare(`SELECT w.name workspace,p.name project,COUNT(pg.path) pageCount FROM workspaces w JOIN projects p ON p.workspace_id=w.id LEFT JOIN pages pg ON pg.workspace_id=p.workspace_id AND pg.project_id=p.id AND pg.is_latest=1 AND (pg.expires_at IS NULL OR pg.expires_at>?) GROUP BY w.id,p.id ORDER BY w.name,p.name`).all(Date.now()*1000) as any[];
    const scopes:MemoryScopeInfo[]=rows.map(r=>({workspace:String(r.workspace),project:String(r.project),pageCount:Number(r.pageCount)}));
    return {scopes,totalPages:scopes.reduce((n,s)=>n+s.pageCount,0)};
  } catch(e) { throw new Error(`Falha ao consultar catálogo ai-memory: ${e instanceof Error?e.message:String(e)}`); } finally { db.close(); }
}
export function memoryList(scope:MemoryScope,offset=0,limit=PAGE_DEFAULT):MemoryListing {
  if(!validScope(scope)) throw new Error('workspace e project obrigatórios');
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>PAGE_MAX) throw new Error('offset/limit inválidos (limit máximo 100)');
  let db:DatabaseSync; try { db=openCatalog(); } catch(e) { throw new Error(`Catálogo ai-memory indisponível: ${e instanceof Error?e.message:String(e)}`); }
  try {
    const where=`workspace_id=(SELECT id FROM workspaces WHERE name=?) AND project_id=(SELECT id FROM projects WHERE workspace_id=(SELECT id FROM workspaces WHERE name=?) AND name=?) AND is_latest=1 AND (expires_at IS NULL OR expires_at>?)`;
    const args=[scope.workspace,scope.workspace,scope.project,Date.now()*1000];
    const total=Number((db.prepare(`SELECT COUNT(*) n FROM pages WHERE ${where}`).get(...args) as any).n);
    const rows=db.prepare(`SELECT path,title FROM pages WHERE ${where} ORDER BY path LIMIT ? OFFSET ?`).all(...args,limit,offset) as any[];
    return {pages:rows.map(r=>({path:String(r.path),title:String(r.title),snippet:''})),total,offset,limit};
  } finally { db.close(); }
}
export function memoryPathExists(scope:MemoryScope,path:string):boolean {
  if(!validScope(scope)) throw new Error('workspace e project obrigatórios');
  let db:DatabaseSync; try { db=openCatalog(); } catch(e) { throw new Error(`Catálogo ai-memory indisponível: ${e instanceof Error?e.message:String(e)}`); }
  try { return Boolean(db.prepare(`SELECT 1 FROM pages WHERE workspace_id=(SELECT id FROM workspaces WHERE name=?) AND project_id=(SELECT id FROM projects WHERE workspace_id=(SELECT id FROM workspaces WHERE name=?) AND name=?) AND path=? AND is_latest=1 AND (expires_at IS NULL OR expires_at>?) LIMIT 1`).get(scope.workspace,scope.workspace,scope.project,path,Date.now()*1000)); }
  finally { db.close(); }
}
