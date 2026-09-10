# Maroon Discord Security Bot

Maroon is a Discord security and moderation bot with slash commands, configurable prefix commands, lockdown controls, moderation automation, giveaways, welcome flows, and server activity history.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secret: `DISCORD_TOKEN` — regenerated Discord bot token, stored in Replit Secrets

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/maroon/bot.ts` — Discord client, slash commands, prefix commands, moderation listeners, giveaways, and member events
- `artifacts/api-server/src/maroon/storage.ts` — persistence helpers for settings, stats, deleted-message history, giveaways, and complaints
- `lib/db/src/schema/maroon.ts` — PostgreSQL source of truth for Maroon data
- `lib/db/src/schema/index.ts` — schema exports consumed by Drizzle
- `artifacts/api-server/src/routes/health.ts` — API health endpoint

## Architecture decisions

- Discord bot hosting runs alongside the existing API service so the managed workflow keeps one health endpoint and one process.
- Bot credentials are read only from `DISCORD_TOKEN`; no token is stored in source or project files.
- Guild settings and moderation history are persisted in PostgreSQL so prefix, lockdown, and moderation behavior survive restarts.
- Slash commands are registered globally at startup from the command definitions in `bot.ts`.
- The owner ID is the sole hardcoded bypass, matching the product requirements.

## Product

Maroon is online in the connected Discord application and provides server owners with setup commands for auto-mod, welcomes, join pings, Close Eye alerts, announcement channels, and custom prefixes. Moderators can use prefix and lockdown commands for member discipline and channel controls. Members can run polls, inspect server stats, enter giveaways, vote for Maroon, and submit rate-limited complaints.

## Gotchas

- Discord Developer Portal must have the privileged Server Members Intent and Message Content Intent enabled for join welcomes, message statistics, auto-mod, and deleted-message tracking.
- A bot token pasted into chat must be revoked; the running service only uses the regenerated secret in Replit Secrets.
- `pnpm --filter @workspace/db run push` applies schema updates to the development database.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
