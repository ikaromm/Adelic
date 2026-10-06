import { createHash, randomBytes } from 'node:crypto';
import { constants, openSync, closeSync, readFileSync, lstatSync, realpathSync, renameSync, unlinkSync, fsyncSync, fchmodSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { memoryDataRoot, memoryScopeIds } from './memory-catalog.js';
import type { MemoryScope } from '../shared/contracts.js';

const MAX_BYTES=8*1024*1024;
function fail(message:string,status=409):never { throw Object.assign(new Error(message),{status}); }
function safeRelative(path:string) {
  if(typeof path!=='string'||!path.endsWith('.md')||path.startsWith('/')||path.includes('\\')||path.includes('\0')) fail('Caminho de nota inválido',400);
  const parts=path.split('/'); if(parts.some(p=>!p||p==='.'||p==='..')) fail('Caminho de nota inválido',400);
  return parts;
}
function regularNoLinks(path:string) {
  const st=lstatSync(path); if(st.isSymbolicLink()) fail('Caminho de memória contém symlink'); if(!st.isFile()&&!st.isDirectory()) fail('Caminho de memória não é regular');
  if(typeof process.getuid==='function'&&st.uid!==process.getuid()) fail('Caminho de memória não pertence ao usuário local atual',403);
  return st;
}
function splitMarkdown(raw:string):{prefix:string;body:string} {
  if(!raw.startsWith('---\n')) return {prefix:'',body:raw};
  const end=raw.indexOf('\n---\n',4); if(end<0) fail('Frontmatter local incompatível; edição bloqueada');
  const prefix=raw.slice(0,end+5); return {prefix,body:raw.slice(end+5)};
}
async function verifiedDataRoot() {
  // Compatibility target: ai-memory 2.x, verified against /admin/status.data_dir,
  // the canonical wiki tree, and the SQLite catalog layout validated by memory-catalog.
  // Do not pin an exact patch release: the checks below are the compatibility boundary.
  const configured=resolve(memoryDataRoot());
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),1200);
  let status:any;
  try { const response=await fetch('http://127.0.0.1:49374/admin/status',{signal:controller.signal}); if(!response.ok) fail(`ai-memory /admin/status retornou HTTP ${response.status}`,503); status=await response.json(); }
  catch(e) { if((e as any)?.status) throw e; fail(`Não foi possível validar ai-memory /admin/status: ${e instanceof Error?e.message:String(e)}`,503); }
  finally { clearTimeout(timer); }
  if(typeof status?.data_dir!=='string') fail('ai-memory /admin/status incompatível: esperado data_dir string (layout 2.x)',503);
  let serverRoot:string,catalogRoot:string;
  try { serverRoot=realpathSync(status.data_dir); catalogRoot=realpathSync(configured); }
  catch(e) { fail(`ai-memory /admin/status incompatível com o layout 2.x: ${e instanceof Error?e.message:String(e)}`,503); }
  if(serverRoot!==catalogRoot) fail('data_dir do ai-memory não corresponde ao catálogo',503);
  return serverRoot;
}
function parseManifest(raw:string,key:string):string|undefined {
  const {prefix}=splitMarkdown(raw); if(!prefix) return undefined;
  const yaml=prefix.slice(4,-5);
  const line=yaml.split('\n').find(x=>new RegExp(`^${key}:\\s*`).test(x)); if(!line) return undefined;
  const value=line.slice(line.indexOf(':')+1).trim();
  if(value.startsWith('"')&&value.endsWith('"')) { try{return JSON.parse(value);}catch{return undefined;} }
  if(value.startsWith("'")&&value.endsWith("'")) return value.slice(1,-1).replace(/''/g,"'");
  return value||undefined;
}
export async function writeExistingMemoryBody(scope:MemoryScope,path:string,body:string,expectedBody:string,assertCurrent:()=>Promise<void>):Promise<void> {
  const parts=safeRelative(path), ids=memoryScopeIds(scope), dataRoot=await verifiedDataRoot();
  regularNoLinks(dataRoot); const wiki=join(dataRoot,'wiki'); regularNoLinks(wiki);
  const wsDir=join(wiki,ids.workspaceId), projectDir=join(wsDir,ids.projectId);
  regularNoLinks(wsDir); regularNoLinks(projectDir);
  const wsMetaPath=join(wsDir,'_meta.md'), projectMetaPath=join(projectDir,'_meta.md');
  regularNoLinks(wsMetaPath); regularNoLinks(projectMetaPath);
  if(parseManifest(readFileSync(wsMetaPath,'utf8'),'workspace')!==scope.workspace || parseManifest(readFileSync(projectMetaPath,'utf8'),'project')!==scope.project) fail('Manifestos do escopo não correspondem ao catálogo');
  let parent=projectDir;
  for(const component of parts.slice(0,-1)) { parent=join(parent,component); regularNoLinks(parent); }
  const target=join(parent,parts.at(-1)!); const initialStat=regularNoLinks(target);
  if(initialStat.size>MAX_BYTES) fail('Nota excede o limite seguro de edição',413);
  const original=readFileSync(target,'utf8'), parsed=splitMarkdown(original);
  if(parsed.body!==expectedBody) fail('Corpo local diverge da leitura MCP; edição bloqueada');
  if(!parsed.prefix&&body.startsWith('---\n')) fail('Edição bloqueada: uma nota sem frontmatter não pode ter corpo iniciado por ---\\n, pois seria interpretado como YAML');
  const originalHash=createHash('sha256').update(original).digest('hex');
  await assertCurrent();
  const temp=join(parent,`.ai-memory-tmp.${process.pid}.${randomBytes(10).toString('hex')}`);
  let fd:number|undefined;
  try {
    fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    fchmodSync(fd,initialStat.mode&0o777);
    const content=Buffer.from(parsed.prefix+body,'utf8'); let offset=0;
    while(offset<content.length) offset+=writeSync(fd,content,offset,content.length-offset);
    fsyncSync(fd); closeSync(fd); fd=undefined;
    const latestStat=regularNoLinks(target), latest=readFileSync(target);
    if(latestStat.dev!==initialStat.dev||latestStat.ino!==initialStat.ino||createHash('sha256').update(latest).digest('hex')!==originalHash) fail('Nota foi alterada durante a edição; recarregue antes de salvar');
    renameSync(temp,target);
    const dirfd=openSync(parent,constants.O_RDONLY); try{fsyncSync(dirfd);}finally{closeSync(dirfd);}
  } finally {
    if(fd!==undefined) closeSync(fd);
    try{unlinkSync(temp);}catch{}
  }
}
