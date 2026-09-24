import { furnitureItem } from "../house-scene";
import type { SceneGraph, SceneNode } from "../types";
import {
  rebuildDoorTransform,
  rebuildWallFromOpenings,
  rebuildWalkthroughCollision,
  wallLength,
} from "./door-edit";
import {
  buildFloorplanScene,
  polygonArea,
  type BlueprintDoor,
  type BlueprintFurniture,
  type BlueprintWindow,
  type FloorplanBlueprint,
  type FloorplanRoom,
  type FloorplanSpec,
  type FloorplanWall,
  type Point,
} from "./types";

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

function bounds(points: Point[]) {
  const xs = points.map((point) => point[0]);
  const zs = points.map((point) => point[1]);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minZ: Math.min(...zs),
    maxZ: Math.max(...zs),
    width: Math.max(...xs) - Math.min(...xs),
    depth: Math.max(...zs) - Math.min(...zs),
  };
}

function pointSegmentDistance(point: Point, start: Point, end: Point) {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared
    ? Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / lengthSquared))
    : 0;
  return Math.hypot(point[0] - (start[0] + dx * t), point[1] - (start[1] + dz * t));
}

function roomTouchesWall(room: FloorplanRoom, wall: FloorplanWall) {
  return room.polygon.some((point, index) => {
    const next = room.polygon[(index + 1) % room.polygon.length];
    const midpoint: Point = [(point[0] + next[0]) / 2, (point[1] + next[1]) / 2];
    return pointSegmentDistance(midpoint, wall.start, wall.end) < 0.08;
  });
}

function connectedRooms(spec: FloorplanSpec, wallId: string): [string | null, string | null] {
  const wall = spec.walls.find((candidate) => candidate.id === wallId);
  if (!wall) return [null, null];
  const ids = spec.rooms.filter((room) => roomTouchesWall(room, wall)).map((room) => room.id);
  return [ids[0] || null, ids[1] || null];
}

function safeRoomPoint(room: FloorplanRoom): [number, number, number] {
  const sum = room.polygon.reduce(
    (value, point) => [value[0] + point[0], value[1] + point[1]] as Point,
    [0, 0] as Point,
  );
  return [sum[0] / room.polygon.length, 0, sum[1] / room.polygon.length];
}

function defaultFurniture(spec: FloorplanSpec): BlueprintFurniture[] {
  const kinds: Record<string, string> = {
    bedroom: "singleBed",
    master_bedroom: "doubleBed",
    child_room: "singleBed",
    living_room: "sofa",
    kitchen: "kitchen",
    bathroom: "toilet",
    storage: "closet",
    study: "table",
  };
  return spec.rooms.flatMap((room, index) => {
    const kind = kinds[room.semantic];
    return kind
      ? [{
          id: `item_${room.id}_${index + 1}`,
          roomId: room.id,
          kind,
          position: safeRoomPoint(room),
          rotation: 0,
          size: [0.72, 1, 0.72],
          scale: [0.72, 1, 0.72],
        } as BlueprintFurniture]
      : [];
  });
}

