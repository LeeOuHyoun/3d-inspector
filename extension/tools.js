import { parse, Parser } from './vendor/acorn.js';
import { generate } from './vendor/astring.js';
import { applyPatches, parsePatches, stripPlugin } from './core.js';

const PARSE_OPTIONS = { ecmaVersion: 'latest' };
const SAVABLE = new Set(['ok', 'applied']);
const STATUS = {
  ok: () => '적용 가능',
  applied: () => '이미 적용됨',
  missing: () => '앵커 없음: 버전이 바뀌었을 수 있음',
  ambiguous: (r) => `앵커 ${r.count}곳 일치: 더 길게 지정`,
  overlap: () => '다른 패치와 겹침',
  'no-module': () => '모듈 없음',
};
const FUNCTION_TYPES = new Set(['FunctionExpression', 'FunctionDeclaration', 'ArrowFunctionExpression']);
const META_KEYS = new Set(['type', 'start', 'end', 'loc', 'range']);
const KEY_OWNERS = new Set(['MemberExpression', 'Property', 'MethodDefinition', 'PropertyDefinition']);

function preview(text) {
  const line = text.trim().split('\n', 1)[0];
  return line.length > 60 ? `${line.slice(0, 60)}...` : line;
}

function formatResult(r) {
  return `  [${STATUS[r.status](r)}] ${r.module}  "${preview(r.find)}"`;
}

function syntaxError(text) {
  try {
    parse(text, PARSE_OPTIONS);
    return null;
  } catch (e) {
    return e.message;
  }
}

export function patchReport(bundles, spec) {
  const patches = parsePatches(spec);
  if (!patches.length) return { text: '[3di patch] 패치를 찾지 못했습니다. 형식: "@@ 모듈ID" 다음 줄부터 <<<< 찾을 문자열 ==== 바꿀 문자열 >>>> (각 구분자는 한 줄에 단독)', files: [] };
  const owner = (p) => bundles.find((b) => b.modules.some((m) => m.id === p.module));
  const files = [];
  const lines = bundles.flatMap((b) => {
    const own = patches.filter((p) => owner(p) === b);
    if (!own.length) return [];
    const { results, text, changed } = applyPatches(b.text, b.modules, own);
    const error = changed ? syntaxError(text) : null;
    const savable = changed > 0 && !error && results.every((r) => SAVABLE.has(r.status));
    if (savable) files.push({ name: b.name, text });
    return [b.name, ...results.map(formatResult), ...(changed ? [`  구문 검사: ${error ? `오류 ${error}` : '정상'}`] : []), `  저장: ${savable ? '가능' : '불가'}`];
  });
  const orphans = patches.filter((p) => !owner(p)).map((p) => formatResult({ ...p, status: 'no-module' }));
  return { text: ['[3di patch]', ...lines, ...orphans].join('\n'), files };
}

function children(node) {
  return Object.entries(node)
    .filter(([key]) => !META_KEYS.has(key))
    .flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).filter((c) => typeof c?.type === 'string').map((c) => [key, c]));
}

function patternNames(node) {
  switch (node?.type) {
    case 'Identifier':
      return [node.name];
    case 'ObjectPattern':
      return node.properties.flatMap((p) => patternNames(p.type === 'RestElement' ? p : p.value));
    case 'ArrayPattern':
      return node.elements.flatMap(patternNames);
    case 'AssignmentPattern':
      return patternNames(node.left);
    case 'RestElement':
      return patternNames(node.argument);
    default:
      return [];
  }
}

function varNames(node) {
  return children(node).flatMap(([, c]) => {
    if (c.type === 'FunctionDeclaration') return [c.id.name];
    if (FUNCTION_TYPES.has(c.type)) return [];
    const own = c.type === 'VariableDeclaration' && c.kind === 'var' ? c.declarations.flatMap((d) => patternNames(d.id)) : [];
    return [...own, ...varNames(c)];
  });
}

