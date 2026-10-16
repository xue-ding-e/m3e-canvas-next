import { describe, expect, it } from 'vitest';
import { applyOperations, createProject, designCatalog, inspectProject } from './design';

const plan = (operations: unknown[], extra = {}) => ({ version: 1, operations, ...extra });
const seed = () => createProject({ title: 'Demo', lang: 'en' });
const add = [
  { op: 'frame.add', frame: { id: 'home', name: 'Home', x: 0, y: 0 } },
  { op: 'group.add', group: { id: 'row', x: 20, y: 80, axis: 'x', items: [] } },
  { op: 'item.add', groupId: 'row', item: { id: 'save', kind: 'button' } },
];
describe('structured design transactions', () => {
  it('creates, catalogs, edits and inspects without modifying input', () => {
    const input = seed(); const before = structuredClone(input);
    const result = applyOperations(input, plan(add));
    expect(input).toEqual(before);
    expect(result.doc.groups[0].items[0]).toMatchObject({ id: 'save', kind: 'button' });
    expect(designCatalog().components).toHaveLength(36);
    expect(inspectProject(result.doc).revision).toMatch(/^[a-f0-9]{64}$/);
    expect(result.changes).toHaveLength(3);
  });
  it('rolls back duplicate IDs and invalid dimensions atomically', () => {
    const input = seed(); const before = structuredClone(input);
    expect(() => applyOperations(input, plan([...add, { op: 'frame.add', frame: { id: 'home', name: 'Duplicate', x: 0, y: 0 } }]))).toThrow(/ID/);
    expect(() => applyOperations(input, plan([...add, { op: 'item.update', id: 'save', set: { size: -1 } }]))).toThrow();
    expect(input).toEqual(before);
  });
  it('enforces revisions and explicit stale-prompt policy', () => {
    const input = { ...seed(), promptEdit: 'saved' };
    expect(() => applyOperations(input, plan(add))).toThrow(/promptEdit/);
    expect(applyOperations(input, plan(add, { promptEditPolicy: 'clear' })).doc.promptEdit).toBeUndefined();
    expect(() => applyOperations(seed(), plan(add, { expectedRevision: '0'.repeat(64) }))).toThrow(/revision/i);
  });
  it('rejects dangling navigation but permits references resolved later in a batch', () => {
    const ops = [...add, { op: 'item.update', id: 'save', set: { action: { to: 'next', transition: 'fade' } } }];
    expect(() => applyOperations(seed(), plan(ops))).toThrow(/reference/i);
    const result = applyOperations(seed(), plan([...ops, { op: 'frame.add', frame: { id: 'next', name: 'Next', x: 500, y: 0 } }]));
    expect(result.doc.frames).toHaveLength(2);
  });
});

