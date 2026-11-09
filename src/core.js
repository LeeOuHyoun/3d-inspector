const MODULE_RE = /(?<![\w$])define\(\s*(["'])(DS\/[^"']+)\1\s*,\s*(?:\[([^\]]*)\]\s*,\s*)?(?:function\s*\(([^)]*)\))?/g;
const DEP_RE = /["']([^"']+)["']/g;
const FRAME_RE = /^\s*at (?:(.*?) \()?(.+?):(\d+):(\d+)\)?$/;
const PLACEHOLDER_RE = /\\\{\w+\\\}|<\\\?>/g;
const MATCH_RANK = { exact: 0, template: 1, partial: 2 };

export function buildModuleIndex(text) {
  const found = [...text.matchAll(MODULE_RE)].map((m) => ({
    id: m[2],
    start: m.index,
    deps: m[3] === undefined ? [] : [...m[3].matchAll(DEP_RE)].map((d) => d[1]),
    params: m[4] === undefined ? [] : m[4].split(',').map((p) => p.trim()).filter(Boolean),
  }));
  return found.map((mod, i) => ({ ...mod, end: i + 1 < found.length ? found[i + 1].start : text.length }));
}

function floorIndex(sorted, value, get) {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (get(sorted[mid]) <= value) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi;
}

export function findModule(modules, offset) {
  const mod = modules[floorIndex(modules, offset, (m) => m.start)];
  return mod && offset < mod.end ? mod : null;
}

export function getLineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

export function toOffset(lineStarts, line, column) {
  return lineStarts[line - 1] + column - 1;
}

export function toLineColumn(lineStarts, offset) {
  const i = floorIndex(lineStarts, offset, (s) => s);
  return { line: i + 1, column: offset - lineStarts[i] + 1 };
}

export function parseStack(stack) {
  return stack
    .split('\n')
    .map((line) => line.match(FRAME_RE))
    .filter(Boolean)
    .map((m) => ({ fn: m[1] ?? '', url: m[2], line: Number(m[3]), column: Number(m[4]) }));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalize(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function stripPlugin(id) {
  return id.replace(/^[\w-]+!/, '');
}

export function stripQuery(url) {
  return url.split(/[?#]/)[0];
}

export function flattenNls(obj, prefix = '') {
  return Object.entries(obj ?? {}).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') return [{ key, value: v }];
    return v && typeof v === 'object' ? flattenNls(v, key) : [];
  });
}

function matchKind(value, target) {
  if (value === target) return 'exact';
  const pattern = escapeRe(value);
  if (pattern.match(PLACEHOLDER_RE) && new RegExp(`^${pattern.replace(PLACEHOLDER_RE, '.+')}$`).test(target)) return 'template';
  if (value.length > 2 && (target.includes(value) || value.includes(target))) return 'partial';
  return null;
}

export function matchNls(sources, text, limit = 10) {
  const target = normalize(text);
  if (!target) return [];
  return sources
    .flatMap(({ id, entries }) => entries.map((e) => ({ id, ...e, match: matchKind(normalize(e.value), target) })))
    .filter((e) => e.match)
    .sort((a, b) => MATCH_RANK[a.match] - MATCH_RANK[b.match] || Math.abs(a.value.length - text.length) - Math.abs(b.value.length - text.length))
    .slice(0, limit);
}

export function findNlsUsages(text, modules, nlsId, key) {
  const path = key.split('.');
  const step = (p) => `(?:\\.${escapeRe(p)}|\\[["']${escapeRe(p)}["']\\])`;
  const loose = new RegExp(`${step(path.at(-1))}(?![\\w$])`, 'g');
  return modules.flatMap((mod) => {
    const index = mod.deps.findIndex((d) => stripPlugin(d) === nlsId);
    if (index === -1) return [];
    const body = text.slice(mod.start, mod.end);
    const param = mod.params[index];
    const precise = param ? [...body.matchAll(new RegExp(`(?<![\\w$.])${escapeRe(param)}${path.map(step).join('')}(?![\\w$])`, 'g'))] : [];
    const hits = precise.length ? precise : [...body.matchAll(loose)];
    return hits.map((m) => ({ module: mod.id, offset: mod.start + m.index, precise: precise.length > 0 }));
  });
}

const PATCH_BLOCK_RE = /<<<<\n([\s\S]*?)\n====\n([\s\S]*?)\n>>>>/g;

export function parsePatches(source) {
  return source
    .replace(/\r\n/g, '\n')
    .split(/^@@[ \t]*/m)
    .slice(1)
    .flatMap((section) => {
      const module = section.split('\n', 1)[0].trim();
      return [...section.matchAll(PATCH_BLOCK_RE)].map((m) => ({ module, find: m[1], replace: m[2] }));
    });
}

function occurrences(text, find, from, to) {
  const found = [];
  for (let i = find ? text.indexOf(find, from) : -1; i !== -1 && i + find.length <= to; i = text.indexOf(find, i + 1)) found.push(i);
  return found;
}

function patchStatus(text, modules, patch) {
  const mod = modules.find((m) => m.id === patch.module);
  if (!mod) return { status: 'no-module' };
  const hits = occurrences(text, patch.find, mod.start, mod.end);
  const applied = occurrences(text, patch.replace, mod.start, mod.end).length === 1;
  if (applied && (!hits.length || patch.replace.includes(patch.find))) return { status: 'applied' };
  if (hits.length === 1) return { status: 'ok', offset: hits[0] };
  return { status: hits.length ? 'ambiguous' : 'missing', count: hits.length };
}

export function applyPatches(text, modules, patches) {
  const results = patches.map((p) => ({ ...p, ...patchStatus(text, modules, p) }));
  const ok = results.filter((r) => r.status === 'ok').sort((a, b) => a.offset - b.offset);
  ok.forEach((r, i) => {
    if (i && ok[i - 1].offset + ok[i - 1].find.length > r.offset) r.status = 'overlap';
  });
  const apply = ok.filter((r) => r.status === 'ok').reverse();
  const patched = apply.reduce((t, r) => t.slice(0, r.offset) + r.replace + t.slice(r.offset + r.find.length), text);
  return { results, text: patched, changed: apply.length };
}
