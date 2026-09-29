import { createServer } from "node:http";

const port = Number(process.env.LOCAL_AI_GATEWAY_PORT || 8300);
const textBaseUrl = (process.env.TEXT_UPSTREAM || "http://qwen-text:8080").replace(/\/$/, "");
const imageBaseUrl = (process.env.IMAGE_UPSTREAM || "http://qwen-image:8200").replace(/\/$/, "");
let queue = Promise.resolve();

async function readBody(req: any) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > 30 * 1024 * 1024) throw new Error("request body exceeds 30MB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function enqueue<T>(work: () => Promise<T>) {
  const job = queue.then(work, work);
  queue = job.then(() => undefined, () => undefined);
  return job;
}

async function proxy(req: any, res: any, upstream: string, path: string, serialized: boolean) {
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  const run = async () => {
    const startedAt = Date.now();
    const response = await fetch(`${upstream}${path}`, {
      method: req.method,
      headers: { "content-type": req.headers["content-type"] || "application/json" },
      body,
    });
    const payload = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, {
      "content-type": response.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
      "x-local-ai-elapsed-ms": String(Date.now() - startedAt),
      "x-local-ai-serialized": serialized ? "true" : "false",
    });
    res.end(payload);
  };
  await (serialized ? enqueue(run) : run());
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://local-ai-gateway");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, service: "local-ai-gateway", concurrency: 1 }));
      return;
    }
    if (url.pathname.startsWith("/text/")) {
      await proxy(req, res, textBaseUrl, url.pathname.slice(5) + url.search, req.method === "POST");
      return;
    }
    if (url.pathname.startsWith("/image/")) {
      await proxy(req, res, imageBaseUrl, url.pathname.slice(6) + url.search, req.method === "POST");
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (error: any) {
    console.error("[Local AI Gateway]", error);
    if (!res.headersSent) res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: error?.message || String(error) }));
  }
}).listen(port, "0.0.0.0", () => console.log(`Local AI gateway listening on :${port}`));
