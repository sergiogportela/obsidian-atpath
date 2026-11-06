"use strict";

function f_createBrowserTokenWorker() {
  // The build embeds the worker, so installs still need only the standard
  // main.js/manifest.json/styles.css assets. No runtime network or Node access.
  const url = URL.createObjectURL(new Blob([ATPATH_TOKEN_WORKER_SOURCE], { type: "text/javascript" }));
  try {
    const worker = new Worker(url);
    // Retain the URL until startup has actually succeeded, including WebKit.
    const revoke = () => URL.revokeObjectURL(url);
    worker.addEventListener("message", revoke, { once: true });
    worker.addEventListener("error", revoke, { once: true });
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => { revoke(); terminate(); };
    return worker;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function f_createTokenCounter({ createWorker = f_createBrowserTokenWorker, timeoutMs = 30000, maxRestarts = 2 } = {}) {
  let worker;
  let active;
  let timer;
  let sequence = 0;
  let failure;
  let restarts = 0;
  const queue = [];

  function f_fail(error, recover = true) {
    clearTimeout(timer);
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
    }
    worker = null;
    if (!recover || restarts >= maxRestarts) {
      failure = error;
      error.tokenCounterUnavailable = true;
    }
    active?.reject(error);
    active = null;
    if (failure) {
      for (const job of queue.splice(0)) job.reject(error);
    } else {
      restarts++;
      f_next();
    }
  }

  function f_next() {
    if (active || failure || !queue.length) return;
    active = queue.shift();
    try {
      if (!worker) {
        worker = createWorker();
        worker.onerror = event => f_fail(new Error("Token worker failed: " + event.message));
        worker.onmessageerror = () => f_fail(new Error("Token worker returned an unreadable message"));
        worker.onmessage = ({ data }) => {
          if (!active || data.id !== active.id) return;
          if (data.error || !Number.isSafeInteger(data.tokens) || data.tokens < 0) {
            f_fail(new Error("Token worker count failed: " + (data.error || "invalid count")));
            return;
          }
          clearTimeout(timer);
          const completed = active;
          active = null;
          completed.resolve(data.tokens);
          f_next();
        };
      }
      timer = setTimeout(() => f_fail(new Error("Token worker timed out after " + timeoutMs + " ms")), timeoutMs);
      worker.postMessage({ id: active.id, text: active.text });
      active.text = null;
    } catch (error) {
      f_fail(error);
    }
  }

  return {
    count(text, { priority = false, key } = {}) {
      if (typeof text !== "string") return Promise.reject(new TypeError("Token input must be text"));
      if (failure) return Promise.reject(failure);
      // Only the newest pending editor snapshot needs work. An active worker
      // job cannot be interrupted; its consumer discards stale generations.
      if (key != null) {
        for (let index = queue.length - 1; index >= 0; index--) {
          if (queue[index].key === key) queue.splice(index, 1)[0].resolve(null);
        }
      }
      return new Promise((resolve, reject) => {
        const job = { id: ++sequence, text, priority, key, resolve, reject };
        const before = priority ? queue.findIndex(item => !item.priority) : -1;
        queue.splice(before < 0 ? queue.length : before, 0, job);
        f_next();
      });
    },
    dispose() { f_fail(new Error("Token counter disposed"), false); },
  };
}

module.exports = { f_createTokenCounter };
