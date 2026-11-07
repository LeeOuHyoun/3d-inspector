import { evalAsync, listFrames } from './devtools-lib.js';
import { parsePatches } from './core.js';
import { patchReport, restoreModule } from './tools.js';

const PICK_TIMEOUT = 300000;
const SPEC_KEY = '3di.patchSpec';
const OVERRIDE_GUIDE = [
  '반영(Local Overrides): Network 탭에서 원본 번들 우클릭 → "Override content" → 오버라이드 폴더에 생긴 같은 이름 파일을 저장한 파일로 교체 → 페이지 새로고침',
  '되돌리기: Sources → Overrides에서 해당 파일 삭제',
].join('\n');
const $ = (id) => document.getElementById(id);
const out = $('out');
const frameUrl = () => $('frame').value || undefined;

async function refreshFrames() {
  const frames = await listFrames();
  $('frame').replaceChildren(...frames.map((f) => new Option(`[번들 ${f.targets}] ${f.href}`, f.url ?? '')));
  out.textContent = frames.length ? '' : '3D Inspector가 로드된 프레임이 없습니다. 페이지를 새로고침하세요.';
}

async function show(task) {
  out.textContent = '실행 중...';
  try {
    out.textContent = (await task()) ?? '취소됨';
  } catch (e) {
    out.textContent = `오류: ${e.message}`;
  }
}

function run(expression, timeout) {
  return show(() => evalAsync(expression, frameUrl(), timeout));
}

function textArg(id) {
  return JSON.stringify($(id).value);
}

function bundlesFor(ids) {
  return evalAsync(`window.__3di.sources(${JSON.stringify(ids)})`, frameUrl());
}

async function viewModule() {
  const id = $('moduleId').value.trim();
  const [bundle] = await bundlesFor([id]);
  return bundle ? restoreModule(bundle, id) : `[3di module] ${id}: 이 프레임의 대상 번들에서 모듈을 찾지 못했습니다.`;
}

function download({ name, text }) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

async function checkPatches(save) {
  const spec = $('patchSpec').value;
  try {
    localStorage.setItem(SPEC_KEY, spec);
  } catch {}
  const { text, files } = patchReport(await bundlesFor([...new Set(parsePatches(spec).map((p) => p.module))]), spec);
  if (!save) return text;
  files.forEach(download);
  return [text, '', files.length ? `저장한 파일: ${files.map((f) => f.name).join(', ')}\n${OVERRIDE_GUIDE}` : '저장할 파일 없음: 모든 패치가 "적용 가능/이미 적용됨"이고 구문 검사가 정상이어야 저장됩니다.'].join('\n');
}

try {
  $('patchSpec').value = localStorage.getItem(SPEC_KEY) ?? '';
} catch {}
$('refresh').addEventListener('click', refreshFrames);
$('pick').addEventListener('click', () => run('window.__3di.text.pick()', PICK_TIMEOUT));
$('diag').addEventListener('click', () => run('window.__3di.text.diag()'));
$('nls').addEventListener('click', () => run(`window.__3di.text.nls(${textArg('nlsQuery')})`));
$('events').addEventListener('click', () => run(`window.__3di.text.events(${textArg('eventFilter')})`));
$('module').addEventListener('click', () => show(viewModule));
$('patchCheck').addEventListener('click', () => show(() => checkPatches(false)));
$('patchSave').addEventListener('click', () => show(() => checkPatches(true)));
[
  ['nlsQuery', 'nls'],
  ['eventFilter', 'events'],
  ['moduleId', 'module'],
].forEach(([input, button]) =>
  $(input).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $(button).click();
  }),
);
chrome.devtools.network.onNavigated.addListener(() => setTimeout(refreshFrames, 1000));
refreshFrames();
