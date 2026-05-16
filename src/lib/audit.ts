// Audit engine: deterministic checks for how visible a site is to AI answer
// engines (ChatGPT, Perplexity, Google AI Overviews, Copilot, ...).
//
// v1 is fully deterministic — it fetches the page, robots.txt, llms.txt and
// sitemap, then inspects markup. No external API keys. Live "does an LLM
// actually know this brand" testing is a planned paid-tier feature.

import { parse, type HTMLElement } from 'node-html-parser';

// 'info' is a non-scored, neutral note — used where a check is genuinely
// informational rather than a pass/fail signal (e.g. llms.txt, which Google
// says is not required).
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  /** What the audit actually found on the page. */
  detail: string;
  /** How to improve it — shown when the check is not a pass. */
  fix: string;
  weight: number;
}

export interface Category {
  id: string;
  title: string;
  blurb: string;
  score: number; // 0-100
  checks: Check[];
}

export interface AuditResult {
  url: string;
  fetchedAt: string;
  score: number; // 0-100, weighted across every check
  band: 'weak' | 'fair' | 'strong';
  summary: string;
  categories: Category[];
}

const UA =
  'geo-audit/0.1 (+https://kant.dev; AI visibility checker)';

/* ------------------------------------------------------------------ */
/* URL handling                                                        */
/* ------------------------------------------------------------------ */

/**
 * Normalize user input into a safe absolute http(s) URL.
 * Throws a user-facing Error for invalid or non-public targets.
 */
export function normalizeUrl(input: string): string {
  let raw = input.trim();
  if (!raw) throw new Error('Enter a website URL.');
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('That does not look like a valid URL.');
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http and https sites can be audited.');
  }

  const host = u.hostname.toLowerCase();
  const isPrivate =
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (isPrivate) {
    throw new Error('That host is not reachable for a public audit.');
  }
  if (!host.includes('.')) {
    throw new Error('Enter a full domain, for example example.com.');
  }

  return u.toString();
}

interface FetchOutcome {
  ok: boolean;
  status: number;
  text: string;
  finalUrl: string;
}

async function fetchText(url: string, timeoutMs = 12000): Promise<FetchOutcome> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
      },
    });
    // Cap the body we read so a huge page can't exhaust memory.
    const text = (await res.text()).slice(0, 2_500_000);
    return { ok: res.ok, status: res.status, text, finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* robots.txt                                                          */
/* ------------------------------------------------------------------ */

interface RobotsGroup {
  agents: string[];
  disallow: string[];
  allow: string[];
}

function parseRobots(txt: string): { groups: RobotsGroup[]; sitemaps: string[] } {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'disallow') {
      if (current) current.disallow.push(value);
      lastWasAgent = false;
    } else if (field === 'allow') {
      if (current) current.allow.push(value);
      lastWasAgent = false;
    } else if (field === 'sitemap') {
      sitemaps.push(value);
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return { groups, sitemaps };
}

/** Is `bot` permitted to crawl the site root per these robots.txt groups? */
function botAllowed(groups: RobotsGroup[], bot: string): boolean {
  const name = bot.toLowerCase();
  let exact: RobotsGroup | undefined;
  let wildcard: RobotsGroup | undefined;
  for (const g of groups) {
    for (const a of g.agents) {
      if (a === name) exact = g;
      else if (a === '*') wildcard = g;
    }
  }
  const group = exact ?? wildcard;
  if (!group) return true; // no matching rule → allowed

  const blocksRoot = group.disallow.some((d) => d === '/');
  const allowsRoot = group.allow.some((a) => a === '/' || a === '/*');
  return !blocksRoot || allowsRoot;
}

// AI crawlers that matter for answer-engine visibility, grouped by impact.
const AI_BOTS_CORE = ['GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'PerplexityBot'];
const AI_BOTS_SECONDARY = ['Google-Extended', 'Applebot-Extended', 'Amazonbot'];

/* ------------------------------------------------------------------ */
/* JSON-LD schema extraction                                           */
/* ------------------------------------------------------------------ */

interface SchemaInfo {
  types: Set<string>;
  hasSameAs: boolean;
  sameAsCount: number;
  blocks: number;
  parseErrors: number;
}

function walkSchema(node: unknown, info: SchemaInfo): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walkSchema(n, info);
    return;
  }
  const obj = node as Record<string, unknown>;
  const t = obj['@type'];
  if (typeof t === 'string') info.types.add(t);
  else if (Array.isArray(t)) {
    for (const x of t) if (typeof x === 'string') info.types.add(x);
  }
  const sameAs = obj['sameAs'];
  if (sameAs) {
    info.hasSameAs = true;
    info.sameAsCount += Array.isArray(sameAs) ? sameAs.length : 1;
  }
  for (const key of Object.keys(obj)) {
    if (key === '@type' || key === 'sameAs') continue;
    walkSchema(obj[key], info);
  }
}

