// Audit engine: deterministic checks for how visible a site is to AI answer
// engines (ChatGPT, Perplexity, Google AI Overviews, Copilot, ...).
//
// v1 is fully deterministic — it fetches the page, robots.txt, llms.txt and
// sitemap, then inspects markup. No external API keys. Live "does an LLM
// actually know this brand" testing is a planned paid-tier feature.

import { parse, type HTMLElement } from 'node-html-parser';

export type CheckStatus = 'pass' | 'warn' | 'fail';

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
  const total = checks.reduce((s, c) => s + c.weight, 0);
  if (total === 0) return 0;
  const got = checks.reduce((s, c) => s + earned(c), 0);
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

  const llmsOk = llmsR.status === 'fulfilled' && llmsR.value.ok && llmsR.value.text.trim().length > 0;
  const llmsCheck: Check = {
    id: 'llms-txt',
    label: 'llms.txt guide for AI engines',
    weight: 1,
    status: llmsOk ? 'pass' : 'warn',
    detail: llmsOk
      ? 'Found /llms.txt — a curated map of your key content for AI engines.'
      : 'No /llms.txt found.',
    fix:
      'Add an /llms.txt file: a short Markdown index of your most important pages. ' +
      'It is an emerging standard that helps AI engines find and prioritise your best content.',
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
    checks: [crawlerCheck, llmsCheck, sitemapCheck],
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

  /* --- Overall --- */

  const categories = [crawlCategory, schemaCategory, contentCategory];
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
