import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { buildModuleIndex } from '../src/core.js';
import { patchReport, restoreModule } from '../extension/tools.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const real = read('../../cnc_source/3dspace/webapps/ENOChgGovernanceUX/ENOChgGovernanceUX.js');
const fixture = read('fixture/webapps/ENOChgFixture/ENOChgFixture.js');
const toBundle = (name, text) => ({ name, text, modules: buildModuleIndex(text) });

test('모듈 파라미터를 deps 이름으로 바꾸되 안쪽 스코프에서 다시 선언된 이름은 그대로 둔다', () => {
  const panel = restoreModule(toBundle('ENOChgFixture.js', fixture), 'DS/ENOChgFixture/scripts/Panel');
  assert.match(panel, /^\/\/ e → PlatformAPI = DS\/PlatformAPI\/PlatformAPI$/m);
  assert.match(panel, /function \(PlatformAPI\)/);
  assert.match(panel, /return \(PlatformAPI\.subscribe\("FIX_OPEN"/);
  assert.match(panel, /show: function \(e\) \{[\s\S]*e\.appendChild\(t\)/);
  const home = restoreModule(toBundle('ENOChgFixture.js', fixture), 'DS/ENOChgFixture/scripts/Home');
  assert.match(home, /label: FixtureNLS\.OPEN_LABEL/);
  assert.match(home, /var a = new ModelEvents\(\)/);
  assert.match(home, /Panel\.show\(r\), PlatformAPI\.publish\("FIX_OPEN"/);
});

test('2025 번들의 모든 모듈을 복원하고 결과가 올바른 JS다', () => {
  const b = toBundle('ENOChgGovernanceUX.js', real);
  for (const m of b.modules) {
    const out = restoreModule(b, m.id);
    assert.doesNotThrow(() => parse(out, { ecmaVersion: 'latest' }), m.id);
  }
  const first = restoreModule(b, b.modules[0].id);
  assert.ok(first.includes('UserPreferenceUtil.getUserPreference(DefaultPreferencesManager.keys'));
  assert.ok(first.includes('ENOChgGovernanceNLS.CHG_NEW_CHANGE_REQUEST_FORM'));
  assert.match(restoreModule(b, 'DS/None'), /모듈 없음/);
});

test('패치 보고서는 모두 적용 가능하고 구문이 맞을 때만 저장 파일을 만든다', () => {
  const b = toBundle('ENOChgGovernanceUX.js', real);
  const id = b.modules[0].id;
  const spec = (replace) => [`@@ ${id}`, '<<<<', 'o.CHG_NEW_CHANGE_REQUEST_FORM', '====', replace, '>>>>'].join('\n');
  const good = patchReport([b], spec('o.CHG_NEW_CHANGE_REQUEST_FORM + "!"'));
  assert.match(good.text, /\[적용 가능\][\s\S]*구문 검사: 정상[\s\S]*저장: 가능/);
  assert.equal(good.files.length, 1);
  assert.equal(good.files[0].name, 'ENOChgGovernanceUX.js');
  const broken = patchReport([b], spec('o.CHG_NEW_CHANGE_REQUEST_FORM + ((('));
  assert.match(broken.text, /구문 검사: 오류[\s\S]*저장: 불가/);
  assert.equal(broken.files.length, 0);
  const orphan = patchReport([], '@@ DS/None\n<<<<\na\n====\nb\n>>>>');
  assert.match(orphan.text, /\[모듈 없음\] DS\/None/);
  assert.match(patchReport([b], 'nothing').text, /패치를 찾지 못했습니다/);
});