export function createFloorplanBlueprint(
  source: FloorplanSpec,
  furniture: BlueprintFurniture[] = defaultFurniture(source),
): FloorplanBlueprint {
  const spec = clone(source);
  const sceneBounds = bounds(spec.outerPolygon);
  const doors: BlueprintDoor[] = spec.doors.map((opening) => ({
    id: opening.id,
    name: opening.name,
    hostWallId: opening.wallId,
    offset: Math.max(0, opening.distance - opening.width / 2),
    width: opening.width,
    height: opening.height || 2.1,
    doorType: "hinged",
    hingeSide: "left",
    swingDirection: "inward",
    swingAngle: 0,
    connects: connectedRooms(spec, opening.wallId),
    locked: opening.id === "door_entry",
  }));
  const windows: BlueprintWindow[] = spec.windows.map((opening) => ({
    id: opening.id,
    name: opening.name,
    hostWallId: opening.wallId,
    offset: Math.max(0, opening.distance - opening.width / 2),
    width: opening.width,
    height: opening.height || 1.4,
    sillHeight: opening.sillHeight ?? 1,
  }));
  return {
    schema: "dreamhouse-floorplan-blueprint/v1",
    unit: "meter",
    id: spec.id,
    name: spec.name,
    factory: spec.factory,
    sourceImage: spec.sourceImage,
    outerPolygon: spec.outerPolygon,
    walls: spec.walls,
    rooms: spec.rooms,
    doors,
    windows,
    furniture: clone(furniture),
    expected: {
      roomCount: spec.rooms.length,
      doorCount: spec.doors.length,
      windowCount: spec.windows.length,
      approximateArea: polygonArea(spec.outerPolygon),
      sceneBounds: { width: sceneBounds.width, depth: sceneBounds.depth },
    },
  };
}

export function blueprintToFloorplanSpec(blueprint: FloorplanBlueprint): FloorplanSpec {
  return {
    id: blueprint.id,
    name: blueprint.name,
    factory: blueprint.factory,
    sourceImage: blueprint.sourceImage,
    outerPolygon: clone(blueprint.outerPolygon),
    walls: clone(blueprint.walls),
    rooms: clone(blueprint.rooms),
    doors: blueprint.doors.map((door) => ({
      id: door.id,
      name: door.name,
      wallId: door.hostWallId,
      distance: door.offset + door.width / 2,
      width: door.width,
      height: door.height,
    })),
    windows: blueprint.windows.map((window) => ({
      id: window.id,
      name: window.name,
      wallId: window.hostWallId,
      distance: window.offset + window.width / 2,
      width: window.width,
      height: window.height,
      sillHeight: window.sillHeight,
    })),
  };
}

export type BlueprintValidation = {
  valid: boolean;
  issues: string[];
  metrics: {
    roomCount: number;
    doorCount: number;
    windowCount: number;
    area: number;
    bounds: { width: number; depth: number };
    compileCoordinateErrorM: number;
  };
};

export function validateVariantBlueprint(blueprint: FloorplanBlueprint): BlueprintValidation {
  const issues: string[] = [];
  if (blueprint.schema !== "dreamhouse-floorplan-blueprint/v1") issues.push("Blueprint schema 无效");
  if (blueprint.unit !== "meter") issues.push("Blueprint 单位必须为 meter");
  if (blueprint.outerPolygon.length < 3) issues.push("outerPolygon 无效");
  const ids = new Set<string>();
  for (const entity of [...blueprint.walls, ...blueprint.rooms, ...blueprint.doors, ...blueprint.windows, ...blueprint.furniture]) {
    if (!entity.id || ids.has(entity.id)) issues.push(`节点ID缺失或重复：${entity.id}`);
    ids.add(entity.id);
  }
  const wallIds = new Set(blueprint.walls.map((wall) => wall.id));
  for (const room of blueprint.rooms) {
    if (room.polygon.length < 3 || polygonArea(room.polygon) < 0.2) issues.push(`房间 polygon 无效：${room.id}`);
  }
  for (const opening of [...blueprint.doors, ...blueprint.windows]) {
    if (!wallIds.has(opening.hostWallId)) issues.push(`${opening.id} 未绑定有效墙体`);
    const wall = blueprint.walls.find((candidate) => candidate.id === opening.hostWallId);
    const length = wall ? Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]) : 0;
    if (opening.offset < -0.001 || opening.offset + opening.width > length + 0.001)
      issues.push(`${opening.id} 超出墙体范围`);
  }
  const area = polygonArea(blueprint.outerPolygon);
  const measuredBounds = bounds(blueprint.outerPolygon);
  if (blueprint.rooms.length !== blueprint.expected.roomCount) issues.push("room count 与 expected 不一致");
  if (blueprint.doors.length !== blueprint.expected.doorCount) issues.push("door count 与 expected 不一致");
  if (blueprint.windows.length !== blueprint.expected.windowCount) issues.push("window count 与 expected 不一致");
  if (Math.abs(area - blueprint.expected.approximateArea) > Math.max(0.5, area * 0.03)) issues.push("户型面积与 expected 不一致");
  if (Math.abs(measuredBounds.width - blueprint.expected.sceneBounds.width) > 0.02 || Math.abs(measuredBounds.depth - blueprint.expected.sceneBounds.depth) > 0.02)
    issues.push("场景 bounds 与 expected 不一致");
  return {
    valid: issues.length === 0,
    issues,
    metrics: {
      roomCount: blueprint.rooms.length,
      doorCount: blueprint.doors.length,
      windowCount: blueprint.windows.length,
      area,
      bounds: { width: measuredBounds.width, depth: measuredBounds.depth },
      compileCoordinateErrorM: 0,
    },
  };
}

