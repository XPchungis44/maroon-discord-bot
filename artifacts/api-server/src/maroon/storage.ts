import { and, desc, eq, gt, sql } from "drizzle-orm";
import { db, deletedMessages, guildSettings, maroonComplaints, maroonGiveaways, maroonUserStats } from "@workspace/db";

export type GuildSettings = typeof guildSettings.$inferSelect;
export const LEVEL_CAP = 125;

/** Total qualifying messages required to reach a level: 25, 75, 150, ... */
export function getLevelThreshold(level: number): number {
  if (level <= 0) return 0;
  return (25 * level * (level + 1)) / 2;
}

export function getLevelFromProgress(progress: number, cap = LEVEL_CAP): number {
  const safeProgress = Math.max(0, progress);
  let level = 0;
  while (level < cap && safeProgress >= getLevelThreshold(level + 1)) level += 1;
  return level;
}

export function getLevelProgressRemaining(progress: number, cap = LEVEL_CAP): number {
  const level = getLevelFromProgress(progress, cap);
  if (level >= cap) return 0;
  return Math.max(0, getLevelThreshold(level + 1) - Math.max(0, progress));
}

const defaultSettings = (guildId: string) => ({
  guildId,
  prefix: ".",
  autoModEnabled: false,
  autoModSlurs: true,
  autoModCurseWords: true,
  autoModNsfw: true,
  autoModTimeoutSeconds: 0,
  triggerWords: [] as string[],
  apingEnabled: false,
  apingChannelIds: [] as string[],
  apingDeleteAfterSeconds: 5,
  closeEyeEnabled: false,
  levelSystemEnabled: false,
  levelAnnouncementChannelId: null,
  levelAutoSetup: false,
  levelRoleRewards: [] as Array<{ level: number; roleId: string }>,
  levelMessageTemplate: "{user} reached level {level}!",
  levelCooldownSeconds: 5,
  lockedChannels: {} as Record<string, unknown>,
});

export async function getGuildSettings(guildId: string): Promise<GuildSettings> {
  const existing = await db.query.guildSettings.findFirst({ where: eq(guildSettings.guildId, guildId) });
  if (existing) return existing;
  const [created] = await db.insert(guildSettings).values(defaultSettings(guildId)).onConflictDoNothing().returning();
  if (created) return created;
  const retry = await db.query.guildSettings.findFirst({ where: eq(guildSettings.guildId, guildId) });
  if (!retry) throw new Error(`Could not initialize settings for guild ${guildId}`);
  return retry;
}

export async function updateGuildSettings(guildId: string, patch: Partial<typeof guildSettings.$inferInsert>) {
  await getGuildSettings(guildId);
  const [updated] = await db.update(guildSettings).set({ ...patch, updatedAt: new Date() }).where(eq(guildSettings.guildId, guildId)).returning();
  return updated;
}

export async function incrementMessageStat(guildId: string, userId: string) {
  await db.insert(maroonUserStats).values({ guildId, userId, messagesSent: 1, lastMessageAt: new Date() }).onConflictDoUpdate({
    target: [maroonUserStats.guildId, maroonUserStats.userId],
    set: { messagesSent: sql`${maroonUserStats.messagesSent} + 1`, lastMessageAt: new Date() },
  });
}

export async function awardEligibleLevelProgress(guildId: string, userId: string, qualifyingMessageCount = 1) {
  const count = Math.max(0, Math.floor(qualifyingMessageCount));
  const stat = await getUserStat(guildId, userId);
  const progress = (stat?.levelMessages ?? 0) + count;
  const level = getLevelFromProgress(progress);
  await db.insert(maroonUserStats).values({ guildId, userId, level, levelMessages: progress, levelLastGrantedAt: new Date() }).onConflictDoUpdate({
    target: [maroonUserStats.guildId, maroonUserStats.userId],
    set: { level, levelMessages: progress, levelLastGrantedAt: new Date() },
  });
  return { level, previousLevel: stat?.level ?? 0, levelMessages: progress, leveledUp: level > (stat?.level ?? 0) };
}

export async function getUserLevelStats(guildId: string, userId: string) {
  return getUserStat(guildId, userId);
}

