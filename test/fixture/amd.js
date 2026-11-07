const registry = {};
const cache = {};
const norm = (id) => id.replace(/^i18n!/, '');

window.define = (id, deps, factory) => {
  registry[id] = Array.isArray(deps) ? { deps, factory } : { deps: [], factory: typeof deps === 'function' ? deps : () => deps };
};

window.req = (id) => {
  const key = norm(id);
  if (!(key in cache)) cache[key] = registry[key].factory(...registry[key].deps.map(req));
  return cache[key];
};

window.require = (ids, cb, eb) => {
  if (typeof ids === 'string') return cache[norm(ids)];
  setTimeout(() => {
    try {
      cb(...ids.map(req));
    } catch (e) {
      eb?.(e);
    }
  });
};
window.require.defined = (id) => norm(id) in cache;
window.require.s = { contexts: { _: { defined: cache } } };