function extractSchema(root: HTMLElement): SchemaInfo {
  const info: SchemaInfo = {
    types: new Set(),
    hasSameAs: false,
    sameAsCount: 0,
    blocks: 0,
    parseErrors: 0,
  };
  const scripts = root.querySelectorAll('script[type="application/ld+json"]');
  for (const s of scripts) {
    info.blocks++;
    const raw = s.textContent.trim();
    if (!raw) continue;
    try {
      walkSchema(JSON.parse(raw), info);
    } catch {
      info.parseErrors++;
    }
  }
  return info;
}

const ENTITY_TYPES = [
  'Organization',
  'Corporation',
  'LocalBusiness',
  'Person',
  'ProfessionalService',
  'OnlineBusiness',
];

/* ------------------------------------------------------------------ */
/* Scoring helpers                                                      */
/* ------------------------------------------------------------------ */

function earned(c: Check): number {
  if (c.status === 'pass') return c.weight;
  if (c.status === 'warn') return c.weight * 0.5;
  return 0;
}

function scoreOf(checks: Check[]): number {
  // 'info' checks are notes, not signals — they never affect the score.
  const scored = checks.filter((c) => c.status !== 'info');
  const total = scored.reduce((s, c) => s + c.weight, 0);
  if (total === 0) return 0;
  const got = scored.reduce((s, c) => s + earned(c), 0);
  return Math.round((got / total) * 100);
}

/* ------------------------------------------------------------------ */
/* Main audit                                                           */
/* ------------------------------------------------------------------ */

