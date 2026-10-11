const UPSTREAM = "https://smart-expense-tracker-v3-production.up.railway.app";

export const config = {
  api: {
    bodyParser: false,
  },
};

function targetUrl(req) {
  const pathValue = req.query?.path;
  const segments = Array.isArray(pathValue)
    ? pathValue
    : pathValue
      ? [pathValue]
      : [];

  const sourceUrl = new URL(req.url || "/", "https://smart-expense.local");
  const encodedPath = segments.map((part) => encodeURIComponent(String(part))).join("/");
  return `${UPSTREAM}/api/${encodedPath}/${sourceUrl.search}`;
}

async function requestBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return undefined;

  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);

  if (req.body && typeof req.body === "object") {
    const contentType = String(req.headers["content-type"] || "");
    if (contentType.includes("application/json")) {
      return Buffer.from(JSON.stringify(req.body));
    }
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function forwardRequestHeaders(req) {
  const headers = new Headers();
  const allowed = [
    "accept",
    "accept-language",
    "authorization",
    "content-type",
    "cookie",
    "user-agent",
    "x-requested-with",
    "x-request-id",
  ];

  for (const name of allowed) {
    const value = req.headers[name];
    if (value) headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
  }

  headers.set("x-forwarded-host", String(req.headers.host || ""));
  headers.set("x-forwarded-proto", "https");
  return headers;
}

function copyResponseHeaders(upstream, res) {
  const blocked = new Set([
    "connection",
    "content-encoding",
    "content-length",
    "transfer-encoding",
  ]);

  upstream.headers.forEach((value, name) => {
    if (!blocked.has(name.toLowerCase()) && name.toLowerCase() !== "set-cookie") {
      res.setHeader(name, value);
    }
  });

  const cookies = typeof upstream.headers.getSetCookie === "function"
    ? upstream.headers.getSetCookie()
    : [];

  if (cookies.length) {
    res.setHeader("Set-Cookie", cookies);
  } else {
    const cookie = upstream.headers.get("set-cookie");
    if (cookie) res.setHeader("Set-Cookie", cookie);
  }

  res.setHeader("Cache-Control", "no-store, max-age=0");
}

export default async function handler(req, res) {
  try {
    const body = await requestBody(req);
    const upstream = await fetch(targetUrl(req), {
      method: req.method,
      headers: forwardRequestHeaders(req),
      body,
      redirect: "manual",
    });

    copyResponseHeaders(upstream, res);
    const payload = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = upstream.status;
    res.end(payload);
  } catch (error) {
    console.error("Smart Expense API proxy failed", error);
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ detail: "Backend temporarily unavailable." }));
  }
}
