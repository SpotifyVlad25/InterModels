import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";

const port = Number(process.env.PORT || 8080);
const token = process.env.COMPOSITE_RENDERER_TOKEN || "";
const maxBodyBytes = Number(process.env.MAX_RENDER_BODY_BYTES || 48 * 1024 * 1024);
const maxSvgCharacters = Number(process.env.MAX_SVG_CHARACTERS || 44 * 1024 * 1024);
const maxFontBytes = Number(process.env.MAX_FONT_BYTES || 4 * 1024 * 1024);
const maxPngBytes = Number(process.env.MAX_PNG_BYTES || 20 * 1024 * 1024);

function authorized(header) {
  if (!token || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function decodeFont(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Invalid font payload");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 4 || bytes.length > maxFontBytes) throw new Error("Font size is invalid");
  return new Uint8Array(bytes);
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, token ? 200 : 503, { ok: Boolean(token), service: "intermodels-composite-renderer" });
  }
  if (req.method !== "POST" || req.url !== "/render") {
    return sendJson(res, 404, { error: "Not found" });
  }
  if (!authorized(req.headers.authorization)) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }

  const startedAt = Date.now();
  try {
    if (!token) return sendJson(res, 503, { error: "Renderer token is not configured" });
    const raw = await readBody(req);
    let payload;
    try { payload = JSON.parse(raw); } catch { return sendJson(res, 400, { error: "Invalid JSON" }); }
    if (!payload || typeof payload.svg !== "string" || payload.svg.length < 100 || payload.svg.length > maxSvgCharacters) {
      return sendJson(res, 400, { error: "SVG payload is invalid or too large" });
    }
    if (!Array.isArray(payload.fonts) || payload.fonts.length !== 2) {
      return sendJson(res, 400, { error: "Exactly two font buffers are required" });
    }
    const fontBuffers = payload.fonts.map(decodeFont);
    if (!payload.svg.trimStart().startsWith("<svg")) return sendJson(res, 400, { error: "SVG root element is missing" });

    const renderer = new Resvg(payload.svg, {
      font: { fontBuffers, defaultFontFamily: "Roboto", loadSystemFonts: false },
    });
    try {
      const png = renderer.render().asPng();
      if (!png.length || png.length > maxPngBytes) return sendJson(res, 413, { error: "Rendered PNG exceeds the configured limit" });
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(png.length),
        "cache-control": "no-store",
        "x-render-duration-ms": String(Date.now() - startedAt),
      });
      res.end(Buffer.from(png));
      console.info("Composite rendered", { durationMs: Date.now() - startedAt, svgCharacters: payload.svg.length, pngBytes: png.length });
    }
  } catch (error) {
    const status = Number(error?.status) || 500;
    console.error("Composite render failed", { status, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) });
    if (!res.headersSent) {
      sendJson(res, status, { error: status === 413 ? "Request body too large" : "Composite rendering failed" });
    } else if (!res.writableEnded) {
      res.destroy(error instanceof Error ? error : undefined);
    }
  }
});

server.listen(port, "0.0.0.0", () => {
  console.info("InterModels composite renderer listening", { port, maxBodyBytes, maxPngBytes });
});
