import type { SceneGraph } from "../types";
import { getAiConfig } from "./config";
import { callPascalTool, listPascalTools, withPascalMcp } from "./pascal-mcp-client";
import { qwenChatCompletion } from "./qwen-client";

export type Model3DEvent =
  | { type: "started"; sessionId: string; model: string }
  | { type: "tool"; name: string; args: Record<string, unknown>; index: number; status: "started" | "complete" | "error"; result?: { revision: number; status: string; validation?: any }; error?: string }
  | { type: "scene"; stage: string; revision: number; scene: SceneGraph; validation?: any }
  | { type: "validation"; revision: number; validation: any }
  | { type: "complete"; result: any };

type GenerateInput = {
  sessionId: string;
  sourceImageHash: string;
  sourceImage: string;
  sourceImageDataUrl: string;
  onEvent?: (event: Model3DEvent) => void | Promise<void>;
};

type StructureWall = { id: string; start: [number, number]; end: [number, number] };

function normalizeOpeningArgs(args: Record<string, any>, walls: StructureWall[]) {
  const wallById = new Map(walls.map((wall) => [wall.id, wall]));
  const usedIds = new Set<string>();
  const normalize = (value: unknown, prefix: "door" | "window") =>
    (Array.isArray(value) ? value : []).flatMap((opening: any, index: number) => {
      const wallId = String(opening?.wallId || "");
      const wall = wallById.get(wallId);
      if (!wall) return [];
      const wallLength = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
      if (wallLength < 0.57) return [];
      const width = Math.min(
        Math.max(Number(opening?.width) || (prefix === "door" ? 0.86 : 1.2), 0.45),
        wallLength - 0.12,
      );
      const minimumCenter = width / 2 + 0.03;
      const maximumCenter = wallLength - width / 2 - 0.03;
      const requestedId = String(opening?.id || `${prefix}_${index + 1}`);
      let id = requestedId;
      for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${requestedId}_${suffix}`;
      usedIds.add(id);
      return [{
        ...opening,
        id,
        name: String(opening?.name || `${prefix === "door" ? "门" : "窗"}${index + 1}`),
        wallId,
        width,
        distance: Math.min(Math.max(Number(opening?.distance) || wallLength / 2, minimumCenter), maximumCenter),
      }];
    });
  return { ...args, doors: normalize(args.doors, "door"), windows: normalize(args.windows, "window") };
}

export async function generatePascalSceneWithLocalQwen(input: GenerateInput) {
  return withPascalMcp(async (mcp) => {
    const config = getAiConfig();
    const tools = await listPascalTools(mcp);
    const openAiTools = tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
    const system = `你是 DreamHouse 的户型图转 Pascal 3D Agent。你必须通过 MCP 工具创建真实 Pascal SceneGraph，不能只输出说明或 JSON。\n
执行顺序必须是 begin_floorplan_scene → set_floor_structure → set_openings → populate_basic_furniture → validate_scene → commit_scene。每轮只调用一个工具，并使用上一个工具返回的 revision。\n
从图片读取外轮廓、每一面墙、房间名称、门窗及相对位置。坐标单位必须为米，原点在户型左上角，x 向右，z 向下。图中有可信尺寸标注时 scaleMethod 使用 drawing-dimensions；否则以一个清晰普通门宽 0.86m 推算比例，并使用 standard-door-estimate。外轮廓墙标记 load_bearing，只有明确的室内隔墙标记 partition。不得虚构图片中不存在的房间。所有 opening 的 wallId 必须引用真实墙体，distance 是从 wall.start 到洞口中心的米数。validate_scene 失败时根据 issues 修正结构或开口，最多两轮；只有校验成功后才能 commit_scene。`;
    const messages: any[] = [
      { role: "system", content: system },
      { role: "user", content: [
        { type: "image_url", image_url: { url: input.sourceImageDataUrl } },
        { type: "text", text: JSON.stringify({ sessionId: input.sessionId, sourceImageHash: input.sourceImageHash, sourceImage: input.sourceImage, goal: "从最终确认的二维户型图创建基础 Pascal 3D 户型" }) },
      ] },
    ];
    let revision = 0;
    let lastResult: any = null;
    let validationFailures = 0;
    let toolIndex = 0;
    let phaseIndex = 0;
    let structureWalls: StructureWall[] = [];
    const phases = ["begin_floorplan_scene", "set_floor_structure", "set_openings", "populate_basic_furniture", "validate_scene", "commit_scene"] as const;
    await input.onEvent?.({ type: "started", sessionId: input.sessionId, model: config.layoutModel });

    for (let round = 0; round < 16; round += 1) {
      const expectedTool = phases[phaseIndex];
      const response: any = await qwenChatCompletion({
        messages,
        tools: openAiTools,
        tool_choice: "required",
        temperature: 0.05,
        max_tokens: 4096,
      }, { model: config.layoutModel, stage: "model3d" });
      const message = response.choices?.[0]?.message || {};
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (!calls.length) throw new Error("Qwen3.8 did not call a Pascal MCP tool");
      const call = calls[0];
      const name = String(call?.function?.name || "");
      if (name !== expectedTool) throw new Error(`Qwen3.8 called ${name || "no tool"}; expected ${expectedTool}`);
      let args: Record<string, any> = {};
      try { args = JSON.parse(call?.function?.arguments || "{}"); } catch { throw new Error(`Qwen3.8 returned invalid tool arguments for ${name}`); }
      args.sessionId = input.sessionId;
      args.sourceImageHash = input.sourceImageHash;
      if (name === "begin_floorplan_scene") args.sourceImage = input.sourceImage;
      else args.revision = revision;
      if (name === "set_openings") args = normalizeOpeningArgs(args, structureWalls);
      toolIndex += 1;
      await input.onEvent?.({ type: "tool", name, args, index: toolIndex, status: "started" });
      messages.push({ role: "assistant", content: message.content || "", tool_calls: [call] });
      try {
        lastResult = await callPascalTool(mcp, name, args);
      } catch (error: any) {
        const message = error?.message || String(error);
        await input.onEvent?.({ type: "tool", name, args, index: toolIndex, status: "error", error: message });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: false, error: message }) });
        continue;
      }
      revision = Number(lastResult.revision || revision);
      if (name === "set_floor_structure") structureWalls = Array.isArray(args.walls) ? args.walls : [];
      await input.onEvent?.({
        type: "tool",
        name,
        args,
        index: toolIndex,
        status: "complete",
        result: { revision, status: String(lastResult.status || ""), validation: lastResult.validation },
      });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: true, revision, status: lastResult.status, validation: lastResult.validation }) });
      if (lastResult.scene) await input.onEvent?.({ type: "scene", stage: lastResult.status, revision, scene: lastResult.scene, validation: lastResult.validation });
      if (name === "validate_scene") {
        await input.onEvent?.({ type: "validation", revision, validation: lastResult.validation });
        if (!lastResult.validation?.valid) {
          validationFailures += 1;
          if (validationFailures > 2) throw new Error(`Pascal validation failed after two corrections: ${(lastResult.validation?.issues || []).join("; ")}`);
          messages.push({ role: "user", content: `Pascal 校验失败。请从 set_floor_structure 开始重新提交修正后的完整场景。问题：${(lastResult.validation?.issues || []).join("；")}` });
          phaseIndex = 1;
          continue;
        }
      }
      if (name === "commit_scene") {
        if (!lastResult.validation?.valid || !lastResult.scene) throw new Error("Pascal MCP committed an invalid scene");
        await input.onEvent?.({ type: "complete", result: lastResult });
        return lastResult;
      }
      phaseIndex += 1;
    }
    throw new Error("Qwen3.8 exceeded the Pascal MCP tool-call limit");
  });
}
