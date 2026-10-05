export class Emitter {
  #handlers = new Map();

  on(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('PipClipboard.on: handler must be a function');
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this.#handlers.get(event)?.delete(fn);
  }

  emit(event, payload) {
    for (const fn of [...(this.#handlers.get(event) || [])]) {
      try { fn(payload); } catch (err) {
        // A host handler must never break the widget.
        console.error('[pip-clipboard] handler for', event, 'threw', err);
      }
    }
  }
}
