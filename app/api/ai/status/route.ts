import { NextResponse } from 'next/server'
import { getAiConfig } from '@/lib/ai/config'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const runtime = 'nodejs'

function readGpuMemory() {
  const drmRoot = '/sys/class/drm'
  let vramBytes = 0
  let gttBytes = 0
  try {
    for (const entry of readdirSync(drmRoot).filter((name) => /^card\d+$/.test(name))) {
      const deviceRoot = join(drmRoot, entry, 'device')
      const read = (name: string) => {
        try {
          return Number(readFileSync(join(deviceRoot, name), 'utf8').trim()) || 0
        } catch {
          return 0
        }
      }
      const candidateVram = read('mem_info_vram_total')
      if (candidateVram > vramBytes) {
        vramBytes = candidateVram
        gttBytes = read('mem_info_gtt_total')
      }
    }
  } catch {
    // Some container runtimes hide DRM sysfs counters. Device health remains authoritative.
  }
  return {
    vramBytes: vramBytes || undefined,
    gttBytes: gttBytes || undefined,
    gpuAddressableBytes: vramBytes ? vramBytes + gttBytes : undefined,
  }
}

export async function GET() {
  const config = getAiConfig()
  const imageModel = process.env.QWEN_INTERIOR_IMAGE_MODEL || config.imageModel
  const probe = async (url: string) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2500)
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
      const body = await response.text()
      let details: Record<string, unknown> = {}
      try { details = JSON.parse(body) } catch {}
      return {
        healthy: response.ok,
        status: response.status,
        message: response.ok ? undefined : body.slice(0, 160),
        details,
      }
    } catch (error: any) {
      return { healthy: false, message: String(error?.message || error).slice(0, 160) }
    } finally {
      clearTimeout(timer)
    }
  }

  const [text, image, mcp] = await Promise.all([
    probe(`${config.compatBaseUrl.replace(/\/v1$/, '')}/health`),
    probe(`${config.nativeBaseUrl}/health`),
    probe(config.mcpUrl.replace(/\/mcp$/, '/health')),
  ])
  const visionProjector = process.env.LOCAL_VISION_PROJECTOR || 'mmproj-F16.gguf'
  const vision = {
    healthy: text.healthy,
    projector: visionProjector,
    message: text.healthy ? undefined : 'vision projector depends on the text service',
  }
  const vulkanDevice = process.env.VULKAN_DEVICE || '/dev/dri/renderD128'
  const vulkanDeviceVisible = existsSync(vulkanDevice) || process.env.VULKAN_DEVICE_VISIBLE === 'true'
  const memory = readGpuMemory()
  const vulkan = {
    healthy: vulkanDeviceVisible && text.healthy && image.healthy,
    device: vulkanDevice,
    memory,
    message: vulkanDeviceVisible ? undefined : 'Vulkan render device is not visible to the web container',
  }

  return NextResponse.json({
    mode: config.mode,
    localOnly: config.mode === 'local',
    ready: text.healthy && vision.healthy && image.healthy && mcp.healthy && vulkan.healthy,
    models: { layout: config.layoutModel, image: imageModel, bom: config.bomModel },
    services: { text, vision, image, mcp, vulkan },
    endpoints: { text: config.compatBaseUrl, image: config.nativeBaseUrl, mcp: config.mcpUrl },
    acceleration: {
      text: 'vulkan',
      image: 'stable-diffusion.cpp-vulkan',
      configuredVramBytes: 96 * 1024 ** 3,
      ...memory,
    },
    persistence: {
      generatedImageDirectory: process.env.GENERATED_IMAGE_DIR || '/data/generated',
      imageUrlsMayExpire: false,
    },
    license: { zImageTurbo: 'check-model-license-before-commercial-use' },
  })
}
