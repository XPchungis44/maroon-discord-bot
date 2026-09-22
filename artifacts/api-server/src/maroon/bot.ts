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
  addGiveawayEntry,
  awardEligibleLevelProgress,
  clearDeletedMessages,
  createComplaint,
  createGiveaway,
  getComplaintByOwnerMessage,
  getGiveawayByMessage,
  getGuildSettings,
  getLevelProgressRemaining,
  getLevelThreshold,
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
        value: "`/prefix_m` · `/announcements_channel_set` · `/welcome` · `/welcome_toggle` · `/a_ping` · `/aping` · `/aping_toggle` · `/level`",
      },
      {
        name: "Safety & moderation",
        value: "`/auto_mod` · `/asetup_mod` · `/close_eye`\n`/mlock` is available as a prefix command.",
      },
      {
        name: "Community",
        value: "`/create_giveaway` · `/edit_giveaway` · `/poll` · `/who_is` · `/complain` · `/v` · `/level`",
      },
      {
        name: "Prefix commands",
        value: `\`${prefix}commands\` · \`${prefix}prefix\` · \`${prefix}mlock add @user\` · \`${prefix}mlock remove @user\`\n\`${prefix}mute\` · \`${prefix}kick\` · \`${prefix}ban\` · \`${prefix}lock\` · \`${prefix}unlock\` · \`${prefix}nuke\` · \`${prefix}raid\`\n\`${prefix}level\` · \`${prefix}leaderboard\` · \`${prefix}afk\` · \`${prefix}s\` · \`${prefix}cs\` · \`${prefix}v\``,
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
      .setName("level")
      .setDescription("Show a member's current level and progress")
      .addUserOption((option) => option.setName("user").setDescription("Member to inspect")),
    new SlashCommandBuilder()
      .setName("auto_mod")
      .setDescription("Configure Maroon's automatic moderation")
      .addBooleanOption((option) => option.setName("enabled").setDescription("Enable auto-mod"))
      .addBooleanOption((option) => option.setName("slurs").setDescription("Block slurs"))
      .addBooleanOption((option) => option.setName("curse_words").setDescription("Block curse words"))
      .addBooleanOption((option) => option.setName("nsfw").setDescription("Flag NSFW terms"))
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
      .setName("aping")
      .setDescription("Configure member join pings for one or more channels")
      .addChannelOption((option) =>
        option.setName("channel").setDescription("Channel to ping in").setRequired(true),
      )
      .addBooleanOption((option) =>
        option.setName("enabled").setDescription("Enable this join ping channel").setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("delete_after_seconds")
          .setDescription("How long the ping stays visible")
          .setMinValue(1)
          .setMaxValue(60),
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

  if (name === "level") {
    const targetUser = interaction.options.getUser("user") ?? interaction.user;
    const stat = await getUserStat(guildId, targetUser.id);
    if (!settings.levelSystemEnabled) {
      await respond(interaction, "The level system is disabled in this server.");
      return;
    }
    const level = stat?.level ?? 0;
    const progress = stat?.levelMessages ?? 0;
    const nextThreshold = getLevelThreshold(level + 1);
    const remaining = getLevelProgressRemaining(progress, 125);
    const current = Math.min(progress, nextThreshold || progress);
    const total = nextThreshold > 0 ? nextThreshold : 1;
    const percentage = Math.min(100, Math.round((current / total) * 100));
    const barSize = 20;
    const filled = Math.max(0, Math.round((percentage / 100) * barSize));
    const empty = Math.max(0, barSize - filled);
    const embed = new EmbedBuilder()
      .setColor(0x8b1e3f)
      .setTitle(`${targetUser.tag} • Level ${level}`)
      .setDescription(
        remaining > 0
          ? `Progress: **${progress} / ${nextThreshold}**\n${"█".repeat(filled)}${"░".repeat(empty)} ${percentage}%\n${remaining} messages until level **${level + 1}**.`
          : `Progress: **${progress}**\n${"█".repeat(barSize)} 100%\nMax level reached!`,
      )
      .setFooter({ text: level === 0 ? "Start chatting to earn your first level." : "Keep the momentum going." });
    await respondWithEmbed(interaction, embed);
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
    const endAt = Date.now() + seconds * 1000;
    const embed = new EmbedBuilder()
      .setTitle(`Giveaway: ${prize}`)
      .setDescription(
        `Hosted by ${host}\nSponsored by **${sponsor}**\nWinners: **${winners}**\nEnds <t:${Math.floor(endAt / 1000)}:R>`,
      )
      .setColor(0x8b1e3f)
      .setFooter({ text: "Click Enter to participate. Vote for a higher win chance." });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("maroon_giveaway_join")
        .setLabel("Enter")
        .setStyle(ButtonStyle.Primary),
    );
    const sent = await channel.send({
      content: `[Vote for a higher win chance.](${VOTE_URL})`,
      embeds: [embed],
      components: [row],
    });
    const giveaway = await createGiveaway({
      guildId,
      channelId: channel.id,
      messageId: sent.id,
      hostId: host.id,
      sponsor,
      prize,
      durationSeconds: seconds,
      endsAt: new Date(endAt),
      entries: [],
    });
    await scheduleGiveaway(giveaway.id, channel.id, sent.id, seconds * 1000);
    await respond(interaction, `Giveaway created in ${channel}.`);
    return;
  }
  if (name === "edit_giveaway") {
    const messageId = interaction.options.getString("message_id", true);
    const giveaway = await getGiveawayByMessage(messageId);
    if (!giveaway || (giveaway.hostId !== interaction.user.id && !commandHasPermission(interaction, PermissionFlagsBits.Administrator))) {
      await respond(interaction, "Only the giveaway host or an administrator can edit that giveaway.");
      return;
    }
    const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
    if (!(channel as { isTextBased?: () => boolean } | null)?.isTextBased?.()) {
      await respond(interaction, "I could not find the giveaway channel.");
      return;
    }
    const message = await (channel as TextChannel).messages.fetch(messageId).catch(() => null);
    if (!message) {
      await respond(interaction, "I could not find that giveaway message.");
      return;
    }
    await message.edit({ content: interaction.options.getString("content", true) });
    await respond(interaction, "Giveaway message edited.");
    return;
  }
  if (name === "poll") {
    const question = interaction.options.getString("question", true);
    const options = interaction.options
      .getString("options", true)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 10);
    if (options.length < 2) {
      await respond(interaction, "Add at least two comma-separated options.");
      return;
    }
    await interaction.editReply({
      content: `**${question}**\n${options.map((option, index) => `${index + 1}. ${option}`).join("\n")}\n\nReact with the number of your choice.`,
    });
    return;
  }
  if (name === "who_is") {
    const user = interaction.options.getUser("user") ?? interaction.user;
    const member = await interaction.guild?.members.fetch(user.id).catch(() => null);
    const stats = await getUserStat(guildId, user.id);
    await respond(
      interaction,
      [
        `**${user.tag}**`,
        `Discord account created: <t:${Math.floor(user.createdTimestamp / 1000)}:F>`,
        `Joined this server: ${member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>` : "Unknown"}`,
        `Messages sent here: **${stats?.messagesSent ?? 0}**`,
        `Deleted messages recorded: **${stats?.deletedMessages ?? 0}**`,
      ].join("\n"),
    );
    return;
  }
  if (name === "auto_mod" || name === "asetup_mod") {
    if (!commandHasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
      await respond(interaction, "You need Manage Server to configure auto-mod.");
      return;
    }
    if (name === "asetup_mod") {
      await updateGuildSettings(guildId, {
        autoModEnabled: true,
        autoModSlurs: true,
        autoModCurseWords: true,
        autoModNsfw: true,
        autoModTimeoutSeconds: 0,
        triggerWords: [],
      });
      await respond(interaction, "Safe default auto-mod is enabled. Messages are deleted without timeouts.");
      return;
    }
    const triggerWords = interaction.options
      .getString("trigger_words")
      ?.split(",")
      .map((word) => word.trim().toLowerCase())
      .filter(Boolean);
    await updateGuildSettings(guildId, {
      autoModEnabled: interaction.options.getBoolean("enabled") ?? settings.autoModEnabled,
      autoModSlurs: interaction.options.getBoolean("slurs") ?? settings.autoModSlurs,
      autoModCurseWords: interaction.options.getBoolean("curse_words") ?? settings.autoModCurseWords,
      autoModNsfw: interaction.options.getBoolean("nsfw") ?? settings.autoModNsfw,
      autoModTimeoutSeconds:
        interaction.options.getInteger("timeout_seconds") ?? settings.autoModTimeoutSeconds,
      ...(triggerWords ? { triggerWords } : {}),
    });
    await respond(interaction, "Auto-mod settings saved.");
    return;
  }
  if (name === "aping") {
    if (!commandHasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
      await respond(interaction, "You need Manage Server to configure join pings.");
      return;
    }
    const channel = interaction.options.getChannel("channel", true);
    if (!(channel as { isTextBased?: () => boolean } | null)?.isTextBased?.()) {
      await respond(interaction, "That channel cannot receive join pings.");
      return;
    }
    const enabled = interaction.options.getBoolean("enabled", true);
    const configuredDelay = Math.min(
      60,
      Math.max(1, interaction.options.getInteger("delete_after_seconds") ?? settings.apingDeleteAfterSeconds ?? 5),
    );
    const channels = new Set((settings.apingChannelIds ?? []).filter((id): id is string => typeof id === "string"));
    if (enabled) {
      channels.add(channel.id);
    } else {
      channels.delete(channel.id);
    }
    const nextChannels = [...channels];
    await updateGuildSettings(guildId, {
      apingEnabled: nextChannels.length > 0,
      apingChannelIds: nextChannels,
      apingDeleteAfterSeconds: configuredDelay,
    });
    await respond(
      interaction,
      enabled
        ? `Join pings are enabled for ${channel}. They will delete after ${configuredDelay}s.`
        : `Join ping removed from ${channel}.`,
    );
    return;
  }
  if (name === "a_ping" || name === "aping_toggle") {
    if (!commandHasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
      await respond(interaction, "You need Manage Server to configure join pings.");
      return;
    }
    if (name === "a_ping") {
      const channelId = interaction.options.getChannel("channel", true).id;
      await updateGuildSettings(guildId, { welcomeChannelId: channelId });
      await respond(interaction, "Join ping channel saved. Use `/aping enabled:true` to turn it on.");
    } else {
      await updateGuildSettings(guildId, {
        apingEnabled: interaction.options.getBoolean("enabled", true),
      });
      await respond(interaction, "Join ping setting updated.");
    }
    return;
  }
  if (name === "welcome_toggle" || name === "welcome") {
    if (!commandHasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
      await respond(interaction, "You need Manage Server to configure welcomes.");
      return;
    }
    if (name === "welcome_toggle") {
      await updateGuildSettings(guildId, {
        welcomeEnabled: interaction.options.getBoolean("enabled", true),
      });
      await respond(interaction, "Welcome setting updated.");
    } else {
      const attachment = interaction.options.getAttachment("media");
      await updateGuildSettings(guildId, {
        welcomeChannelId: interaction.options.getChannel("channel", true).id,
        welcomeMessage: interaction.options.getString("message", true),
        welcomeMediaUrl: attachment?.url ?? null,
        welcomeEnabled: true,
      });
      await respond(interaction, "Welcome message saved and enabled.");
    }
    return;
  }
  if (name === "close_eye") {
    if (!commandHasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
      await respond(interaction, "You need Manage Server to configure Close Eye.");
      return;
    }
    await updateGuildSettings(guildId, {
      closeEyeEnabled: interaction.options.getBoolean("enabled", true),
    });
    await respond(interaction, "Close Eye setting updated.");
    return;
  }
  if (name === "complain") {
    const since = new Date(Date.now() - 3 * 86400000);
    if (await hasRecentComplaint(interaction.user.id, since)) {
      await respond(interaction, "You already sent a complaint recently. Try again after the 3-day cooldown.");
      return;
    }
    const complaint = await createComplaint({
      guildId,
      userId: interaction.user.id,
      complaint: interaction.options.getString("message", true),
    });
    const owner = await client.users.fetch(OWNER_ID).catch(() => null);
    if (!owner) {
      await respond(interaction, "Your complaint was saved, but the owner DM is unavailable.");
      return;
    }
    const ownerMessage = await owner.send(
      `Maroon complaint #${complaint.id}\nFrom: ${interaction.user.tag} (${interaction.user.id})\nServer: ${interaction.guild?.name ?? guildId} (${guildId})\n\n${complaint.complaint}\n\nReply to this DM to respond directly to the user.`,
    );
    await setComplaintOwnerMessage(complaint.id, ownerMessage.id);
    await respond(interaction, "Your complaint was sent privately. Thank you for helping improve Maroon.");
    return;
  }
  await respond(interaction, "That command is not available in this version of Maroon. Try `/help`.");
}

