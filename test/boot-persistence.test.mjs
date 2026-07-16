// Boot persistence tests: run with `node test/boot-persistence.test.mjs`
//
// 1. Adopting a fallback plan and "reopening the app" (re-evaluating the
//    script against the same storage) must land on the home screen.
// 2. A browser where localStorage.setItem THROWS (private tab, in-app
//    webview, full quota) must not crash adoptPlan — the session keeps
//    working in memory.

import fs from 'node:fs';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .find((s) => s.includes('FALLBACK_PLANS'));
assert.ok(script, 'app <script> block found');

function makeStorage(initial = new Map()) {
  return {
    map: initial,
    getItem(k) { return this.map.has(k) ? this.map.get(k) : null; },
    setItem(k, v) { this.map.set(k, String(v)); },
    removeItem(k) { this.map.delete(k); },
  };
}

function makeElementStub() {
  return {
    innerHTML: '', value: '', disabled: false, textContent: '',
    dataset: {}, style: {},
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener() {}, appendChild() {}, remove() {},
  };
}

// Evaluate the app script against a given storage, as a fresh page load would.
function boot(storage) {
  const documentStub = {
    getElementById: () => makeElementStub(),
    querySelectorAll: () => [],
    createElement: () => makeElementStub(),
    body: makeElementStub(),
  };
  const locationStub = { origin: 'http://test.local', reload() {} };
  const fn = new Function(
    'document', 'localStorage', 'location', 'window',
    script + '\nreturn { STATE, adoptPlan, deepCopy, FALLBACK_PLANS, isPlanValid };'
  );
  return fn(documentStub, storage, locationStub, {});
}

// --- Test 1: adopt fallback plan → simulate reload → boot lands on 'home' ---
{
  const storage = makeStorage();
  // First open: user finished onboarding (name + answers saved by the UI)…
  storage.setItem('gymbuddy_name', 'Srishti');
  storage.setItem('gymbuddy_onboarding', JSON.stringify({
    experience_level: 'beginner', days_available: '3', goal: 'lose_weight', injuries: '', weight: '60', height: '160',
  }));
  const first = boot(storage);
  // …and the API failed, so the fallback plan was adopted.
  first.adoptPlan(first.deepCopy(first.FALLBACK_PLANS.lose_weight.week), { fallback: true });
  assert.ok(storage.getItem('gymbuddy_plan'), 'fallback plan persisted');

  // Second open: same storage, fresh script evaluation.
  const second = boot(storage);
  assert.strictEqual(second.STATE.screen, 'home', `boot after fallback adoption lands on 'home' (got '${second.STATE.screen}')`);
  assert.strictEqual(second.STATE.usingFallback, true, 'usingFallback flag survived the reload');
  assert.strictEqual(second.isPlanValid(second.STATE.plan), true, 'reloaded fallback plan passes isPlanValid (schema_version intact)');
  console.log('PASS: adopt fallback → reload → home');
}

// --- Test 2: storage writes that throw must not break the app ---
{
  const storage = makeStorage();
  storage.setItem = () => { throw new DOMException('QuotaExceededError'); };
  const app = boot(storage); // boot itself must not throw
  assert.doesNotThrow(
    () => app.adoptPlan(app.deepCopy(app.FALLBACK_PLANS.general_fitness.week), { fallback: true }),
    'adoptPlan survives a throwing localStorage'
  );
  assert.strictEqual(app.isPlanValid(app.STATE.plan), true, 'plan still usable in memory');
  console.log('PASS: throwing localStorage does not crash adoptPlan');
}

console.log('All boot persistence tests passed');
