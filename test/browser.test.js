import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const ROOT = new URL('../', import.meta.url);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
const HOME = 'DS/ENOChgFixture/scripts/Home';
const PANEL = 'DS/ENOChgFixture/scripts/Panel';

function serve() {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    try {
      const body = await readFile(new URL(`.${path}`, ROOT));
      res.writeHead(200, { 'content-type': TYPES[path.slice(path.lastIndexOf('.'))] ?? 'text/plain' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function runFixture(page) {
  const server = await serve();
  const profile = await mkdtemp(join(tmpdir(), '3di-'));
  try {
    const url = `http://127.0.0.1:${server.address().port}/test/fixture/${page}`;
    const args = ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, '--virtual-time-budget=10000', '--dump-dom', url];
    const { stdout } = await promisify(execFile)(CHROME, args, { maxBuffer: 1 << 24 });
    const raw = stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/)[1];
    return JSON.parse(raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  } finally {
    server.close();
    await rm(profile, { recursive: true, force: true });
  }
}

test('크롬에서 스니펫이 요소를 만든 모듈을 찾는다', { skip: !CHROME, timeout: 60000 }, async () => {
  const out = await runFixture('index.html');
  assert.equal(out.error, undefined, out.error);
  assert.match(out.diag, /ENOChgFixture\.js size=\d+ lines=\d+ modules=2/);
  assert.doesNotMatch(out.diag, /UIKIT/);
  assert.deepEqual(out.before, []);

  const [button] = out.button;
  assert.equal(button.label, 'button');
  const byKind = Object.fromEntries(button.entries.map((e) => [e.kind, e]));
  assert.equal(byKind.create.chain[0].module, 'DS/ENOChgFixture/scripts/Home');
  assert.equal(byKind.insert.chain[0].module, 'DS/ENOChgFixture/scripts/Home');
  assert.equal(byKind.listen.type, 'click');
  assert.equal(byKind.listen.handler, 'DS/ENOChgFixture/scripts/Home');

  const [panel] = out.span;
  assert.equal(panel.label, 'div.chg-panel');
  assert.equal(panel.depth, 1);
  const create = panel.entries.find((e) => e.kind === 'create');
  assert.deepEqual(create.chain.map((c) => c.module), ['DS/ENOChgFixture/scripts/Panel', 'DS/ENOChgFixture/scripts/Home']);
  assert.ok(panel.entries.some((e) => e.kind === 'innerHTML' && e.chain[0].module === 'DS/ENOChgFixture/scripts/Panel'));

  assert.match(out.diag, /bus PlatformAPI=O ModelEvents=O/);
  assert.match(out.diag, /nls modules=1 keys=2 source=registry/);
  assert.equal(out.subscribersFired, true);

  const platform = out.events.find((e) => e.bus === 'PlatformAPI');
  assert.equal(platform.topic, 'FIX_OPEN');
  assert.equal(platform.data, '{"id":1}');
  assert.equal(platform.publisher[0].module, HOME);
  assert.deepEqual(platform.subscribers, [PANEL]);
  const model = out.events.find((e) => e.bus === 'ModelEvents');
  assert.equal(model.topic, 'opened');
  assert.deepEqual(model.subscribers, [HOME]);

  const [open] = out.nlsOpen;
  assert.deepEqual([open.id, open.key, open.match], ['DS/ENOChgFixture/assets/nls/FixtureNLS', 'OPEN_LABEL', 'exact']);
  assert.deepEqual(open.usages.map((u) => [u.module, u.precise, u.file, u.line]), [[HOME, true, 'ENOChgFixture.js', 1]]);
  assert.deepEqual(out.nlsEval, out.nlsOpen);
  assert.match(out.diagEval, /nls modules=1 keys=2 source=eval/);
  const [panelTitle] = out.nlsPanel;
  assert.deepEqual([panelTitle.key, panelTitle.match], ['PANEL.TITLE', 'template']);

  const watched = out.logs.filter((l) => l.includes('[PlatformAPI]'));
  assert.equal(watched.length, 1);
  assert.match(watched[0], /FIX_OPEN \{"id":2\}[\s\S]*sub → DS\/ENOChgFixture\/scripts\/Panel/);

  assert.equal(out.panelsAfterPick, 1);
  const picked = out.logs.find((l) => l.startsWith('[3di] button'));
  assert.ok(picked.includes(`handler ${HOME}`));
  assert.ok(picked.includes(`nls FixtureNLS.OPEN_LABEL [exact] "Open"`));
  assert.match(picked, /DS\/ENOChgFixture\/scripts\/Home {2}ENOChgFixture\.js:1:\d+/);
  assert.equal(out.restored, true);
});

test('확장 모드: 페이지 로드 전 주입으로 첫 화면까지 기록하고 DevTools 연동이 동작한다', { skip: !CHROME, timeout: 60000 }, async () => {
  const out = await runFixture('ext.html');
  assert.equal(out.error, undefined, out.error);
  assert.equal(out.startupLogs, 0);
  assert.equal(out.busesWrapped, true);

  assert.equal(out.frames.length, 1);
  assert.equal(out.frames[0].targets, 2);
  assert.equal(out.selected, out.frames[0].href);

  assert.match(out.inspect, /^\[3di\] button\n {2}create +DS\/ENOChgFixture\/scripts\/Home \(Object\.render\)/);
  assert.ok(out.inspect.includes(`handler ${HOME}`));
  assert.ok(out.inspect.includes('nls FixtureNLS.OPEN_LABEL [exact] "Open"'));

  assert.match(out.events, /\[PlatformAPI\] FIX_OPEN \{"id":1\}\n {4}pub ← DS\/ENOChgFixture\/scripts\/Home \(.*\)\n {4}sub → DS\/ENOChgFixture\/scripts\/Panel/);
  assert.match(out.events, /\[ModelEvents\] opened "y"[\s\S]*sub → DS\/ENOChgFixture\/scripts\/Home/);

  assert.match(out.picked, /^\[3di\] span\.title\n↑1 div\.chg-panel\n {2}create +DS\/ENOChgFixture\/scripts\/Panel \(Object\.show\) ← DS\/ENOChgFixture\/scripts\/Home/);
  assert.ok(out.picked.includes('nls FixtureNLS.PANEL.TITLE [template] "Panel {0}"'));
  assert.equal(out.cancelled, null);
  assert.match(out.jobError, /boom/);

  assert.ok(out.restored.includes('return (PlatformAPI.subscribe("FIX_OPEN"'));
  assert.equal(out.patch.files.length, 1);
  assert.ok(out.patch.files[0].text.includes('Panel 4'));
  assert.equal(out.patch.text, ['[3di patch]', 'ENOChgFixture.js', `  [적용 가능] ${PANEL}  "Panel 3"`, '  구문 검사: 정상', '  저장: 가능'].join('\n'));
  assert.match(out.diag, /\[정상\] 대상 번들 2개\n\[정상\] 요소 기록 \d+건\n\[정상\] 이벤트 버스 PlatformAPI 연결\n\[정상\] 이벤트 버스 ModelEvents 연결\n\[정상\] NLS 1개 모듈\n\[정상\] 오류 없음/);
});
