import { NextRequest, NextResponse } from "next/server";
import { generateDreamHouseImage } from "@/lib/ai/image-service";
import { getAiConfig } from "@/lib/ai/config";
import { INTERIOR_STYLE_PRESETS } from "@/config/interiorStyles";
import { inferRoomType, ROOM_TYPE_PROMPTS, type RoomType } from "@/config/roomTypes";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const sourceImage = String(b?.sourceImage || b?.screenshotDataUrl || "");
    if (!sourceImage)
      return NextResponse.json(
        { error: "SOURCE_IMAGE_REQUIRED", message: "sourceImage is required" },
        { status: 400 },
      );
    if (!/^data:image\/(?:png|jpeg|jpg);base64,/i.test(sourceImage) || sourceImage.length < 1000)
      return NextResponse.json(
        { error: "SOURCE_IMAGE_INVALID", message: "请重新拍摄有效的PNG或JPEG视角图片" },
        { status: 400 },
      );
    const styleId = String(b?.styleId || "");
    if (!(styleId in INTERIOR_STYLE_PRESETS))
      return NextResponse.json(
        { error: "INVALID_STYLE", message: "请选择有效的装修风格" },
        { status: 400 },
      );
    const roomName = String(b?.roomName || "").trim();
    const requestedRoomType = String(b?.roomType || "");
    const roomType = (requestedRoomType in ROOM_TYPE_PROMPTS
      ? requestedRoomType
      : inferRoomType(roomName)) as RoomType;
    const stylePrompt = INTERIOR_STYLE_PRESETS[styleId as keyof typeof INTERIOR_STYLE_PRESETS].prompt;
    const config = getAiConfig();
    const imageModel = process.env.QWEN_INTERIOR_IMAGE_MODEL || config.imageModel;
    console.info("[INTERIOR I2I REQUEST]", {
      roomType,
      roomName,
      styleId,
      hasSourceImage: true,
      imageCount: 1,
      textCount: 1,
      mode: "I2I",
    });
    const image = await generateDreamHouseImage({
      mode: "walkthrough-render",
      pascalScreenshot: sourceImage,
      roomName,
      roomType,
      stylePrompt,
      // Keep the model configurable in one place. The old hard-coded
      // qwen-image-3 identifier caused DashScope to return Model not exist.
      imageModel,
      // Let image-service derive a same-aspect output size from the capture.
      size: process.env.QWEN_IMAGE_SIZE || undefined,
    });
    return NextResponse.json({
      sessionId: b.sessionId,
      sourceSceneRevision: b.sceneRevision,
      roomId: b.roomId,
      roomName: b.roomName,
      captureId: b.captureId,
      camera: b.camera,
      roomType,
      styleId,
      image,
    });
  } catch (e: any) {
    const c = getAiConfig();
    console.error("[Qwen Image API Error]", {
      status: e?.status,
      message: e?.message,
      stage: e?.stage || "render-view",
      model: process.env.QWEN_INTERIOR_IMAGE_MODEL || c.imageModel,
      apiKeyConfigured: Boolean(c.apiKey),
    });
    return NextResponse.json(
      {
        error: e?.message || "render-view failed",
        stage: "render-view",
        model: process.env.QWEN_INTERIOR_IMAGE_MODEL || c.imageModel,
        status: e?.status,
      },
      { status: e?.status || 502 },
    );
  }
}