async function runPrefixCommand(message: Message, content: string, prefix: string) {
  const tokens = content.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
  const [rawCommand, ...args] = tokens;
  if (!rawCommand) return undefined;
  const command = rawCommand.toLowerCase();
  const member = message.member;
  if (!member || !message.guild) return;
  const reply = (text: string) => message.reply(text).catch(() => undefined);
  const replyEmbed = (embed: EmbedBuilder) => message.reply({ embeds: [embed] }).catch(() => undefined);

  if (command === "help" || command === "commands" || command === "menu" || command === "menu_m") {
    return replyEmbed(helpEmbed(normalizePrefix(prefix) ?? DEFAULT_PREFIX));
  }
  if (command === "level") {
    const settings = await getGuildSettings(message.guild.id);
    if (!settings.levelSystemEnabled) {
      return reply("The level system is disabled in this server.");
    }
    const target = args[0] ? (await resolveMentionedMember(message, args[0])) ?? member : member;
    const stat = await getUserStat(message.guild.id, target.id);
    const level = stat?.level ?? 0;
    const progress = stat?.levelMessages ?? 0;
    const nextThreshold = getLevelThreshold(level + 1);
    const remaining = getLevelProgressRemaining(progress, 125);
    const total = nextThreshold > 0 ? nextThreshold : 1;
    const percentage = Math.min(100, Math.round((Math.min(progress, total) / total) * 100));
    const barSize = 20;
    const filled = Math.max(0, Math.round((percentage / 100) * barSize));
    const empty = Math.max(0, barSize - filled);
    const embed = new EmbedBuilder()
      .setColor(0x8b1e3f)
      .setTitle(`${target.user.tag} • Level ${level}`)
      .setDescription(
        remaining > 0
          ? `Progress: **${progress} / ${nextThreshold}**\n${"█".repeat(filled)}${"░".repeat(empty)} ${percentage}%\n${remaining} messages until level **${level + 1}**.`
          : `Progress: **${progress}**\n${"█".repeat(barSize)} 100%\nMax level reached!`,
      );
    return replyEmbed(embed);
  }
  if (command === "prefix" || command === "prefix_m") {
    if (!memberHasPermission(member, PermissionFlagsBits.ManageGuild)) {
      return reply("You need Manage Server to change the prefix.");
    }
    const requested = args[0]?.toLowerCase() === "set" ? args[1] : args[0];
    if (!requested) return reply(`Current prefix: \`${prefix}\`. Usage: ${prefix}prefix set <new-prefix>`);
    const nextPrefix = normalizePrefix(requested);
    if (!nextPrefix) {
      return reply("Choose a prefix from 1–7 characters without spaces or `/`; `?!` is reserved for lockdown commands.");
    }
    await updateGuildSettings(message.guild.id, { prefix: nextPrefix });
    return reply(`Prefix changed to \`${nextPrefix}\`. Use \`${nextPrefix}commands\` for help.`);
  }
  if (command === "v") return reply(`[Vote for a higher win chance.](${VOTE_URL})`);
  if (command === "afk" || command === "a") {
    const reason = args.join(" ") || "AFK";
    afkUsers.set(`${message.guild.id}:${message.author.id}`, reason);
    return reply(`You are now marked as AFK: ${reason}`);
  }
  if (command === "s") {
    const rows = await listDeletedMessages(message.guild.id, message.channel.id);
    return reply(
      rows.length
        ? rows.map((row, index) => `${index + 1}. <@${row.userId}>: ${row.content.slice(0, 150)}`).join("\n")
        : "No deleted messages are recorded in this channel.",
    );
  }
  if (command === "cs") {
    if (!memberHasPermission(member, PermissionFlagsBits.ManageMessages)) return reply("You need Manage Messages.");
    await clearDeletedMessages(message.guild.id, message.channel.id);
    return reply("Deleted message history cleared for this channel.");
  }
  if (command === "leaderboard" || command === "li" || command === "lm" || command === "ld" || command === "ldm") {
    const requestedMetric = command === "li" || (command === "leaderboard" && args[0]?.toLowerCase() === "invites")
      ? "inviteJoins"
      : command === "ld" || command === "ldm" || (command === "leaderboard" && args[0]?.toLowerCase() === "deleted")
        ? "deletedMessages"
        : "messagesSent";
    const rows = await getUserLeaderboard(message.guild.id, requestedMetric);
    if (!rows.length) return reply("There is not enough activity recorded yet.");
    const label = requestedMetric === "inviteJoins" ? "invites" : requestedMetric === "deletedMessages" ? "deleted messages" : "messages";
    return reply(`**Leaderboard: ${label}**\n${rows.map((row, index) => `${index + 1}. <@${row.userId}> — ${row[requestedMetric]}`).join("\n")}`);
  }
  if (command === "mlock" || command === "mlockm") {
    if (!memberHasPermission(member, PermissionFlagsBits.ManageMessages)) return reply("You need Manage Messages.");
    const action = args[0]?.toLowerCase();
    if (action === "list") {
      const settings = await getGuildSettings(message.guild.id);
      const lockedMembers = getLockedMemberIds(settings);
      return reply(
        lockedMembers.length
          ? `**Member locks (${lockedMembers.length})**\n${lockedMembers.map((userId) => `<@${userId}>`).join(", ")}`
          : "No members are currently locked.",
      );
    }
    if (action !== "add" && action !== "remove" && action !== "del") {
      return reply(`Usage: ${prefix}mlock add @user | ${prefix}mlock remove @user | ${prefix}mlock list`);
    }
    const target = await resolveMentionedMember(message, args[1]);
    if (!target) return reply(`Usage: ${prefix}mlock ${action} @user`);
    if (target.id === message.guild.ownerId || target.id === OWNER_ID) {
      return reply("The server owner and Maroon owner cannot be member-locked.");
    }
    const settings = await getGuildSettings(message.guild.id);
    const lockedMembers = getLockedMemberIds(settings);
    if (action === "add") {
      if (lockedMembers.includes(target.id)) return reply(`${target} is already member-locked.`);
      await updateGuildSettings(message.guild.id, {
        lockedChannels: withLockedMemberIds(settings, [...lockedMembers, target.id]),
      });
      return reply(`${target} is now member-locked. Their messages will be removed.`);
    }
    if (!lockedMembers.includes(target.id)) return reply(`${target} is not member-locked.`);
    await updateGuildSettings(message.guild.id, {
      lockedChannels: withLockedMemberIds(
        settings,
        lockedMembers.filter((userId) => userId !== target.id),
      ),
    });
    return reply(`${target} is no longer member-locked.`);
  }
  if (command === "mute") {
    if (!memberHasPermission(member, PermissionFlagsBits.MuteMembers)) return reply("You need Mute Members.");
    const target = message.mentions.members?.first();
    if (!target) return reply(`Usage: ${prefix}mute @user [duration] [reason]`);
    const seconds = durationSeconds(args.find((arg) => durationSeconds(arg) !== null) ?? "5m") ?? 300;
    const reason = args.filter((arg) => durationSeconds(arg) === null).slice(1).join(" ") || "No reason provided";
    await target.timeout(seconds * 1000, reason).catch(() => undefined);
    await target.send(`You were muted in **${message.guild.name}** for ${seconds}s because: ${reason}`).catch(() => undefined);
    return reply(`${target} was muted for ${seconds}s.`);
  }
  if (command === "kick") {
    if (!memberHasPermission(member, PermissionFlagsBits.KickMembers)) return reply("You need Kick Members.");
    const target = message.mentions.members?.first();
    if (!target) return reply(`Usage: ${prefix}kick @user [reason]`);
    const reason = args.slice(1).join(" ") || "No reason provided";
    await target.send(`You were kicked from **${message.guild.name}** because of: ${reason}\n\n*${message.guild.id} kicked by ${message.author.id}*`).catch(() => undefined);
    await target.kick(reason);
    return reply(`${target.user.tag} was kicked.`);
  }
  if (command === "ban") {
    if (!memberHasPermission(member, PermissionFlagsBits.BanMembers)) return reply("You need Ban Members.");
    const target = message.mentions.members?.first();
    if (!target) return reply(`Usage: ${prefix}ban @user [duration] [reason]`);
    const secondsArg = args.find((arg) => durationSeconds(arg) !== null);
    const seconds = secondsArg ? durationSeconds(secondsArg) : null;
    const reason = args.filter((arg) => arg !== secondsArg).slice(1).join(" ") || "No reason provided";
    await target.send(`You were banned from **${message.guild.name}** because of: ${reason}\n\n*${message.guild.id} banned by ${message.author.id}*`).catch(() => undefined);
    await target.ban({ reason });
    if (seconds) setTimeout(() => message.guild?.members.unban(target.id, "Temporary ban ended").catch(() => undefined), seconds * 1000);
    return reply(`${target.user.tag} was banned${seconds ? ` for ${seconds}s` : ""}.`);
  }
  if (command === "nuke" || command === "nke") {
    if (!memberHasPermission(member, PermissionFlagsBits.ManageChannels)) return reply("You need Manage Channels.");
    if (!message.channel.isTextBased() || !("clone" in message.channel)) return reply("This channel cannot be nuked.");
    const cloned = await message.channel.clone({ reason: `Nuked by ${message.author.tag}` });
    await message.channel.delete();
    return cloned.send("Channel rebuilt with Maroon's nuke command. Review permissions before reopening it.");
  }
  if (command === "raid" || command === "rd") {
    if (!memberHasPermission(member, PermissionFlagsBits.ManageChannels) && !memberHasPermission(member, PermissionFlagsBits.ManageMessages)) {
      return reply("You need Manage Channels or Manage Messages.");
    }
    if (!message.channel.isTextBased() || !("bulkDelete" in message.channel)) return reply("This channel cannot be raided.");
    const messages = await message.channel.messages.fetch({ limit: 100 });
    const bulkDeleteChannel = message.channel;
    if (!("bulkDelete" in bulkDeleteChannel)) return reply("This channel cannot be raided.");
    await bulkDeleteChannel.bulkDelete(messages.filter((entry) => entry.author.id !== message.author.id && Date.now() - entry.createdTimestamp < 86400000), true);
    return reply("Removed other users' messages from the last day.");
  }
  if (command === "lock") {
    if (!memberHasPermission(member, PermissionFlagsBits.KickMembers) || !memberHasPermission(member, PermissionFlagsBits.ManageMessages)) {
      return reply("You need Kick Members and Manage Messages.");
    }
    if (!message.channel.isTextBased() || !("permissionOverwrites" in message.channel)) return reply("This channel cannot be locked.");
    const settings = await getGuildSettings(message.guild.id);
    const existing = message.channel.permissionOverwrites.cache.get(message.guild.roles.everyone.id);
    await updateGuildSettings(message.guild.id, {
      lockedChannels: {
        ...settings.lockedChannels,
        [message.channel.id]: existing
          ? { allow: existing.allow.bitfield.toString(), deny: existing.deny.bitfield.toString() }
          : null,
      },
    });
    await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
    return reply("Channel locked for regular members.");
  }
  if (command === "unlock") {
    if (!memberHasPermission(member, PermissionFlagsBits.KickMembers) || !memberHasPermission(member, PermissionFlagsBits.ManageMessages)) {
      return reply("You need Kick Members and Manage Messages.");
    }
    if (!message.channel.isTextBased() || !("permissionOverwrites" in message.channel)) return reply("This channel cannot be unlocked.");
    const settings = await getGuildSettings(message.guild.id);
    const snapshot = settings.lockedChannels[message.channel.id] as { allow?: string; deny?: string } | null | undefined;
    if (snapshot?.allow || snapshot?.deny) {
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, {
        SendMessages: null,
      });
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, {
        SendMessages: (BigInt(snapshot.allow ?? "0") & PermissionFlagsBits.SendMessages) !== 0n
          ? true
          : (BigInt(snapshot.deny ?? "0") & PermissionFlagsBits.SendMessages) !== 0n
            ? false
            : null,
      });
    } else {
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null });
    }
    const { [message.channel.id]: _removed, ...remainingLocks } = settings.lockedChannels;
    await updateGuildSettings(message.guild.id, { lockedChannels: remainingLocks });
    return reply("Channel unlocked.");
  }
  return undefined;
}

