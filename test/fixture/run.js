function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function main() {
  const out = {};
  const home = req('DS/ENOChgFixture/scripts/Home');
  home.render(document.getElementById('before'));
  await loadScript('/dist/3d-inspector.js');
  await __3di.ready;
  out.diag = await __3di.text.diag();
  home.render(document.getElementById('after'));
  document.querySelector('#after button').click();
  out.before = await __3di.collect(document.querySelector('#before button'));
  out.button = await __3di.collect(document.querySelector('#after button'));
  out.span = await __3di.collect(document.querySelector('#after .title'));
  await sleep(50);
  out.subscribersFired = document.body.dataset.opened === '1' && document.body.dataset.model === 'y';
  out.events = await __3di.collectEvents();
  out.nlsOpen = await __3di.collectNls('Open');
  out.nlsPanel = await __3di.collectNls('Panel 3');
  const registry = require.s;
  delete require.s;
  out.nlsEval = await __3di.collectNls('Open');
  out.diagEval = await __3di.text.diag();
  require.s = registry;
  const api = req('DS/PlatformAPI/PlatformAPI');
  __3di.watch('FIX_OPEN');
  api.publish('FIX_OPEN', { id: 2 });
  api.publish('OTHER', {});
  __3di.watch(false);
  await sleep(50);
  __3di.pick();
  document.querySelector('#after button').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(100);
  out.panelsAfterPick = document.querySelectorAll('#after .chg-panel').length;
  __3di.stop();
  out.restored = document.createElement.toString().includes('[native code]') && !window.__3di && !api.publish.toString().includes('original');
  return out;
}

report(main);
