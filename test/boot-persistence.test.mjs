// App harness tests: run with `node test/boot-persistence.test.mjs`
//
// 1. Adopting a fallback plan and "reopening the app" (re-evaluating the
//    script against the same storage) must land on the home screen.
// 2. A browser where localStorage.setItem THROWS (private tab, in-app
//    webview, full quota) must not crash adoptPlan.
// 3. Completing every day of the week turns home into the Week Review screen.
// 4. Generate Week 2 (API success): request carries the check-in summary;
//    adoption bumps weekNumber, archives history, resets progress, and all
//    of it survives a reload; home shows Week 2 + adaptation notes.
// 5. Generate Week 2 (API down): falls back to the goal-matched starter
//    plan, still rolls the week forward, never throws.
// 6. Dietary preference: persisted, passed in the meal-ideas fetch body,
//    and survives a reload.
// 7. Profile edits persist across reload; BMI recomputes with category.

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

// Evaluate the app script against a given storage, as a fresh page load
// would. `fetchImpl` stands in for the network (default: offline).
function boot(storage, fetchImpl) {
  const documentStub = {
    getElementById: () => makeElementStub(),
    querySelectorAll: () => [],
    createElement: () => makeElementStub(),
    body: makeElementStub(),
  };
  const locationStub = { origin: 'http://test.local', reload() {} };
  const fetchStub = fetchImpl || (() => Promise.reject(new Error('offline')));
  const fn = new Function(
    'document', 'localStorage', 'location', 'window', 'fetch',
    script + `\nreturn { STATE, STORAGE_KEYS, adoptPlan, adoptNextWeek, generateNextWeek, deepCopy,
      FALLBACK_PLANS, isPlanValid, renderHome, renderWeekReview, fetchMealIdeas,
      computeBMI, bmiCategory, computeWeekStats, writeStored };`
  );
  return fn(documentStub, storage, locationStub, {}, fetchStub);
}

function onboardedStorage() {
  const storage = makeStorage();
  storage.setItem('gymbuddy_name', 'Srishti');
  storage.setItem('gymbuddy_onboarding', JSON.stringify({
    experience_level: 'beginner', days_available: '3', goal: 'lose_weight', injuries: '', weight: '60', height: '160',
  }));
  return storage;
}

// --- Test 1: adopt fallback plan → simulate reload → boot lands on 'home' ---
{
  const storage = onboardedStorage();
  const first = boot(storage);
  first.adoptPlan(first.deepCopy(first.FALLBACK_PLANS.lose_weight.week), { fallback: true });
  assert.ok(storage.getItem('gymbuddy_plan'), 'fallback plan persisted');

  const second = boot(storage);
  assert.strictEqual(second.STATE.screen, 'home', `boot after fallback adoption lands on 'home' (got '${second.STATE.screen}')`);
  assert.strictEqual(second.STATE.usingFallback, true, 'usingFallback flag survived the reload');
  assert.strictEqual(second.isPlanValid(second.STATE.plan), true, 'reloaded fallback plan passes isPlanValid');
  console.log('PASS 1: adopt fallback → reload → home');
}

// --- Test 2: storage writes that throw must not break the app ---
{
  const storage = makeStorage();
  storage.setItem = () => { throw new DOMException('QuotaExceededError'); };
  const app = boot(storage);
  assert.doesNotThrow(
    () => app.adoptPlan(app.deepCopy(app.FALLBACK_PLANS.general_fitness.week), { fallback: true }),
    'adoptPlan survives a throwing localStorage'
  );
  assert.strictEqual(app.isPlanValid(app.STATE.plan), true, 'plan still usable in memory');
  console.log('PASS 2: throwing localStorage does not crash adoptPlan');
}

