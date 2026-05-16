# AI Visibility Check (geo-audit)

A free tool that audits how visible a website is to AI answer engines —
ChatGPT, Perplexity, Google AI Overviews, Copilot. Enter a URL, get a scored
report on crawler access, structured data, content extractability, and agent
readiness, with a concrete fix for every issue.

A **kant.dev product**. The intended role: a free, shareable tool that
demonstrates AI/SEO expertise and feeds inbound — see `kant.dev/products`.

> **Naming is a working title.** The product is "AI Visibility Check" and the
> repo is `geo-audit` for now. Final name + domain are Philipp's call; change
> `src/consts.ts` and `astro.config.mjs` (`site`) when decided.

## What it checks

The audit is **deterministic** — it fetches the page, `robots.txt`, `llms.txt`
and `sitemap.xml`, then inspects the markup. No API keys, no model calls.

| Category | Checks |
| --- | --- |
| **AI crawler access** | robots.txt rules for GPTBot / OAI-SearchBot / ClaudeBot / PerplexityBot / Google-Extended / Applebot-Extended / Amazonbot; `noindex` indexability; discoverable XML sitemap; `llms.txt` (informational) |
| **Structured data** | JSON-LD present & valid; Organization/Person entity schema; WebSite schema; `sameAs` entity-graph links |
| **Content & extractability** | title, meta description, single H1, heading structure, canonical, Open Graph tags, substantive server-rendered text |
| **Agent readiness** | semantic landmarks (`<main>`/`<nav>`); real `<a href>`/`<button>` controls; labelled form fields; image `alt` text |

Each check returns pass / improve / fix, with a per-category and overall score
(0–100, weighted). The audit follows Google's [AI optimization
guide](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)
and the Chrome team's [agent-friendly UX
guidance](https://web.dev/articles/ai-agent-site-ux) — including Google's
position that `llms.txt` is **not** required, so that check is shown as an
informational note and does not affect the score.

## Tech

- **Astro 5** (`output: 'server'`, `@astrojs/node` standalone adapter)
- **Tailwind 4** via `@tailwindcss/vite` — shares the kant.dev paper/ink/coral palette
- `node-html-parser` for markup inspection
- Homepage is prerendered; only `POST /api/audit` runs on demand

## Develop

```bash
npm install
npm run dev      # http://localhost:4321
npm run check    # astro check (types + content schema)
npm run build    # production build to dist/
```

## Deploy

Built from the `Dockerfile` (Node 20 builder → Node 20 runner, standalone
server). Hosted on Coolify, same as kant.dev. The server listens on `PORT`
(default `4321`).

## Known limitations (v1)

- Audits the **single URL given** — not a whole-site crawl.
- Sees only **server-rendered HTML**. JavaScript-rendered content is not
  executed — which is deliberate, since most AI crawlers don't execute JS
  either, so a near-empty result is itself a real finding.
- SSRF guard blocks localhost and private IP ranges by hostname only; it does
  not resolve DNS. Fine for a public tool, worth hardening if abused.

## Roadmap

Planned, not built:

- **Live citation test** — ask LLMs what they know about the brand/domain
  (needs API keys; intended paid tier).
- **Monitoring** — re-run audits on a schedule, alert on regressions.
- **Agency mode** — multi-site dashboards.
- PDF export of the report.
