# syntax=docker/dockerfile:1.7
FROM node:24.19.0-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/voice-gateway/package.json apps/voice-gateway/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY apps/voice-gateway apps/voice-gateway
COPY packages/db packages/db
COPY packages/domain packages/domain
RUN pnpm exec esbuild apps/voice-gateway/src/entrypoint.ts --bundle --platform=node --format=esm --target=node24 --outfile=/workspace/voice-gateway.mjs --external:pg-native --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"

FROM node:24.19.0-bookworm-slim AS runtime
LABEL org.opencontainers.image.description="AccountPulse private VoIPcloud voice gateway"
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3105
ENV PATH=/opt/piper/bin:$PATH
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates \
  && python3 -m venv /opt/piper \
  && /opt/piper/bin/pip install --no-cache-dir piper-tts==1.8.0 \
  && mkdir -p /opt/accountpulse/voices/en_GB-alba-medium /dev/shm/accountpulse-voice \
  && chown -R node:node /dev/shm/accountpulse-voice \
  && rm -rf /var/lib/apt/lists/*

ARG VOICE_BASE=https://huggingface.co/rhasspy/piper-voices/resolve/217ddc79818708b078d0d14a8fae9608b9d77141/en/en_GB/alba/medium
ADD --checksum=sha256:401369c4a81d09fdd86c32c5c864440811dbdcc66466cde2d64f7133a66ad03b ${VOICE_BASE}/en_GB-alba-medium.onnx /opt/accountpulse/voices/en_GB-alba-medium/en_GB-alba-medium.onnx
ADD --checksum=sha256:aa965a2f02ecced632c2694e1fc72bbff6d65f265fab567ca945918c73dd89f4 ${VOICE_BASE}/en_GB-alba-medium.onnx.json /opt/accountpulse/voices/en_GB-alba-medium/en_GB-alba-medium.onnx.json
ADD --checksum=sha256:fa166b1779404c470b0b6b4ba0238bc4a35bf89d2cd130c6788f697188b737d6 ${VOICE_BASE}/MODEL_CARD /opt/accountpulse/voices/en_GB-alba-medium/MODEL_CARD

COPY --from=build --chown=node:node /workspace/voice-gateway.mjs /app/voice-gateway.mjs
COPY --chown=node:node apps/voice-gateway/THIRD_PARTY_NOTICES.md /app/THIRD_PARTY_NOTICES.md

RUN printf '%s\n' 'AccountPulse voice gateway ready.' | piper \
      -m /opt/accountpulse/voices/en_GB-alba-medium/en_GB-alba-medium.onnx \
      -c /opt/accountpulse/voices/en_GB-alba-medium/en_GB-alba-medium.onnx.json \
      -f /tmp/piper-smoke.wav \
  && ffmpeg -nostdin -hide_banner -loglevel error -y -i /tmp/piper-smoke.wav -ac 1 -ar 8000 -c:a pcm_s16le /tmp/piper-smoke-8khz.wav \
  && test -s /tmp/piper-smoke-8khz.wav \
  && rm -f /tmp/piper-smoke.wav /tmp/piper-smoke-8khz.wav

USER node
EXPOSE 3105
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "process.kill(1,0)"]
CMD ["node", "/app/voice-gateway.mjs"]
