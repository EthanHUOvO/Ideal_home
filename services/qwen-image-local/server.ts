import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

const port = Number(process.env.LOCAL_IMAGE_PORT || 8200);
const binary = process.env.QWEN_IMAGE_BIN || "/opt/qwen-image/qwenimage-ncnn-vulkan";
const modelPath = process.env.QWEN_IMAGE_MODEL_PATH || "/models/qwenimage21";
const outputDirectory = process.env.GENERATED_IMAGE_DIR || "/data/generated";
const temporaryDirectory = process.env.QWEN_IMAGE_TMP_DIR || "/tmp/qwen-image-jobs";
const timeoutMs = Number(process.env.QWEN_IMAGE_JOB_TIMEOUT_MS || 900_000);
let queue = Promise.resolve();
const requiredModelFiles = [
  "processor/merges.txt",
  "processor/vocab.txt",
  "text_encoder/text_encoder.ncnn.bin",
  "text_encoder/text_encoder.ncnn.param",
  "transformer/blocks.ncnn.bin",
  "transformer/blocks.ncnn.param",
  "transformer/input.ncnn.bin",
  "transformer/input.ncnn.param",
  "transformer/output.ncnn.bin",
  "transformer/output.ncnn.param",
  "vae/decoder.ncnn.bin",
  "vae/decoder.ncnn.param",
  "vae/encoder.ncnn.bin",
  "vae/encoder.ncnn.param",
  "vision/vision_encoder.ncnn.bin",
  "vision/vision_encoder.ncnn.param",
  "vision/vision_pos_embed.f32",
];

function json(res: any, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

async function readJson(req: any) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > 25 * 1024 * 1024) throw new Error("request body exceeds 25MB");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function parseSize(value: unknown) {
  const match = String(value || "1024*1024").match(/^(\d+)[*xX,](\d+)$/);
  const round = (number: number) => Math.max(512, Math.min(1536, Math.round(number / 32) * 32));
  return match ? [round(Number(match[1])), round(Number(match[2]))] : [1024, 1024];
}

function decodeDataUrl(value: string) {
  const match = value.match(/^data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) throw new Error("local image service accepts base64 image data URLs only");
  return Buffer.from(match[1], "base64");
}

async function runProcess(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-12_000); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-12_000); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Qwen Image job timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`qwenimage-ncnn-vulkan exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function generate(body: any) {
  if (!String(body.prompt || "").trim()) throw new Error("prompt is required");
  const requestId = randomUUID();
  const jobDirectory = join(temporaryDirectory, requestId);
  await mkdir(jobDirectory, { recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  const outputName = `${requestId}.png`;
  const outputPath = join(outputDirectory, outputName);
  try {
    const references: string[] = [];
    for (const [index, image] of (Array.isArray(body.images) ? body.images : []).slice(0, 3).entries()) {
      const path = join(jobDirectory, `reference-${index + 1}.png`);
      await writeFile(path, decodeDataUrl(String(image)));
      references.push(path);
    }
    const [width, height] = parseSize(body.size);
    const args = ["-m", modelPath, "-g", "0", "-p", String(body.prompt), "-s", `${width},${height}`, "-l", String(Number(body.steps) || 40), "-w", String(Number(body.guidanceScale) || 1), "-o", outputPath];
    if (body.negativePrompt) args.push("-n", String(body.negativePrompt));
    if (Number.isInteger(body.seed)) args.push("-r", String(body.seed));
    for (const reference of references) args.push("-i", reference);
    const startedAt = Date.now();
    const logs = await runProcess(binary, args);
    return {
      requestId,
      model: "Qwen-Image-2.1",
      url: `/api/generated-images/${outputName}`,
      width,
      height,
      elapsedMs: Date.now() - startedAt,
      usage: { backend: "ncnn-vulkan", gpu: 0, steps: Number(body.steps) || 40 },
      logs: process.env.LOCAL_AI_DEBUG === "true" ? logs : undefined,
    };
  } finally {
    await rm(jobDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function health() {
  const missingModelFiles: string[] = [];
  await Promise.all(requiredModelFiles.map(async (file) => {
    try {
      const details = await stat(join(modelPath, file));
      if (!details.isFile() || details.size === 0) missingModelFiles.push(file);
    } catch {
      missingModelFiles.push(file);
    }
  }));
  const binaryReady = await access(binary, constants.X_OK).then(() => true, () => false);
  const vulkanDevice = "/dev/dri/renderD128";
  const vulkanReady = await access(vulkanDevice, constants.R_OK | constants.W_OK).then(() => true, () => false);
  return {
    ok: binaryReady && vulkanReady && missingModelFiles.length === 0,
    service: "qwen-image-ncnn-vulkan",
    model: "Qwen-Image-2.1",
    backend: "vulkan",
    binary,
    binaryReady,
    modelPath,
    modelFilesPresent: requiredModelFiles.length - missingModelFiles.length,
    modelFilesRequired: requiredModelFiles.length,
    missingModelFiles: missingModelFiles.sort(),
    vulkanDevice,
    vulkanReady,
  };
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      const status = await health();
      json(res, status.ok ? 200 : 503, status);
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/images/generations") {
      json(res, 404, { error: "not found" });
      return;
    }
    const body = await readJson(req);
    const job = queue.then(() => generate(body));
    queue = job.then(() => undefined, () => undefined);
    json(res, 200, await job);
  } catch (error: any) {
    console.error("[Local Qwen Image]", error);
    json(res, 503, { error: error?.message || String(error) });
  }
});

server.listen(port, "0.0.0.0", () => console.log(`Local Qwen Image service listening on :${port}`));