export async function getUserStat(guildId: string, userId: string) {
  return db.query.maroonUserStats.findFirst({ where: and(eq(maroonUserStats.guildId, guildId), eq(maroonUserStats.userId, userId)) });
}

export async function setMemberJoinedAt(guildId: string, userId: string, joinedAt: Date) {
  await db.insert(maroonUserStats).values({ guildId, userId, joinedAt }).onConflictDoUpdate({ target: [maroonUserStats.guildId, maroonUserStats.userId], set: { joinedAt } });
}

export async function incrementInviteJoin(guildId: string, userId: string) {
  await db.insert(maroonUserStats).values({ guildId, userId, inviteJoins: 1 }).onConflictDoUpdate({ target: [maroonUserStats.guildId, maroonUserStats.userId], set: { inviteJoins: sql`${maroonUserStats.inviteJoins} + 1` } });
}

export async function getUserLeaderboard(guildId: string, metric: "messagesSent" | "deletedMessages" | "inviteJoins") {
  const column = maroonUserStats[metric];
  return db.select().from(maroonUserStats).where(metric === "inviteJoins" ? and(eq(maroonUserStats.guildId, guildId), gt(maroonUserStats.inviteJoins, 0)) : eq(maroonUserStats.guildId, guildId)).orderBy(desc(column)).limit(10);
}

export async function recordDeletedMessage(input: { guildId: string; channelId: string; messageId: string; userId: string; content: string }) {
  await db.insert(deletedMessages).values(input);
  await db.insert(maroonUserStats).values({ guildId: input.guildId, userId: input.userId, deletedMessages: 1 }).onConflictDoUpdate({ target: [maroonUserStats.guildId, maroonUserStats.userId], set: { deletedMessages: sql`${maroonUserStats.deletedMessages} + 1` } });
}

export async function listDeletedMessages(guildId: string, channelId: string) {
  return db.select().from(deletedMessages).where(and(eq(deletedMessages.guildId, guildId), eq(deletedMessages.channelId, channelId))).orderBy(desc(deletedMessages.deletedAt)).limit(10);
}

export async function clearDeletedMessages(guildId: string, channelId: string) {
  await db.delete(deletedMessages).where(and(eq(deletedMessages.guildId, guildId), eq(deletedMessages.channelId, channelId)));
}

export async function createGiveaway(input: typeof maroonGiveaways.$inferInsert) {
  const [created] = await db.insert(maroonGiveaways).values(input).returning();
  if (!created) throw new Error("Could not create giveaway");
  return created;
}

export async function getGiveawayByMessage(messageId: string) { return db.query.maroonGiveaways.findFirst({ where: eq(maroonGiveaways.messageId, messageId) }); }
export async function updateGiveaway(id: number, patch: Partial<typeof maroonGiveaways.$inferInsert>) { const [updated] = await db.update(maroonGiveaways).set(patch).where(eq(maroonGiveaways.id, id)).returning(); return updated; }
export async function addGiveawayEntry(id: number, userId: string) {
  const [updated] = await db.update(maroonGiveaways).set({ entries: sql`${maroonGiveaways.entries} || ARRAY[${userId}]::text[]` }).where(and(eq(maroonGiveaways.id, id), eq(maroonGiveaways.status, "active"), sql`NOT (${maroonGiveaways.entries} @> ARRAY[${userId}]::text[])`)).returning();
  return updated;
}

export async function createComplaint(input: typeof maroonComplaints.$inferInsert) { const [created] = await db.insert(maroonComplaints).values(input).returning(); if (!created) throw new Error("Could not create complaint"); return created; }
export async function hasRecentComplaint(userId: string, since: Date) { return Boolean(await db.query.maroonComplaints.findFirst({ where: and(eq(maroonComplaints.userId, userId), sql`${maroonComplaints.createdAt} >= ${since}`) })); }
export async function setComplaintOwnerMessage(id: number, ownerMessageId: string) { await db.update(maroonComplaints).set({ ownerMessageId }).where(eq(maroonComplaints.id, id)); }
export async function getComplaintByOwnerMessage(ownerMessageId: string) { return db.query.maroonComplaints.findFirst({ where: eq(maroonComplaints.ownerMessageId, ownerMessageId) }); }
