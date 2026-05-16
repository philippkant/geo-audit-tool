import type { APIRoute } from 'astro';
import { runAudit, normalizeUrl } from '../../lib/audit';

export const prerender = false;

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
  }

  const input =
    body && typeof body === 'object' && 'url' in body && typeof (body as Record<string, unknown>).url === 'string'
      ? ((body as Record<string, unknown>).url as string)
      : '';

  let url: string;
  try {
    url = normalizeUrl(input);
  } catch (err) {
    return json({ error: (err as Error).message }, 400);
  }

  try {
    const result = await runAudit(url);
    return json(result, 200);
  } catch (err) {
    const message =
      err instanceof Error && err.message
        ? err.message
        : 'Could not audit that site. Try again.';
    return json({ error: message }, 502);
  }
};

// Reject other verbs cleanly.
export const ALL: APIRoute = () => json({ error: 'Use POST to run an audit.' }, 405);