async function handleLockdown(message: Message) {
  if (!message.guild || !message.member) return false;
  const content = message.content.trim().toUpperCase();
  const hasPermissions =
    message.member.id === OWNER_ID ||
    (message.member.permissions.has(PermissionFlagsBits.KickMembers) &&
      message.member.permissions.has(PermissionFlagsBits.ManageMessages));
  if (!hasPermissions) return false;
  if (content === "?!LOCK!?") {
    if (!message.channel.isTextBased() || !("permissionOverwrites" in message.channel)) return true;
    const settings = await getGuildSettings(message.guild.id);
    const existing = message.channel.permissionOverwrites.cache.get(message.guild.roles.everyone.id);
    await updateGuildSettings(message.guild.id, {
      lockedChannels: {
        ...settings.lockedChannels,
        [message.channel.id]: existing
          ? { allow: existing.allow.bitfield.toString(), deny: existing.deny.bitfield.toString() }
          : null,
      },
    });
    await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
    await message.channel.send("Channel locked. Staff with the required permissions can still speak.");
    return true;
  }
  if (content === "?!UNLOCK!?") {
    if (!message.channel.isTextBased() || !("permissionOverwrites" in message.channel)) return true;
    const settings = await getGuildSettings(message.guild.id);
    const snapshot = settings.lockedChannels[message.channel.id] as { allow?: string; deny?: string } | null | undefined;
    await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, {
      SendMessages: snapshot?.allow && (BigInt(snapshot.allow) & PermissionFlagsBits.SendMessages) !== 0n
        ? true
        : snapshot?.deny && (BigInt(snapshot.deny) & PermissionFlagsBits.SendMessages) !== 0n
          ? false
          : null,
    });
    const { [message.channel.id]: _removed, ...remainingLocks } = settings.lockedChannels;
    await updateGuildSettings(message.guild.id, { lockedChannels: remainingLocks });
    await message.channel.send("Channel unlocked.");
    return true;
  }
  if (content.startsWith("?!DELETE!?")) {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return true;
    const target = message.mentions.users.first();
    if (!target || !message.channel.isTextBased() || !("messages" in message.channel)) return true;
    const messages = await message.channel.messages.fetch({ limit: 100 });
    const deleteChannel = message.channel;
    if (!("bulkDelete" in deleteChannel)) return true;
    await deleteChannel.bulkDelete(messages.filter((entry) => entry.author.id === target.id), true);
    return true;
  }
  return false;
}

