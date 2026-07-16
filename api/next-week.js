// api/next-week.js
// Vercel serverless function — runs server-side only.
// Generates an ADAPTED week from the previous week's check-in: completion
// rate, perceived difficulty, weight change, optional free-text feedback,
// and a possibly-updated goal. Same schema as /api/generate-plan plus a
// one-line "adaptation_note" per day explaining what changed.

import { validatePlan } from './generate-plan.js';

const FEEDBACK_LABELS = {
  too_easy: 'too easy',
  just_right: 'just right',
  tough_but_doable: 'tough but doable',
  too_hard: 'too hard',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server misconfigured: missing API key' });
  }

  const { onboarding, previousWeekSummary, weekNumber } = req.body || {};
  const { experience_level, days_available, goal, injuries: rawInjuries, weight, height } = onboarding || {};
  if (!experience_level || !days_available || !goal || !previousWeekSummary) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  let injuries = typeof rawInjuries === 'string' ? rawInjuries.trim() : rawInjuries;
  if (injuries && typeof injuries === 'string' && injuries.length < 3) {
    injuries = 'none reported';
  }

  const week = Math.max(2, parseInt(weekNumber, 10) || 2);
  const completionRate = Math.min(100, Math.max(0, parseInt(previousWeekSummary.completionRate, 10) || 0));
  const feedback = FEEDBACK_LABELS[previousWeekSummary.feedback] || 'just right';
  const feedbackText = typeof previousWeekSummary.feedbackText === 'string'
    ? previousWeekSummary.feedbackText.replace(/[\r\n]+/g, ' ').slice(0, 200)
    : '';
  const wc = previousWeekSummary.weightChange || {};
  const weightFrom = parseFloat(wc.from);
  const weightTo = parseFloat(wc.to);
  const weightLine = (!isNaN(weightFrom) && !isNaN(weightTo))
    ? `weight went from ${weightFrom} kg to ${weightTo} kg`
    : 'weight unchanged/unknown';
  const goalChanged = previousWeekSummary.newGoal && previousWeekSummary.newGoal !== goal
    ? `The user also switched their goal to ${String(previousWeekSummary.newGoal).replace(/_/g, ' ')}.`
    : '';

  let bmiLine = '';
  const kg = parseFloat(weight);
  if (!isNaN(kg) && kg > 0) {
    const m = (parseFloat(height) || 165) / 100;
    const bmi = Math.round((kg / (m * m)) * 10) / 10;
    bmiLine = `\n- User BMI: ${bmi} — bias exercise selection accordingly`;
  }

  const prompt = `You are a certified fitness coach creating week ${week} of a progressive workout program for a budget gym member in India.

User profile:
- Experience level: ${experience_level}
- Days available per week: ${days_available}
- Goal: ${goal}
- Injuries/limitations: ${injuries || 'none reported'}${bmiLine}

This is week ${week} for this user. Last week: ${completionRate}% completed, felt "${feedback}", ${weightLine}.${feedbackText ? ` The user asked: "${feedbackText}".` : ''} ${goalChanged}

Adaptation rules:
- If last week felt "too easy": increase intensity — raise reps/sets ~10-15% or suggest slightly heavier loads
- If last week felt "too hard": reduce volume — fewer sets or easier variations, keep movement patterns
- If "just right" or "tough but doable": progress gently (small load or rep bumps on what they did)
- If completion was under 60%, keep volume similar but make sessions feel more achievable
- If the goal changed, rebias exercise selection toward the new goal
- Add an "adaptation_note" per day: exactly 1 short sentence explaining what changed vs last week

Rules:
- Create exactly ${days_available} workout days, with sensible rest/recovery between muscle groups
- Beginner-friendly exercises only if experience_level is beginner; scale difficulty appropriately otherwise
- Each day is a realistic ~60 minute session with three phases: warmup, exercises (main strength work), and cooldown
- "warmup" (total ~12-15 min): at least 4 dynamic movements (e.g. arm circles, bodyweight squats, high knees, dynamic lunges), each with duration 1-2 min, PLUS 1 separate cardio machine block of 8-10 min (e.g. "Cycling" or "Cross Trainer / Elliptical"). That means 5+ warmup items total. Each item has name, duration (e.g. "2 min"), and instructions (exactly 1 short sentence)
- "exercises" (the main strength work, total ~40 min): at least 5 strength exercises, PLUS 1 finishing cardio block of 8-10 min as the LAST item (e.g. "Treadmill — always on incline" or "Stair climber"). That means 6+ exercise items total. Each item needs: name, sets, reps, suggested_weight (a short beginner-appropriate load suggestion), instructions (exactly 1 short sentence including any relevant safety guidance for listed injuries), alternative (a substitute exercise name), and video_search_term (a short phrase usable to search YouTube for a demo). For the finishing cardio block, use sensible values (e.g. sets 1, reps "8-10 min") and still fill every field
- "cooldown" (total ~5 min): at least 3 static stretches (e.g. child's pose, hamstring stretch, chest stretch), each with duration 1-2 min. That means 3+ cooldown items. Each has name, duration, and instructions (exactly 1 short sentence)
- If injuries are listed, exclude contraindicated movements entirely and fold safety guidance into "instructions" — no separate safety field
- Include one short, practical diet_tip per day (not a full meal plan)
- Be concise everywhere. No extra explanation or commentary beyond what's requested.
- Output STRICT JSON ONLY. No markdown, no prose, no code fences. Keep names and video_search_terms short (under 6 words). Match this exact schema:
{"week":[{"day":"","focus":"","adaptation_note":"","warmup":[{"name":"","duration":"","instructions":""}],"exercises":[{"name":"","sets":0,"reps":"","suggested_weight":"","instructions":"","alternative":"","video_search_term":""}],"cooldown":[{"name":"","duration":"","instructions":""}],"diet_tip":""}]}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${encodeURIComponent(apiKey)}`;
  const requestBody = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 3500,
      responseMimeType: 'application/json',
    },
  });

  // Same retry/budget discipline as /api/generate-plan: up to 2 attempts
  // inside Vercel's 10s Hobby cap, clean statuses for the client fallback.
  const startedAt = Date.now();
  const TOTAL_BUDGET_MS = 9000;
  let lastFailure = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const remainingMs = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    if (remainingMs < 1500) break;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.min(9000, remainingMs));

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text();
        lastFailure = { status: 502, body: { error: 'Upstream API error', detail: errText } };
        continue;
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        lastFailure = { status: 502, body: { error: 'No text response from model' } };
        continue;
      }

      const cleaned = text
        .trim()
        .replace(/^```json/, '')
        .replace(/^```/, '')
        .replace(/```$/, '')
        .trim();

      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch (parseErr) {
        lastFailure = { status: 502, body: { error: 'Plan response was incomplete — please retry' } };
        continue;
      }

      if (!validatePlan(parsed)) {
        lastFailure = { status: 502, body: { error: 'Generated plan was missing required sections — please retry' } };
        continue;
      }

      return res.status(200).json(parsed);
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        lastFailure = { status: 504, body: { error: 'Gemini took too long to respond — please try again' } };
      } else {
        lastFailure = { status: 500, body: { error: 'Server error', detail: err.message } };
      }
    }
  }

  const failure = lastFailure || { status: 502, body: { error: 'Plan generation failed — please try again' } };
  return res.status(failure.status).json(failure.body);
}
