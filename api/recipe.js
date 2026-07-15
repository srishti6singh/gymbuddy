// api/recipe.js
// Vercel serverless function — runs server-side only.
// Called lazily when the user expands Recipe/Ingredients on a meal idea.
// Returns short steps plus an ingredients list with Indian-kitchen
// substitutes/aliases (e.g. asafoetida → "hing").

export function validateRecipe(parsed) {
  return (
    !!parsed &&
    Array.isArray(parsed.steps) &&
    parsed.steps.length >= 3 &&
    parsed.steps.every((s) => typeof s === 'string' && s.trim()) &&
    Array.isArray(parsed.ingredients) &&
    parsed.ingredients.length >= 1 &&
    parsed.ingredients.every((i) => i && typeof i.name === 'string' && i.name.trim())
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

  const { mealName } = req.body || {};
  if (!mealName || typeof mealName !== 'string' || !mealName.trim()) {
    return res.status(400).json({ error: 'Missing mealName' });
  }

  const safeMealName = mealName.replace(/[\r\n]+/g, ' ').slice(0, 80);
  const prompt = `Give a simple beginner recipe for "${safeMealName}" made in a typical Indian home kitchen.

Rules:
- 4-6 steps, each exactly 1 short sentence
- List the ingredients; for each, "alternative" is an easy Indian-kitchen substitute or common local alias (e.g. asafoetida → "hing", curd → "homemade curd, water drained"). Use "" if none needed.
- Keep everything concise
- Output STRICT JSON ONLY. No markdown, no prose, no code fences. Match this exact schema:
{"steps":["",""],"ingredients":[{"name":"","alternative":""}]}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 500,
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

    let parsed;
    try {
      parsed = JSON.parse(text.trim().replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim());
    } catch (parseErr) {
      return res.status(502).json({ error: 'Recipe response was incomplete — please retry' });
    }

    if (!validateRecipe(parsed)) {
      return res.status(502).json({ error: 'Recipe was incomplete — please retry' });
    }

    return res.status(200).json({
      steps: parsed.steps.slice(0, 6),
      ingredients: parsed.ingredients.map((i) => ({
        name: String(i.name),
        alternative: typeof i.alternative === 'string' ? i.alternative : '',
      })),
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Took too long to respond — please try again' });
    }
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
}
