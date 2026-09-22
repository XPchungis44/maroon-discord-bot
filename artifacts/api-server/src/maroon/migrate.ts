import { pool } from "@workspace/db";
import { logger } from "../lib/logger";

/**
 * Safe startup migration. Creates core tables if missing and adds any
 * columns required by the current bot. All statements are idempotent.
 */
export async function runMaroonMigrations() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "maroon_guild_settings" (
        "guild_id" varchar(32) PRIMARY KEY,
        "prefix" varchar(8) NOT NULL DEFAULT '.',
        "announcement_channel_id" varchar(32),
        "welcome_enabled" boolean NOT NULL DEFAULT false,
        "welcome_channel_id" varchar(32),
        "welcome_message" text,
        "welcome_media_url" text,
        "auto_mod_enabled" boolean NOT NULL DEFAULT false,
        "auto_mod_slurs" boolean NOT NULL DEFAULT true,
        "auto_mod_curse_words" boolean NOT NULL DEFAULT true,
        "auto_mod_nsfw" boolean NOT NULL DEFAULT true,
        "auto_mod_timeout_seconds" integer NOT NULL DEFAULT 0,
        "trigger_words" text[] NOT NULL DEFAULT '{}',
        "aping_enabled" boolean NOT NULL DEFAULT false,
        "aping_channel_ids" text[] NOT NULL DEFAULT '{}',
        "aping_delete_after_seconds" integer NOT NULL DEFAULT 5,
        "close_eye_enabled" boolean NOT NULL DEFAULT false,
        "level_system_enabled" boolean NOT NULL DEFAULT false,
        "level_announcement_channel_id" varchar(32),
        "level_auto_setup" boolean NOT NULL DEFAULT false,
        "level_role_rewards" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "level_message_template" text NOT NULL DEFAULT '{user} reached level {level}!',
        "level_cooldown_seconds" integer NOT NULL DEFAULT 5,
        "locked_channels" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS "maroon_user_stats" (
        "guild_id" varchar(32) NOT NULL,
        "user_id" varchar(32) NOT NULL,
        "messages_sent" integer NOT NULL DEFAULT 0,
        "deleted_messages" integer NOT NULL DEFAULT 0,
        "invite_joins" integer NOT NULL DEFAULT 0,
        "joined_at" timestamptz,
        "last_message_at" timestamptz,
        "level" integer NOT NULL DEFAULT 0,
        "level_messages" integer NOT NULL DEFAULT 0,
        "level_last_granted_at" timestamptz,
        PRIMARY KEY ("guild_id", "user_id")
      );

      CREATE TABLE IF NOT EXISTS "maroon_deleted_messages" (
        "id" serial PRIMARY KEY,
        "guild_id" varchar(32) NOT NULL,
        "channel_id" varchar(32) NOT NULL,
        "message_id" varchar(32) NOT NULL,
        "user_id" varchar(32) NOT NULL,
        "content" text NOT NULL,
        "deleted_at" timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS "maroon_giveaways" (
        "id" serial PRIMARY KEY,
        "guild_id" varchar(32) NOT NULL,
        "channel_id" varchar(32) NOT NULL,
        "message_id" varchar(32) NOT NULL,
        "host_id" varchar(32) NOT NULL,
        "sponsor" text,
        "prize" text NOT NULL,
        "duration_seconds" integer NOT NULL,
        "ends_at" timestamptz NOT NULL,
        "winner_id" varchar(32),
        "status" varchar(16) NOT NULL DEFAULT 'active',
        "entries" text[] NOT NULL DEFAULT '{}',
        "created_at" timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS "maroon_complaints" (
        "id" serial PRIMARY KEY,
        "guild_id" varchar(32),
        "user_id" varchar(32) NOT NULL,
        "complaint" text NOT NULL,
        "owner_message_id" varchar(32),
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
    `);

    // Additive column upgrades for DBs created before level/aping fields existed.
    await client.query(`
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
    `);

    logger.info("Maroon database migrations applied");
  } finally {
    client.release();
  }
}
