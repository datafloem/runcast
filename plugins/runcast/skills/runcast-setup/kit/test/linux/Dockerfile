# Linux self-test of Runcast: sets up a sample project with the kit's
# CLI, records it twice (a headless tab, and the screen of an Xvfb display),
# renders the videos, and splits a
# narration with ffmpeg. From the repository root:
#
#   docker build -f plugins/runcast/skills/runcast-setup/kit/test/linux/Dockerfile -t runcast-linux plugins/runcast
#   docker run --rm -v "$PWD/kit-linux-out:/out" runcast-linux
#
# Output: kit-linux-out/ (videos, frames, captures).
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg xvfb \
  && rm -rf /var/lib/apt/lists/*

# The plugin, as Claude Code, Codex or Antigravity would install it.
COPY . /plugin

# Build the kit's runtime once in the image (Playwright, canvas), plus
# Playwright's Chromium: Google Chrome has no Linux ARM build.
RUN mkdir -p /warm && cd /warm \
  && node /plugin/skills/runcast-setup/kit/cli.ts setup --dir /warm/rec --name warm \
  && node /warm/rec/.kit/node_modules/@playwright/test/cli.js install --with-deps chromium \
  && rm -rf /warm /var/lib/apt/lists/*

ENV REC_CHANNEL=chromium
WORKDIR /app
CMD ["bash", "/plugin/skills/runcast-setup/kit/test/linux/run.sh"]
