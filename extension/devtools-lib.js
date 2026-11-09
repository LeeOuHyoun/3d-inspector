import { stripQuery } from './core.js';

const POLL_MS = 100;

export function evalIn(expression, frameURL) {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expression, frameURL ? { frameURL } : {}, (value, error) => {
      if (error) reject(new Error(error.isException ? error.value : error.description));
      else resolve(value);
    });
  });
}

function resources() {
  return new Promise((resolve) => chrome.devtools.inspectedWindow.getResources(resolve));
}

function contentOf(resource) {
  return new Promise((resolve) => (resource ? resource.getContent((content) => resolve(content ?? null)) : resolve(null)));
}

async function ensureBundles(frameURL) {
  const missing = await evalIn('window.__3di.missing()', frameURL);
  if (!missing.length) return;
  const byKey = new Map((await resources()).map((r) => [stripQuery(r.url), r]));
  for (const url of missing) {
    const text = await contentOf(byKey.get(stripQuery(url)));
    await evalIn(`window.__3di.addBundle(${JSON.stringify(url)}, ${JSON.stringify(text)})`, frameURL);
  }
}

let seq = 0;

export async function evalAsync(expression, frameURL, timeout = 60000) {
  await ensureBundles(frameURL);
  const id = JSON.stringify(`job${Date.now()}_${seq++}`);
  await evalIn(`window.__3di.job(${id}, ${expression})`, frameURL);
  for (const started = Date.now(); Date.now() - started < timeout; ) {
    const r = await evalIn(`window.__3di.result(${id})`, frameURL);
    if (r?.error) throw new Error(r.error);
    if (r) return r.ok;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error('시간 초과');
}

async function documentUrls() {
  return (await resources()).filter((r) => r.type === 'document').map((r) => r.url);
}

export async function listFrames() {
  const urls = [undefined, ...new Set(await documentUrls())];
  const frames = await Promise.all(
    urls.map((url) =>
      evalIn('window.__3di ? { href: location.href, targets: window.__3di.targets() } : null', url).then(
        (info) => info && { url, ...info },
        () => null,
      ),
    ),
  );
  return [...new Map(frames.filter(Boolean).map((f) => [f.href, f])).values()].sort((a, b) => b.targets - a.targets);
}

export async function selectionFrame(frames) {
  for (const frame of frames) {
    const selected = await evalIn('typeof $0 !== "undefined" && $0 instanceof Node && $0.ownerDocument === document', frame.url).catch(() => false);
    if (selected) return frame;
  }
  return null;
}
