// Retries a call that may hit a free-tier rate limit (HTTP 429 / RESOURCE_EXHAUSTED), waiting `waitMs`
// between attempts. Other errors are thrown at once.
export async function retryOnRateLimit<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; waitMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const waitMs = opts.waitMs ?? 35_000;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (i >= attempts || !/429|RESOURCE_EXHAUSTED/.test(message)) throw err;
      console.warn(`  rate limited (attempt ${i}/${attempts}); retrying in ${Math.round(waitMs / 1000)} s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
