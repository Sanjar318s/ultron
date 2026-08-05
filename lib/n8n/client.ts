/**
 * Minimal n8n webhook client (server-side, native fetch — no axios in repo).
 * POSTs the payload with the shared secret header, 10s timeout, capped body.
 */

export interface N8nWebhookResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

const SECRET_HEADER = "X-Ultron-Secret";
const MAX_BODY = 64 * 1024;

export async function triggerN8nWebhook(
  webhookUrl: string,
  payload: Record<string, unknown>,
): Promise<N8nWebhookResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = process.env.N8N_SHARED_SECRET?.trim();
  if (secret) headers[SECRET_HEADER] = secret;
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.text()).slice(0, MAX_BODY);
    if (!res.ok) {
      return { success: false, error: `n8n ответил ${res.status}${body ? `: ${body}` : ""}` };
    }
    let data: unknown;
    try {
      data = body ? JSON.parse(body) : null;
    } catch {
      data = body;
    }
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
