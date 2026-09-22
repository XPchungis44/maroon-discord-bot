# Maroon Discord Security Bot

Moderation bot with slash + prefix commands, auto-mod, giveaways, levels, and more.

## Render

- Build: `pnpm install --frozen-lockfile && pnpm run typecheck:libs && pnpm --filter @workspace/api-server run typecheck && pnpm --filter @workspace/api-server run build`
- Start: `node artifacts/api-server/dist/index.mjs`
- Env: `DISCORD_TOKEN`, `DATABASE_URL` (Internal Postgres URL)

Migrations run automatically on startup.

## Levels

1. `/level_toggle enabled:True` (Manage Server)
2. `/level` or `.level` to view progress

## Help

`/help`, `/menu_m`, or `.help`
