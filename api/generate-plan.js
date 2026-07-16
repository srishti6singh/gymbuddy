// api/generate-plan.js
// Vercel serverless function — runs server-side only.
// The GEMINI_API_KEY is read from environment variables (set in Vercel dashboard,
// never committed to the repo, never exposed to the browser).

// A plan is only returned to the client if EVERY day has realistic volume:
// warmup >= 5 items (4 dynamic movements + 1 cardio block), exercises >= 6 items
// (5 lifts + 1 finishing cardio block), cooldown >= 3 static stretches.
// Partial or thin plans are never returned.
// (Meal ideas moved to the lazy /api/meal-ideas endpoint to keep this call small.)
export function validatePlan(parsed) {
  if (!parsed || !Array.isArray(parsed.week) || parsed.week.length === 0) return false;
  return parsed.week.every(
    (day) =>
      day &&
      Array.isArray(day.warmup) && day.warmup.length >= 5 &&
      Array.isArray(day.exercises) && day.exercises.length >= 6 &&
      Array.isArray(day.cooldown) && day.cooldown.length >= 3
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server misconfigured: missing API key' });
  }

  const { experience_level, days_available, goal, injuries } = req.body || {};

  if (!experience_level || !days_available || !goal) {
    return res.status(400).json({ error: 'Missing required onboarding fields' });
  }

  const prompt = `You are a certified fitness coach creating a beginner-safe weekly workout plan for a budget gym member in India.

User profile:
- Experience level: ${experience_level}
- Days available per week: ${days_available}
- Goal: ${goal}
- Injuries/limitations: ${injuries || 'none reported'}

Rules:
- Create exactly ${days_available} workout days, with sensible rest/recovery between muscle groups
- Beginner-friendly exercises only if experience_level is beginner; scale difficulty appropriately otherwise
- Each day is a realistic ~60 minute session with three phases: warmup, exercises (main strength work), and cooldown
- "warmup" (total ~12-15 min): at least 4 dynamic movements (e.g. arm circles, bodyweight squats, high knees, dynamic lunges), each with duration 1-2 min, PLUS 1 separate cardio machine block of 8-10 min (e.g. "Cycling" or "Cross Trainer / Elliptical"). That means 5+ warmup items total. Each item has name, duration (e.g. "2 min"), and instructions (exactly 1 short sentence)
- "exercises" (the main strength work, total ~40 min): at least 5 strength exercises, PLUS 1 finishing cardio block of 8-10 min as the LAST item (e.g. "Treadmill — always on incline" or "Stair climber"). That means 6+ exercise items total. Each item needs: name, sets, reps, suggested_weight (a short beginner-appropriate load suggestion, e.g. "Bodyweight only" or "Start with 2-5 kg dumbbells"), instructions (exactly 1 short sentence that includes any relevant safety guidance — e.g. if injuries are listed, note how to modify or avoid aggravating them), alternative (a substitute exercise name for someone who can't access equipment or has a limitation), and video_search_term (a short phrase usable to search YouTube for a demo). For the finishing cardio block, use sensible values (e.g. sets 1, reps "8-10 min") and still fill every field
- "cooldown" (total ~5 min): at least 3 static stretches (e.g. child's pose, hamstring stretch, chest stretch), each with duration 1-2 min. That means 3+ cooldown items. Each has name, duration, and instructions (exactly 1 short sentence)
- If injuries are listed, exclude contraindicated movements entirely and fold any relevant safety guidance into the "instructions" field of affected items — do not use a separate safety field
- Include one short, practical diet_tip per day (not a full meal plan)
- Be concise everywhere. Do not add extra explanation, elaboration, or commentary beyond what's requested — every field should be as short as possible while staying useful.
- Output STRICT JSON ONLY. No markdown, no prose, no code fences, no explanations before or after. Keep names and video_search_terms short (under 6 words). Match this exact schema:
{"week":[{"day":"","focus":"","warmup":[{"name":"","duration":"","instructions":""}],"exercises":[{"name":"","sets":0,"reps":"","suggested_weight":"","instructions":"","alternative":"","video_search_term":""}],"cooldown":[{"name":"","duration":"","instructions":""}],"diet_tip":""}]}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${encodeURIComponent(apiKey)}`;
  const requestBody = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 3500,
      responseMimeType: 'application/json',
    },
  });

  // Up to 2 attempts (1 retry on any failure, including an incomplete plan),
  // bounded by a total budget that stays inside Vercel's 10s Hobby cap.
  const startedAt = Date.now();
  const TOTAL_BUDGET_MS = 9000;
  let lastFailure = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const remainingMs = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    if (remainingMs < 1500) break;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.min(8000, remainingMs));

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
