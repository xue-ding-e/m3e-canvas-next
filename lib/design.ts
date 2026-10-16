import { createHash } from 'node:crypto';
import { z } from 'zod';
import { HeadlessError, MAX_PROJECT_BYTES, normalizeProject } from './headless';
import { type Lang } from './i18n';
import { updateRail } from './rail';
import { carryFrame, stretchFrame, tidyFrame } from './tidy';
import {
  BUTTON_H_MIN, BUTTON_H_MAX, KIND_ORDER, KIND_SPEC, COLOR_TOKENS, TEXT_TOKENS, VARIANTS, TRANSITIONS, PALETTES,
  CAROUSEL_LAYOUTS, DATE_LAYOUTS, TIME_LAYOUTS, SHAPES, FONTS, CONTRASTS,
  actionSlotsOf, carouselCardsOf, SPLIT_MENU_SLOT, makeItem, runSizePatch, frameOfGroup, groupBounds, frameSizeOf, frameLengthOf,
  reorderTabsPatch, removeTabPatch, explodeGroup, isFab, sizeOf, MEASURED, PHONE_MARGIN,
  type Doc, type Frame, type Group, type Item, type Kind,
} from './tokens';

const enumeration = (values: readonly string[]) => z.enum(values as [string, ...string[]]);
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).refine((x) => !['back', 'link', 'menu', '__proto__', 'constructor', 'prototype'].includes(x), 'ID is reserved');
const finite = z.number().finite();
const dimension = finite.positive().max(10000);
const point = z.object({ x: finite, y: finite }).strict();
const langSchema = z.enum(['en', 'ja', 'zh', 'ko']);
const color = enumeration(COLOR_TOKENS.map((t) => t.key));
const action = z.object({ to: z.string().min(1), transition: enumeration(TRANSITIONS.map((t) => t.key)), url: z.string().optional() }).strict();
const tab = z.object({ label: z.string(), icon: z.string().nullable().optional(), src: z.string().optional() }).strict();
const itemFields = {
  label: z.string(), icon: z.string().nullable(), variant: enumeration(VARIANTS.map((v) => v.key)),
  icon2: z.string().nullable().optional(), supporting: z.string().optional(), size: dimension.optional(), size2: dimension.optional(),
  radiusTop: finite.min(0).max(10000).optional(), radiusBottom: finite.min(0).max(10000).optional(),
  corners: z.object({ tl: finite.min(0), tr: finite.min(0), bl: finite.min(0), br: finite.min(0) }).strict().optional(),
  tabs: z.array(tab).max(100).optional(), selected: finite.int().min(0).optional(),
  switch: z.boolean().optional(), noImage: z.boolean().optional(), imagePos: z.enum(['top', 'bottom', 'leading', 'trailing', 'background']).optional(),
  imageSize: dimension.optional(), contentAlign: z.enum(['start', 'center', 'end']).optional(), textAlign: z.enum(['start', 'center', 'end']).optional(),
  textColor: enumeration(TEXT_TOKENS.map((t) => t.key)).optional(), checked: z.boolean().optional(), value: finite.min(0).max(100).optional(),
  wavy: z.boolean().optional(), railExpanded: z.boolean().optional(), railModal: z.boolean().optional(), trackThickness: finite.min(2).max(16).optional(),
  contained: z.boolean().optional(), note: z.string().optional(), noteHistory: z.array(z.string()).optional(), bold: z.boolean().optional(),
  fill: color.optional(), iconFill: z.union([color, z.literal('none')]).optional(), src: z.string().optional(),
  action: action.optional(), actions: z.record(z.string(), action).optional(),
  toggle: z.object({ icon: z.string().nullable().optional(), variant: enumeration(VARIANTS.map((v) => v.key)).optional(), label: z.string().optional() }).strict().optional(),
  layout: enumeration([...CAROUSEL_LAYOUTS, ...DATE_LAYOUTS, ...TIME_LAYOUTS].map((l) => l.key)).optional(), count: finite.int().min(2).max(8).optional(),
};
const itemSchema = z.object({ id, kind: enumeration(KIND_ORDER), ...itemFields }).strict();
const itemInput = itemSchema.partial().required({ id: true, kind: true });
const itemPatch = z.object(itemFields).partial().strict();
const frameFields = {
  name: z.string(), x: finite, y: finite, w: dimension.optional(), h: dimension.optional(), bg: color.optional(), note: z.string().optional(),
  noteHistory: z.array(z.string()).optional(), swipe: z.object({ left: z.string(), right: z.string(), up: z.string(), down: z.string() }).partial().strict().optional(),
  place: z.enum(['top', 'center', 'bottom', 'spread']).optional(), length: dimension.optional(),
};
const frameSchema = z.object({ id, ...frameFields }).strict();
const framePatch = z.object(frameFields).partial().strict();
const groupFields = { x: finite, y: finite, axis: z.enum(['x', 'y']), locked: z.boolean().optional(), free: z.boolean().optional(), pos: z.record(id, point).optional() };
const groupSchema = z.object({ id, ...groupFields, items: z.array(itemSchema) }).strict();
const groupInput = z.object({ id, ...groupFields, items: z.array(itemInput).default([]) }).strict();
const groupPatch = z.object(groupFields).partial().strict();
const themeSchema = z.object({ dark: z.boolean(), bothModes: z.boolean(), contrast: enumeration(CONTRASTS.map((v) => v.key)), shape: enumeration(SHAPES.map((v) => v.key)), font: enumeration(FONTS.map((v) => v.key)), emphasized: z.boolean(), motion: z.enum(['standard', 'expressive']) }).strict();
const projectFields = { title: z.string(), brief: z.string(), frame: z.enum(['phone', 'blank']), platform: z.enum(['android', 'web']).optional(), paletteKey: z.string(), customPalette: z.record(z.string(), z.string()).optional(), dynamicColor: z.boolean().optional(), theme: themeSchema.optional(), promptOptions: z.array(z.string()).optional() };
const projectPatch = z.object(projectFields).partial().strict();
export const createOptionsSchema = projectPatch.extend({ lang: langSchema.optional() }).strict();
const unset = z.array(z.string()).max(50).optional();
const order = z.array(id).max(10000);
export const operationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('project.update'), set: projectPatch, unset }).strict(),
  z.object({ op: z.literal('frame.add'), frame: frameSchema }).strict(),
  z.object({ op: z.literal('frame.update'), id, set: framePatch, unset }).strict(),
  z.object({ op: z.literal('frame.remove'), id, references: z.enum(['reject', 'clear']).default('reject'), contents: z.enum(['keep', 'remove']).default('keep') }).strict(),
  z.object({ op: z.literal('frame.reorder'), ids: order }).strict(),
  z.object({ op: z.literal('frame.tidy'), id }).strict(),
  z.object({ op: z.literal('group.add'), group: groupInput }).strict(),
  z.object({ op: z.literal('group.update'), id, set: groupPatch, unset }).strict(),
  z.object({ op: z.literal('group.remove'), id }).strict(),
  z.object({ op: z.literal('group.reorder'), ids: order }).strict(),
  z.object({ op: z.literal('group.lock'), id, locked: z.boolean() }).strict(),
  z.object({ op: z.literal('item.add'), groupId: id, item: itemInput, index: finite.int().min(0).optional() }).strict(),
  z.object({ op: z.literal('item.update'), id, set: itemPatch, unset }).strict(),
  z.object({ op: z.literal('item.remove'), id }).strict(),
  z.object({ op: z.literal('item.move'), id, groupId: id, index: finite.int().min(0).optional(), position: point.optional() }).strict(),
  z.object({ op: z.literal('item.reorder'), groupId: id, ids: order }).strict(),
  z.object({ op: z.literal('tabs.reorder'), id, indices: z.array(finite.int().min(0)).max(100) }).strict(),
  z.object({ op: z.literal('tabs.remove'), id, index: finite.int().min(0) }).strict(),
  z.object({ op: z.literal('tabs.insert'), id, index: finite.int().min(0), tab }).strict(),
  z.object({ op: z.literal('prompt.set'), text: z.string() }).strict(),
  z.object({ op: z.literal('prompt.clear') }).strict(),
]);
export const transactionSchema = z.object({ version: z.literal(1), operations: z.array(operationSchema).min(1).max(200), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(), promptEditPolicy: z.enum(['reject', 'clear', 'preserve']).default('reject'), lang: langSchema.default('en') }).strict();
export type DesignTransaction = z.input<typeof transactionSchema>;
export class DesignError extends HeadlessError {
  constructor(message: string) { super('INVALID_PROJECT', message); this.name = 'DesignError'; }
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new DesignError(result.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; '));
  return result.data;
}
const fail = (message: string): never => { throw new DesignError(message); };
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => JSON.stringify(k) + ':' + canonical(x)).join(',') + '}';
  return JSON.stringify(v);
}
export const projectRevision = (doc: Doc) => createHash('sha256').update(canonical(doc)).digest('hex');
const defaultItem = (input: z.infer<typeof itemInput>, lang: Lang): Item => {
  const item = { ...makeItem(input.kind as Kind, lang), ...input } as Item;
  checkDimensions(item); return item;
};
function checkDimensions(it: Item) {
  if (['button', 'splitButton'].includes(it.kind) && it.size2 !== undefined && (it.size2 < BUTTON_H_MIN || it.size2 > BUTTON_H_MAX)) fail(`Invalid size2 for ${it.kind}`);
  for (const key of ['size', 'size2'] as const) {
    const spec = KIND_SPEC[it.kind][key], n = it[key];
    const fixed = ['iconButton', 'fab', 'extendedFab', 'chip', 'text', 'loadingIndicator', 'circularProgress', 'topAppBar'].includes(it.kind);
    if (n !== undefined && spec && (n < spec.min || (fixed && n > spec.max))) fail(`Invalid ${key} for ${it.kind}: ${n}`);
  }
}
export function createProject(options: unknown = {}): Doc {
  const { lang: _lang, ...settings } = parse(createOptionsSchema, options);
  return validateDesign({ groups: [], frames: [], title: '', brief: '', frame: 'phone', paletteKey: 'purple', ...settings });
}
function validateDesign(value: unknown): Doc {
  // Validate raw entity values before migrations can replace malformed dimensions.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    if (Array.isArray(raw.groups)) raw.groups.forEach((g) => parse(groupSchema, g));
    if (Array.isArray(raw.frames)) raw.frames.forEach((f) => parse(frameSchema, f));
  }
  const doc = normalizeProject(value);
  parse(z.object({ ...projectFields, groups: z.array(groupSchema), frames: z.array(frameSchema), promptEdit: z.string().optional() }).strict(), doc);
  const seen = new Set<string>();
  const unique = (key: string) => { if (seen.has(key)) fail(`Duplicate ID: ${key}`); seen.add(key); };
  doc.frames.forEach((f) => unique(f.id));
  const targets = new Set(doc.frames.map((f) => f.id));
  const reference = (target: string) => { if (!targets.has(target)) fail(`Dangling frame reference: ${target}`); };
  const checkAction = (a: Item['action'], item: Item) => {
    if (!a) return;
    if (a.to === 'back') return;
    if (a.to === 'menu') { if (!isFab(item.kind)) fail('menu action requires a FAB'); return; }
    if (a.to === 'link') {
      let u: URL; try { u = new URL(a.url ?? ''); } catch { return fail('Link action requires an absolute HTTP(S) URL'); }
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) fail('Unsafe link action URL');
      return;
    }
    reference(a.to);
  };
  for (const f of doc.frames) {
    if (f.length !== undefined && f.length < frameSizeOf(f).h) fail('Frame length must not be shorter than its viewport');
    Object.values(f.swipe ?? {}).forEach(reference);
  }
  for (const g of doc.groups) {
    unique(g.id);
    if (g.items.length === 0) fail('Groups must contain at least one item');
    for (const key of Object.keys(g.pos ?? {})) if (!g.items.some((it) => it.id === key)) fail(`Unknown group position ID: ${key}`);
    for (const it of g.items) {
      unique(it.id);
      if (it.selected !== undefined && it.selected >= (it.tabs?.length ?? 0)) fail(`Selected tab index out of bounds: ${it.id}`);
      if (it.layout) {
        const layouts = it.kind === 'carousel' ? CAROUSEL_LAYOUTS : it.kind === 'datePicker' ? DATE_LAYOUTS : it.kind === 'timePicker' ? TIME_LAYOUTS : [];
        if (!layouts.some((l) => l.key === it.layout)) fail(`Invalid layout for ${it.kind}`);
      }
      checkDimensions(it);
      checkAction(it.action, it);
      for (const [slot, a] of Object.entries(it.actions ?? {})) {
        const slots = actionSlotsOf(it).map((s) => s.key);
        if (it.kind === 'splitButton') slots.push(SPLIT_MENU_SLOT);
        if (!slots.includes(slot)) fail(`Unknown or unavailable action slot: ${slot}`);
        checkAction(a, it);
      }
    }
  }
  return doc;
}
export function inspectProject(value: unknown) {
  const doc = validateDesign(value);
  return { version: 1, revision: projectRevision(doc), doc, counts: { frames: doc.frames.length, groups: doc.groups.length, items: doc.groups.reduce((n, g) => n + g.items.length, 0) }, groups: doc.groups.map((g) => ({ id: g.id, frameId: frameOfGroup(g, doc.frames, {})?.id ?? null, bounds: groupBounds(g, {}), itemIds: g.items.map((it) => it.id) })), geometry: 'estimated; browser font measurements are not available' };
}
export function designCatalog(lang: Lang = 'en') {
  parse(langSchema, lang);
  return { version: 1, components: KIND_ORDER.map((kind) => ({ kind, defaults: { ...makeItem(kind, lang), id: '<required-id>' }, storedFields: Object.keys(itemFields), spec: KIND_SPEC[kind] })), schemas: { transaction: z.toJSONSchema(transactionSchema), create: z.toJSONSchema(createOptionsSchema) }, palettes: PALETTES, colors: COLOR_TOKENS, textColors: TEXT_TOKENS, layouts: { carousel: CAROUSEL_LAYOUTS, datePicker: DATE_LAYOUTS, timePicker: TIME_LAYOUTS }, limits: { documentBytes: MAX_PROJECT_BYTES, batchOperations: 200 }, supported: ['create', 'inspect', 'catalog', ...operationSchema.options.map((o) => o.shape.op.value)], unsupported: ['per-kind semantic validation for every stored field (storedFields is a union, not a promise of visual effect)', 'pixel-exact browser measurements', 'browser undo/redo history', 'live preview interaction', 'automatic group join/split', 'frame duplication with navigation remapping', 'implicit item kind conversion', 'screenshots in this module'], geometry: 'estimated' };
}
function patch<T extends object>(current: T, set: object, unsetKeys: string[] | undefined, optionalKeys: string[]): T {
  const out = { ...current, ...set } as Record<string, unknown>;
  for (const key of unsetKeys ?? []) {
    if (!optionalKeys.includes(key) || Object.hasOwn(set, key)) fail(`Cannot unset field: ${key}`);
    delete out[key];
  }
  return out as T;
}
function reorder<T extends { id: string }>(values: T[], ids: string[]): T[] {
  if (ids.length !== values.length || new Set(ids).size !== ids.length || ids.some((x) => !values.some((v) => v.id === x))) fail('Reorder IDs must be an exact permutation');
  return ids.map((key) => values.find((v) => v.id === key)!);
}
function prepareTabs(it: Item) {
  if (!(KIND_SPEC[it.kind].hasTabs || ['fab', 'extendedFab', 'splitButton', 'fabMenu', 'carousel'].includes(it.kind))) fail(`Component ${it.kind} does not support tabs`);
  if (it.kind === 'carousel') it.tabs = carouselCardsOf(it);
}
const unlock = (g: Group) => { if (g.locked) fail(`Group is locked: ${g.id}; unlock explicitly first`); };