export async function runAudit(url: string): Promise<AuditResult> {
  const origin = new URL(url).origin;

  const [pageR, robotsR, llmsR, sitemapR] = await Promise.allSettled([
    fetchText(url),
    fetchText(origin + '/robots.txt'),
    fetchText(origin + '/llms.txt'),
    fetchText(origin + '/sitemap.xml'),
  ]);

  if (pageR.status !== 'fulfilled') {
    throw new Error(
      'Could not reach that site. Check the URL is correct and the site is online.',
    );
  }
  const page = pageR.value;
  if (!page.ok) {
    throw new Error(`The site responded with HTTP ${page.status}. Try a different page or URL.`);
  }

  const root = parse(page.text);

  /* --- Category 1: AI crawler access --- */

  const robotsOk = robotsR.status === 'fulfilled' && robotsR.value.ok;
  const robots = robotsOk ? parseRobots(robotsR.value.text) : { groups: [], sitemaps: [] };

  const allBots = [...AI_BOTS_CORE, ...AI_BOTS_SECONDARY];
  const blocked = robotsOk ? allBots.filter((b) => !botAllowed(robots.groups, b)) : [];
  const blockedCore = blocked.filter((b) => AI_BOTS_CORE.includes(b));

  const crawlerCheck: Check = {
    id: 'ai-crawlers',
    label: 'AI crawlers can access the site',
    weight: 5,
    status: blockedCore.length > 0 ? 'fail' : blocked.length > 0 ? 'warn' : 'pass',
    detail: !robotsOk
      ? 'No robots.txt found, so every crawler is allowed by default.'
      : blocked.length === 0
        ? `robots.txt allows all major AI crawlers (${allBots.join(', ')}).`
        : `robots.txt blocks: ${blocked.join(', ')}.`,
    fix:
      blockedCore.length > 0
        ? `Remove the "Disallow: /" rules for ${blockedCore.join(', ')} in robots.txt. ` +
          'Blocking these means ChatGPT, Perplexity and similar engines never see your content.'
        : 'Allow the remaining AI crawlers in robots.txt unless you have a deliberate reason to block them.',
  };

  // Indexability — a noindex page is kept out of Search, and therefore out
  // of AI Overviews and AI Mode. Google's AI optimization guide treats Search
  // indexing as a hard prerequisite for any AI feature.
  const robotsMetas = root.querySelectorAll(
    'meta[name="robots"], meta[name="googlebot"]',
  );
  const noindex = robotsMetas.some((m) =>
    /\bnoindex\b/i.test(m.getAttribute('content') || ''),
  );
  const noindexCheck: Check = {
    id: 'indexable',
    label: 'Page is indexable (no noindex)',
    weight: 3,
    status: noindex ? 'fail' : 'pass',
    detail: noindex
      ? 'A robots meta tag sets "noindex" — this page is kept out of Google Search, and so out of AI Overviews and AI Mode.'
      : 'No "noindex" robots meta tag — the page is eligible to be indexed.',
    fix:
      'Remove the noindex directive from the robots meta tag. Google\'s AI ' +
      'optimization guide is explicit: a page must be indexable in Search ' +
      'before it can appear in any AI feature.',
  };

  const llmsOk = llmsR.status === 'fulfilled' && llmsR.value.ok && llmsR.value.text.trim().length > 0;
  const llmsCheck: Check = {
    id: 'llms-txt',
    label: 'llms.txt index for AI engines',
    weight: 1,
    // Informational only — does not affect the score. Google's AI
    // optimization guide explicitly states llms.txt is not needed for its
    // AI features; some independent crawlers still read it.
    status: 'info',
    detail: llmsOk
      ? 'Found /llms.txt — a curated Markdown index of key pages. Note: ' +
        "Google's AI optimization guide says llms.txt is not required for " +
        'its AI features, so treat it as an optional, emerging signal.'
      : 'No /llms.txt found. This is informational only — Google\'s AI ' +
        'optimization guide explicitly says llms.txt and AI-specific files ' +
        'are not needed. Some independent tools still read it.',
    fix: '',
  };

  const hasSitemap =
    (sitemapR.status === 'fulfilled' && sitemapR.value.ok) || robots.sitemaps.length > 0;
  const sitemapCheck: Check = {
    id: 'sitemap',
    label: 'XML sitemap is discoverable',
    weight: 2,
    status: hasSitemap
      ? robots.sitemaps.length > 0
        ? 'pass'
        : 'warn'
      : 'fail',
    detail: !hasSitemap
      ? 'No sitemap.xml found and none referenced in robots.txt.'
      : robots.sitemaps.length > 0
        ? 'Sitemap found and referenced from robots.txt.'
        : 'sitemap.xml exists but is not referenced in robots.txt.',
    fix: !hasSitemap
      ? 'Publish an XML sitemap so crawlers can discover every page, not just what they stumble onto.'
      : 'Add a "Sitemap:" line to robots.txt pointing at your sitemap so crawlers find it reliably.',
  };

  const crawlCategory: Category = {
    id: 'crawl',
    title: 'AI crawler access',
    blurb: 'Whether AI answer engines can reach and index your content at all.',
    checks: [crawlerCheck, noindexCheck, sitemapCheck, llmsCheck],
    score: 0,
  };
  crawlCategory.score = scoreOf(crawlCategory.checks);

  /* --- Category 2: Structured data --- */

  const schema = extractSchema(root);

  const jsonldCheck: Check = {
    id: 'jsonld',
    label: 'Structured data (JSON-LD) present',
    weight: 2,
    status: schema.blocks > 0 && schema.parseErrors === 0
      ? 'pass'
      : schema.blocks > 0
        ? 'warn'
        : 'fail',
    detail:
      schema.blocks === 0
        ? 'No JSON-LD structured data found on the page.'
        : schema.parseErrors > 0
          ? `${schema.blocks} JSON-LD block(s) found, but ${schema.parseErrors} failed to parse.`
          : `${schema.blocks} valid JSON-LD block(s) found.`,
    fix:
      schema.parseErrors > 0
        ? 'Fix the invalid JSON-LD — broken markup is ignored by AI engines and search.'
        : 'Add schema.org JSON-LD markup. It is the clearest way to tell AI engines what your pages are.',
  };

  const entityType = ENTITY_TYPES.find((t) => schema.types.has(t));
  const entityCheck: Check = {
    id: 'entity-schema',
    label: 'Organization / Person schema defines the entity',
    weight: 3,
    status: entityType ? 'pass' : 'fail',
    detail: entityType
      ? `Found ${entityType} schema — AI engines can identify who is behind the site.`
      : 'No Organization, LocalBusiness or Person schema found.',
    fix:
      'Add an Organization (or Person) JSON-LD block with name, url, logo and description. ' +
      'This is how an answer engine knows what entity to attribute and cite.',
  };

  const websiteCheck: Check = {
    id: 'website-schema',
    label: 'WebSite schema',
    weight: 1,
    status: schema.types.has('WebSite') ? 'pass' : 'warn',
    detail: schema.types.has('WebSite')
      ? 'Found WebSite schema.'
      : 'No WebSite schema found.',
    fix: 'Add a WebSite JSON-LD block — it links your pages into one identifiable site.',
  };

  const sameAsCheck: Check = {
    id: 'sameas',
    label: 'sameAs links connect you to the entity graph',
    weight: 2,
    status: schema.hasSameAs ? 'pass' : 'warn',
    detail: schema.hasSameAs
      ? `Found sameAs links (${schema.sameAsCount}) pointing to other profiles.`
      : 'No sameAs links found in structured data.',
    fix:
      'Add a "sameAs" array to your Organization/Person schema linking to your LinkedIn, ' +
      'X, GitHub, Crunchbase and Wikipedia/Wikidata entries. This is how AI engines confirm you are a real, known entity.',
  };

  const schemaCategory: Category = {
    id: 'schema',
    title: 'Structured data',
    blurb: 'Schema.org markup tells AI engines what your site is and how to cite it.',
    checks: [jsonldCheck, entityCheck, websiteCheck, sameAsCheck],
    score: 0,
  };
  schemaCategory.score = scoreOf(schemaCategory.checks);

  /* --- Category 3: Content & extractability --- */

  const titleEl = root.querySelector('title');
  const title = titleEl ? titleEl.textContent.trim() : '';
  const titleCheck: Check = {
    id: 'title',
    label: 'Page title',
    weight: 1,
    status: title.length >= 10 && title.length <= 65 ? 'pass' : title ? 'warn' : 'fail',
    detail: title
      ? `Title is ${title.length} characters: “${title}”.`
      : 'No <title> tag found.',
    fix: !title
      ? 'Add a descriptive <title> tag — it is the primary label AI engines use for the page.'
      : 'Aim for a 10–65 character title that names the page and the entity clearly.',
  };

  const descEl = root.querySelector('meta[name="description"]');
  const desc = descEl ? (descEl.getAttribute('content') || '').trim() : '';
  const descCheck: Check = {
    id: 'meta-description',
    label: 'Meta description',
    weight: 1,
    status: desc.length >= 50 && desc.length <= 170 ? 'pass' : desc ? 'warn' : 'fail',
    detail: desc
      ? `Meta description is ${desc.length} characters.`
      : 'No meta description found.',
    fix: !desc
      ? 'Add a meta description that summarises the page in 50–170 characters.'
      : 'Tighten the meta description to 50–170 characters of plain, concrete summary.',
  };

  const h1s = root.querySelectorAll('h1');
  const h1Check: Check = {
    id: 'single-h1',
    label: 'Exactly one clear H1',
    weight: 2,
    status: h1s.length === 1 ? 'pass' : 'fail',
    detail:
      h1s.length === 1
        ? `One H1: “${h1s[0].textContent.trim().slice(0, 80)}”.`
        : h1s.length === 0
          ? 'No H1 heading found.'
          : `${h1s.length} H1 headings found — the main topic is ambiguous.`,
    fix:
      h1s.length === 0
        ? 'Add a single H1 that states the page topic.'
        : 'Use exactly one H1 per page so AI engines can identify the main subject.',
  };

  const h2s = root.querySelectorAll('h2');
  const headingsCheck: Check = {
    id: 'headings',
    label: 'Scannable heading structure',
    weight: 1,
    status: h2s.length >= 2 ? 'pass' : h2s.length === 1 ? 'warn' : 'fail',
    detail: `${h2s.length} H2 heading(s) found.`,
    fix: 'Break content into sections with descriptive H2s. AI engines quote well-segmented content far more readily.',
  };

  const canonical = root.querySelector('link[rel="canonical"]');
  const canonicalCheck: Check = {
    id: 'canonical',
    label: 'Canonical URL declared',
    weight: 1,
    status: canonical && canonical.getAttribute('href') ? 'pass' : 'warn',
    detail: canonical && canonical.getAttribute('href')
      ? `Canonical points to ${canonical.getAttribute('href')}.`
      : 'No canonical link found.',
    fix: 'Add a <link rel="canonical"> so engines consolidate signals on one URL instead of splitting them.',
  };

  const ogTitle = root.querySelector('meta[property="og:title"]');
  const ogDesc = root.querySelector('meta[property="og:description"]');
  const ogImage = root.querySelector('meta[property="og:image"]');
  const ogCount = [ogTitle, ogDesc, ogImage].filter(Boolean).length;
  const ogCheck: Check = {
    id: 'og-tags',
    label: 'Open Graph metadata',
    weight: 1,
    status: ogCount === 3 ? 'pass' : ogCount > 0 ? 'warn' : 'fail',
    detail: `${ogCount} of 3 core Open Graph tags found (og:title, og:description, og:image).`,
    fix: 'Add og:title, og:description and og:image so the page renders cleanly when AI tools and people share it.',
  };

  // Readable word count of the body, scripts/styles stripped.
  const body = root.querySelector('body');
  if (body) {
    body.querySelectorAll('script, style, noscript, template, svg').forEach((el) => el.remove());
  }
  const bodyText = (body ? body.textContent : '').replace(/\s+/g, ' ').trim();
  const wordCount = bodyText ? bodyText.split(' ').length : 0;
  const contentCheck: Check = {
    id: 'content-depth',
    label: 'Substantive, server-rendered text',
    weight: 2,
    status: wordCount >= 250 ? 'pass' : wordCount >= 80 ? 'warn' : 'fail',
    detail: `About ${wordCount} words of readable text in the served HTML.`,
    fix:
      wordCount < 80
        ? 'Very little text in the raw HTML. If the page renders content with JavaScript, ' +
          'most AI crawlers see this near-empty version too — server-render or pre-render the key content.'
        : 'Add more substantive on-page text. AI engines quote and cite pages that actually answer questions.',
  };

  const contentCategory: Category = {
    id: 'content',
    title: 'Content & extractability',
    blurb: 'AI engines extract and quote text — clear structure and metadata make your content quotable.',
    checks: [
      titleCheck,
      descCheck,
      h1Check,
      headingsCheck,
      canonicalCheck,
      ogCheck,
      contentCheck,
    ],
    score: 0,
  };
  contentCategory.score = scoreOf(contentCategory.checks);

  /* --- Category 4: Agent readiness --- */

  // How well AI browser agents — which read the DOM and the accessibility
  // tree, not just the visual render — can perceive and operate the page.
  // See web.dev/articles/ai-agent-site-ux.

  const hasMain = root.querySelectorAll('main').length > 0;
  const hasNavOrHeader =
    root.querySelectorAll('nav').length > 0 || root.querySelectorAll('header').length > 0;
  const landmarkCheck: Check = {
    id: 'landmarks',
    label: 'Semantic landmarks mark out the page',
    weight: 1,
    status: hasMain && hasNavOrHeader ? 'pass' : hasMain || hasNavOrHeader ? 'warn' : 'fail',
    detail:
      (hasMain ? 'A <main> landmark is present' : 'No <main> landmark') +
      (hasNavOrHeader
        ? ' and <nav>/<header> structure is present.'
        : '; no <nav>/<header> structure.'),
    fix:
      'Wrap the primary content in <main> and use <nav>/<header>/<footer>. ' +
      'Agents use these landmarks to tell main content apart from navigation.',
  };

  // Anchors with no real destination are invisible as links in the
  // accessibility tree that agents rely on.
  const anchors = root.querySelectorAll('a');
  const deadAnchors = anchors.filter((a) => {
    const href = (a.getAttribute('href') || '').trim();
    return !href || href === '#' || href.toLowerCase().startsWith('javascript:');
  });
  const buttonCount = root.querySelectorAll('button').length;
  const controlsCheck: Check = {
    id: 'semantic-controls',
    label: 'Links and buttons are real interactive elements',
    weight: 2,
    status: deadAnchors.length === 0 ? 'pass' : deadAnchors.length <= 3 ? 'warn' : 'fail',
    detail:
      `${anchors.length} link(s) and ${buttonCount} <button> element(s) found; ` +
      (deadAnchors.length === 0
        ? 'every <a> has a real destination.'
        : `${deadAnchors.length} <a> tag(s) have no usable href (empty, "#" or javascript:).`),
    fix:
      'Use <a href> for navigation and <button> for actions, not <div>/<span>. ' +
      'Agents recognise native elements as interactive; placeholder anchors are not.',
  };

  // Form fields need a programmatic name to appear in the accessibility tree.
  const labelEls = root.querySelectorAll('label');
  const labelFor = new Set<string>();
  const wrappedFields = new Set<HTMLElement>();
  for (const l of labelEls) {
    const f = (l.getAttribute('for') || '').trim();
    if (f) labelFor.add(f);
    for (const c of l.querySelectorAll('input, select, textarea')) wrappedFields.add(c);
  }
  const SKIP_INPUT = ['hidden', 'submit', 'button', 'image', 'reset'];
  const fields = root
    .querySelectorAll('input, select, textarea')
    .filter((el) => !SKIP_INPUT.includes((el.getAttribute('type') || '').toLowerCase()));
  const unlabelledFields = fields.filter((el) => {
    if ((el.getAttribute('aria-label') || '').trim()) return false;
    if ((el.getAttribute('aria-labelledby') || '').trim()) return false;
    const id = (el.getAttribute('id') || '').trim();
    if (id && labelFor.has(id)) return false;
    return !wrappedFields.has(el);
  });
  const labelCheck: Check = {
    id: 'form-labels',
    label: 'Form fields have associated labels',
    weight: 1,
    status:
      fields.length === 0 || unlabelledFields.length === 0
        ? 'pass'
        : unlabelledFields.length <= 2
          ? 'warn'
          : 'fail',
    detail:
      fields.length === 0
        ? 'No form fields on this page.'
        : unlabelledFields.length === 0
          ? `All ${fields.length} form field(s) carry a label, aria-label or aria-labelledby.`
          : `${unlabelledFields.length} of ${fields.length} form field(s) have no associated label.`,
    fix:
      'Tie every input to a <label for> (or give it an aria-label). Without a ' +
      'name, an agent cannot tell what a field is for.',
  };

  const images = root.querySelectorAll('img');
  const noAltImages = images.filter((img) => img.getAttribute('alt') == null);
  const altCheck: Check = {
    id: 'image-alt',
    label: 'Images carry alt text',
    weight: 1,
    status:
      images.length === 0 || noAltImages.length === 0
        ? 'pass'
        : noAltImages.length <= 3
          ? 'warn'
          : 'fail',
    detail:
      images.length === 0
        ? 'No <img> elements on this page.'
        : noAltImages.length === 0
          ? `All ${images.length} image(s) have an alt attribute.`
          : `${noAltImages.length} of ${images.length} image(s) have no alt attribute.`,
    fix:
      'Give every <img> an alt attribute (use alt="" for purely decorative ' +
      'images). Alt text is the name an agent sees in the accessibility tree.',
  };

  const agentCategory: Category = {
    id: 'agent',
    title: 'Agent readiness',
    blurb:
      'Whether AI browser agents — which read the DOM and accessibility tree — can perceive and operate the page.',
    checks: [landmarkCheck, controlsCheck, labelCheck, altCheck],
    score: 0,
  };
  agentCategory.score = scoreOf(agentCategory.checks);

  /* --- Overall --- */

  const categories = [crawlCategory, schemaCategory, contentCategory, agentCategory];
  const allChecks = categories.flatMap((c) => c.checks);
  const score = scoreOf(allChecks);
  const band: AuditResult['band'] = score >= 75 ? 'strong' : score >= 50 ? 'fair' : 'weak';

  const failCount = allChecks.filter((c) => c.status === 'fail').length;
  const summary =
    band === 'strong'
      ? 'Strong AI visibility. A few refinements would push it further.'
      : band === 'fair'
        ? `Decent foundation, but ${failCount} issue(s) are holding back how AI engines read this site.`
        : `Significant gaps — ${failCount} issue(s) make this site hard for AI answer engines to read and cite.`;

  return {
    url: page.finalUrl || url,
    fetchedAt: new Date().toISOString(),
    score,
    band,
    summary,
    categories,
  };
}
