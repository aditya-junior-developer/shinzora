/* ==========================================================================
   Shinzora — production-like front door for performance measurements
   --------------------------------------------------------------------------
   The local dev server is a plain static server: no compression and none of
   the cache headers in vercel.json. Vercel applies both to every static file,
   so a fair measurement needs them too. This proxy sits in front of the dev
   server and adds, exactly as production does:

     • the header rules from vercel.json (read at startup, so an edit to that
       file is what gets measured)
     • Brotli (or gzip) for text responses — Vercel compresses these at the edge
     • a content ETag, answering If-None-Match with 304

   It changes nothing on disk and never touches application code.

     node tests/perf/proxy.mjs [--port 4180] [--upstream http://127.0.0.1:4173]
   ========================================================================== */

import http from "node:http";
import zlib from "node:zlib";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const PORT = Number(arg("--port", "4180"));
const UPSTREAM = new URL(arg("--upstream", "http://127.0.0.1:4173"));

const vercel = JSON.parse(fs.readFileSync(path.join(repo, "vercel.json"), "utf8"));
const RULES = (vercel.headers || []).map((rule) => ({
  test: new RegExp("^" + rule.source.replace(/\((\.\*)\)/g, "(.*)").replace(/\//g, "\\/") + "$"),
  headers: Object.fromEntries(rule.headers.map((h) => [h.key.toLowerCase(), h.value]))
}));

const COMPRESSIBLE = /^(text\/|application\/(javascript|json|manifest|xml)|image\/svg\+xml)/;
const cache = new Map();

function headersFor(pathname) {
  const out = {};
  for (const rule of RULES) if (rule.test.test(pathname)) Object.assign(out, rule.headers);
  return out;
}

const server = http.createServer((req, res) => {
  const upstreamReq = http.request(
    {
      host: UPSTREAM.hostname,
      port: UPSTREAM.port,
      path: req.url,
      method: req.method,
      headers: { host: UPSTREAM.host, "user-agent": req.headers["user-agent"] || "" }
    },
    (up) => {
      const chunks = [];
      up.on("data", (c) => chunks.push(c));
      up.on("end", () => {
        const pathname = new URL(req.url, "http://x").pathname;
        const type = String(up.headers["content-type"] || "");
        let body = Buffer.concat(chunks);
        const status = up.statusCode || 200;
        const headers = { ...headersFor(pathname) };
        for (const [key, value] of Object.entries(up.headers)) {
          if (["content-length", "transfer-encoding", "connection", "content-encoding", "cache-control", "etag", "last-modified"].includes(key)) continue;
          headers[key] = value;
        }
        if (!headers["cache-control"]) headers["cache-control"] = "public, max-age=0, must-revalidate";

        if (status === 200 && body.length) {
          const etag = `"${crypto.createHash("sha1").update(body).digest("base64url").slice(0, 27)}"`;
          headers.etag = etag;
          if (req.headers["if-none-match"] === etag) {
            res.writeHead(304, headers);
            return res.end();
          }
          if (COMPRESSIBLE.test(type) && body.length > 512) {
            const accepts = String(req.headers["accept-encoding"] || "");
            const encoding = /\bbr\b/.test(accepts) ? "br" : /\bgzip\b/.test(accepts) ? "gzip" : null;
            if (encoding) {
              const key = `${pathname}|${encoding}|${etag}`;
              if (!cache.has(key)) {
                cache.set(
                  key,
                  encoding === "br"
                    ? zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
                    : zlib.gzipSync(body, { level: 6 })
                );
              }
              body = cache.get(key);
              headers["content-encoding"] = encoding;
              headers.vary = "Accept-Encoding";
            }
          }
        }
        if (req.method !== "HEAD") headers["content-length"] = body.length;
        res.writeHead(status, headers);
        res.end(req.method === "HEAD" ? undefined : body);
      });
    }
  );
  upstreamReq.on("error", (error) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`upstream unavailable: ${error.message}`);
  });
  req.pipe(upstreamReq);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`perf proxy on http://127.0.0.1:${PORT} → ${UPSTREAM.origin} (${RULES.length} header rules)`);
});