async function handleAutoMod(message: Message) {
  if (!message.guild || message.author.bot) return false;
  const settings = await getGuildSettings(message.guild.id);
  const lower = message.content.toLowerCase();
  const terms = [
    ...(settings.autoModSlurs ? blockedTerms.slurs : []),
    ...(settings.autoModCurseWords ? blockedTerms.curseWords : []),
    ...(settings.autoModNsfw ? blockedTerms.nsfw : []),
    ...settings.triggerWords,
  ];
  const matched = settings.autoModEnabled && terms.some((term) => lower.includes(term));
  const suspiciousAttachment =
    settings.closeEyeEnabled &&
    message.attachments.some((attachment) => /(\.gif|\.png|\.jpg|\.jpeg|\.webp)$/i.test(attachment.url));
  const suspiciousContent = settings.closeEyeEnabled && (settings.triggerWords.some((word) => lower.includes(word)) || blockedTerms.nsfw.some((word) => lower.includes(word)));
  if ((suspiciousAttachment || suspiciousContent) && !message.author.bot) {
    const owner = await client.users.fetch(OWNER_ID).catch(() => null);
    await owner?.send(`Close Eye flagged an attachment in ${message.guild.name} from ${message.author.tag}: ${message.url}`).catch(() => undefined);
  }
  if (!matched) return false;
  await message.delete().catch(() => undefined);
  if (settings.autoModTimeoutSeconds > 0 && message.member?.moderatable) {
    await message.member.timeout(settings.autoModTimeoutSeconds * 1000, "Maroon auto-mod").catch(() => undefined);
  }
  return true;
}