// Shared setup for the week-cycle tests: onboarded user, week 1 plan adopted,
// every day completed with logged work.
function completedWeekApp(fetchImpl) {
  const storage = onboardedStorage();
  const app = boot(storage, fetchImpl);
  app.adoptPlan(app.deepCopy(app.FALLBACK_PLANS.lose_weight.week), { fallback: false });
  app.STATE.dayProgress = { 0: true, 1: true, 2: true };
  app.writeStored(app.STORAGE_KEYS.dayProgress, JSON.stringify(app.STATE.dayProgress));
  app.STATE.weekLog = [
    { dayIndex: 0, kcal: 180, activeMinutes: 42 },
    { dayIndex: 1, kcal: 210, activeMinutes: 48 },
    { dayIndex: 2, kcal: 195, activeMinutes: 45 },
  ];
  app.writeStored(app.STORAGE_KEYS.weekLog, JSON.stringify(app.STATE.weekLog));
  return { storage, app };
}

// --- Test 3: all days complete → home renders the Week Review ---
{
  const { app } = completedWeekApp();
  const htmlOut = app.renderHome();
  assert.ok(htmlOut.includes('Week 1 done!'), 'review headline shown');
  assert.ok(htmlOut.includes('3/3'), 'days completed vs planned shown');
  assert.ok(htmlOut.includes('135'), 'total active minutes summed from week log');
  assert.ok(htmlOut.includes('585'), 'total kcal summed from week log');
  assert.ok(htmlOut.includes('reviewWeightInput') && htmlOut.includes('value="60"'), 'weight input pre-filled with current');
  assert.ok(htmlOut.includes('data-review-feel="too_easy"') && htmlOut.includes('data-review-feel="too_hard"'), 'feel chips present');
  assert.ok(htmlOut.includes('Keep goal (Lose weight) or switch?'), 'goal keep/switch row present');
  assert.ok(htmlOut.includes('Generate Week 2'), 'generate button present');
  console.log('PASS 3: completed week renders the Week Review screen');
}

// --- Test 4: Generate Week 2 via API — request payload, adoption, archive, reload ---
{
  let captured = null;
  const fetchImpl = (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    const week = fetchImpl.week;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ week }) });
  };
  const { storage, app } = completedWeekApp(fetchImpl);
  fetchImpl.week = app.deepCopy(app.FALLBACK_PLANS.build_muscle.week).map((d) => ({
    ...d, adaptation_note: 'Added one set to each lift since last week felt too easy.',
  }));

  app.STATE.weekReview = { weight: '58', feedback: 'too_easy', feedbackText: 'more core work', goal: 'build_muscle' };
  await app.generateNextWeek();

  assert.strictEqual(captured.url, '/api/next-week', 'posted to the next-week endpoint');
  const summary = captured.body.previousWeekSummary;
  assert.strictEqual(summary.completionRate, 100, 'completion rate computed');
  assert.strictEqual(summary.feedback, 'too_easy', 'feedback chip forwarded');
  assert.strictEqual(summary.feedbackText, 'more core work', 'free text forwarded');
  assert.deepStrictEqual(summary.weightChange, { from: '60', to: '58' }, 'weight change forwarded');
  assert.strictEqual(summary.newGoal, 'build_muscle', 'goal switch forwarded');
  assert.strictEqual(captured.body.weekNumber, 2, 'week number forwarded');

  assert.strictEqual(app.STATE.weekNumber, 2, 'week number incremented');
  assert.strictEqual(app.STATE.history.length, 1, 'completed week archived');
  assert.strictEqual(app.STATE.history[0].completedDays, 3, 'archive records completed days');
  assert.strictEqual(app.STATE.history[0].weekLog.length, 3, 'archive carries the week log');
  assert.deepStrictEqual(app.STATE.weekLog, [], 'week log reset');
  assert.deepStrictEqual(app.STATE.dayProgress, {}, 'day progress reset');
  assert.strictEqual(app.STATE.onboarding.weight, '58', 'weight updated from check-in');
  assert.strictEqual(app.STATE.onboarding.goal, 'build_muscle', 'goal updated from check-in');

  // Reload: everything must come back.
  const second = boot(storage);
  assert.strictEqual(second.STATE.screen, 'home', 'reboot lands on home');
  assert.strictEqual(second.STATE.weekNumber, 2, 'week number persisted');
  assert.strictEqual(second.STATE.history.length, 1, 'history persisted');
  assert.strictEqual(second.isPlanValid(second.STATE.plan), true, 'adapted plan valid after reload');
  const homeOut = second.renderHome();
  assert.ok(homeOut.includes('Week 2 · Day 1'), 'home shows Week 2 · Day 1');
  assert.ok(homeOut.includes('Added one set to each lift'), 'adaptation note shown on day card');
  console.log('PASS 4: next-week adoption + archive + reset survive reload');
}

