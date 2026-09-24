import { NextRequest, NextResponse } from "next/server";
import { generateDreamHouseImage } from "@/lib/ai/image-service";
import { getAiConfig } from "@/lib/ai/config";

export const runtime = "nodejs";

/**
 * Floorplan-edit has a deliberately small contract: exactly one source image
 * and the user's instruction. It is independent from Pascal scene data.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const allowedBodyKeys = new Set(["sourceImage", "instruction"]);
    const unexpectedBodyKey = Object.keys(body || {}).find((key) => !allowedBodyKeys.has(key));
    if (unexpectedBodyKey) {
      return NextResponse.json(
        {
          error: "户型图片编辑只接受当前图片和用户修改文字。",
          field: unexpectedBodyKey,
        },
        { status: 400 },
      );
    }
    if (!String(body?.sourceImage || "")) {
      return NextResponse.json(
        { error: "SOURCE_FLOOR_PLAN_REQUIRED" },
        { status: 400 },
      );
    }
    if (!/^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(String(body.sourceImage))) {
      return NextResponse.json(
        { error: "SOURCE_FLOOR_PLAN_INVALID" },
        { status: 400 },
      );
    }
    const instruction = String(body?.instruction || "").trim();
    if (!instruction) return NextResponse.json({ error: "USER_INSTRUCTION_REQUIRED" }, { status: 400 });
    const image = await generateDreamHouseImage({
      mode: "floorplan-edit",
      originalFloorplan: String(body.sourceImage),
      userPrompt: instruction,
    });
    console.info("[DreamHouse][floorplan-edit]", {
      taskType: "floor_plan_edit",
      promptLength: instruction.length,
      inputImageCount: 1,
      pascalInput: false,
    });
    return NextResponse.json({
      image,
      mode: "floorplan-edit",
      prompt: instruction,
    });
  } catch (error: any) {
    const c = getAiConfig();
    return NextResponse.json(
      {
        error: error?.message || "floorplan_image_failed",
        stage: "floorplan-image",
        provider: "qwen",
        model: c.imageModel,
        status: error?.status,
      },
      { status: error?.status || 502 },
    );
  }
}