client.once("clientReady", async (readyClient) => {
  readyClient.user.setActivity(`Bot modding ${readyClient.guilds.cache.size} servers`);
  logger.info({ guilds: readyClient.guilds.cache.size }, "Maroon is online");
  await Promise.all(
    [...readyClient.guilds.cache.values()].map((guild) =>
      registerGuildCommands(guild.id).catch((error: unknown) =>
        logger.warn({ error, guildId: guild.id }, "Could not register guild slash commands"),
      ),
    ),
  );
  for (const guild of readyClient.guilds.cache.values()) {
    await getGuildSettings(guild.id).catch((error: unknown) => logger.error({ error }, "Could not initialize guild settings"));
    await refreshGuildInvites(guild);
  }
});

client.on("guildCreate", (guild) => {
  client.user?.setActivity(`Bot modding ${client.guilds.cache.size} servers`);
  void getGuildSettings(guild.id);
  void refreshGuildInvites(guild);
  void registerGuildCommands(guild.id).catch((error: unknown) =>
    logger.warn({ error, guildId: guild.id }, "Could not register guild slash commands"),
  );
});

client.on("guildMemberAdd", async (member) => {
  await attributeInviteJoin(member.guild).catch((error: unknown) => {
    logger.warn({ error, guildId: member.guild.id, userId: member.id }, "Could not attribute invite join");
    return null;
  });
  await setMemberJoinedAt(member.guild.id, member.id, new Date()).catch((error: unknown) => {
    logger.error({ error, guildId: member.guild.id, userId: member.id }, "Could not record member join");
  });
  const settings = await getGuildSettings(member.guild.id);
  const welcomeChannel = settings.welcomeChannelId
    ? await member.guild.channels.fetch(settings.welcomeChannelId).catch(() => null)
    : null;
  if (settings.apingEnabled && Array.isArray(settings.apingChannelIds) && settings.apingChannelIds.length > 0) {
    const deleteDelayMs = Math.max(1000, (settings.apingDeleteAfterSeconds ?? 5) * 1000);
    for (const channelId of settings.apingChannelIds) {
      const channel = await member.guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased()) continue;
      const ping = await channel.send(`${member}`).catch(() => null);
      if (ping) setTimeout(() => ping.delete().catch(() => undefined), deleteDelayMs);
    }
  }
  if (settings.welcomeEnabled && settings.welcomeMessage && welcomeChannel?.isTextBased()) {
    await welcomeChannel.send({
      content: settings.welcomeMessage.replaceAll("{user}", `${member}`).replaceAll("{server}", member.guild.name),
      files: settings.welcomeMediaUrl ? [new AttachmentBuilder(settings.welcomeMediaUrl)] : [],
    }).catch((error: unknown) => {
      logger.warn({ error, guildId: member.guild.id }, "Could not send welcome message");
    });
  }
});

