import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { buildModuleIndex, findModule, getLineStarts, toOffset, toLineColumn, parseStack, flattenNls, matchNls, findNlsUsages, parsePatches, applyPatches } from '../src/core.js';

const WEBAPP = new URL('../../Enovia_analysis/enovia2025/3dspace/webapps/ENOChgGovernanceUX/', import.meta.url);
const bundle = readFileSync(new URL('ENOChgGovernanceUX.js', WEBAPP), 'utf8');
const NLS_ID = 'DS/ENOChgGovernanceUX/assets/nls/ENOChgGovernanceNLS';

function loadAmd(text, filename) {
  const factories = {};
  const define = (id, deps, factory) => {
    factories[id] = typeof deps === 'function' || !Array.isArray(deps) ? deps : factory;
  };
  runInNewContext(text, { define, console }, { filename });
  return factories;
}

function nlsSources() {
  const objects = loadAmd(readFileSync(new URL('ENOChgGovernanceUX_en.js', WEBAPP), 'utf8'), 'en.js');
  return Object.entries(objects).map(([id, obj]) => ({ id, entries: flattenNls(obj) }));
}

function throwingProxy() {
  return new Proxy(function () {}, {
    get() {
      throw new Error('probe');
    },
    apply() {
      throw new Error('probe');
    },
  });
}

function resolveError(error, text, filename) {
  const modules = buildModuleIndex(text);
  const lineStarts = getLineStarts(text);
  const frame = parseStack(error.stack).find((f) => f.url === filename);
  return findModule(modules, toOffset(lineStarts, frame.line, frame.column));
}

test('2025 번들에서 모듈 274개를 고유 ID로 색인한다', () => {
  const modules = buildModuleIndex(bundle);
  assert.equal(modules.length, 274);
  assert.equal(new Set(modules.map((m) => m.id)).size, 274);
  assert.equal(modules[0].id, 'DS/ENOChgGovernanceUX/scripts/view/changeRequest/ChgCreateChangeRequest');
  assert.equal(modules.at(-1).end, bundle.length);
});

test('deps와 팩토리 파라미터가 1:1로 대응한다', () => {
  const [first] = buildModuleIndex(bundle);
  assert.deepEqual(first.params, ['e', 't', 'i', 'n', 'o', 'a', 's']);
  assert.equal(first.deps.length, 7);
  assert.equal(first.deps[6], 'require');
});

test('오프셋으로 모듈을 찾는다', () => {
  const modules = buildModuleIndex(bundle);
  const offset = bundle.indexOf('launchCreateChangeRequestDialog');
  assert.equal(findModule(modules, offset).id, modules[0].id);
  assert.equal(findModule(modules, bundle.length - 1).id, modules.at(-1).id);
  assert.equal(findModule(modules, 0), null);
});

test('한 줄 압축 번들에서도 열 위치로 모듈을 찾는다', () => {
  const text = '(define("DS/A/a",["DS/B"],function(e){return{run:function(){e.x}}}),define("DS/A/b",[],function(){return{run:function(){throw new Error("x")}}}));';
  const factories = loadAmd(text, 'min.js');
  const error = (() => {
    try {
      factories['DS/A/b']().run();
    } catch (e) {
      return e;
    }
  })();
  assert.equal(resolveError(error, text, 'min.js').id, 'DS/A/b');
});

test('실제 2025 번들 코드의 스택트레이스로 모듈을 찾는다', () => {
  const filename = 'ENOChgGovernanceUX.js';
  const factories = loadAmd(bundle, filename);
  const id = 'DS/ENOChgGovernanceUX/scripts/view/changeRequest/ChgCreateChangeRequest';
  const api = factories[id](...Array.from({ length: 7 }, throwingProxy));
  const error = (() => {
    try {
      api.launchCreateChangeRequestDialog(throwingProxy());
    } catch (e) {
      return e;
    }
  })();
  assert.equal(resolveError(error, bundle, filename).id, id);
});

test('오프셋을 줄:열로 바꾼다', () => {
  const lineStarts = getLineStarts('ab\ncd\nef');
  assert.deepEqual(toLineColumn(lineStarts, 0), { line: 1, column: 1 });
  assert.deepEqual(toLineColumn(lineStarts, 4), { line: 2, column: 2 });
  assert.deepEqual(toLineColumn(lineStarts, 6), { line: 3, column: 1 });
});

