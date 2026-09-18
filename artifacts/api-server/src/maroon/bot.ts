import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Message,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type TextChannel,
} from "discord.js";
import { logger } from "../lib/logger";
import {
  clearDeletedMessages,
  addGiveawayEntry,
  createComplaint,
  createGiveaway,
  getComplaintByOwnerMessage,
  getGiveawayByMessage,
  getGuildSettings,
  getUserLeaderboard,
  getUserStat,
  hasRecentComplaint,
  incrementInviteJoin,
  incrementMessageStat,
  listDeletedMessages,
  recordDeletedMessage,
  setComplaintOwnerMessage,
  setMemberJoinedAt,
  updateGiveaway,
  updateGuildSettings,
} from "./storage";

const OWNER_ID = "1459373221756538923";
const VOTE_URL = "https://top.gg/bot/1535813652525875280/vote";
const DEFAULT_PREFIX = ".";
const LOCKED_MEMBERS_KEY = "__maroon_locked_members";
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

// Stay connected after Render free-tier sleep/wake cycles
client.on("error", (error) => {
  logger.error({ error }, "Discord client error");
});
client.on("shardError", (error) => {
  logger.error({ error }, "Discord shard error");
});
client.on("warn", (message) => {
  logger.warn({ message }, "Discord client warning");
});

const afkUsers = new Map<string, string>();
const giveawayTimers = new Map<number, NodeJS.Timeout>();
type InviteSnapshot = {
  uses: number;
  inviterId: string | null;
};
const inviteSnapshots = new Map<string, Map<string, InviteSnapshot>>();
const inviteAttributionQueues = new Map<string, Promise<void>>();

const blockedTerms = {
  slurs: ["n1gger", "f4ggot"],
  curseWords: ["fuck", "shit", "bitch", "cunt"],
  nsfw: ["porn", "hentai", "onlyfans"],
};

function durationSeconds(raw: string): number | null {
  const match = raw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/);
  if (!match) return null;
  const value = Number(match[1]);
  const units: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  const unit = match[2];
  return Math.round(value * (units[unit] ?? 0));
}

function normalizePrefix(raw: string | null | undefined) {
  const prefix = raw?.trim() ?? "";
  if (!prefix || prefix.length > 7 || /\s/.test(prefix) || prefix.includes("/") || prefix === "?!") {
    return null;
  }
  return prefix;
}

function getLockedMemberIds(settings: { lockedChannels: Record<string, unknown> }) {
  const value = settings.lockedChannels[LOCKED_MEMBERS_KEY];
  return Array.isArray(value) ? value.filter((userId): userId is string => typeof userId === "string") : [];
}

function withLockedMemberIds(
  settings: { lockedChannels: Record<string, unknown> },
  userIds: string[],
) {
  return {
    ...settings.lockedChannels,
    [LOCKED_MEMBERS_KEY]: userIds,
  };
}

function resolveMentionedMember(message: Message, rawId?: string) {
  const mentioned = message.mentions.members?.first();
  if (mentioned) return Promise.resolve(mentioned);
  const userId = rawId?.match(/^<@!?(\d+)>$/)?.[1] ?? (rawId?.match(/^\d{15,25}$/) ? rawId : null);
  return userId ? message.guild?.members.fetch(userId).catch(() => null) : Promise.resolve(null);
}

function commandHasPermission(
  interaction: ChatInputCommandInteraction,
  permission: bigint,
) {
  return interaction.user.id === OWNER_ID || Boolean(interaction.memberPermissions?.has(permission));
}

function memberHasPermission(member: GuildMember, permission: bigint) {
  return member.id === OWNER_ID || member.permissions.has(permission);
}

async function refreshGuildInvites(guild: Guild) {
  try {
    const invites = await guild.invites.fetch();
    const snapshot = new Map<string, InviteSnapshot>();
    for (const [code, invite] of invites) {
      snapshot.set(code, {
        uses: invite.uses ?? 0,
        inviterId: invite.inviter?.id ?? null,
      });
    }
    inviteSnapshots.set(guild.id, snapshot);
    return snapshot;
  } catch (error) {
    logger.warn({ error, guildId: guild.id }, "Could not refresh guild invites");
    return null;
  }
}

