---
name: Render build quirks
description: Node and pnpm build behavior for the Render deployment.
---

Render's Node build image already provides the required pnpm version for this project; enabling Corepack can fail because the image cannot replace `/usr/bin/pnpm`.

**Why:** The initial Render build failed before dependency installation with a read-only filesystem error from `corepack enable`.

**How to apply:** Keep the Render build command starting with `pnpm install --frozen-lockfile`; do not run `corepack enable` or attempt to replace the system pnpm binary.