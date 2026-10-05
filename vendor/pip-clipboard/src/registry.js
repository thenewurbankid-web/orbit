// Host extension points: card actions, card renderers and taggers.

import { publicItem } from './normalize.js';

const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export class ActionRegistry {
  #actions = new Map();

  /**
   * register({ id, label, accepts?(item) => boolean, run(item) => any, icon?, danger? })
   * Returns an unregister function. Re-registering an id replaces it.
   */
  register(action) {
    if (!action || typeof action !== 'object') throw new TypeError('registerAction: expected an object');
    const { id, label, accepts, run } = action;
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new TypeError('registerAction: id must match /^[A-Za-z0-9_.:-]{1,64}$/');
    if (typeof label !== 'string' || !label.trim()) throw new TypeError('registerAction: label must be a non-empty string');
    if (typeof run !== 'function') throw new TypeError('registerAction: run must be a function');
    if (accepts !== undefined && typeof accepts !== 'function') throw new TypeError('registerAction: accepts must be a function');
    const entry = Object.freeze({ id, label: label.trim().slice(0, 60), accepts: accepts || (() => true), run, host: true });
    this.#actions.set(id, entry);
    return () => { if (this.#actions.get(id) === entry) this.#actions.delete(id); };
  }

  unregister(id) { return this.#actions.delete(id); }

  get(id) { return this.#actions.get(id) || null; }

  all() { return [...this.#actions.values()]; }

  /** Actions whose accepts(item) is truthy. A throwing accepts() hides the action. */
  forItem(item) {
    const pub = publicItem(item);
    return this.all().filter((a) => {
      try { return Boolean(a.accepts(pub)); } catch { return false; }
    });
  }

  /** Run an action against an item. Resolves to { ok, result } or { ok: false, error }. */
  async run(id, item) {
    const action = this.get(id);
    if (!action) return { ok: false, error: new Error(`Unknown action: ${id}`) };
    const pub = publicItem(item);
    try {
      if (!action.accepts(pub)) return { ok: false, error: new Error(`Action ${id} does not accept this item`) };
      const result = await action.run(pub);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error };
    }
  }
}

export class RendererRegistry {
  #list = [];

  /**
   * register(typeOrPredicate, render)
   *   typeOrPredicate: an item kind ('image', 'link', ...), a tag ('github-issue'), or (item) => boolean
   *   render(item, helpers) => Node | HTMLTemplateElement | SafeHTML | string | null
   * Later registrations win. Returns an unregister function.
   */
  register(match, render) {
    if (typeof render !== 'function') throw new TypeError('registerRenderer: render must be a function');
    let test;
    if (typeof match === 'string' && match) test = (it) => it.kind === match || (it.tags || []).includes(match);
    else if (typeof match === 'function') test = match;
    else throw new TypeError('registerRenderer: first argument must be a type/tag string or a predicate');
    const entry = { match, test, render };
    this.#list.unshift(entry);
    return () => { this.#list = this.#list.filter((e) => e !== entry); };
  }

  find(item) {
    const pub = publicItem(item);
    for (const e of this.#list) {
      try { if (e.test(pub)) return e; } catch { /* ignore bad predicates */ }
    }
    return null;
  }

  get size() { return this.#list.length; }
}

export class TaggerRegistry {
  #list = [];
  version = 0;

  register(fn) {
    if (typeof fn !== 'function') throw new TypeError('registerTagger: expected a function (item) => string[]');
    this.#list.push(fn);
    this.version++;
    return () => { this.#list = this.#list.filter((f) => f !== fn); this.version++; };
  }

  all() { return [...this.#list]; }
}
