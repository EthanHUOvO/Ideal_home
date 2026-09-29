import { NextRequest } from "next/server";
import { generatePascalSceneWithLocalQwen } from "@/lib/ai/local-model3d-agent";
import type { SceneGraph } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fallbackScene(source: SceneGraph, input: { sourceImageHash: string; sourceImage: string; reason: string }) {
  const scene = JSON.parse(JSON.stringify(source)) as SceneGraph;
  const building = scene.nodes.building_house || Object.values(scene.nodes).find((node) => node.type === "building");
  if (!building) throw new Error("Fallback Pascal scene has no building node");
  const metadata = (building.metadata ||= {});
  Object.assign(metadata, {
    floorplanSource: "fallback-prebuilt",
    sourceImageHash: input.sourceImageHash,
    sourceDrawing: input.sourceImage,
    fallbackReason: input.reason,
    model: "prebuilt-pascal-v2",
    scaleEstimated: false,
    generatedAt: new Date().toISOString(),
  });
  return scene;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!String(body?.sessionId || "") || !String(body?.sourceImageHash || "") || !/^data:image\//i.test(String(body?.sourceImageDataUrl || "")) || !body?.fallbackScene?.nodes)
    return Response.json({ error: "sessionId, sourceImageHash, sourceImageDataUrl, and fallbackScene are required" }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const emit = (type: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const close = () => { if (!closed) { closed = true; controller.close(); } };
      void (async () => {
        try {
          await generatePascalSceneWithLocalQwen({
            sessionId: String(body.sessionId),
            sourceImageHash: String(body.sourceImageHash),
            sourceImage: String(body.sourceImage || "confirmed-floorplan"),
            sourceImageDataUrl: String(body.sourceImageDataUrl),
            onEvent: (event) => emit(event.type, event),
          });
        } catch (error: any) {
          const reason = error?.message || String(error);
          console.error("[DreamHouse][model3d][local]", { sessionId: body.sessionId, reason });
          const scene = fallbackScene(body.fallbackScene, { sourceImageHash: String(body.sourceImageHash), sourceImage: String(body.sourceImage || "confirmed-floorplan"), reason });
          emit("fallback", { type: "fallback", reason, source: "fallback-prebuilt", scene });
        } finally {
          close();
        }
      })();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