describe('component and editor semantics', () => {
  it('supports all 36 component kinds in all four languages', () => {
    for (const lang of ['en', 'ja', 'zh', 'ko'] as const) for (const {kind} of designCatalog(lang).components) {
      const result = applyOperations(seed(), plan([{ op:'group.add', group:{ id:'g', x:0,y:0,axis:'x',items:[{ id:'i',kind }] } }], {lang}));
      expect(result.doc.groups[0].items[0].id).toBe('i');
      expect(inspectProject(result.doc).doc).toEqual(result.doc);
    }
  });
  it('moves a frame together with its geometrically owned groups', () => {
    const doc = applyOperations(seed(), plan(add)).doc;
    const result = applyOperations(doc, plan([{op:'frame.update',id:'home',set:{x:500,y:300}}]));
    expect(result.doc.groups[0]).toMatchObject({x:520,y:380});
  });
  it('protects locked groups across direct and indirect edits', () => {
    const doc = applyOperations(seed(), plan([...add,{op:'group.lock',id:'row',locked:true}])).doc;
    for (const op of [{op:'item.update',id:'save',set:{label:'no'}},{op:'group.remove',id:'row'},{op:'frame.update',id:'home',set:{x:500}},{op:'item.move',id:'save',groupId:'row'}]) {
      expect(()=>applyOperations(doc,plan([op]))).toThrow(/locked/);
    }
    expect(applyOperations(doc,plan([{op:'group.lock',id:'row',locked:false},{op:'item.update',id:'save',set:{label:'yes'}}])).doc.groups[0].items[0].label).toBe('yes');
  });
  it('remaps tab selection and targets through reorder, insertion and removal', () => {
    const doc = applyOperations(seed(), plan([{op:'frame.add',frame:{id:'home',name:'Home',x:0,y:0}},{op:'group.add',group:{id:'g',x:0,y:0,axis:'x',items:[{id:'nav',kind:'tabs',tabs:[{label:'A',icon:''},{label:'B',icon:''}],selected:0,actions:{'tab:0':{to:'home',transition:'fade'}}}]}}])).doc;
    const reordered = applyOperations(doc,plan([{op:'tabs.reorder',id:'nav',indices:[1,0]}])).doc;
    expect(reordered.groups[0].items[0]).toMatchObject({selected:1,actions:{'tab:1':{to:'home'}}});
    const inserted = applyOperations(reordered,plan([{op:'tabs.insert',id:'nav',index:0,tab:{label:'C',icon:''}}])).doc;
    expect(inserted.groups[0].items[0]).toMatchObject({selected:2,actions:{'tab:2':{to:'home'}}});
    const removed = applyOperations(inserted,plan([{op:'tabs.remove',id:'nav',index:2}])).doc;
    expect(removed.groups[0].items[0].actions).toBeUndefined();
  });
  it('deletes navigation references only when explicitly requested', () => {
    const doc = applyOperations(seed(),plan([...add,{op:'item.update',id:'save',set:{action:{to:'home',transition:'fade'}}}])).doc;
    expect(()=>applyOperations(doc,plan([{op:'frame.remove',id:'home'}]))).toThrow(/reference/);
    expect(applyOperations(doc,plan([{op:'frame.remove',id:'home',references:'clear'}])).doc.groups[0].items[0].action).toBeUndefined();
  });
  it('preserves connected run heights and lone FAB bottom-right anchor', () => {
    const doc = applyOperations(seed(),plan([{op:'group.add',group:{id:'g',x:100,y:100,axis:'x',items:[{id:'a',kind:'button'},{id:'b',kind:'button'}]}}])).doc;
    const out = applyOperations(doc,plan([{op:'item.update',id:'a',set:{size2:96}}])).doc;
    expect(out.groups[0].items.map(i=>i.size2)).toEqual([96,96]);
    const fab = applyOperations(seed(),plan([{op:'group.add',group:{id:'g',x:100,y:100,axis:'x',items:[{id:'a',kind:'fab'}]}}])).doc;
    const large=applyOperations(fab,plan([{op:'item.update',id:'a',set:{size:96}}])).doc;
    expect(large.groups[0].x).toBeLessThan(100);expect(large.groups[0].y).toBeLessThan(100);
  });
  it('rejects unknown fields, reserved IDs, invalid layouts and unsafe links', () => {
    for(const patch of [{size:-1},{size:0},{count:9},{layout:'hero'},{selected:100},{action:{to:'link',transition:'none',url:'https://user:secret@example.com'}},{unknown:42}]) {
      expect(()=>applyOperations(seed(),plan([...add,{op:'item.update',id:'save',set:patch}]))).toThrow();
    }
    expect(()=>applyOperations(seed(),plan([{op:'frame.add',frame:{id:'back',name:'bad',x:0,y:0}}]))).toThrow();
    expect(()=>applyOperations(seed(),{version:2,operations:add})).toThrow();
  });
  it('honors expected revision, explicit prompt preservation and final replacement',()=>{
    const input={...seed(),promptEdit:''};
    const revision=inspectProject(input).revision;
    const kept=applyOperations(input,plan(add,{expectedRevision:revision,promptEditPolicy:'preserve'}));
    expect(kept.doc.promptEdit).toBe('');expect(kept.warnings.join()).toMatch(/preserved/);
    expect(applyOperations(input,plan([...add,{op:'prompt.set',text:'new'}])).doc.promptEdit).toBe('new');
    expect(()=>applyOperations(input,plan([{op:'prompt.set',text:'new'},...add]))).toThrow(/stale/);
  });
});

describe('frame length regression',()=>{
 it('uses the old length when moving frames below a growing screen',()=>{
  const doc=applyOperations(seed(),plan([{op:'frame.add',frame:{id:'f',name:'First',x:0,y:0,h:892}},{op:'frame.add',frame:{id:'f2',name:'Second',x:0,y:1000,h:892}}])).doc;
  const out=applyOperations(doc,plan([{op:'frame.update',id:'f',set:{length:1100}}])).doc;
  expect(out.frames.find(f=>f.id==='f2')?.y).toBe(1208);
 });
});

describe('component-specific actions',()=>{
 it('supports bottom card images, split menu slots and implicit carousel cards',()=>{
  for(const item of [{id:'i',kind:'card',imagePos:'bottom'},{id:'i',kind:'splitButton',actions:{menu:{to:'back',transition:'none'}}},{id:'i',kind:'carousel',actions:{'tab:0':{to:'back',transition:'none'}}}]) {
   expect(()=>applyOperations(seed(),plan([{op:'group.add',group:{id:'g',x:0,y:0,axis:'x',items:[item]}}]))).not.toThrow();
  }
 });
 it('rejects nonexistent slots and tab edits on plain buttons',()=>{
  expect(()=>applyOperations(seed(),plan([...add,{op:'item.update',id:'save',set:{actions:{icon:{to:'back',transition:'none'}}}}]))).toThrow(/slot/);
  expect(()=>applyOperations(seed(),plan([...add,{op:'tabs.insert',id:'save',index:0,tab:{label:'bad',icon:''}}]))).toThrow(/does not support tabs/);
 });
});

describe('pre-normalization bounds',()=>{
 it('rejects values before run helpers can silently clamp them',()=>{
  for(const set of [{size2:1},{size2:9999}]) expect(()=>applyOperations(seed(),plan([...add,{op:'item.update',id:'save',set}]))).toThrow(/size2/);
 });
});
