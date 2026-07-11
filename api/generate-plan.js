// api/generate-plan.js
// Vercel serverless function — runs server-side only.
// The GEMINI_API_KEY is read from environment variables (set in Vercel dashboard,
// never committed to the repo, never exposed to the browser).

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
- Each day has three phases: warmup, exercises (main strength work), and cooldown
- "warmup": 2-3 items, each with name, duration (e.g. "3 min"), and instructions (exactly 1 short sentence)
- "exercises": the main strength work. Each item needs: name, sets, reps, instructions (exactly 1 short sentence that includes any relevant safety guidance — e.g. if injuries are listed, note how to modify or avoid aggravating them), alternative (a substitute exercise name for someone who can't access equipment or has a limitation), and video_search_term (a short phrase usable to search YouTube for a demo)
- "cooldown": 1-2 items, each with name, duration, and instructions (exactly 1 short sentence)
- If injuries are listed, exclude contraindicated movements entirely and fold any relevant safety guidance into the "instructions" field of affected items — do not use a separate safety field
- Include one short, practical diet_tip per day (not a full meal plan)
- Be concise everywhere. Do not add extra explanation, elaboration, or commentary beyond what's requested — every field should be as short as possible while staying useful.
- Output STRICT JSON ONLY. No markdown, no prose, no code fences, no explanations before or after. Keep names and video_search_terms short (under 6 words). Match this exact schema:
{"week":[{"day":"","focus":"","warmup":[{"name":"","duration":"","instructions":""}],"exercises":[{"name":"","sets":0,"reps":"","instructions":"","alternative":"","video_search_term":""}],"cooldown":[{"name":"","duration":"","instructions":""}],"diet_tip":""}]}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2500,
            responseMimeType: 'application/json',
          },
        }),
        signal: controller.signal,
      }
    );
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: 'Upstream API error', detail: errText });
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return res.status(502).json({ error: 'No text response from model' });
    }

    let cleaned = text
      .trim()
      .replace(/^```json/, '')
      .replace(/^```/, '')
      .replace(/```$/, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      return res.status(502).json({ error: 'Plan response was incomplete — please retry' });
    }

    if (!parsed.week || !Array.isArray(parsed.week)) {
      return res.status(502).json({ error: 'Unexpected plan format from model' });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Gemini took too long to respond (>8s) — please try again' });
    }
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
}
