// api/get-video.js
// Vercel serverless function — runs server-side only.
// The YOUTUBE_API_KEY is read from environment variables (set in Vercel dashboard,
// never committed to the repo, never exposed to the browser).
//
// Called lazily from the frontend — only when a user taps to expand a specific
// exercise's video — to conserve the YouTube Data API's free-tier quota.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server misconfigured: missing API key' });
  }

  const { searchTerm } = req.body || {};
  if (!searchTerm || typeof searchTerm !== 'string') {
    return res.status(400).json({ error: 'Missing searchTerm' });
  }

  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(searchTerm)}&key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url);

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: 'Upstream API error', detail: errText });
    }

    const data = await response.json();
    const videoId = data.items?.[0]?.id?.videoId;
    if (!videoId) {
      return res.status(404).json({ error: 'No video found for that search term' });
    }

    return res.status(200).json({ videoId });
  } catch (err) {
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
}
