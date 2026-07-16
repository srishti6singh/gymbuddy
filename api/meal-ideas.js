// api/meal-ideas.js
// Vercel serverless function — runs server-side only.
// Called lazily from the day summary when a meal chip is tapped, so the main
// plan-generation call stays small. Returns 3 Indian-context meal ideas plus
// 2 craving swaps for the chosen meal type.

export function validateMealIdeas(parsed) {
  return (
    !!parsed &&
    Array.isArray(parsed.ideas) &&
    parsed.ideas.length >= 3 &&
    parsed.ideas.every((i) => typeof i === 'string' && i.trim()) &&
    Array.isArray(parsed.cravingSwaps) &&
    parsed.cravingSwaps.length >= 2 &&
    parsed.cravingSwaps.every((c) => typeof c === 'string' && c.trim())
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

  const { mealType, goal, dietPref } = req.body || {};
  if (!mealType || typeof mealType !== 'string') {
    return res.status(400).json({ error: 'Missing mealType' });
  }

  const goalText = goal ? String(goal).replace(/_/g, ' ').slice(0, 40) : 'general fitness';
  const DIET_LABELS = { vegetarian: 'vegetarian', vegan: 'vegan', lactose_free: 'lactose-free', eggetarian: 'eggetarian (vegetarian + eggs)' };
  const dietLine = DIET_LABELS[dietPref] ? `\n- User is ${DIET_LABELS[dietPref]} — all suggestions must comply` : '';
  const prompt = `Suggest exactly 3 healthy ${String(mealType).slice(0, 20)} ideas for a budget-conscious gym beginner in India whose fitness goal is ${goalText}.

Rules:${dietLine}
- Easy to make in a typical Indian home kitchen, high-protein where possible
- Each idea is a short dish name under 6 words (e.g. "Paneer bhurji with roti")
- Also give exactly 2 healthy swaps for common cravings (sweets, fried snacks), each under 8 words
- Output STRICT JSON ONLY. No markdown, no prose, no code fences. Match this exact schema:
{"ideas":["","",""],"cravingSwaps":["",""]}`;

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
            temperature: 0.8,
            maxOutputTokens: 300,
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
      return res.status(502).json({ error: 'Meal ideas response was incomplete — please retry' });
    }

    if (!validateMealIdeas(parsed)) {
      return res.status(502).json({ error: 'Meal ideas were incomplete — please retry' });
    }

    return res.status(200).json({
      ideas: parsed.ideas.slice(0, 3),
      cravingSwaps: parsed.cravingSwaps.slice(0, 2),
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Took too long to respond — please try again' });
    }
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
}