export function compileBlueprintToPascal(blueprint: FloorplanBlueprint): SceneGraph {
  const validation = validateVariantBlueprint(blueprint);
  if (!validation.valid) throw new Error(`FloorplanBlueprint 校验失败：${validation.issues.join("；")}`);
  const items = blueprint.furniture.map((item) =>
    furnitureItem(
      item.id,
      item.roomId,
      item.kind as any,
      item.position,
      item.rotation,
      item.scale,
    ),
  );
  const scene = buildFloorplanScene(blueprintToFloorplanSpec(blueprint), items);
  for (const door of blueprint.doors) {
    const node = scene.nodes[door.id];
    Object.assign(node, {
      hostWallId: door.hostWallId,
      offset: door.offset,
      wallId: door.hostWallId,
      parentId: door.hostWallId,
      height: door.height,
      doorType: door.doorType,
      hingeSide: door.hingeSide,
      hingesSide: door.hingeSide,
      swingDirection: door.swingDirection,
      swingAngle: door.swingAngle,
      connects: door.connects,
      locked: door.locked,
      metadata: { ...(node.metadata || {}), blueprintOffset: door.offset, locked: door.locked },
    });
    rebuildDoorTransform(scene, door.id);
  }
  for (const window of blueprint.windows) {
    const node = scene.nodes[window.id];
    Object.assign(node, {
      hostWallId: window.hostWallId,
      wallId: window.hostWallId,
      parentId: window.hostWallId,
      height: window.height,
      sillHeight: window.sillHeight,
      metadata: { ...(node.metadata || {}), blueprintOffset: window.offset },
    });
  }
  for (const wall of blueprint.walls) rebuildWallFromOpenings(scene, wall.id);
  const building = scene.nodes.building_house;
  building.metadata = {
    ...(building.metadata || {}),
    floorplanBlueprint: clone(blueprint),
    coordinateUnit: "meter",
    blueprintValidation: validation,
  };
  rebuildWalkthroughCollision(scene);
  return scene;
}

