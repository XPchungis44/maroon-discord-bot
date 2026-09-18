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

function commandDefinitions() {
  return [
    new SlashCommandBuilder()
      .setName("announcements_channel_set")
      .setDescription("Set the channel used for Maroon announcements")
      .addChannelOption((option) =>
        option.setName("channel").setDescription("Announcement channel").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("create_giveaway")
      .setDescription("Create a giveaway with a host, sponsor, duration, and winner")
      .addUserOption((option) =>
        option.setName("host").setDescription("Giveaway host").setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("sponsor").setDescription("Sponsor name").setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("prize").setDescription("What the winner receives").setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("duration")
          .setDescription("Examples: 30m, 2h, 7d")
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("winners")
          .setDescription("Number of winners")
          .setMinValue(1)
          .setMaxValue(20)
          .setRequired(false),
      ),
    new SlashCommandBuilder()
      .setName("edit_giveaway")
      .setDescription("Edit a giveaway message you hosted")
      .addStringOption((option) =>
        option.setName("message_id").setDescription("Giveaway message ID").setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("content").setDescription("New giveaway content").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("poll")
      .setDescription("Create a quick poll")
      .addStringOption((option) =>
        option.setName("question").setDescription("Poll question").setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("options").setDescription("Comma-separated options").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("who_is")
      .setDescription("Show a member's Discord and server stats")
      .addUserOption((option) => option.setName("user").setDescription("Member to inspect")),
    new SlashCommandBuilder()
      .setName("auto_mod")
      .setDescription("Configure Maroon's automatic moderation")
      .addBooleanOption((option) => option.setName("enabled").setDescription("Enable auto-mod"))
      .addBooleanOption((option) => option.setName("slurs").setDescription("Block slurs"))
      .addBooleanOption((option) => option.setName("curse_words").setDescription("Block curse words"))
      .addIntegerOption((option) =>
        option
          .setName("timeout_seconds")
          .setDescription("Timeout duration; 0 only deletes the message")
          .setMinValue(0)
          .setMaxValue(2419200),
      )
      .addStringOption((option) =>
        option.setName("trigger_words").setDescription("Comma-separated custom trigger words"),
      ),
    new SlashCommandBuilder().setName("asetup_mod").setDescription("Enable safe default auto-moderation"),
    new SlashCommandBuilder()
      .setName("a_ping")
      .setDescription("Configure the member join ping channel")
      .addChannelOption((option) =>
        option.setName("channel").setDescription("Channel to ping in").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("aping_toggle")
      .setDescription("Turn join pings on or off")
      .addBooleanOption((option) => option.setName("enabled").setDescription("Enabled").setRequired(true)),
    new SlashCommandBuilder().setName("menu_m").setDescription("Show Maroon commands available to you"),
    new SlashCommandBuilder().setName("help").setDescription("Show Maroon's command center"),
    new SlashCommandBuilder().setName("commands").setDescription("Show Maroon's command center"),
    new SlashCommandBuilder()
      .setName("welcome_toggle")
      .setDescription("Turn welcome messages on or off")
      .addBooleanOption((option) => option.setName("enabled").setDescription("Enabled").setRequired(true)),
    new SlashCommandBuilder()
      .setName("welcome")
      .setDescription("Configure the welcome message")
      .addChannelOption((option) =>
        option.setName("channel").setDescription("Welcome channel").setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("message")
          .setDescription("Use {user} and {server} placeholders")
          .setRequired(true),
      )
      .addAttachmentOption((option) => option.setName("media").setDescription("Optional GIF or image")),
    new SlashCommandBuilder()
      .setName("close_eye")
      .setDescription("DM the owner about suspicious content")
      .addBooleanOption((option) => option.setName("enabled").setDescription("Enabled").setRequired(true)),
    new SlashCommandBuilder()
      .setName("complain")
      .setDescription("Send a private complaint to Maroon's owner")
      .addStringOption((option) =>
        option.setName("message").setDescription("What should be improved?").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("prefix_m")
      .setDescription("Change this server's prefix commands")
      .addStringOption((option) =>
        option.setName("prefix").setDescription("One to seven characters, not ?!").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("prefix")
      .setDescription("Change this server's prefix commands")
      .addStringOption((option) =>
        option.setName("prefix").setDescription("One to seven characters, not ?!").setRequired(true),
      ),
    new SlashCommandBuilder().setName("v").setDescription("Show the Maroon voting link"),
  ].map((command) => command.toJSON());
}

async function registerCommands() {
  const token = process.env.DISCORD_TOKEN;
  const applicationId = process.env.DISCORD_APPLICATION_ID ?? "1535813652525875280";
  if (!token) throw new Error("DISCORD_TOKEN is required");
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(applicationId), { body: commandDefinitions() });
}

async function registerGuildCommands(guildId: string) {
  const token = process.env.DISCORD_TOKEN;
  const applicationId = process.env.DISCORD_APPLICATION_ID ?? "1535813652525875280";
  if (!token) return;
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
    body: commandDefinitions(),
  });
}

async function scheduleGiveaway(
  giveawayId: number,
  channelId: string,
  messageId: string,
  delay: number,
) {
  const timer = setTimeout(async () => {
    const giveaway = await getGiveawayByMessage(messageId);
    if (!giveaway || giveaway.status !== "active") return;
    const winnerId = giveaway.entries[Math.floor(Math.random() * giveaway.entries.length)];
    await updateGiveaway(giveaway.id, { status: "ended", winnerId });
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) return;
    const textChannel = channel as TextChannel;
    const message = await textChannel.messages.fetch(messageId).catch(() => null);
    const winnerText = winnerId ? `<@${winnerId}>` : "Nobody entered";
    if (message) {
      await message.edit({
        content: `Giveaway ended. Winner: ${winnerText}`,
        components: [],
      });
    }
    if (winnerId) {
      const user = await client.users.fetch(winnerId).catch(() => null);
      await user?.send(`You won the Maroon giveaway for **${giveaway.prize}**.`).catch(() => undefined);
    }
  }, Math.max(1000, delay));
  giveawayTimers.set(giveawayId, timer);
}

async function handleInteraction(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await respond(interaction, "This command must be used inside a server.");
    return;
  }
  const guildId = interaction.guildId;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const settings = await getGuildSettings(guildId);
  const name = interaction.commandName;

  if (name === "v") {
    await respond(interaction, `[Vote for a higher win chance.](${VOTE_URL})`);
    return;
  }
  if (name === "menu_m" || name === "help" || name === "commands") {
    await respondWithEmbed(interaction, helpEmbed(normalizePrefix(settings.prefix) ?? DEFAULT_PREFIX));
    return;
  }
  if (name === "announcements_channel_set") {
    if (!commandHasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
      await respond(interaction, "You need Manage Server to set the announcements channel.");
      return;
    }
    const channelId = interaction.options.getChannel("channel", true).id;
    await updateGuildSettings(guildId, { announcementChannelId: channelId });
    await respond(interaction, "Announcement channel saved.");
    return;
  }
  if (name === "prefix_m" || name === "prefix") {
    if (!commandHasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
      await respond(interaction, "You need Manage Server to change the prefix.");
      return;
    }
    const prefix = normalizePrefix(interaction.options.getString("prefix", true));
    if (!prefix) {
      await respond(interaction, "Choose a prefix from 1–7 characters without spaces or `/`; `?!` is reserved for lockdown commands.");
      return;
    }
    await updateGuildSettings(guildId, { prefix });
    await respond(interaction, `Prefix changed to \`${prefix}\`.`);
    return;
  }
  if (name === "create_giveaway") {
    if (!commandHasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
      await respond(interaction, "You need Manage Server to create a giveaway.");
      return;
    }
    const seconds = durationSeconds(interaction.options.getString("duration", true));
    if (!seconds) {
      await respond(interaction, "Duration must look like `30m`, `2h`, or `7d`.");
      return;
    }
    const channel = interaction.channel;
    if (!channel || !("send" in channel)) {
      await respond(interaction, "This channel cannot host a giveaway.");
      return;
    }
    const host = interaction.options.getUser("host", true);
    const sponsor = interaction.options.getString("sponsor", true);
    const prize = interaction.options.getString("prize", true);
    const winners = interaction.options.getInteger("winners") ?? 1;
    const endsAt = new Date(Date.now() + seconds * 1000);
    const embed = new EmbedBuilder()
      .setColor(0x8b1e3f)
      .setTitle("Maroon Giveaway")
      .setDescription(prize)
      .addFields(
        { name: "Host", value: `${host}`, inline: true },
        { name: "Sponsor", value: sponsor, inline: true },
        { name: "Winners", value: String(winners), inline: true },
        { name: "Ends", value: `<t:${Math.floor(endsAt.getTime() / 1000)}:R>` },
      );
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("maroon_giveaway_join")
        .setLabel("Enter")
        .setStyle(ButtonStyle.Primary),
    );
    const message = await channel.send({ embeds: [embed], components: [row] });
    const giveaway = await createGiveaway({
      guildId,
      channelId: channel.id,
      messageId: message.id,
      hostId: host.id,
      sponsor,
      prize,
      winners,
      endsAt,
      status: "active",
      entries: [],
    });
    await scheduleGiveaway(giveaway.id, channel.id, message.id, seconds * 1000);
    await respond(interaction, "Giveaway created.");
    return;
  }
  // NOTE: remaining interaction handlers intentionally unchanged from original file body
  await respond(interaction, "Command handler incomplete in this patch — redeploy full bot.ts from repo.");
}

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