/** The editor's lone-part resize anchoring, using estimated widths headlessly. */
function resizeShift(doc: Doc, g: Group, before: Item, after: Item) {
  const none = { dx: 0, dy: 0 };
  if (g.items.length !== 1) return none;
  const a = sizeOf(before, {}), b = sizeOf(after, {});
  if (isFab(before.kind) || isFab(after.kind)) return { dx: MEASURED.includes(after.kind) ? 0 : a.w - b.w, dy: a.h - b.h };
  if (doc.frame !== 'phone') return none;
  const f = frameOfGroup(g, doc.frames, {});
  if (!f) return none;
  const { w, h } = frameSizeOf(f), length = frameLengthOf(f);
  const shift = (pos: number, old: number, next: number, origin: number, extent: number, foot = true) => {
    const d = next - old;
    if (Math.abs(pos + old / 2 - (origin + extent / 2)) <= 1) return -Math.round(d / 2);
    if (foot && (Math.abs(pos + old - (origin + extent - PHONE_MARGIN)) <= 1 || Math.abs(pos + old - (origin + extent)) <= 1)) return -d;
    return 0;
  };
  return { dx: shift(g.x, a.w, b.w, f.x, w), dy: shift(g.y, a.h, b.h, f.y, length) || (length > h ? shift(g.y, a.h, b.h, f.y, h, false) : 0) };
}