client.on("inviteCreate", (invite) => {
  if (!invite.guild || !("invites" in invite.guild)) return;
  const guild = invite.guild;
  void queueGuildInviteOperation(guild.id, () => refreshGuildInvites(guild));
});

client.on("inviteDelete", (invite) => {
  if (!invite.guild || !("invites" in invite.guild)) return;
  const guild = invite.guild;
  void queueGuildInviteOperation(guild.id, () => refreshGuildInvites(guild));
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.guild) {
    if (message.author.id === OWNER_ID && message.reference?.messageId) {
      const complaint = await getComplaintByOwnerMessage(message.reference.messageId);
      if (complaint) {
        const user = await client.users.fetch(complaint.userId).catch(() => null);
        await user?.send(`Maroon owner response:\n\n${message.content}`).catch(() => undefined);
      }
    }
    return;
  }
  await incrementMessageStat(message.guild.id, message.author.id);
  const afkKey = `${message.guild.id}:${message.author.id}`;
  if (afkUsers.has(afkKey)) {
    afkUsers.delete(afkKey);
    await message.reply("Welcome back — your AFK status is cleared.").catch(() => undefined);
  }
  for (const user of message.mentions.users.values()) {
    const reason = afkUsers.get(`${message.guild.id}:${user.id}`);
    if (reason) await message.reply(`${user} is AFK: ${reason}`).catch(() => undefined);
  }
  const settings = await getGuildSettings(message.guild.id);
  if (getLockedMemberIds(settings).includes(message.author.id)) {
    await message.delete().catch(() => undefined);
    return;
  }
  const autoModTriggered = await handleAutoMod(message);
  if (autoModTriggered) return;
  const lockdownHandled = await handleLockdown(message);
  if (lockdownHandled) return;

  if (settings.levelSystemEnabled) {
    const result = await awardEligibleLevelProgress(message.guild.id, message.author.id, 1);
    if (result.leveledUp) {
      const member = await message.guild.members.fetch(message.author.id).catch(() => null);
      const reward = settings.levelRoleRewards?.find((entry) => entry.level === result.level);
      if (reward && member && message.guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
        await member.roles.add(reward.roleId).catch(() => undefined);
      }
      if (settings.levelAnnouncementChannelId) {
        const channel = await message.guild.channels.fetch(settings.levelAnnouncementChannelId).catch(() => null);
        if (channel?.isTextBased()) {
          const content = (settings.levelMessageTemplate ?? "{user} reached level {level}!")
            .replaceAll("{user}", `${message.author}`)
            .replaceAll("{level}", String(result.level));
          await channel.send(content).catch(() => undefined);
        }
      }
    }
  }

  const configuredPrefix = normalizePrefix(settings.prefix) ?? DEFAULT_PREFIX;
  if (message.content.startsWith(configuredPrefix)) {
    await runPrefixCommand(message, message.content, configuredPrefix);
    return;
  }
  if (configuredPrefix !== DEFAULT_PREFIX && message.content.startsWith(DEFAULT_PREFIX)) {
    const fallbackCommand = message.content
      .slice(DEFAULT_PREFIX.length)
      .trim()
      .split(/\s+/, 1)[0]
      ?.toLowerCase();
    if (["help", "commands", "menu", "prefix", "prefix_m", "level"].includes(fallbackCommand ?? "")) {
      await runPrefixCommand(message, message.content, DEFAULT_PREFIX);
    }
  }
});

