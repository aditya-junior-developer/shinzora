/* ==========================================================================
   Shinzora — pre-launch file storage (server only)
   --------------------------------------------------------------------------
   Business logos (onboarding) and avatars (settings) are uploaded through
   supabase-js storage. While a pre-launch account is signed in those calls are
   routed here, so uploads genuinely work instead of failing with a 404:

     POST   /storage/v1/object/<bucket>/<path>        upload (binary body)
     GET    /storage/v1/object/public/<bucket>/<path> serve (public bucket)
     POST   /storage/v1/object/sign/<bucket>/<path>   signed URL
     DELETE /storage/v1/object/<bucket>/<path>        delete own upload
     GET    /storage/v1/object/list/<bucket>          list

   Files stay inside `.prelaunch/uploads/` — inside the pre-launch sandbox, never
   mixed with real customer assets. Uploads are size-capped and path-traversal
   safe; only image mime types are accepted because that is all the app uploads.
   ========================================================================== */

import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = /^image\/(png|jpeg|jpg|webp|svg\+xml|avif|gif)$/i;

export class StorageError extends Error {
  constructor(message, { status = 400, code = "storage_error" } = {}) {
    super(message);
    this.name = "StorageError";
    this.status = status;
    this.code = code;
  }
  toJSON() {
    return { error: this.message, code: this.code, message: this.message, statusCode: String(this.status) };
  }
}

function rootDir(root) {
  const base = process.env.PRELAUNCH_DATA_DIR ? path.resolve(process.env.PRELAUNCH_DATA_DIR) : path.join(root, ".prelaunch");
  return path.join(base, "uploads");
}

/** Reject absolute paths and ".." segments before touching the filesystem. */
function safePath(bucket, objectPath) {
  const cleanBucket = String(bucket || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!cleanBucket) throw new StorageError("Missing bucket.", { status: 400, code: "invalid_bucket" });
  const segments = String(objectPath || "")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, "_"));
  if (!segments.length) throw new StorageError("Missing object path.", { status: 400, code: "invalid_path" });
  return { bucket: cleanBucket, segments, relative: path.join(cleanBucket, ...segments) };
}

async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new StorageError("File is larger than the 5 MB pre-launch limit.", { status: 413, code: "too_large" });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Minimal multipart/form-data reader: returns the first file part's bytes and
 * the content type that part declared. Header values are read as latin1, and the
 * part body is sliced from the original buffer so binary data is never mangled.
 */
function parseMultipart(buffer, contentTypeHeader) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentTypeHeader);
  const boundary = match ? (match[1] || match[2]).trim() : null;
  if (!boundary) return null;

  const delimiter = Buffer.from(`--${boundary}`);
  let index = buffer.indexOf(delimiter);
  while (index !== -1) {
    const next = buffer.indexOf(delimiter, index + delimiter.length);
    if (next === -1) break;
    const part = buffer.subarray(index + delimiter.length, next);
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString("latin1");
      const isFile = /filename=/i.test(headers);
      if (isFile) {
        const typeMatch = /content-type:\s*([^\r\n;]+)/i.exec(headers);
        return {
          contentType: (typeMatch ? typeMatch[1] : "").trim().toLowerCase(),
          /* strip the CRLF that precedes the next boundary */
          bytes: part.subarray(headerEnd + 4, part.length - 2)
        };
      }
    }
    index = next;
  }
  return null;
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".gif": "image/gif"
};

/**
 * @returns {Promise<boolean>} true when the request was a storage request
 */
export async function handleStorage({ req, res, root, url }) {
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/prelaunch/storage/v1/")) return false;

  const rest = pathname.slice("/api/prelaunch/storage/v1/".length);
  const method = (req.method || "GET").toUpperCase();

  try {
    /* ---------------------------------------------------------- public read */
    if (rest.startsWith("object/public/") && (method === "GET" || method === "HEAD")) {
      const [, , bucket, ...segments] = rest.split("/");
      const target = safePath(bucket, segments.join("/"));
      const file = path.join(rootDir(root), target.relative);
      if (!fs.existsSync(file)) throw new StorageError("File not found.", { status: 404, code: "not_found" });
      const stat = fs.statSync(file);
      res.writeHead(200, {
        "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "content-length": String(stat.size),
        "cache-control": "public, max-age=3600"
      });
      if (method === "HEAD") res.end();
      else res.end(fs.readFileSync(file));
      return true;
    }

    /* ------------------------------------------------------------- upload */
    if (rest.startsWith("object/") && !rest.startsWith("object/public/") && !rest.startsWith("object/sign/") && method === "POST") {
      const body = await readRaw(req);
      if (!body.length) throw new StorageError("Empty upload.", { status: 400, code: "empty" });

      /* supabase-js wraps a File in multipart/form-data; raw bodies are accepted
         too, because that is what the storage REST API allows. */
      const declared = String(req.headers["content-type"] || "");
      const parsed = declared.startsWith("multipart/form-data")
        ? parseMultipart(body, declared)
        : { bytes: body, contentType: declared.split(";")[0].trim() };

      if (!parsed || !parsed.bytes?.length) throw new StorageError("The uploaded file could not be read.", { status: 400, code: "unreadable" });
      if (parsed.contentType && !ALLOWED.test(parsed.contentType)) {
        throw new StorageError(`Unsupported file type: ${parsed.contentType}. Upload a PNG, JPEG, WebP, AVIF, GIF or SVG image.`, {
          status: 415,
          code: "unsupported_type"
        });
      }

      const [, bucket, ...segments] = rest.split("/");
      const target = safePath(bucket, segments.join("/"));
      const file = path.join(rootDir(root), target.relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, parsed.bytes);
      json(res, 200, { Key: `${target.bucket}/${segments.join("/")}` });
      return true;
    }

    /* --------------------------------------------------------- signed url */
    if (rest.startsWith("object/sign/") && method === "POST") {
      const [, , bucket, ...segments] = rest.split("/");
      const target = safePath(bucket, segments.join("/"));
      json(res, 200, { signedURL: `/api/prelaunch/storage/v1/object/public/${target.bucket}/${segments.join("/")}` });
      return true;
    }

    /* ------------------------------------------------------------- delete */
    if (rest.startsWith("object/") && method === "DELETE") {
      const [, bucket, ...segments] = rest.split("/");
      const target = safePath(bucket, segments.join("/"));
      const file = path.join(rootDir(root), target.relative);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      json(res, 200, { message: "Deleted" });
      return true;
    }

    /* --------------------------------------------------------------- list */
    if (rest.startsWith("object/list/") && (method === "POST" || method === "GET")) {
      const bucket = rest.slice("object/list/".length).split("/")[0];
      const target = safePath(bucket, ".");
      const dir = path.join(rootDir(root), target.bucket);
      const files = fs.existsSync(dir)
        ? fs.readdirSync(dir).map((name) => ({ name, id: name, updated_at: null, metadata: null }))
        : [];
      json(res, 200, files);
      return true;
    }

    throw new StorageError(`Storage route not supported: ${method} ${rest}`, { status: 404, code: "not_found" });
  } catch (error) {
    if (error instanceof StorageError) {
      json(res, error.status, error.toJSON());
      return true;
    }
    throw error;
  }
}

export default handleStorage;
