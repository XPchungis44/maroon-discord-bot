-- Safe, additive migration for the level system and multi-channel join pings.
-- Every statement is idempotent so existing rows and values are preserved.

ALTER TABLE "maroon_guild_settings"
  ADD COLUMN IF NOT EXISTS "aping_channel_ids" text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "aping_delete_after_seconds" integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS "level_system_enabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "level_announcement_channel_id" varchar(32),
  ADD COLUMN IF NOT EXISTS "level_auto_setup" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "level_role_rewards" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "level_message_template" text NOT NULL DEFAULT '{user} reached level {level}!',
  ADD COLUMN IF NOT EXISTS "level_cooldown_seconds" integer NOT NULL DEFAULT 5;

ALTER TABLE "maroon_user_stats"
  ADD COLUMN IF NOT EXISTS "level" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "level_messages" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "level_last_granted_at" timestamptz;

-- Keep invalid legacy/config values from causing unsafe behavior after migration.
UPDATE "maroon_guild_settings"
SET "aping_delete_after_seconds" = LEAST(GREATEST("aping_delete_after_seconds", 1), 60),
    "level_cooldown_seconds" = GREATEST("level_cooldown_seconds", 0)
WHERE "aping_delete_after_seconds" < 1
   OR "aping_delete_after_seconds" > 60
   OR "level_cooldown_seconds" < 0;

UPDATE "maroon_user_stats"
SET "level" = LEAST(GREATEST("level", 0), 125),
    "level_messages" = GREATEST("level_messages", 0)
WHERE "level" < 0
   OR "level" > 125
   OR "level_messages" < 0;
