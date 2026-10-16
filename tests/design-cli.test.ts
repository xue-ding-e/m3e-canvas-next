import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe,expect,it } from 'vitest';
const run=(args:string[],value:unknown={})=>spawnSync(process.execPath,[resolve('dist-headless/cli/main.js'),...args],{input:JSON.stringify(value),encoding:'utf8',timeout:10000,maxBuffer:5*1024*1024});
describe('design CLI subprocesses',()=>{
 it('creates, inspects, catalogs, and applies JSON transactions',()=>{
  const created=run(['create'],{title:'CLI'});expect(created.status).toBe(0);expect(created.stderr).toBe('');
  const doc=JSON.parse(created.stdout);expect(doc.title).toBe('CLI');
  const inspected=run(['inspect'],doc);expect(inspected.status).toBe(0);
  const revision=JSON.parse(inspected.stdout).revision;
  const catalog=run(['catalog','--lang','zh']);expect(catalog.status).toBe(0);expect(JSON.parse(catalog.stdout).components).toHaveLength(36);
  const edited=run(['apply'],{doc,version:1,expectedRevision:revision,operations:[{op:'frame.add',frame:{id:'home',name:'Home',x:0,y:0}}]});
  expect(edited.status).toBe(0);expect(edited.stderr).toBe('');expect(JSON.parse(edited.stdout).doc.frames).toHaveLength(1);
 });
 it('fails atomically with machine-readable stderr and no stdout',()=>{
  const doc=JSON.parse(run(['create']).stdout);
  for(const envelope of [{doc,version:2,operations:[]},{doc,version:1,expectedRevision:'0'.repeat(64),operations:[{op:'project.update',set:{title:'x'}}]},{doc,version:1,operations:[{op:'project.update',set:{title:'partial'}},{op:'item.remove',id:'missing'}]}]) {
   const result=run(['apply'],envelope);expect(result.status).toBe(3);expect(result.stdout).toBe('');expect(JSON.parse(result.stderr).error.code).toBe('INVALID_PROJECT');
  }
 });
});
