// Site-wide constants. Product name is a working title — final naming/domain TBD.
export const SITE_TITLE = 'AI Visibility Check';
export const SITE_TAGLINE = 'See how AI answer engines read your site.';
export const SITE_DESCRIPTION =
  'A free audit of how visible your website is to AI answer engines like ChatGPT, ' +
  'Perplexity, and Google AI Overviews. Checks crawler access, structured data, ' +
  'content extractability, and agent readiness.';
export const SITE_URL = 'https://geo-audit.kant.dev';

// The kant.dev product this tool belongs to.
export const PARENT = {
  name: 'kant.dev',
  url: 'https://kant.dev',
};

// Funnel target — high-intent visitors are routed to the kant.dev commercial page.
export const CTA = {
  url: 'https://kant.dev/work/',
  label: 'Book a call',
};

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