function lexicalNames(statements) {
  return statements.flatMap((s) => {
    if (s.type === 'VariableDeclaration' && s.kind !== 'var') return s.declarations.flatMap((d) => patternNames(d.id));
    return s.type === 'ClassDeclaration' || s.type === 'FunctionDeclaration' ? [s.id.name] : [];
  });
}

function loopNames(declaration) {
  return declaration?.type === 'VariableDeclaration' && declaration.kind !== 'var' ? lexicalNames([declaration]) : [];
}

function bindings(node) {
  if (FUNCTION_TYPES.has(node.type)) {
    const body = node.body.type === 'BlockStatement' ? [...varNames(node.body), ...lexicalNames(node.body.body)] : [];
    return [...(node.type === 'FunctionExpression' && node.id ? [node.id.name] : []), ...node.params.flatMap(patternNames), ...body];
  }
  switch (node.type) {
    case 'BlockStatement':
    case 'StaticBlock':
      return lexicalNames(node.body);
    case 'SwitchStatement':
      return lexicalNames(node.cases.flatMap((c) => c.consequent));
    case 'ForStatement':
      return loopNames(node.init);
    case 'ForInStatement':
    case 'ForOfStatement':
      return loopNames(node.left);
    case 'CatchClause':
      return patternNames(node.param);
    case 'ClassExpression':
      return node.id ? [node.id.name] : [];
    default:
      return [];
  }
}

function isReference(parent, key) {
  if (KEY_OWNERS.has(parent.type) && (key === 'key' || (parent.type === 'MemberExpression' && key === 'property'))) return parent.computed;
  return key !== 'label' && parent.type !== 'MetaProperty';
}

function rename(node, names, shadowed) {
  const inner = bindings(node).filter((n) => names.has(n));
  const scope = inner.length ? new Set([...shadowed, ...inner]) : shadowed;
  children(node).forEach(([key, child]) => {
    if (child.type !== 'Identifier') return rename(child, names, scope);
    if (!isReference(node, key) || !names.has(child.name) || scope.has(child.name)) return;
    child.name = names.get(child.name);
    if (node.type === 'Property') node.shorthand = false;
  });
}

function identifierNames(node, found = new Set()) {
  if (node.type === 'Identifier') found.add(node.name);
  children(node).forEach(([, c]) => identifierNames(c, found));
  return found;
}

function nameOf(dep) {
  const base = stripPlugin(dep).split('/').at(-1).replace(/[^\w$]/g, '_');
  return /^\d/.test(base) ? `_${base}` : base;
}

export function restoreModule(bundle, id) {
  const mod = bundle.modules.find((m) => m.id === id);
  if (!mod) return `[3di module] ${id}: 모듈 없음`;
  const parser = new Parser(PARSE_OPTIONS, bundle.text.slice(mod.start, mod.end));
  parser.nextToken();
  const call = parser.parseMaybeAssign();
  const factory = call.arguments.find((a) => FUNCTION_TYPES.has(a.type));
  const deps = call.arguments.find((a) => a.type === 'ArrayExpression')?.elements.map((e) => e?.value) ?? [];
  const used = identifierNames(call);
  const names = new Map();
  const header = (factory?.params ?? []).flatMap((p, i) => {
    if (p.type !== 'Identifier' || typeof deps[i] !== 'string') return [];
    let name = nameOf(deps[i]);
    while (used.has(name)) name += '$';
    used.add(name);
    names.set(p.name, name);
    return [`// ${p.name} → ${name} = ${deps[i]}`];
  });
  if (factory) {
    rename(factory.body, names, new Set());
    factory.params.forEach((p) => {
      if (names.has(p.name)) p.name = names.get(p.name);
    });
  }
  return [`// [3di module] ${id} (${bundle.name}, 읽기 전용: 패치 앵커는 원본 번들에서 복사)`, ...header, generate(call)].join('\n');
}