export function sceneToFloorplanBlueprint(scene: SceneGraph): FloorplanBlueprint {
  const stored = scene.nodes.building_house?.metadata?.floorplanBlueprint as FloorplanBlueprint | undefined;
  if (stored) {
    const blueprint = clone(stored);
    blueprint.walls = Object.values(scene.nodes)
      .filter((node) => node.type === "wall")
      .map((node) => ({
        id: node.id,
        start: clone(node.start),
        end: clone(node.end),
        structural: node.metadata?.structural_type || "partition",
      }));
    const slab = Object.values(scene.nodes).find((node) => node.type === "slab" && Array.isArray(node.polygon));
    if (slab) blueprint.outerPolygon = clone(slab.polygon);
    blueprint.rooms = Object.values(scene.nodes)
      .filter((node) => node.type === "zone")
      .map((node) => ({
        id: node.id,
        name: String(node.name || node.id),
        semantic: node.metadata?.semantic_type || "bedroom",
        polygon: clone(node.polygon),
        expectedArea: polygonArea(node.polygon || []),
        color: node.color || "#9aa8ac",
      }));
    blueprint.doors = Object.values(scene.nodes)
      .filter((node) => node.type === "door")
      .map((node) => ({
        id: node.id,
        name: String(node.name || "门"),
        hostWallId: String(node.hostWallId || node.wallId || node.parentId),
        offset: Number(node.metadata?.blueprintOffset ?? (Number(node.position?.[0] || 0) - Number(node.width || 0.86) / 2)),
        width: Number(node.width || 0.86),
        height: Number(node.height || 2.1),
        doorType: node.doorType || "hinged",
        hingeSide: node.hingeSide || node.hingesSide || "left",
        swingDirection: node.swingDirection || "inward",
        swingAngle: Number(node.swingAngle || 0),
        connects: node.connects || [null, null],
        locked: Boolean(node.locked || node.metadata?.locked),
      }));
    blueprint.windows = Object.values(scene.nodes)
      .filter((node) => node.type === "window")
      .map((node) => ({
        id: node.id,
        name: String(node.name || "窗"),
        hostWallId: String(node.hostWallId || node.wallId || node.parentId),
        offset: Number(node.metadata?.blueprintOffset ?? (Number(node.position?.[0] || 0) - Number(node.width || 1.2) / 2)),
        width: Number(node.width || 1.2),
        height: Number(node.height || 1.4),
        sillHeight: Number(node.sillHeight ?? 1),
      }));
    blueprint.furniture = Object.values(scene.nodes)
      .filter((node) => node.type === "item")
      .map((node) => {
        const scale = clone(node.scale || [1, 1, 1]) as [number, number, number];
        const dimensions = (node.asset?.dimensions || [1, 1, 1]) as [number, number, number];
        return {
          id: node.id,
          roomId: node.metadata?.room_id,
          kind: node.metadata?.furniture_asset_key || node.asset?.id || "sofa",
          position: clone(node.position || [0, 0, 0]),
          rotation: Number(node.rotation?.[1] || 0),
          size: dimensions.map((value, index) => Number(value || 0) * Math.abs(Number(scale[index] || 1))) as [number, number, number],
          scale,
        };
      });
    return blueprint;
  }
  throw new Error("Scene 缺少 FloorplanBlueprint");
}

export function recompileSceneFromBlueprint(scene: SceneGraph) {
  const previousMetadata = clone(scene.nodes.building_house?.metadata || {});
  const blueprint = sceneToFloorplanBlueprint(scene);
  const measuredBounds = bounds(blueprint.outerPolygon);
  blueprint.expected = {
    roomCount: blueprint.rooms.length,
    doorCount: blueprint.doors.length,
    windowCount: blueprint.windows.length,
    approximateArea: polygonArea(blueprint.outerPolygon),
    sceneBounds: { width: measuredBounds.width, depth: measuredBounds.depth },
  };
  const compiled = compileBlueprintToPascal(blueprint);
  compiled.nodes.building_house.metadata = {
    ...previousMetadata,
    ...compiled.nodes.building_house.metadata,
    floorplanBlueprint: blueprint,
  };
  return compiled;
}

export function blueprintWallCoordinateError(scene: SceneGraph, blueprint: FloorplanBlueprint) {
  let squared = 0;
  let count = 0;
  for (const expected of blueprint.walls) {
    const actual = scene.nodes[expected.id];
    if (!actual || actual.type !== "wall") continue;
    for (const [a, b] of [[actual.start, expected.start], [actual.end, expected.end]]) {
      squared += (Number(a[0]) - b[0]) ** 2 + (Number(a[1]) - b[1]) ** 2;
      count += 2;
    }
  }
  return count ? Math.sqrt(squared / count) : Number.POSITIVE_INFINITY;
}
