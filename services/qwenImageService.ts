export async function generateInterior(input: {
  image: string;
  prompt: string;
  styleId: string;
  roomType?: string;
  roomName?: string;
  captureId?: string;
  camera?: unknown;
  sessionId?: string;
  sceneRevision?: number;
  signal?: AbortSignal;
}) {
  if (!/^data:image\/(?:png|jpeg|jpg);base64,/i.test(input.image || "") || input.image.length < 1000) {
    throw new Error("装修生成需要有效的3D视角图片");
  }
  if (!input.styleId || !input.prompt.trim()) {
    throw new Error("装修生成需要有效的装修风格和提示词");
  }
  console.info("[Interior Generation Request]", {
    hasImage: Boolean(input.image),
    imagePrefix: input.image.slice(0, 30),
    imageLength: input.image.length,
    captureId: input.captureId,
    selectedStyleId: input.styleId,
    roomType: input.roomType,
    roomName: input.roomName,
    promptLength: input.prompt.length,
  });
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch("/api/ai/render-view", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: input.sessionId,
          sceneRevision: input.sceneRevision,
          captureId: input.captureId,
          camera: input.camera,
          sourceImage: input.image,
          styleId: input.styleId,
          roomType: input.roomType,
          roomName: input.roomName,
        }),
        signal: input.signal,
      });
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(data?.error || "装修效果暂时没有生成完成") as Error & { status?: number };
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const status = (lastError as Error & { status?: number }).status;
      console.error("[Interior Generation Failed]", {
        attempt: attempt + 1,
        status,
        message: lastError.message,
        captureId: input.captureId,
        selectedStyleId: input.styleId,
      });
      const retryable = !status || status === 408 || status === 425 || status === 429 || status >= 500;
      if (attempt === 0 && retryable && !input.signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 600));
      else if (!retryable) break;
    }
  }
  throw lastError || new Error("装修效果暂时没有生成完成");
}