test('NLS 객체를 키 경로로 평탄화한다', () => {
  assert.deepEqual(flattenNls({ a: 'A', b: { c: 'C', d: 1 } }), [
    { key: 'a', value: 'A' },
    { key: 'b.c', value: 'C' },
  ]);
  const keys = nlsSources().flatMap((s) => s.entries);
  assert.ok(keys.length > 700);
  assert.ok(keys.some((e) => e.key === 'templateNLS.back'));
});

test('화면 문구로 NLS 키를 찾는다', () => {
  const sources = nlsSources();
  const [exact] = matchNls(sources, '  Change   management ');
  assert.deepEqual([exact.id, exact.key, exact.match], [NLS_ID, 'CHG_GOV_Widget_Title', 'exact']);
  const template = sources.flatMap((s) => s.entries).find((e) => /\{\d\}/.test(e.value));
  const filled = template.value.replace(/\{\d\}/g, '42');
  assert.ok(matchNls(sources, filled).some((m) => m.key === template.key && m.match === 'template'));
  assert.ok(matchNls(sources, 'Owner: John').some((m) => m.key === 'CHG_GOV_DataGrid_Column_Owner' && m.match === 'partial'));
  assert.deepEqual(matchNls(sources, '   '), []);
});

test('NLS 키를 사용하는 모듈과 위치를 찾는다', () => {
  const modules = buildModuleIndex(bundle);
  const usages = findNlsUsages(bundle, modules, NLS_ID, 'CHG_NEW_CHANGE_REQUEST_FORM');
  assert.ok(usages.length > 0);
  assert.equal(usages[0].module, modules[0].id);
  assert.equal(usages[0].precise, true);
  assert.ok(bundle.startsWith('o.CHG_NEW_CHANGE_REQUEST_FORM', usages[0].offset));
  const nested = findNlsUsages(bundle, modules, 'DS/ENOChgGovernanceUX/assets/nls/ENOChangeIDCard', 'templateNLS.back');
  assert.ok(nested.every((u) => bundle.slice(u.offset, u.offset + 30).includes('back')));
});

test('크롬 스택 형식을 파싱한다', () => {
  const stack = [
    'Error: x',
    '    at Object.run (https://host/3dspace/webapps/A/A.js:1:120)',
    '    at https://host/3dspace/webapps/A/A.js:3:5',
    '    at async Foo.bar (https://host/b.js?v=1:10:2)',
  ].join('\n');
  assert.deepEqual(parseStack(stack), [
    { fn: 'Object.run', url: 'https://host/3dspace/webapps/A/A.js', line: 1, column: 120 },
    { fn: '', url: 'https://host/3dspace/webapps/A/A.js', line: 3, column: 5 },
    { fn: 'async Foo.bar', url: 'https://host/b.js?v=1', line: 10, column: 2 },
  ]);
});

test('문자열 앵커로 패치를 적용하고 상태를 판정한다', () => {
  const modules = buildModuleIndex(bundle);
  const id = modules[0].id;
  const block = (find, replace) => ['<<<<', find, '====', replace, '>>>>'];
  const spec = [
    `@@ ${id}`,
    ...block('o.CHG_NEW_CHANGE_REQUEST_FORM', 'o.CHG_NEW_CHANGE_REQUEST_FORM + "!"'),
    ...block('function', 'x'),
    ...block('zzz_not_here', 'y'),
    '@@ DS/None/x',
    ...block('a', 'b'),
  ].join('\r\n');
  const patches = parsePatches(spec);
  assert.deepEqual(patches.map((p) => p.module), [id, id, id, 'DS/None/x']);
  const { results, text, changed } = applyPatches(bundle, modules, patches);
  assert.deepEqual(results.map((r) => r.status), ['ok', 'ambiguous', 'missing', 'no-module']);
  assert.equal(changed, 1);
  assert.equal(text.length, bundle.length + 6);
  assert.ok(text.includes('o.CHG_NEW_CHANGE_REQUEST_FORM + "!"'));
  assert.equal(applyPatches(text, modules, patches.slice(0, 1)).results[0].status, 'applied');
  const overlap = applyPatches(bundle, modules, parsePatches([`@@ ${id}`, ...block('launchCreateChangeRequestDialog: function', 'a'), ...block('Dialog: function', 'b')].join('\n')));
  assert.deepEqual(overlap.results.map((r) => r.status), ['ok', 'overlap']);
  assert.equal(overlap.changed, 1);
});