// --- Test 5: Generate Week 2 with API down → fallback, still rolls forward ---
{
  const { app } = completedWeekApp(); // offline fetch
  app.STATE.weekReview = { weight: '60', feedback: 'too_hard', feedbackText: '', goal: 'lose_weight' };
  await app.generateNextWeek();
  assert.strictEqual(app.STATE.weekNumber, 2, 'week rolled forward despite API failure');
  assert.strictEqual(app.STATE.usingFallback, true, 'fallback flag set');
  assert.strictEqual(app.isPlanValid(app.STATE.plan), true, 'fallback week valid');
  assert.strictEqual(app.STATE.history.length, 1, 'week still archived');
  console.log('PASS 5: next-week API failure falls back and never throws');
}

// --- Test 6: dietary preference persists and rides the meal fetch body ---
{
  let captured = null;
  const fetchImpl = (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ideas: ['A', 'B', 'C'], cravingSwaps: ['x', 'y'] }) });
  };
  const storage = onboardedStorage();
  const app = boot(storage, fetchImpl);
  // Same writes the diet chip listener performs:
  app.STATE.dietPref = 'vegan';
  app.writeStored(app.STORAGE_KEYS.dietPref, 'vegan');
  await app.fetchMealIdeas('Lunch');
  assert.strictEqual(captured.url, '/api/meal-ideas', 'meal endpoint called');
  assert.strictEqual(captured.body.dietPref, 'vegan', 'dietPref included in request body');

  const second = boot(storage);
  assert.strictEqual(second.STATE.dietPref, 'vegan', 'dietPref survives reload');
  console.log('PASS 6: dietary preference persisted and passed to meal fetch');
}

// --- Test 7: profile edits persist across reload; BMI recomputes with category ---
{
  const storage = onboardedStorage();
  const app = boot(storage);
  assert.strictEqual(app.computeBMI(app.STATE.onboarding), 23.4, 'initial BMI from stored profile');

  // Same writes the profile listeners perform on input:
  app.STATE.name = 'Sri';
  app.writeStored(app.STORAGE_KEYS.name, 'Sri');
  app.STATE.onboarding.weight = '80';
  app.STATE.onboarding.height = '180';
  app.STATE.onboarding.injuries = 'left knee';
  app.writeStored(app.STORAGE_KEYS.onboarding, JSON.stringify(app.STATE.onboarding));

  assert.strictEqual(app.computeBMI(app.STATE.onboarding), 24.7, 'BMI recomputed from edited values');
  assert.strictEqual(app.bmiCategory(24.7), 'Healthy range', 'category label');
  assert.strictEqual(app.bmiCategory(15.6), 'Underweight', 'underweight label');
  assert.strictEqual(app.bmiCategory(37.1), 'Obese range', 'obese label');
  assert.strictEqual(app.computeBMI({ weight: '60' }), 22, 'missing height defaults to 165 cm');

  const second = boot(storage);
  assert.strictEqual(second.STATE.name, 'Sri', 'name edit persisted');
  assert.strictEqual(second.STATE.onboarding.weight, '80', 'weight edit persisted');
  assert.strictEqual(second.STATE.onboarding.height, '180', 'height edit persisted');
  assert.strictEqual(second.STATE.onboarding.injuries, 'left knee', 'injuries edit persisted');
  console.log('PASS 7: profile edits persist; BMI recomputes correctly');
}

console.log('All harness tests passed');
process.exit(0); // don't wait out toast/loading-fact timers left by the flows
