import { buildModuleIndex, findModule, getLineStarts, toOffset, toLineColumn, parseStack, stripPlugin, flattenNls, matchNls, findNlsUsages } from './core.js';

const MATCH = /\/webapps\/ENOChg/i;
const LANG_RE = /_[a-z]{2}(-[A-Z]{2})?\.js$/;
const MAX_NODES = 5;
const MAX_RECORDS_PER_NODE = 20;
const MAX_EVENTS = 500;
const MAX_USAGES = 5;
const gel = typeof getEventListeners === 'function' ? getEventListeners : null;

window.__3di?.stop();

const bundles = new Map();
const loading = new Map();
const records = new WeakMap();
const counts = {};
const errors = [];
const restores = [];
let paused = false;
let stopped = false;

function addError(message) {
  if (!errors.includes(message)) errors.push(message);
}

function stripQuery(url) {
  return url.split(/[?#]/)[0];
}

function isTarget(url) {
  return MATCH.test(url) && /\.js$/i.test(stripQuery(url));
}

function loadBundle(url) {
  const key = stripQuery(url);
  if (!loading.has(key)) {
    const job = fetch(url)
      .then((res) => res.text())
      .then((text) => bundles.set(key, { url, text, modules: buildModuleIndex(text), lineStarts: getLineStarts(text) }))
      .catch((e) => addError(`${url}: ${e.message}`));
    loading.set(key, job);
  }
  return loading.get(key);
}

function loadBundles(urls) {
  return Promise.all([...new Set(urls)].filter(isTarget).map(loadBundle));
}

function scriptUrls() {
  return [...performance.getEntriesByType('resource').map((e) => e.name), ...[...document.scripts].map((s) => s.src)].filter(Boolean);
}

function targetStack() {
  const stack = new Error().stack;
  return MATCH.test(stack) ? stack : null;
}

function record(target, kind, extra = {}) {
  if (paused || !target) return;
  const stack = targetStack();
  if (!stack && !extra.fn) return;
  if (!records.has(target)) records.set(target, []);
  const list = records.get(target);
  if (list.length >= MAX_RECORDS_PER_NODE) return;
  list.push({ kind, stack, ...extra });
  counts[kind] = (counts[kind] ?? 0) + 1;
}

function recordInserted(nodes) {
  nodes
    .flatMap((n) => (n instanceof DocumentFragment ? [...n.childNodes] : [n]))
    .filter((n) => n instanceof Node)
    .forEach((n) => record(n, 'insert'));
}

function wrap(proto, name, fn) {
  const original = proto[name];
  proto[name] = function (...args) {
    return fn.call(this, original, args);
  };
  restores.push(() => {
    proto[name] = original;
  });
}

function install() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  restores.push(() => {
    Error.stackTraceLimit = limit;
  });
  wrap(Document.prototype, 'createElement', function (original, args) {
    const el = original.apply(this, args);
    record(el, 'create');
    return el;
  });
  [
    [Node.prototype, 'appendChild', (args) => [args[0]]],
    [Node.prototype, 'insertBefore', (args) => [args[0]]],
    [Element.prototype, 'append', (args) => args],
    [Element.prototype, 'prepend', (args) => args],
  ].forEach(([proto, name, pickNodes]) =>
    wrap(proto, name, function (original, args) {
      recordInserted(pickNodes(args));
      return original.apply(this, args);
    }),
  );
  wrap(EventTarget.prototype, 'addEventListener', function (original, args) {
    record(this, 'listen', { type: args[0], fn: args[1] });
    return original.apply(this, args);
  });
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  Object.defineProperty(Element.prototype, 'innerHTML', {
    ...desc,
    set(value) {
      record(this, 'innerHTML');
      desc.set.call(this, value);
    },
  });
  restores.push(() => Object.defineProperty(Element.prototype, 'innerHTML', desc));
}

function resolveStack(stack) {
  const chain = [];
  for (const f of parseStack(stack)) {
    const b = bundles.get(stripQuery(f.url));
    const mod = b && findModule(b.modules, toOffset(b.lineStarts, f.line, f.column));
    if (mod && !chain.some((c) => c.module === mod.id)) chain.push({ module: mod.id, fn: f.fn, line: f.line, column: f.column });
  }
  return chain;
}

function locateFunction(listener) {
  const fn = typeof listener === 'function' ? listener : listener?.handleEvent;
  if (typeof fn !== 'function') return null;
  const src = Function.prototype.toString.call(fn);
  if (src.endsWith('{ [native code] }')) return null;
  for (const b of bundles.values()) {
    const i = b.text.indexOf(src);
    if (i !== -1) return findModule(b.modules, i)?.id ?? null;
  }
  return null;
}

function existingListeners(node, recorded) {
  if (!gel) return [];
  try {
    return Object.entries(gel(node)).flatMap(([type, list]) =>
      list.filter((l) => !recorded.some((r) => r.fn === l.listener)).map((l) => ({ kind: 'listen(기존)', type, fn: l.listener })),
    );
  } catch {
    return [];
  }
}

function describe(node) {
  if (!(node instanceof Element)) return node.nodeName;
  const id = node.id ? `#${node.id}` : '';
  const cls = typeof node.className === 'string' && node.className.trim() ? `.${node.className.trim().split(/\s+/).join('.')}` : '';
  return `${node.tagName.toLowerCase()}${id}${cls}`;
}

async function collect(el) {
  const found = [];
  for (let n = el, depth = 0; n; n = n.parentNode, depth++) {
    const recorded = records.get(n) ?? [];
    const entries = [...recorded, ...existingListeners(n, recorded)];
    if (entries.length) found.push({ node: n, depth, entries });
  }
  await loadBundles(found.flatMap((x) => x.entries.flatMap((e) => (e.stack ? parseStack(e.stack).map((f) => f.url) : []))));
  return found
    .map(({ node, depth, entries }) => ({
      label: describe(node),
      depth,
      entries: entries
        .map((e) => ({ kind: e.kind, type: e.type, handler: e.fn ? locateFunction(e.fn) : null, chain: e.stack ? resolveStack(e.stack) : [] }))
        .filter((e) => e.handler || e.chain.length),
    }))
    .filter((x) => x.entries.length)
    .slice(0, MAX_NODES);
}

function formatEntry(e) {
  const kind = e.type ? `${e.kind}:${e.type}` : e.kind;
  const handler = e.handler ? `handler ${e.handler}` : '';
  const chain = e.chain.map((c) => `${c.module} (${c.fn || 'anonymous'})`).join(' ← ');
  return `  ${kind.padEnd(18)} ${[handler, chain].filter(Boolean).join(' | ')}`;
}

function format(el, report) {
  const head = `[3di] ${describe(el)}`;
  if (!report.length) return `${head}\n  기록 없음 (도구 실행 전에 만들어졌거나 대상 번들 밖에서 만들어진 요소. 화면을 다시 그린 뒤 재시도)`;
  return [head, ...report.flatMap(({ label, depth, entries }) => [depth && `↑${depth} ${label}`, ...entries.map(formatEntry)])].filter(Boolean).join('\n');
}

async function inspectText(el) {
  const label = labelOf(el);
  const nlsLines = label ? formatNls(await collectNls(label, 3)) : [];
  return [format(el, await collect(el)), ...nlsLines].join('\n');
}

function labelOf(el) {
  return [el.textContent, el.getAttribute?.('title'), el.getAttribute?.('placeholder')]
    .map((t) => t?.replace(/\s+/g, ' ').trim())
    .find((t) => t && t.length <= 100) ?? '';
}

function isNls([id, value]) {
  return id.includes('/nls/') && value !== null && typeof value === 'object' && !Array.isArray(value);
}

function registryNls() {
  return Object.entries(window.require?.s?.contexts?._?.defined ?? {}).filter(isNls);
}

function evalNls() {
  const found = [];
  const define = (id, value) => found.push([id, value]);
  for (const b of bundles.values()) {
    if (!LANG_RE.test(stripQuery(b.url))) continue;
    try {
      new Function('define', b.text)(define);
    } catch (e) {
      addError(`nls eval ${fileName(b.url)}: ${e.message}`);
    }
  }
  return found.filter(isNls);
}

let nlsOrigin = 'none';

function nlsSources() {
  const fromRegistry = registryNls();
  const pairs = fromRegistry.length ? fromRegistry : evalNls();
  nlsOrigin = fromRegistry.length ? 'registry' : pairs.length ? 'eval' : 'none';
  return [...new Map(pairs.map(([id, value]) => [stripPlugin(id), value]))].map(([id, value]) => ({ id, entries: flattenNls(value) }));
}

function fileName(url) {
  return stripQuery(url).split('/').at(-1);
}

function usagesOf(id, key) {
  return [...bundles.values()].flatMap((b) =>
    findNlsUsages(b.text, b.modules, id, key).map((u) => ({ module: u.module, precise: u.precise, file: fileName(b.url), ...toLineColumn(b.lineStarts, u.offset) })),
  );
}

async function collectNls(text, limit = 5) {
  await loadBundles(scriptUrls());
  return matchNls(nlsSources(), text, limit).map((m) => ({ ...m, usages: usagesOf(m.id, m.key) }));
}

function formatNls(list) {
  return list.flatMap((m) => [
    `  nls ${m.id.split('/').at(-1)}.${m.key} [${m.match}] "${m.value}"`,
    ...m.usages.slice(0, MAX_USAGES).map((u) => `      ${u.module}  ${u.file}:${u.line}:${u.column}${u.precise ? '' : ' (추정)'}`),
    ...(m.usages.length > MAX_USAGES ? [`      ... +${m.usages.length - MAX_USAGES}`] : []),
  ]);
}

async function nlsText(text) {
  const lines = formatNls(await collectNls(text));
  return [`[3di nls] "${text}"`, ...(lines.length ? lines : ['  일치 없음'])].join('\n');
}

const events = [];
const subscriptionStacks = new WeakMap();
const buses = {};
let watchFilter = null;

function logEvent(bus, topic, data, getCallbacks) {
  if (paused) return;
  let callbacks = [];
  try {
    callbacks = getCallbacks().filter((c) => typeof c === 'function');
  } catch {}
  const event = { time: new Date(), bus, topic: String(topic), data, callbacks, stack: new Error().stack };
  events.push(event);
  if (events.length > MAX_EVENTS) events.shift();
  if (watchFilter !== null && event.topic.includes(watchFilter)) resolveEvents([event]).then(([e]) => console.log(formatEvent(e)));
}

function recordSubscription(callback) {
  if (typeof callback !== 'function' || paused) return;
  const stack = targetStack();
  if (stack) subscriptionStacks.set(callback, stack);
}

function definedModule(id) {
  const req = window.require;
  try {
    const known = typeof req?.defined === 'function' ? req.defined(id) : Boolean(req?.s?.contexts?._?.defined?.[id]);
    return known ? req(id) : null;
  } catch {
    return null;
  }
}

function wrapSubscribe(target, callbackIndex) {
  wrap(target, 'subscribe', function (original, args) {
    recordSubscription(args[callbackIndex]);
    return original.apply(this, args);
  });
}

let busTimer = null;

function wrapBuses() {
  if (stopped) return;
  if (!buses.PlatformAPI) wrapPlatformApi(definedModule('DS/PlatformAPI/PlatformAPI'));
  if (!buses.ModelEvents) wrapModelEvents(definedModule('DS/CoreEvents/ModelEvents'));
  if (!buses.PlatformAPI || !buses.ModelEvents) busTimer = setTimeout(wrapBuses, 1000);
}

function wrapPlatformApi(api) {
  if (typeof api?.publish !== 'function') return;
  wrap(api, 'publish', function (original, args) {
    logEvent('PlatformAPI', args[0], args[1], () => (definedModule('DS/MessageBus/MessageBus')?.subscriptions?.Widgets?.[args[0]] ?? []).map((s) => s.callback));
    return original.apply(this, args);
  });
  wrapSubscribe(api, 1);
  buses.PlatformAPI = true;
}

function wrapModelEvents(ModelEvents) {
  const proto = ModelEvents?.prototype;
  if (typeof proto?.publish === 'function') {
    wrap(proto, 'publish', function (original, args) {
      const event = args[0]?.event;
      logEvent('ModelEvents', event, args[0]?.data, () => {
        const key = typeof this._formatEvent === 'function' ? this._formatEvent(event) : event;
        return (this._pubsub?.topics?.[key] ?? []).map((s) => s.func);
      });
      return original.apply(this, args);
    });
    wrapSubscribe(proto, 1);
    buses.ModelEvents = true;
  }
}

function preview(data) {
  try {
    return (JSON.stringify(data) ?? '').slice(0, 80);
  } catch {
    return '[직렬화 불가]';
  }
}

function subscriberOf(fn) {
  const stack = subscriptionStacks.get(fn);
  return locateFunction(fn) ?? (stack && resolveStack(stack)[0]?.module) ?? null;
}

async function resolveEvents(list) {
  const stacks = list.flatMap((e) => [e.stack, ...e.callbacks.map((c) => subscriptionStacks.get(c))]).filter(Boolean);
  await loadBundles(stacks.flatMap((s) => parseStack(s).map((f) => f.url)));
  return list.map((e) => ({
    time: e.time,
    bus: e.bus,
    topic: e.topic,
    data: preview(e.data),
    publisher: resolveStack(e.stack),
    subscribers: e.callbacks.map(subscriberOf),
  }));
}

function formatEvent(e) {
  const time = `${e.time.toTimeString().slice(0, 8)}.${String(e.time.getMilliseconds()).padStart(3, '0')}`;
  const pub = e.publisher[0] ? `${e.publisher[0].module} (${e.publisher[0].fn || 'anonymous'})` : '번들 밖';
  const known = [...new Set(e.subscribers.filter(Boolean))];
  const unknown = e.subscribers.filter((s) => !s).length;
  const subs = [...known, ...(unknown ? [`미확인 ${unknown}`] : [])].join(', ') || '없음';
  return `${time} [${e.bus}] ${e.topic} ${e.data}\n    pub ← ${pub}\n    sub → ${subs}`;
}

async function collectEvents(filter = '', limit = 50) {
  return resolveEvents(events.filter((e) => e.topic.includes(filter)).slice(-limit));
}

async function eventsText(filter = '', limit = 50) {
  const list = await collectEvents(filter, limit);
  return list.length ? list.map(formatEvent).join('\n') : '[3di] 이벤트 없음';
}

function watch(filter = '') {
  watchFilter = filter === false ? null : filter;
  console.log(watchFilter === null ? '[3di] 이벤트 실시간 출력 끔' : `[3di] 이벤트 실시간 출력 켬 (필터: "${watchFilter}")`);
}

let endPick = null;

function pickText() {
  endPick?.(null);
  return new Promise((resolve) => {
    paused = true;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;outline:2px solid #e91e63;background:rgba(233,30,99,.15)';
    document.body.appendChild(box);
    const move = (e) => {
      const r = e.target.getBoundingClientRect();
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    };
    const block = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const click = (e) => {
      block(e);
      endPick(inspectText(e.target));
    };
    const key = (e) => {
      if (e.key === 'Escape') endPick(null);
    };
    const handlers = { mousemove: move, pointerdown: block, mousedown: block, pointerup: block, mouseup: block, click, keydown: key };
    endPick = (result) => {
      Object.entries(handlers).forEach(([type, h]) => window.removeEventListener(type, h, true));
      box.remove();
      endPick = null;
      resolve(result);
    };
    Object.entries(handlers).forEach(([type, h]) => window.addEventListener(type, h, true));
    paused = false;
    console.log('[3di] 요소를 클릭하세요. (Esc: 취소)');
  });
}

function verdicts(sources) {
  const recorded = Object.values(counts).reduce((a, b) => a + b, 0);
  return [
    [bundles.size > 0, `대상 번들 ${bundles.size}개`, '대상 번들(ENOChg) 없음: 위젯 iframe 프레임을 선택했는지 확인'],
    [recorded > 0, `요소 기록 ${recorded}건`, '요소 기록 없음: 화면을 새로고침(F5)한 뒤 다시 확인'],
    ...['PlatformAPI', 'ModelEvents'].map((name) => [buses[name], `이벤트 버스 ${name} 연결`, `이벤트 버스 ${name} 미연결: 모듈이 아직 로드되지 않았거나 모듈 ID가 바뀜`]),
    [sources.length > 0, `NLS ${sources.length}개 모듈`, 'NLS 없음: 언어 번들을 찾지 못함'],
    [!errors.length, '오류 없음', `오류 ${errors.length}건: 아래 error 줄 참고`],
  ].map(([ok, good, bad]) => (ok ? `[정상] ${good}` : `[문제] ${bad}`));
}

async function diagText() {
  const urls = scriptUrls();
  await loadBundles(urls);
  const sources = nlsSources();
  return [
    `[3di diag] ${location.href}`,
    ...verdicts(sources),
    `scripts(js)=${urls.filter((u) => /\.js$/i.test(stripQuery(u))).length} bundles=${bundles.size} getEventListeners=${gel ? 'O' : 'X'}`,
    `records ${JSON.stringify(counts)}`,
    `bus PlatformAPI=${buses.PlatformAPI ? 'O' : 'X'} ModelEvents=${buses.ModelEvents ? 'O' : 'X'} events=${events.length} watch=${watchFilter ?? 'off'}`,
    `nls modules=${sources.length} keys=${sources.reduce((n, s) => n + s.entries.length, 0)} source=${nlsOrigin}`,
    ...[...bundles.values()].map((b) => `  ${stripQuery(b.url).split('/').slice(-2).join('/')} size=${b.text.length} lines=${b.lineStarts.length} modules=${b.modules.length}`),
    ...errors.map((e) => `  error ${e}`),
  ].join('\n');
}

function logged(fn) {
  return async (...args) => {
    const text = await fn(...args);
    if (text) console.log(text);
  };
}

const jobs = new Map();

function job(id, value) {
  jobs.set(id, null);
  Promise.resolve(value).then(
    (ok) => jobs.set(id, { ok }),
    (e) => jobs.set(id, { error: String(e?.stack ?? e) }),
  );
  return true;
}

function result(id) {
  const r = jobs.get(id);
  if (r) jobs.delete(id);
  return r ?? null;
}

async function sources(ids) {
  await loadBundles(scriptUrls());
  return [...bundles.values()]
    .filter((b) => b.modules.some((m) => ids.includes(m.id)))
    .map((b) => ({ url: b.url, name: fileName(b.url), text: b.text, modules: b.modules }));
}

function targets() {
  return new Set(scriptUrls().filter(isTarget).map(stripQuery)).size;
}

function stop() {
  stopped = true;
  clearTimeout(busTimer);
  endPick?.(null);
  restores.splice(0).reverse().forEach((r) => r());
  delete window.__3di;
}

install();
wrapBuses();
const diag = logged(diagText);
const ready = EXTENSION ? Promise.resolve() : loadBundles(scriptUrls()).then(() => diag());
window.__3di = {
  pick: logged(pickText),
  inspect: logged(inspectText),
  nls: logged(nlsText),
  events: logged(eventsText),
  watch,
  diag,
  stop,
  collect,
  collectNls,
  collectEvents,
  text: { pick: pickText, inspect: inspectText, nls: nlsText, events: eventsText, diag: diagText },
  job,
  result,
  sources,
  targets,
  bundles,
  ready,
};
