# Maroon Discord Security Bot

Maroon is an all-in-one Discord moderation bot with slash commands, configurable prefix commands, auto-moderation, giveaways, welcome messages, join pings, lockdown controls, complaint handling, and server activity statistics.

## GitHub repository layout

```text
.
├── artifacts/api-server/
│   └── src/
│       ├── maroon/bot.ts       # Discord client and command/event handlers
│       ├── maroon/storage.ts   # Database operations
│       └── index.ts            # HTTP health server + bot startup
├── lib/db/src/schema/maroon.ts # PostgreSQL schema
├── lib/api-spec/               # Shared API contract and generated types
├── render.yaml                 # Render Blueprint
├── .env.example                # Local environment template
├── package.json
├── pnpm-lock.yaml
└── pnpm-workspace.yaml
```

## Local setup

Requirements:

- Node.js 20 or newer
- pnpm 10
- A PostgreSQL database
- A Discord application with a bot user

```bash
corepack enable
pnpm install
cp .env.example .env
```

Fill in `.env` locally. Never commit `.env` or a Discord token.

Apply the database schema:

```bash
pnpm --filter @workspace/db run push
```

Start the bot:

```bash
PORT=8080 pnpm --filter @workspace/api-server run dev
```

Health check:

```text
http://localhost:8080/api/healthz
```

## Discord Developer Portal setup

Enable these privileged intents under the bot's **Bot** settings:

- Server Members Intent
- Message Content Intent

The invite leaderboard also needs the bot to be able to view server invites. Maroon uses the `GuildInvites` gateway intent and the bot should have permission to view invite metadata.

Invite the bot with the `bot` and `applications.commands` scopes. Give it only the permissions it needs for the servers where it is installed; moderation commands also require the matching Discord permissions.

## Deploy to Render

This repository includes `render.yaml` for a Render Blueprint.

1. Push the repository to GitHub.
2. In Render, choose **New + → Blueprint**.
3. Select the GitHub repository.
4. Render will create the free web service from `render.yaml`.
5. Set these environment variables in the Render service:
   - `DISCORD_TOKEN`: the regenerated Discord bot token
   - `DATABASE_URL`: a reachable PostgreSQL connection string
6. Deploy.

Render supplies `PORT` automatically. The service listens on that port and exposes:

```text
https://YOUR-SERVICE.onrender.com/api/healthz
```

Do not put the Discord token or database password in GitHub, `render.yaml`, or this README. Use Render's environment-variable form.

## Keeping a Render free service awake

A Discord bot needs a long-lived WebSocket connection. A cron job should **not** run the bot itself. Use the cron service only to send an HTTP request to the health endpoint so a sleeping Render service wakes up and reconnects.

Recommended cron-job.org configuration:

```text
URL: https://YOUR-SERVICE.onrender.com/api/healthz
Method: GET
Schedule: every 10 minutes
Expected response: HTTP 200
```

Set the job to alert on non-200 responses. A free Render instance can still have cold starts, maintenance interruptions, or free-plan limitations, so this is a keep-awake workaround rather than a production uptime guarantee.

## Available command groups

- Slash commands: `/menu_m`, `/help`, `/commands`, `/create_giveaway`, `/edit_giveaway`, `/poll`, `/who_is`, `/auto_mod`, `/asetup_mod`, `/a_ping`, `/aping_toggle`, `/welcome`, `/welcome_toggle`, `/close_eye`, `/complain`, `/prefix`, `/prefix_m`, `/announcements_channel_set`, `/v`
- Prefix commands: `.commands`, `.help`, `.prefix`, `.mlock add @user`, `.mlock remove @user`, `.mlock list`, `.mute`, `.kick`, `.ban`, `.nuke`, `.raid`, `.lock`, `.unlock`, `.s`, `.cs`, `.leaderboard`, `.li`, `.lm`, `.ld`, `.ldm`, `.afk`, `.a`, `.v`
- Lockdown commands: `?!LOCK!?`, `?!UNLOCK!?`, and `?!DELETE!? @user`

The default prefix is `.`, and each server can change it with `/prefix` or `/prefix_m`. If a custom prefix is forgotten, `.help` and `.prefix` remain available as recovery commands.

## Useful commands

```bash
pnpm run typecheck
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/db run push
```

The API service is the deployable part of this repository. The design-preview package is included for local workspace previews and is not needed on Render.

## Security note

If a bot token is ever pasted into chat, an issue, a commit, or a log, revoke it immediately in the Discord Developer Portal and create a replacement. Store the replacement only in Render environment variables or a local untracked `.env` file.