# Self-audit: getting geo-audit.kant.dev to 100/100

This tool audits how visible a website is to AI answer engines. So it should
pass its own audit. This document records the self-audit that was run against
`geo-audit.kant.dev` and every change made to take the score from **66/100
("fair") to 100/100 ("strong")**.

Commit: `3b11b53` — "Make the site pass its own AI visibility audit (66 → 100)".

## Starting score: 66/100

The audit (see `src/lib/audit.ts`) runs 18 weighted checks across four
categories. The initial run found:

| Category | Score | Problems |
| --- | --- | --- |
| AI crawler access | 80 | No `sitemap.xml` (404, and not referenced in `robots.txt`) |
| Structured data | **19** | No JSON-LD at all; no entity schema; no `WebSite`; no `sameAs` |
| Content & extractability | 78 | Meta description 200 chars (over the 170 limit); only 2/3 Open Graph tags (no `og:image`); 234 words of body text (under the 250 threshold) |
| Agent readiness | 100 | — already clean |

The worst offender was structured data at 19/100. A tool selling AI-visibility
expertise was itself invisible as an **entity** to AI engines: nothing on the
page told ChatGPT or Perplexity what the site was, who was behind it, or how to
cite it.

## What was changed

### 1. Structured data: 19 → 100

Added a single JSON-LD `@graph` block to the page `<head>`, built in
`src/layouts/BaseLayout.astro`. The graph has four nodes:

- **`WebApplication`** — describes the audit tool itself (free, browser-based,
  `BusinessApplication` category, with a `price: 0` offer).
- **`WebSite`** — links the page into one identifiable site.
- **`Organization`** — the entity behind the site (`kant.dev`), with a
  `founder` Person node and, critically, a **`sameAs`** array pointing to
  philippkant.com, GitHub, LinkedIn and X. `sameAs` is how an answer engine
  confirms the site maps to a real, known entity in the wider graph.
- **`FAQPage`** — generated from the on-page FAQ (see change 4).

This turned four checks from fail/warn to pass: `jsonld`, `entity-schema`,
`website-schema` and `sameas`.

Supporting change in `src/consts.ts`: added a `PROFILES` array (the `sameAs`
URLs) so the entity links live in one place.

### 2. Sitemap: crawler-access check fail → pass

- Created `public/sitemap.xml` — a minimal, valid sitemap listing the one page.
- Added a `Sitemap:` directive to `public/robots.txt` so crawlers find it
  reliably instead of guessing the path.

The `sitemap` check only awards a full pass when the sitemap is *referenced
from robots.txt*, so both halves were needed.

### 3. Open Graph image: og-tags warn → pass

- Generated `public/og.png` — a branded 1200×630 share image (warm paper
  background, coral magnifying-glass mark, title and domain), created with the
  `sharp` library already bundled in the project.
- Added `og:image`, `og:image:width/height/alt`, `twitter:image` and
  `og:site_name` tags in `BaseLayout.astro`.

This took the Open Graph check from 2/3 tags to the full 3/3.

### 4. Content depth: content-depth warn → pass

The served HTML had only 234 words; the check wants ≥250.

- Added a 4-item **FAQ** (`FAQ` in `src/consts.ts`) covering what AI visibility
  is, that the tool is free, how it differs from an SEO audit, and the planned
  live-citation feature.
- Rendered it as a "Frequently asked" `<dl>` section in `src/pages/index.astro`.

Body text rose from 234 to 411 words. The same `FAQ` constant feeds the
`FAQPage` JSON-LD, so the page and its schema can never drift apart.

### 5. Meta description: meta-description warn → pass

Rewrote `SITE_DESCRIPTION` in `src/consts.ts` from 200 characters down to 158,
inside the 50–170 range engines use a description verbatim as a snippet.

## Files touched

| File | Change |
| --- | --- |
| `src/consts.ts` | Shorter `SITE_DESCRIPTION`; new `OG_IMAGE`, `PROFILES`, `FAQ` |
| `src/layouts/BaseLayout.astro` | JSON-LD `@graph`; `og:image` / `twitter:image` / `og:site_name` tags |
| `src/pages/index.astro` | New "Frequently asked" section rendered from `FAQ` |
| `public/robots.txt` | Added `Sitemap:` directive |
| `public/sitemap.xml` | New — minimal valid sitemap |
| `public/og.png` | New — 1200×630 branded share image |

## Final score: 100/100

After the changes, all 18 scored checks pass:

| Category | Before | After |
| --- | --- | --- |
| AI crawler access | 80 | 100 |
| Structured data | 19 | 100 |
| Content & extractability | 78 | 100 |
| Agent readiness | 100 | 100 |
| **Overall** | **66 ("fair")** | **100 ("strong")** |

Verified against the production build in `dist/`: meta description 158 chars;
all three Open Graph tags present; one valid JSON-LD block exposing
`Organization` / `WebSite` / `sameAs` / `FAQPage`; 411 words of body text;
sitemap discoverable from `robots.txt`. Build and `astro check` both pass with
zero errors.

The score goes live after the next deploy.
