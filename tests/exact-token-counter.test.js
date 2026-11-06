"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Worker } = require("node:worker_threads");
const esbuild = require("esbuild");
const { f_createTokenCounter } = require("../src/token-counter");
const { f_createBufferTokenCounts } = require("../src/buffer-token-counts");
const { TOKEN_CACHE_IDENTITY } = require("../src/token-contract");

test("the cache identity includes the installed and declared pinned tokenizer version", () => {
  const installed = require("gpt-tokenizer/package.json").version;
  assert.equal(require("../package.json").dependencies["gpt-tokenizer"], installed);
  assert.ok(TOKEN_CACHE_IDENTITY.startsWith("gpt-tokenizer@" + installed + "/o200k_base/"));
});

function f_fakeCounter(options) {
  const posted = [];
  const worker = { postMessage: job => posted.push(job), terminate() { this.terminated = true; } };
  const counter = f_createTokenCounter({ createWorker: () => worker, ...options });
  return { worker, posted, counter, reply(tokens) { worker.onmessage({ data: { id: posted.at(-1).id, tokens } }); } };
}

test("production worker matches independent o200k_base fixtures including literal special tokens", async t => {
  const { cases } = require("./fixtures/exact-token-counts.json");
  const built = await esbuild.build({ entryPoints: ["src/token-worker.js"], bundle: true, write: false, platform: "browser", format: "iife" });
  const counter = f_createTokenCounter({ createWorker: () => {
    const thread = new Worker('const {parentPort}=require("node:worker_threads"); global.self={postMessage:data=>parentPort.postMessage(data)}; parentPort.on("message",data=>self.onmessage({data}));\n' + built.outputFiles[0].text, { eval: true });
    const adapter = { postMessage: data => thread.postMessage(data), terminate: () => void thread.terminate() };
    thread.on("message", data => adapter.onmessage({ data }));
    thread.on("error", error => adapter.onerror(error));
    return adapter;
  } });
  t.after(() => counter.dispose());
  for (const { text, tokens } of cases) assert.equal(await counter.count(text), tokens, JSON.stringify(text).slice(0, 100));
});

test("worker queue prioritizes editor jobs and coalesces superseded snapshots", async t => {
  const fake = f_fakeCounter();
  t.after(() => fake.counter.dispose());
  const first = fake.counter.count("file one");
  const next = fake.counter.count("file two");
  const old = fake.counter.count("old document", { priority: true, key: "doc" });
  const latest = fake.counter.count("new document", { priority: true, key: "doc" });
  assert.equal(await old, null);
  fake.reply(2);
  assert.equal(await first, 2);
  assert.equal(fake.posted.at(-1).text, "new document");
  fake.reply(3);
  assert.equal(await latest, 3);
  assert.equal(fake.posted.at(-1).text, "file two");
  fake.reply(4);
  assert.equal(await next, 4);
});

test("worker failure, timeout and disposal reject active and queued jobs without estimates", async () => {
  for (const kind of ["error", "timeout", "dispose", "invalid"]) {
    const fake = f_fakeCounter({ timeoutMs: 10, maxRestarts: 0 });
    const requests = [fake.counter.count("one"), fake.counter.count("two")];
    const assertions = requests.map(request => assert.rejects(request));
    if (kind === "error") fake.worker.onerror({ message: "crash" });
    else if (kind === "dispose") fake.counter.dispose();
    else if (kind === "invalid") fake.reply(-1);
    await Promise.all(assertions);
    assert.equal(fake.worker.terminated, true);
    await assert.rejects(fake.counter.count("later"));
    assert.equal(fake.posted.length, 1);
  }
});

test("a failed job is isolated while a fresh worker continues queued work, with a restart cap", async () => {
  const workers = [];
  const counter = f_createTokenCounter({ createWorker: () => {
    const worker = { postMessage(job) { this.job = job; }, terminate() { this.terminated = true; } };
    workers.push(worker);
    return worker;
  } });
  const first = counter.count("bad input");
  const rejected = assert.rejects(first, /crash/);
  const healthy = counter.count("healthy input");
  workers[0].onerror({ message: "crash" });
  await rejected;
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[1].job.text, "healthy input");
  workers[1].onmessage({ data: { id: workers[1].job.id, tokens: 2 } });
  assert.equal(await healthy, 2);
  const second = counter.count("second bad input");
  const secondRejected = assert.rejects(second);
  workers[1].onerror({ message: "second crash" });
  await secondRejected;
  const third = counter.count("third bad input");
  const thirdRejected = assert.rejects(third, error => error.tokenCounterUnavailable === true);
  const queued = assert.rejects(counter.count("waiting"), error => error.tokenCounterUnavailable === true);
  workers[2].onerror({ message: "third crash" });
  await Promise.all([thirdRejected, queued]);
  await assert.rejects(counter.count("later"), error => error.tokenCounterUnavailable === true);
  assert.equal(workers.length, 3);
  counter.dispose();
});

test("editor invalidation discards earlier jobs before debounced text reads, and failures are distinct", async () => {
  const jobs = [];
  const values = [];
  const counter = f_createBufferTokenCounts({ count: () => new Promise((resolve, reject) => jobs.push({ resolve, reject })),
    delay: 0, onChange: (note, selected) => values.push([note, selected]), onError() {} });
  counter.update("old");
  await new Promise(resolve => setTimeout(resolve, 5));
  counter.invalidate(true);
  jobs[0].resolve(999);
  await Promise.resolve();
  assert.deepEqual(values.at(-1), [null, null]);
  counter.update("new");
  await new Promise(resolve => setTimeout(resolve, 5));
  jobs[1].reject(new Error("worker error"));
  await Promise.resolve();
  assert.equal(Number.isNaN(values.at(-1)[0]), true);
  counter.dispose();
});

test("editor count generations discard stale results, cache zero and count selections separately", async t => {
  const jobs = [];
  const outputs = [];
  const buffer = f_createBufferTokenCounts({
    delay: 0,
    count: text => new Promise(resolve => jobs.push({ text, resolve })),
    onChange: (note, selection) => outputs.push([note, selection]),
    onError: error => { throw error; },
  });
  t.after(() => buffer.dispose());
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));
  buffer.update("old");
  await tick();
  buffer.update("new", ["a", "b"]);
  await tick();
  jobs[0].resolve(999);
  jobs[1].resolve(2);
  jobs[2].resolve(1);
  await tick();
  assert.equal(jobs[3].text, "b");
  jobs[3].resolve(3);
  await tick();
  assert.deepEqual(outputs.at(-1), [2, 4]);
  assert.ok(!outputs.some(([note]) => note === 999));
  buffer.update("");
  await tick();
  jobs[4].resolve(0);
  await tick();
  buffer.update("");
  await tick();
  assert.equal(jobs.length, 5);
  assert.deepEqual(outputs.at(-1), [0, 0]);
});
