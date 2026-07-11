# GymBuddy — MVP

Real, working AI fitness onboarding app: name → experience level → days/week →
goal → real LLM-generated weekly plan → checklist with check-ins → streak.

## Project structure
```
/index.html           — the entire frontend (no build step needed)
/api/generate-plan.js  — serverless function, calls Anthropic API server-side
/vercel.json           — deployment config
```

## Deploy to Vercel (free tier) — step by step

### 1. Push this folder to GitHub
```bash
cd gymbuddy-vercel-project
git init
git add .
git commit -m "GymBuddy MVP - onboarding + real LLM plan generation"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/gymbuddy.git
git push -u origin main
```
(Create the empty repo on github.com first, then run the commands above.)

### 2. Connect to Vercel
1. Go to vercel.com → Sign in with GitHub
2. Click "Add New Project" → select your `gymbuddy` repo → Import
3. Framework preset: leave as "Other" (no build step needed)
4. Before clicking Deploy, add your environment variable (next step)

### 3. Add your API key (critical — do this before first deploy)
In the Vercel project settings → Environment Variables:
- Name: `ANTHROPIC_API_KEY`
- Value: your actual Anthropic API key
- Apply to: Production, Preview, and Development

This key is never in your code or your GitHub repo — it lives only in
Vercel's encrypted environment settings and is read server-side by
`api/generate-plan.js`.

### 4. Deploy
Click Deploy. Vercel gives you a live URL like `gymbuddy-yourname.vercel.app`
— this is your real, shareable, mobile-browser-working link for submission.

### 5. Test on your phone
Open the Vercel URL directly on your phone's browser. Every screen, the real
LLM plan generation, check-ins, and streak should all work exactly as they
did in the prototype — except now it's a real public deployment.

## Notes
- Data (name, plan, check-ins, streak) is stored in the browser's
  localStorage — private to each device, no backend database needed for
  this MVP.
- Every future code change: just `git push` and Vercel auto-redeploys.
