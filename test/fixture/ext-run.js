window.chrome = {
  devtools: {
    inspectedWindow: {
      eval(expression, options, callback) {
        try {
          callback((0, eval)(expression));
        } catch (e) {
          callback(undefined, { isException: true, value: String(e) });
        }
      },
      getResources(callback) {
        callback([
          { type: 'document', url: location.href },
          { type: 'script', url: `${location.origin}/x.js` },
        ]);
      },
    },
  },
};

const { evalAsync, listFrames, selectionFrame } = await import('/extension/devtools-lib.js');
const { patchReport, restoreModule } = await import('/extension/tools.js');

async function waitFor(check, timeout = 5000) {
  for (const started = Date.now(); Date.now() - started < timeout; await sleep(100)) {
    if (await check()) return true;
  }
  return false;
}

function clickOn(selector) {
  document.querySelector(selector).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

async function main() {
  const out = {};
  out.startupLogs = logs.length;
  req('DS/ENOChgFixture/scripts/Home').render(document.getElementById('root'));
  out.busesWrapped = await waitFor(async () => (await __3di.text.diag()).includes('PlatformAPI=O ModelEvents=O'));
  const button = document.querySelector('#root button');
  button.click();
  await sleep(50);
  const frames = await listFrames();
  out.frames = frames;
  window.$0 = button;
  const frame = await selectionFrame(frames);
  out.selected = frame?.href;
  out.inspect = await evalAsync('window.__3di.text.inspect($0)', frame.url);
  out.events = await evalAsync('window.__3di.text.events("")', frame.url);
  const picking = evalAsync('window.__3di.text.pick()', frame.url);
  await sleep(50);
  clickOn('#root .title');
  out.picked = await picking;
  const cancelling = evalAsync('window.__3di.text.pick()', frame.url);
  await sleep(50);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  out.cancelled = await cancelling;
  const [bundle] = await evalAsync('window.__3di.sources(["DS/ENOChgFixture/scripts/Panel"])', frame.url);
  out.restored = restoreModule(bundle, 'DS/ENOChgFixture/scripts/Panel');
  out.patch = patchReport([bundle], ['@@ DS/ENOChgFixture/scripts/Panel', '<<<<', 'Panel 3', '====', 'Panel 4', '>>>>'].join('\n'));
  out.diag = await __3di.text.diag();
  out.jobError = await evalAsync('Promise.reject(new Error("boom"))', frame.url).catch((e) => e.message);
  return out;
}

report(main);