export function applyOperations(value: unknown, input: unknown) {
  if (Buffer.byteLength(JSON.stringify(input) ?? '') > MAX_PROJECT_BYTES) fail('Transaction exceeds 1 MiB');
  const transaction = parse(transactionSchema, input);
  let doc = validateDesign(value);
  if (transaction.expectedRevision && transaction.expectedRevision !== projectRevision(doc)) fail('Revision conflict: document changed after the plan was prepared');
  const original = structuredClone(doc);
  const changes: { index: number; op: string; target?: string }[] = [];
  const warnings: string[] = [];
  const group = (key: string): Group => doc.groups.find((g) => g.id === key) ?? fail(`Unknown group ID: ${key}`);
  const frame = (key: string): Frame => doc.frames.find((f) => f.id === key) ?? fail(`Unknown frame ID: ${key}`);
  const item = (key: string): { g: Group; it: Item } => {
    for (const g of doc.groups) { const it = g.items.find((i) => i.id === key); if (it) return { g, it }; }
    return fail(`Unknown item ID: ${key}`);
  };
  const assertNew = (key: string) => { if (doc.frames.some((f) => f.id === key) || doc.groups.some((g) => g.id === key || g.items.some((it) => it.id === key))) fail(`Duplicate ID: ${key}`); };
  const insert = <T>(array: T[], value: T, index = array.length) => { if (index > array.length) fail('Insert index out of bounds'); array.splice(index, 0, value); };
  let designChanged = false;
  let promptHandled = false;
  for (const [index, op] of transaction.operations.entries()) {
    const before = canonical(doc);
    const locked = doc.groups.filter((g) => g.locked).map((g) => ({ id: g.id, value: canonical(g) }));
    try {
      switch (op.op) {
        case 'project.update': doc = patch(doc, op.set, op.unset, ['platform', 'customPalette', 'dynamicColor', 'theme', 'promptOptions']); break;
        case 'frame.add': assertNew(op.frame.id); doc.frames.push(structuredClone(op.frame) as Frame); break;
        case 'frame.update': {
          const f = frame(op.id); const next = patch(f, op.set, op.unset, Object.keys(frameFields).filter((k) => !['name', 'x', 'y'].includes(k))) as Frame;
          const dx = next.x - f.x, dy = next.y - f.y;
          if (dx || dy) {
            const owned = new Set(doc.groups.filter((g) => frameOfGroup(g, doc.frames, {})?.id === f.id).map((g) => g.id));
            doc.groups = doc.groups.map((g) => owned.has(g.id) ? { ...g, x: g.x + dx, y: g.y + dy } : g);
            doc.frames = doc.frames.map((v) => v.id === f.id ? { ...v, x: next.x, y: next.y } : v);
          }
          const current = frame(op.id);
          // Keep the previous length until stretchFrame computes its delta.
          const resized = { ...next, length: current.length };
          if (['w', 'h'].some((key) => Object.hasOwn(op.set, key) || op.unset?.includes(key))) {
            doc = { ...doc, ...carryFrame(doc.groups, current, resized, doc.frames, {}) };
          } else doc.frames = doc.frames.map((v) => v.id === op.id ? resized : v);
          if (Object.hasOwn(op.set, 'length') || op.unset?.includes('length')) {
            const previousLength = frame(op.id);
            doc = { ...doc, ...stretchFrame(doc.groups, previousLength, next.length ?? frameSizeOf(next).h, doc.frames, {}) };
          }
          break;
        }
        case 'frame.remove': {
          const f = frame(op.id);
          if (op.contents === 'remove') doc.groups = doc.groups.filter((g) => frameOfGroup(g, doc.frames, {})?.id !== f.id);
          doc.frames = doc.frames.filter((v) => v.id !== op.id);
          if (op.references === 'clear') {
            for (const fr of doc.frames) if (fr.swipe) fr.swipe = Object.fromEntries(Object.entries(fr.swipe).filter(([, target]) => target !== op.id));
            for (const g of doc.groups) for (const it of g.items) {
              if (it.action?.to === op.id) delete it.action;
              if (it.actions) it.actions = Object.fromEntries(Object.entries(it.actions).filter(([, a]) => a.to !== op.id));
            }
          }
          break;
        }
        case 'frame.reorder': doc.frames = reorder(doc.frames, op.ids); break;
        case 'frame.tidy': { const result = tidyFrame(doc.groups, frame(op.id), doc.frames, {}); if (!result) fail('Frame cannot be tidied with the current layout'); doc.groups = result!; break; }
        case 'group.add': {
          assertNew(op.group.id);
          const g = { ...structuredClone(op.group), items: op.group.items.map((v) => defaultItem(v, transaction.lang)) } as Group;
          for (const it of g.items) assertNew(it.id);
          doc.groups.push(g); break;
        }
        case 'group.update': { const g = group(op.id); unlock(g); if (Object.hasOwn(op.set, 'locked') || op.unset?.includes('locked')) fail('Use group.lock to change locking'); Object.assign(g, patch(g, op.set, op.unset, ['free', 'pos'])); for (const key of op.unset ?? []) delete (g as unknown as Record<string, unknown>)[key]; break; }
        case 'group.remove': unlock(group(op.id)); doc.groups = doc.groups.filter((g) => g.id !== op.id); break;
        case 'group.reorder': doc.groups.forEach(unlock); doc.groups = reorder(doc.groups, op.ids); break;
        case 'group.lock': group(op.id).locked = op.locked; break;
        case 'item.add': { const g = group(op.groupId); unlock(g); assertNew(op.item.id); insert(g.items, defaultItem(op.item, transaction.lang), op.index); break; }
        case 'item.update': {
          const { g, it } = item(op.id); unlock(g);
          const next = patch(it, op.set, op.unset, Object.keys(itemFields).filter((k) => !['label', 'icon', 'variant'].includes(k)));
          checkDimensions(next);
          const update = { ...op.set, ...Object.fromEntries((op.unset ?? []).map((k) => [k, undefined])) } as Partial<Item>;
          const resizes = ['size', 'size2', 'railExpanded', 'railModal'].some((k) => Object.hasOwn(update, k));
          const shift = resizes ? resizeShift(doc, g, it, next) : { dx: 0, dy: 0 };
          if (Object.hasOwn(update, 'railExpanded') || Object.hasOwn(update, 'railModal')) doc.groups = updateRail(doc.groups, doc.frames, {}, it.id, update);
          else { g.x += shift.dx; g.y += shift.dy; g.items = g.free ? g.items.map((i) => i.id === it.id ? next : i) : runSizePatch(g.items, it.id, update); }
          break;
        }
        case 'item.remove': { const { g, it } = item(op.id); unlock(g); g.items = g.items.filter((i) => i.id !== it.id); if (g.pos) delete g.pos[it.id]; if (!g.items.length) doc.groups = doc.groups.filter((v) => v.id !== g.id); break; }
        case 'item.move': {
          const { g, it } = item(op.id); const target = group(op.groupId); unlock(g); unlock(target);
          if (op.position && !target.free) fail('position requires a free target group');
          g.items = g.items.filter((i) => i.id !== it.id); if (g.pos) delete g.pos[it.id];
          insert(target.items, it, op.index);
          if (target.free) target.pos = { ...target.pos, [it.id]: op.position ?? { x: 0, y: 0 } };
          if (!g.items.length) doc.groups = doc.groups.filter((v) => v.id !== g.id);
          break;
        }
        case 'item.reorder': {
          const g = group(op.groupId); unlock(g); const items = reorder(g.items, op.ids);
          if (g.free) {
            const rank = new Map(items.map((it, i) => [it.id, i])); const pos = { ...g.pos };
            for (const run of explodeGroup(g, {})) {
              if (run.items.length < 2) continue;
              const slots = run.items.map((it) => pos[it.id] ?? { x: 0, y: 0 });
              [...run.items].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!).forEach((it, i) => { pos[it.id] = slots[i]; });
            }
            g.pos = pos;
          }
          g.items = items; break;
        }
        case 'tabs.reorder': { const { g, it } = item(op.id); unlock(g); prepareTabs(it); const n = it.tabs?.length ?? 0; if (op.indices.length !== n || new Set(op.indices).size !== n || op.indices.some((v) => v >= n)) fail('Tab indices must be an exact permutation'); Object.assign(it, reorderTabsPatch(it, op.indices)); break; }
        case 'tabs.remove': { const { g, it } = item(op.id); unlock(g); prepareTabs(it); if (it.kind === 'carousel' && (it.tabs?.length ?? 0) <= 2) fail('Carousel requires at least two cards'); if (op.index >= (it.tabs?.length ?? 0)) fail('Tab index out of bounds'); Object.assign(it, removeTabPatch(it, op.index)); if (it.kind === 'carousel') it.count = it.tabs!.length; break; }
        case 'tabs.insert': {
          const { g, it } = item(op.id); unlock(g); prepareTabs(it); if (it.kind === 'carousel' && (it.tabs?.length ?? 0) >= 8) fail('Carousel supports at most eight cards'); const tabs = [...(it.tabs ?? [])]; insert(tabs, op.tab as Item['tabs'] extends (infer T)[] | undefined ? T : never, op.index);
          it.tabs = tabs; if (it.kind === 'carousel') it.count = tabs.length;
          if (it.selected !== undefined && it.selected >= op.index) it.selected++;
          if (it.actions) it.actions = Object.fromEntries(Object.entries(it.actions).map(([key, a]) => [key.startsWith('tab:') && Number(key.slice(4)) >= op.index ? `tab:${Number(key.slice(4)) + 1}` : key, a]));
          break;
        }
        case 'prompt.set': doc.promptEdit = op.text; promptHandled = true; break;
        case 'prompt.clear': delete doc.promptEdit; promptHandled = true; break;
      }
      for (const previous of locked) if (!(op.op === 'group.lock' && op.id === previous.id) && canonical(doc.groups.find((g) => g.id === previous.id)) !== previous.value) fail(`Operation would change locked group: ${previous.id}`);
      if (canonical(doc) !== before) {
        changes.push({ index, op: op.op, ...('id' in op ? { target: op.id } : {}) });
        if (!op.op.startsWith('prompt.')) { designChanged = true; promptHandled = false; }
      }
    } catch (error) { throw new DesignError(`Operation ${index} (${op.op}): ${error instanceof Error ? error.message : 'failed'}`); }
  }
  if (designChanged && doc.promptEdit !== undefined && !promptHandled) {
    if (transaction.promptEditPolicy === 'reject') fail('Design changes would leave promptEdit stale; use clear/preserve policy or a final prompt.set/clear operation');
    if (transaction.promptEditPolicy === 'clear') delete doc.promptEdit;
    else warnings.push('Saved promptEdit was explicitly preserved and may no longer describe this design.');
  }
  const normalized = validateDesign(doc);
  if (canonical(normalized) !== canonical(doc)) warnings.push('Editor normalization applied migrations or constrained component state.');
  return { version: 1, doc: normalized, revision: projectRevision(normalized), previousRevision: projectRevision(original), changes, warnings, geometry: 'estimated' };
}
