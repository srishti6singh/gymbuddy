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
- If injuries are listed, exclude contraindicated movements and add a one-line safety_note for any affected exercise (empty string if not applicable)
- Each exercise needs: name, sets, reps, and video_search_term (a short phrase usable to search YouTube for a demo)
- Include one short, practical diet_tip per day (not a full meal plan)
- Output STRICT JSON ONLY. No markdown, no prose, no code fences, no explanations before or after. Keep exercise names and video_search_terms short (under 6 words). Match this exact schema:
{"week":[{"day":"Monday","focus":"","exercises":[{"name":"","sets":0,"reps":"","video_search_term":"","safety_note":""}],"diet_tip":""}]}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 4000,
            responseMimeType: 'application/json',
          },
        }),
      }
    );

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
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
}
