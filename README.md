# Maroon Discord Security Bot

Maroon is an all-in-one Discord moderation bot with slash commands, configurable prefix commands, auto-moderation, giveaways, welcome messages, join pings, lockdown controls, complaint handling, and server activity statistics.

## Deploy

See `render.yaml`. Set `DISCORD_TOKEN` and `DATABASE_URL` on Render.

Health check: `https://YOUR-SERVICE.onrender.com/`

## Commands

- Slash: `/help`, `/menu_m`, `/level`, `/create_giveaway`, `/poll`, `/who_is`, `/auto_mod`, `/welcome`, `/prefix`, and more
- Prefix: `.help`, `.level`, `.mute`, `.kick`, `.ban`, `.lock`, `.unlock`, etc.
- Lockdown: `?!LOCK!?`, `?!UNLOCK!?`, `?!DELETE!? @user`

## Database

The API server runs idempotent migrations on startup (`runMaroonMigrations`).

```bash
pnpm --filter @workspace/db run push
```