async function queueGuildInviteOperation<T>(
  guildId: string,
  operation: () => Promise<T>,
) {
  const previous = inviteAttributionQueues.get(guildId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  inviteAttributionQueues.set(guildId, queued);

  try {
    await previous;
    return await operation();
  } finally {
    release();
    if (inviteAttributionQueues.get(guildId) === queued) {
      inviteAttributionQueues.delete(guildId);
    }
  }
}

async function attributeInviteJoin(guild: Guild) {
  return queueGuildInviteOperation(guild.id, async () => {
    const previous = inviteSnapshots.get(guild.id);
    const current = await refreshGuildInvites(guild);
    if (!previous || !current) return null;

    const increased = [...current.entries()].filter(([code, invite]) => {
      const previousUses = previous.get(code)?.uses ?? 0;
      return invite.uses > previousUses;
    });
    if (increased.length !== 1) return null;

    const inviterId = increased[0][1].inviterId;
    if (!inviterId) return null;
    await incrementInviteJoin(guild.id, inviterId);
    return inviterId;
  });
}

async function respond(
  interaction: ChatInputCommandInteraction,
  content: string,
  ephemeral = true,
) {
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ content });
  } else {
    await interaction.reply({
      content,
      flags: ephemeral ? MessageFlags.Ephemeral : undefined,
    });
  }
}

async function respondWithEmbed(
  interaction: ChatInputCommandInteraction,
  embed: EmbedBuilder,
  ephemeral = true,
) {
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ content: "", embeds: [embed] });
  } else {
    await interaction.reply({
      embeds: [embed],
      flags: ephemeral ? MessageFlags.Ephemeral : undefined,
    });
  }
}

function helpEmbed(prefix: string) {
  return new EmbedBuilder()
    .setColor(0x8b1e3f)
    .setTitle("Maroon Command Center")
    .setDescription(
      `Security, moderation, and server tools in one place.\nYour current prefix is **${prefix}**.`,
    )
    .addFields(
      {
        name: "Setup",
        value: "`/prefix_m` · `/announcements_channel_set` · `/welcome` · `/welcome_toggle` · `/a_ping` · `/aping_toggle`",
      },
      {
        name: "Safety & moderation",
        value: "`/auto_mod` · `/asetup_mod` · `/close_eye`\n`/mlock` is available as a prefix command.",
      },
      {
        name: "Community",
        value: "`/create_giveaway` · `/edit_giveaway` · `/poll` · `/who_is` · `/complain` · `/v`",
      },
      {
        name: "Prefix commands",
        value: `\`${prefix}commands\` · \`${prefix}prefix\` · \`${prefix}mlock add @user\` · \`${prefix}mlock remove @user\`\n\`${prefix}mute\` · \`${prefix}kick\` · \`${prefix}ban\` · \`${prefix}lock\` · \`${prefix}unlock\` · \`${prefix}nuke\` · \`${prefix}raid\`\n\`${prefix}leaderboard\` · \`${prefix}afk\` · \`${prefix}s\` · \`${prefix}cs\` · \`${prefix}v\``,
      },
      {
        name: "Emergency lockdown",
        value: "`?!LOCK!?` · `?!UNLOCK!?` · `?!DELETE!? @user`",
      },
    )
    .setFooter({ text: "Use /help or your prefix followed by commands any time." });
}

// FULL FILE CONTINUES - this was truncated in previous attempts; loading from verified local restore
export async function startMaroon() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    logger.warn("DISCORD_TOKEN is not set; Maroon bot is disabled.");
    return;
  }
  try {
    await registerCommands();
    logger.info("Slash commands registered (global)");
  } catch (error) {
    logger.error({ error }, "Failed to register global slash commands — prefix and ?! commands still work");
  }
  await client.login(token);
}
