# Ideal Home local Vulkan deployment

This stack runs Qwen3.8-27B, its F16 vision projector, Qwen-Image-2.1, and Pascal MCP without cloud AI dependencies. Model downloads use `https://hf-mirror.com` only. Runtime containers share an internal Docker network, and only the web port is published.

## Install models

```bash
sudo mkdir -p /srv/ideal-home/models /srv/ideal-home/data/{generated,scenes}
sudo chown -R "$USER":"$USER" /srv/ideal-home
MODEL_ROOT=/srv/ideal-home/models ./deploy/local-ai/download-models.sh
```

The script pins both model repository revisions and writes `SOURCES.json` plus `SHA256SUMS`. Model volumes are mounted read-only by Compose.

## Build and stage on port 3001

```bash
cd deploy/local-ai
cp .env.example .env
docker compose build
docker compose up -d
curl http://127.0.0.1:3001/api/ai/status
```

The `ai-gateway` serializes text and image generation requests so the two Vulkan workloads do not execute concurrently. Qwen3.8 remains loaded with one parallel slot and a 32K context.

## Promote to port 3000

After the complete acceptance flow passes on port 3001, set `WEB_PORT=3000`. Preserve the previous `ideal-home:latest` image under a rollback tag before replacing the old container.

## Offline verification

The `local-ai` network is declared `internal: true`. After images and model files are present, recreate the stack and verify layout editing, Step 3 MCP scene creation, manual Pascal editing, renders, and BOM generation. `GET /api/ai/status` must report text, vision, image, MCP, and Vulkan as healthy.
