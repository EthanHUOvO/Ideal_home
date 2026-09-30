import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

const port = Number(process.env.LOCAL_IMAGE_PORT || 8200);
const binary = process.env.SD_CPP_BIN || "/usr/local/bin/sd-cli";
const diffusionModel = process.env.SD_DIFFUSION_MODEL || "/models/z_image_turbo-Q8_0.gguf";
const textEncoder = process.env.SD_TEXT_ENCODER || "/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf";
const vae = process.env.SD_VAE || "/models/ae.safetensors";
const outputDirectory = process.env.GENERATED_IMAGE_DIR || "/data/generated";
const temporaryDirectory = process.env.SD_TMP_DIR || "/tmp/sd-image-jobs";
const timeoutMs = Number(process.env.SD_JOB_TIMEOUT_MS || 1_800_000);
let queue = Promise.resolve();

function json(res: any, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
async function readJson(req: any) {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) { const b = Buffer.from(chunk); length += b.length; if (length > 25 * 1024 * 1024) throw new Error("request body exceeds 25MB"); chunks.push(b); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function parseSize(value: unknown) {
  const m = String(value || "512*512").match(/^(\d+)[*xX,](\d+)$/);
  const round = (n: number) => Math.max(256, Math.min(2048, Math.round(n / 32) * 32));
  return m ? [round(Number(m[1])), round(Number(m[2]))] : [512, 512];
}
async function runProcess(args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout = (stdout + c).slice(-16000); }); child.stderr.on("data", c => { stderr = (stderr + c).slice(-16000); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`sd.cpp job timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("exit", code => { clearTimeout(timer); code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`sd.cpp exited ${code}: ${(stderr || stdout).slice(-4000)}`)); });
  });
}
async function generate(body: any) {
  if (!String(body.prompt || "").trim()) throw new Error("prompt is required");
  const id = randomUUID(), dir = join(temporaryDirectory, id); await mkdir(dir, { recursive: true }); await mkdir(outputDirectory, { recursive: true });
  const [width, height] = parseSize(body.size); const outputName = `${id}.png`; const outputPath = join(outputDirectory, outputName);
  try {
    const args = ["--diffusion-model", diffusionModel, "--vae", vae, "--llm", textEncoder, "-p", String(body.prompt), "--cfg-scale", String(Number(body.guidanceScale) || 1), "--steps", String(Number(body.steps) || 8), "-H", String(height), "-W", String(width), "-o", outputPath, "--diffusion-fa"];
    const sourceImage = Array.isArray(body.images) ? body.images.find((value: unknown) => typeof value === "string" && value.startsWith("data:image/")) : undefined;
    if (sourceImage) {
      const match = String(sourceImage).match(/^data:image\/[^;]+;base64,(.*)$/s);
      if (!match) throw new Error("invalid source image data URL");
      const initPath = join(dir, "init-image");
      await writeFile(initPath, Buffer.from(match[1], "base64"));
      const editStrength = String(body.mode || "") === "floorplan-edit" ? 0.2 : 0.28;
      args.push("--init-img", initPath, "--strength", String(editStrength), "--img-cfg-scale", "1");
    }
    if (body.negativePrompt) args.push("--negative-prompt", String(body.negativePrompt));
    if (Number.isInteger(body.seed)) args.push("--seed", String(body.seed));
    const startedAt = Date.now(); const logs = await runProcess(args); const details = await stat(outputPath);
    return { requestId: id, model: "Z-Image-Turbo", url: `/api/generated-images/${outputName}`, width, height, elapsedMs: Date.now() - startedAt, usage: { backend: "stable-diffusion.cpp-vulkan", steps: Number(body.steps) || 8, bytes: details.size }, logs: process.env.LOCAL_AI_DEBUG === "true" ? logs : undefined };
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}
async function health() {
  const files = [diffusionModel, textEncoder, vae]; const missingModelFiles: string[] = [];
  await Promise.all(files.map(async f => { try { const s = await stat(f); if (!s.isFile() || s.size === 0) missingModelFiles.push(f); } catch { missingModelFiles.push(f); } }));
  const binaryReady = await access(binary, constants.X_OK).then(() => true, () => false); const dev = "/dev/dri/renderD128"; const deviceAccessible = await access(dev, constants.R_OK | constants.W_OK).then(() => true, () => false);
  return { ok: binaryReady && deviceAccessible && missingModelFiles.length === 0, service: "stable-diffusion.cpp", model: "Z-Image-Turbo", backend: "vulkan", binary, binaryReady, models: { diffusionModel, textEncoder, vae, missingModelFiles }, vulkanDevice: dev, vulkanDeviceAccessible: deviceAccessible };
}
const server = createServer(async (req, res) => {
  try { if (req.method === "GET" && req.url === "/health") { const s = await health(); json(res, s.ok ? 200 : 503, s); return; }
    if (req.method !== "POST" || req.url !== "/v1/images/generations") { json(res, 404, { error: "not found" }); return; }
    const job = queue.then(async () => generate(await readJson(req))); queue = job.then(() => undefined, () => undefined); json(res, 200, await job);
  } catch (e: any) { console.error("[stable-diffusion.cpp]", e); json(res, 503, { error: e?.message || String(e) }); }
});
server.listen(port, "0.0.0.0", () => console.log(`stable-diffusion.cpp Vulkan service listening on :${port}`));
