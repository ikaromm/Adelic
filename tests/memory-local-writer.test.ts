import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let root:string; const scope={workspace:'fixture-workspace',project:'fixture-project'};
const uuid=(n:number)=>`00000000-0000-0000-0000-${n.toString(16).padStart(12,'0')}`;
const page=()=>join(root,'wiki',uuid(1),uuid(17),'nested','page.md');
const status=(data_dir=root)=>vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({data_dir}),{status:200})));
beforeEach(()=>{
  vi.resetModules(); root=mkdtempSync(join(process.env.TMPDIR||tmpdir(),'adelic-local-writer-')); process.env.ADELIC_MEMORY_DATA_DIR=root;
  mkdirSync(join(root,'db'),{recursive:true}); const db=new DatabaseSync(join(root,'db/memory.sqlite'));
  db.exec("CREATE TABLE workspaces(id BLOB PRIMARY KEY,name TEXT);CREATE TABLE projects(id BLOB PRIMARY KEY,workspace_id BLOB,name TEXT);CREATE TABLE pages(workspace_id BLOB,project_id BLOB,path TEXT,title TEXT,is_latest INTEGER,expires_at INTEGER,updated_at INTEGER);INSERT INTO workspaces VALUES(X'00000000000000000000000000000001','fixture-workspace');INSERT INTO projects VALUES(X'00000000000000000000000000000011',X'00000000000000000000000000000001','fixture-project');"); db.close();
  const pdir=join(root,'wiki',uuid(1),uuid(17)); mkdirSync(join(pdir,'nested'),{recursive:true});
  writeFileSync(join(root,'wiki',uuid(1),'_meta.md'),'---\nworkspace: fixture-workspace\ntype: Scope Manifest\n---\n');
  writeFileSync(join(pdir,'_meta.md'),'---\nproject: fixture-project\ntype: Scope Manifest\n---\n');
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();delete process.env.ADELIC_MEMORY_DATA_DIR;rmSync(root,{recursive:true,force:true});});
describe('shared memory local body writer',()=>{
  it('preserves exact YAML prefix, comments, custom metadata and original mode',async()=>{
    status(); const original='---\n# keep this exact comment\nkind: Fact\ncustomFM:\n  origin: "source"\nsource: "imported"\nexpires_at: "2026-11-01T00:00:00Z"\npinned: true\n---\nold body\n';
    writeFileSync(page(),original,{mode:0o640}); const effectiveMode=statSync(page()).mode&0o777; const {writeExistingMemoryBody}=await import('../server/memory-local-writer.js');
    await writeExistingMemoryBody(scope,'nested/page.md','new body\n','old body\n',async()=>{});
    const updated=readFileSync(page(),'utf8'); expect(updated).toBe(original.replace('old body\n','new body\n'));
    expect(statSync(page()).mode&0o777).toBe(effectiveMode);
  });
  it('fails closed for wrong service root, manifest identity, stale body and symlinks',async()=>{
    writeFileSync(page(),'---\nkind: Fact\n---\nbase'); const {writeExistingMemoryBody}=await import('../server/memory-local-writer.js');
    mkdirSync(join(root,'not-the-same')); status(join(root,'not-the-same'));
    await expect(writeExistingMemoryBody(scope,'nested/page.md','x','base',async()=>{})).rejects.toThrow(/não corresponde/);
    status(); await expect(writeExistingMemoryBody(scope,'nested/page.md','x','stale',async()=>{})).rejects.toThrow(/diverge/);
    writeFileSync(join(root,'wiki',uuid(1),uuid(17),'_meta.md'),'---\nproject: other\n---\n');
    await expect(writeExistingMemoryBody(scope,'nested/page.md','x','base',async()=>{})).rejects.toThrow(/Manifestos/);
    writeFileSync(join(root,'wiki',uuid(1),uuid(17),'_meta.md'),'---\nproject: fixture-project\n---\n');
    const outside=mkdtempSync(join(tmpdir(),'adelic-outside-')), outsidePage=join(outside,'target.md');
    writeFileSync(outsidePage,'external original');
    const link=join(root,'wiki',uuid(1),uuid(17),'nested','link.md'); symlinkSync(outsidePage,link);
    await expect(writeExistingMemoryBody(scope,'nested/link.md','x','external original',async()=>{})).rejects.toThrow(/symlink/);
    const dirLink=join(root,'wiki',uuid(1),uuid(17),'linked'); writeFileSync(join(outside,'page.md'),'external parent original'); symlinkSync(outside,dirLink,'dir');
    await expect(writeExistingMemoryBody(scope,'linked/page.md','x','external parent original',async()=>{})).rejects.toThrow(/symlink/);
    expect(readFileSync(outsidePage,'utf8')).toBe('external original'); expect(readFileSync(join(outside,'page.md'),'utf8')).toBe('external parent original');
    rmSync(outside,{recursive:true,force:true});
  });
  it('blocks fence-like first body line without frontmatter before writing',async()=>{
    status(); const original='plain note\n'; writeFileSync(page(),original);
    const {writeExistingMemoryBody}=await import('../server/memory-local-writer.js'); const assertCurrent=vi.fn(async()=>{});
    await expect(writeExistingMemoryBody(scope,'nested/page.md','---\ntitle: forged\n---\nbody','plain note\n',assertCurrent)).rejects.toThrow(/sem frontmatter.*YAML/);
    expect(readFileSync(page(),'utf8')).toBe(original); expect(assertCurrent).not.toHaveBeenCalled();
  });
  it('allows fence-like body content when an existing header is present',async()=>{
    status(); const original='---\nkind: Fact\n---\nold'; writeFileSync(page(),original);
    const {writeExistingMemoryBody}=await import('../server/memory-local-writer.js');
    await writeExistingMemoryBody(scope,'nested/page.md','---\ntitle: body text\n---\n','old',async()=>{});
    expect(readFileSync(page(),'utf8')).toBe('---\nkind: Fact\n---\n---\ntitle: body text\n---\n');
  });
  it('rejects a mismatched local UID without changing the note',async()=>{
    status(); writeFileSync(page(),'body');
    const real=process.getuid!; const uid=lstatSync(page()).uid;
    vi.spyOn(process,'getuid').mockReturnValue(uid+1);
    const {writeExistingMemoryBody}=await import('../server/memory-local-writer.js');
    await expect(writeExistingMemoryBody(scope,'nested/page.md','changed','body',async()=>{})).rejects.toThrow(/não pertence/);
    expect(readFileSync(page(),'utf8')).toBe('body'); vi.spyOn(process,'getuid').mockRestore(); expect(real()).toBe(uid);
  });
});
