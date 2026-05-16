// Site-wide constants. Product name is a working title — final naming/domain TBD.
export const SITE_TITLE = 'AI Visibility Check';
export const SITE_TAGLINE = 'See how AI answer engines read your site.';
// Kept to 50–170 chars so engines use it verbatim as a snippet (audit check).
export const SITE_DESCRIPTION =
  'Free audit of how visible your site is to AI answer engines — ChatGPT, ' +
  'Perplexity and Google AI Overviews. Checks crawler access, structured ' +
  'data and content.';
export const SITE_URL = 'https://geo-audit.kant.dev';

// OG/Twitter share image — resolved to an absolute URL in the layout.
export const OG_IMAGE = '/og.png';

// The kant.dev product this tool belongs to.
export const PARENT = {
  name: 'kant.dev',
  url: 'https://kant.dev',
};

// kant.dev / Philipp Kant profiles — used as schema.org `sameAs` so AI
// engines can confirm the entity behind the site against the wider graph.
export const PROFILES = [
  'https://philippkant.com',
  'https://github.com/philippkant',
  'https://www.linkedin.com/in/philippkant/',
  'https://x.com/philippkant',
];

// Funnel target — high-intent visitors are routed to the kant.dev commercial page.
export const CTA = {
  url: 'https://kant.dev/work/',
  label: 'Book a call',
};

// On-page FAQ. Rendered on the homepage and emitted as FAQPage JSON-LD, so
// the tool follows the same structured-data advice it gives.
export const FAQ = [
  {
    q: 'What is AI visibility?',
    a: 'AI visibility is how easily AI answer engines — ChatGPT, Perplexity, Google AI Overviews and Copilot — can crawl your site, understand what it is, and cite it in their answers. It builds on classic SEO but adds structured data, entity signals and agent-readable markup.',
  },
  {
    q: 'Is the audit free?',
    a: 'Yes. The audit is completely free, needs no signup and stores nothing. Enter a URL and get a scored report with a concrete fix for every issue it finds.',
  },
  {
    q: 'How is this different from an SEO audit?',
    a: 'A classic SEO audit optimises for the ten blue links. This audit focuses on what AI answer engines need: crawler access for GPTBot and similar bots, schema.org entity data, quotable server-rendered content, and markup that AI browser agents can operate.',
  },
  {
    q: 'Does it test whether ChatGPT already knows my brand?',
    a: 'Not yet. Version 1 is a deterministic technical audit of your markup and crawler access. A live citation test — asking models what they actually know about your brand — is planned as a separate feature.',
  },
];

// Primary guidance the audit checks are based on. Surfaced on the page so
// visitors can read the source material themselves.
export const SOURCES = [
  {
    label: 'Google — AI features and your website',
    url: 'https://developers.google.com/search/docs/fundamentals/ai-optimization-guide',
    note: "Google's official guidance on appearing in AI Overviews and AI Mode. Notably, it states that llms.txt and AI-specific markup are not required.",
  },
  {
    label: 'web.dev — Build agent-friendly websites',
    url: 'https://web.dev/articles/ai-agent-site-ux',
    note: 'How AI browser agents perceive and operate a page through the DOM and accessibility tree.',
  },
];