client.on("messageDelete", async (message) => {
  if (!message.guild || !message.author || message.author.bot || !message.content) return;
  await recordDeletedMessage({
    guildId: message.guild.id,
    channelId: message.channel.id,
    messageId: message.id,
    userId: message.author.id,
    content: message.content,
  }).catch((error: unknown) => logger.error({ error }, "Could not record deleted message"));
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) await handleInteraction(interaction);
    if (interaction.isButton() && interaction.customId === "maroon_giveaway_join") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const message = interaction.message;
      const giveaway = await getGiveawayByMessage(message.id);
      if (!giveaway || giveaway.status !== "active") {
        await interaction.editReply({ content: "That giveaway has ended." });
        return;
      }
      const updated = await addGiveawayEntry(giveaway.id, interaction.user.id);
      if (!updated) {
        const latest = await getGiveawayByMessage(message.id);
        await interaction.editReply({
          content: latest?.status === "active" ? "You are already entered." : "That giveaway has ended.",
        });
        return;
      }
      await interaction.editReply({ content: "You are entered. Good luck." });
    }
  } catch (error) {
    logger.error({ error, interaction: interaction.id }, "Interaction failed");
    if (interaction.isChatInputCommand()) {
      await respond(interaction, "Maroon could not complete that command.", true).catch(() => undefined);
    } else if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: "Maroon could not complete that command." }).catch(() => undefined);
      } else {
        await interaction.reply({ content: "Maroon could not complete that command.", flags: MessageFlags.Ephemeral }).catch(() => undefined);
      }
    }
  }
});

export async function startMaroon() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    logger.warn("DISCORD_TOKEN is not set; Maroon bot is disabled.");
    return;
  }
  await registerCommands();
  await client.login(token);
}
