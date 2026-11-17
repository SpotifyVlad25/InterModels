export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/probe") {
      return new Response("Not found", { status: 404 });
    }

    async function check(label, token) {
      if (!token) return { label, result: "MISSING_TOKEN" };
      const started = Date.now();
      try {
        const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
          method: "GET",
          signal: AbortSignal.timeout(12000)
        });
        let body = null;
        try { body = await response.json(); } catch {}
        return {
          label,
          httpStatus: response.status,
          elapsedMs: Date.now() - started,
          telegramOk: body?.ok ?? null,
          errorCode: body?.error_code ?? null,
          description: body?.description ?? null,
          username: body?.result?.username ?? null
        };
      } catch (error) {
        return {
          label,
          result: error?.name === "TimeoutError" || error?.name === "AbortError" ? "TIMEOUT" : "FETCH_ERROR",
          elapsedMs: Date.now() - started,
          errorName: error?.name ?? "unknown"
        };
      }
    }

    const results = await Promise.all([
      check("model", env.MODEL_BOT_TOKEN),
      check("director-control", env.DIRECTOR_BOT_TOKEN)
    ]);
    return Response.json({
      probe: "Cloudflare Worker outbound Telegram Bot API test",
      timestamp: new Date().toISOString(),
      results
    }, {
      headers: { "cache-control": "no-store" }
    });
  }
};
