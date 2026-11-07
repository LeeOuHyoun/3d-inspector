import { evalAsync, listFrames, selectionFrame } from './devtools-lib.js';

const out = document.getElementById('out');
let seq = 0;

async function update() {
  const current = ++seq;
  const show = (text) => {
    if (current === seq) out.textContent = text;
  };
  show('조회 중...');
  try {
    const frame = await selectionFrame(await listFrames());
    show(frame ? await evalAsync('window.__3di.text.inspect($0)', frame.url) : '3D Inspector가 로드된 프레임의 요소가 아닙니다.');
  } catch (e) {
    show(`오류: ${e.message}`);
  }
}

chrome.devtools.panels.elements.onSelectionChanged.addListener(update);
update();
