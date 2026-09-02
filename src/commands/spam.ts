import { proto } from '@whiskeysockets/baileys';
import { Command, sendHumanLikeResponse, isSenderGroupAdmin } from './index';
import { getDb } from '../db/mongodb';
import { isSocketConnected, getSocket } from '../bot';
import { cleanUserJid } from './warn';

const prefix = process.env.BOT_PREFIX || '/';

// SPAM PROTECTION

const SPAM_SETTINGS_COL = 'spam_settings';
const STICKER_VIOLATIONS_COL = 'spam_sticker_violations';
export const STICKER_LIMIT = parseInt(process.env.STICKER_SPAM_LIMIT || '3', 10);
const WARN_EXPIRE_DAYS = parseInt(process.env.WARN_EXPIRE_DAYS || '30', 10);
let stickerTtlIndexReady = false;

export async function getSpamEnabled(groupId: string): Promise<boolean> {
  try {
    const doc = await getDb().collection(SPAM_SETTINGS_COL).findOne({ _id: groupId } as any);
    return doc?.enabled ?? false;
  } catch {
    return false;
  }
}

export async function setSpamEnabled(groupId: string, enabled: boolean): Promise<void> {
  await getDb().collection(SPAM_SETTINGS_COL).updateOne(
    { _id: groupId } as any,
    {
      $set: { enabled, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() }
    },
    { upsert: true }
  );
}

async function getUserViolationQuery(userId: string): Promise<any[]> {
  const cleanedUserId = cleanUserJid(userId);
  const queries: any[] = [{ userId: cleanedUserId }];

  try {
    const mapCol = getDb().collection('lid_phone_map');
    if (cleanedUserId.endsWith('@lid')) {
      const mapping = await mapCol.findOne({ _id: cleanedUserId } as any);
      if (mapping?.phoneJid) queries.push({ userId: mapping.phoneJid });
    } else if (cleanedUserId.endsWith('@s.whatsapp.net')) {
      const mapping = await mapCol.findOne({ phoneJid: cleanedUserId } as any);
      if (mapping?._id) queries.push({ userId: String(mapping._id) });
    }
  } catch {
    // ignore
  }

  return queries;
}

async function incrementStickerViolation(groupId: string, userId: string): Promise<number> {
  const userQueries = await getUserViolationQuery(userId);
  const col = getDb().collection(STICKER_VIOLATIONS_COL);

  // Auto-expire sticker warnings 30 days after the last one (MongoDB TTL index, created once).
  if (!stickerTtlIndexReady) {
    stickerTtlIndexReady = true;
    col.createIndex(
      { lastViolationAt: 1 },
      { expireAfterSeconds: WARN_EXPIRE_DAYS * 24 * 60 * 60, name: 'sticker_violation_ttl' }
    ).catch(() => { });
  }

  const filter = { groupId, $or: userQueries };

  const doc = await col.findOne(filter);

  if (doc) {
    await col.updateOne(
      { _id: doc._id },
      { $inc: { count: 1 }, $set: { lastViolationAt: new Date() } }
    );
    return (doc.count || 0) + 1;
  }

  const cleanedUserId = cleanUserJid(userId);
  await col.insertOne({
    groupId,
    userId: cleanedUserId,
    count: 1,
    lastViolationAt: new Date(),
    createdAt: new Date()
  });

  return 1;
}

async function resetStickerViolations(groupId: string, userId: string): Promise<void> {
  const userQueries = await getUserViolationQuery(userId);
  await getDb().collection(STICKER_VIOLATIONS_COL).deleteMany({
    groupId,
    $or: userQueries
  });
}

export async function getStickerViolationCount(groupId: string, userId: string): Promise<number> {
  const userQueries = await getUserViolationQuery(userId);
  const doc = await getDb().collection(STICKER_VIOLATIONS_COL).findOne({ groupId, $or: userQueries } as any);
  return doc?.count || 0;
}

async function kickUserForSpam(sock: any, groupId: string, userId: string, reason: string): Promise<void> {
  try {
    const metadata = await sock.groupMetadata(groupId);
    const canonicalUserId = cleanUserJid(userId);

    const participant = metadata.participants.find((p: any) => {
      const pId = cleanUserJid(p.id);
      const pLid = p.lid ? cleanUserJid(p.lid) : null;
      const pJid = p.jid ? cleanUserJid(p.jid) : null;

      return pId === canonicalUserId ||
        (pLid && pLid === canonicalUserId) ||
        (pJid && pJid === canonicalUserId);
    });

    if (!participant) return;

    await sock.groupParticipantsUpdate(groupId, [participant.id], 'remove');

    await sendHumanLikeResponse(sock, groupId, {
      text: `🚫 *Auto-Kicked for Spam*\n\nUser @${canonicalUserId.split('@')[0]} has been removed from the group.\n*Reason:* ${reason}`,
      mentions: [canonicalUserId]
    });
  } catch (err) {
    console.error('[SpamProtection] Failed to kick user:', err);
  }
}

// How long a sender gets to delete a sticker before it counts as a violation.
const STICKER_GRACE_SECONDS = parseInt(process.env.STICKER_GRACE_SECONDS || '30', 10);
const STICKER_GRACE_MS = STICKER_GRACE_SECONDS * 1000;
const STICKER_BURST_KICK_LIMIT = parseInt(process.env.STICKER_BURST_LIMIT || '3', 10);
const BLACKLIST_COL = 'spam_blacklist';

interface PendingBurst {
  timer: NodeJS.Timeout;
  jid: string;
  senderJid: string;
  msg: proto.IWebMessageInfo;
  count: number;
  msgIds: Set<string>;
}
const pendingBursts = new Map<string, PendingBurst>();
const burstKey = (jid: string, sender: string) => `${jid}:${sender}`;

async function addToBlacklist(groupId: string, userId: string): Promise<void> {
  try {
    await getDb().collection(BLACKLIST_COL).updateOne(
      { groupId, userId: cleanUserJid(userId) } as any,
      { $set: { groupId, userId: cleanUserJid(userId), reason: 'sticker spam burst', at: new Date() } },
      { upsert: true }
    );
  } catch { /* ignore */ }
}

export async function isBlacklisted(groupId: string, userId: string): Promise<boolean> {
  try {
    const doc = await getDb().collection(BLACKLIST_COL).findOne({ groupId, userId: cleanUserJid(userId) } as any);
    return !!doc;
  } catch { return false; }
}

// Records one confirmed sticker violation and hands out the warning (or the boot).
async function applyStickerViolation(sock: any, jid: string, senderJid: string, msg: proto.IWebMessageInfo): Promise<'kicked' | 'warned'> {
  const violationCount = await incrementStickerViolation(jid, senderJid);

  if (violationCount >= STICKER_LIMIT) {
    await sendHumanLikeResponse(sock, jid, {
      text: `🚨 @${senderJid.split('@')[0]} FINAL WARNING ${STICKER_LIMIT}/${STICKER_LIMIT} — You have been warned ${STICKER_LIMIT} times for sticker spam. You are being removed from the group.`,
      mentions: [senderJid]
    }, { quoted: msg });

    setTimeout(async () => {
      if (!isSocketConnected()) return;
      try {
        await kickUserForSpam(sock, jid, senderJid, `Reached ${STICKER_LIMIT}/${STICKER_LIMIT} sticker spam violations`);
      } catch {
        // ignore
      }
    }, 1000);

    await resetStickerViolations(jid, senderJid);
    return 'kicked';
  }

  await sendHumanLikeResponse(sock, jid, {
    text: `⚠️ *Sticker Spam Warning ${violationCount}/${STICKER_LIMIT}* @${senderJid.split('@')[0]}\n\nPlease stop sending stickers. You will be removed from the group on your ${STICKER_LIMIT}th warning.`,
    mentions: [senderJid]
  }, { quoted: msg });

  return 'warned';
}

export async function checkStickerSpam(sock: any, msg: proto.IWebMessageInfo): Promise<'kicked' | 'warned' | null> {
  const jid = msg.key.remoteJid!;
  if (!jid.endsWith('@g.us')) return null;

  const enabled = await getSpamEnabled(jid);
  if (process.env.SPAM_DEBUG) console.log('[SpamProtection] sticker check enabled=', enabled, 'jid=', jid);
  if (!enabled) return null;

  const message = msg.message as any;
  if (!message?.stickerMessage) return null;

  const senderJid = cleanUserJid(msg.key.participant || msg.key.remoteJid!);

  // Group admins are exempt — don't track or punish their stickers.
  if (await isSenderGroupAdmin(sock, msg)) return null;

  // Already blacklisted for sticker spam — boot immediately, no grace.
  if (await isBlacklisted(jid, senderJid)) {
    const liveSock = getSocket();
    if (liveSock && isSocketConnected()) {
      await kickUserForSpam(liveSock, jid, senderJid, 'Blacklisted for sticker spam');
    }
    return null;
  }

  // Group stickers from the same sender into one burst session.
  const bkey = burstKey(jid, senderJid);
  let entry = pendingBursts.get(bkey);

  // First sticker in the burst — open a single grace window.
  if (!entry) {
    entry = { jid, senderJid, msg, count: 0, msgIds: new Set(), timer: null! };
    entry.timer = setTimeout(async () => {
      pendingBursts.delete(bkey);

      // Admin may have switched protection off while the timer was running.
      if (!(await getSpamEnabled(jid))) return;

      const liveSock = getSocket();
      if (!liveSock || !isSocketConnected()) return;

      if (process.env.SPAM_DEBUG) console.log('[SpamProtection] grace window expired for', senderJid, 'in', jid, '-> applying violation');
      await applyStickerViolation(liveSock, jid, senderJid, entry.msg);
    }, STICKER_GRACE_MS);
    pendingBursts.set(bkey, entry);
  }

  // Ignore the same sticker delivered more than once (retries / re-ups shouldn't inflate the burst).
  if (entry.msgIds.has(msg.key.id!)) return null;
  entry.msgIds.add(msg.key.id!);

  entry.count++;

  // Burst spam: more than the limit in one go — blacklist and kick on the spot.
  if (entry.count > STICKER_BURST_KICK_LIMIT) {
    clearTimeout(entry.timer);
    pendingBursts.delete(bkey);
    const liveSock = getSocket();
    if (liveSock && isSocketConnected()) {
      await addToBlacklist(jid, senderJid);
      await kickUserForSpam(liveSock, jid, senderJid, `Sticker spam burst (more than ${STICKER_BURST_KICK_LIMIT} stickers at once)`);
    }
    return null;
  }

  // Notify only on the first sticker so we don't flood the chat.
  if (entry.count === 1) {
    if (process.env.SPAM_DEBUG) console.log('[SpamProtection] sending grace notice for', senderJid, 'in', jid);
    await sendHumanLikeResponse(sock, jid, {
      text: `🕐 @${senderJid.split('@')[0]} sticker spotted, delete it within ${STICKER_GRACE_SECONDS}s or you'll catch a spam warning.`,
      mentions: [senderJid]
    }, { quoted: msg });
  }

  return null;
}

// Cancel a pending grace window for a specific sticker (group + message id).
// Called when a sender deletes the sticker for everyone before the grace period ends,
// or from the messages.update 'deleted' listener as a secondary signal.
export function cancelPendingSticker(groupId: string, msgId: string): void {
  for (const [bkey, entry] of pendingBursts) {
    if (entry.jid === groupId && entry.msgIds.has(msgId)) {
      clearTimeout(entry.timer);
      pendingBursts.delete(bkey);
      if (process.env.SPAM_DEBUG) {
        console.log(`[SpamProtection] Grace window cancelled for ${msgId} in ${groupId} (sticker deleted)`);
      }
      return;
    }
  }
}

// If the sender deletes a sticker for everyone before the grace window ends,
// drop the pending timer so no warning is issued.
export function handleStickerRevoke(sock: any, msg: proto.IWebMessageInfo): void {
  const origKey = (msg.message as any)?.protocolMessage?.key;
  if (!origKey?.id || !origKey?.remoteJid) return;
  cancelPendingSticker(origKey.remoteJid, origKey.id);
}

export async function checkSpam(sock: any, msg: proto.IWebMessageInfo): Promise<'kicked' | 'warned' | null> {
  const proto = (msg.message as any)?.protocolMessage;
  if (proto?.type === 'REVOKE') {
    handleStickerRevoke(sock, msg);
    return null;
  }
  return await checkStickerSpam(sock, msg);
}

export const spamCommand: Command = {
  name: 'spam',
  aliases: ['antispam', 'spamprotection'],
  description: 'Admin: Toggle automatic spam protection on/off.',
  execute: async (sock, msg, args) => {
    const jid = msg.key.remoteJid!;

    if (!jid.endsWith('@g.us')) {
      await sendHumanLikeResponse(sock, jid, { text: '❌ This command can only be used in groups.' }, { quoted: msg });
      return;
    }

    const isAdmin = await isSenderGroupAdmin(sock, msg);
    if (!isAdmin) {
      await sendHumanLikeResponse(sock, jid, { text: '❌ Only group admins can manage spam protection.' }, { quoted: msg });
      return;
    }

    const action = args[0]?.toLowerCase();

    if (action === 'on') {
      await setSpamEnabled(jid, true);
      await sendHumanLikeResponse(sock, jid, {
        text: `✅ *Spam protection ENABLED.*\n\n• Stickers: each sticker sent counts as a warning\n  Warning 1/${STICKER_LIMIT} → ... → Warning ${STICKER_LIMIT}/${STICKER_LIMIT} + kick`
      }, { quoted: msg });
    } else if (action === 'off') {
      await setSpamEnabled(jid, false);
      await sendHumanLikeResponse(sock, jid, { text: '❌ *Spam protection DISABLED.*' }, { quoted: msg });
    } else {
      const enabled = await getSpamEnabled(jid);
      await sendHumanLikeResponse(sock, jid, {
        text: `🛡️ *Spam Protection:* ${enabled ? 'ENABLED ✅' : 'DISABLED ❌'}\n\nUse \`${prefix}spam on\` or \`${prefix}spam off\` to toggle.`
      }, { quoted: msg });
    }
  }
};

/**
 * Command: /rm-warn <@user | phone | reply>
 * Admin/Group-admin: clears a member's sticker-spam warnings in this group.
 */
export const rmWarnCommand: Command = {
  name: 'rm-warn',
  aliases: ['rmwarn', 'remove-sticker-warn', 'clear-sticker-warn', 'reset-sticker-warn'],
  description: 'Admin/Group-admin: Removes a member\'s sticker-spam warnings in this group.',
  execute: async (sock, msg, args) => {
    const jid = msg.key.remoteJid!;

    // 1. Group-only
    if (!jid.endsWith('@g.us')) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '❌ *Error:* This command can only be executed within a group chat.' },
        { quoted: msg }
      );
      return;
    }

    // 2. Authorisation: developer OR group admin
    const isAdmin = await isSenderGroupAdmin(sock, msg);
    if (!isAdmin) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '❌ *Access Denied:* Only group admins can remove sticker warnings.' },
        { quoted: msg }
      );
      return;
    }

    // 3. Identify target JID
    const ctxInfo: any = (msg.message as any)?.extendedTextMessage?.contextInfo
      || (msg.message as any)?.imageMessage?.contextInfo
      || (msg.message as any)?.videoMessage?.contextInfo
      || null;

    let targetJid: string | null = null;

    if (ctxInfo?.participant) {
      targetJid = ctxInfo.participant;
    } else if (ctxInfo?.mentionedJid && ctxInfo.mentionedJid.length > 0) {
      targetJid = ctxInfo.mentionedJid[0];
    } else if (args.length > 0) {
      const rawArg = args[0].trim().replace(/^@/, '');
      const digits = rawArg.replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 15) {
        targetJid = `${digits}@s.whatsapp.net`;
      }
    }

    if (!targetJid) {
      await sendHumanLikeResponse(
        sock,
        jid,
        {
          text: `⚠️ *Usage Error:* Mention a user or reply to their message to remove sticker warnings.\n\n*Example:*\n- \`${prefix}rm-warn @user\``
        },
        { quoted: msg }
      );
      return;
    }

    targetJid = cleanUserJid(targetJid);
    await resetStickerViolations(jid, targetJid);

    await sendHumanLikeResponse(
      sock,
      jid,
      {
        text: `✅ Sticker warnings cleared for @${targetJid.split('@')[0]}.\nThey're back to 0/${STICKER_LIMIT}.`,
        mentions: [targetJid]
      },
      { quoted: msg }
    );
  },
};

/**
 * Command: /rm-blacklist <@user | phone | reply>
 * Admin/Group-admin: removes a member from the sticker-spam blacklist.
 */
export const rmBlacklistCommand: Command = {
  name: 'rm-blacklist',
  aliases: ['rmblacklist', 'unblacklist', 'removeblacklist', 'whitelist'],
  description: 'Admin/Group-admin: Removes a member from the sticker-spam blacklist.',
  execute: async (sock, msg, args) => {
    const jid = msg.key.remoteJid!;

    if (!jid.endsWith('@g.us')) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '❌ *Error:* This command can only be executed within a group chat.' },
        { quoted: msg }
      );
      return;
    }

    const isAdmin = await isSenderGroupAdmin(sock, msg);
    if (!isAdmin) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: '❌ *Access Denied:* Only group admins can remove users from the blacklist.' },
        { quoted: msg }
      );
      return;
    }

    const ctxInfo: any = (msg.message as any)?.extendedTextMessage?.contextInfo
      || (msg.message as any)?.imageMessage?.contextInfo
      || (msg.message as any)?.videoMessage?.contextInfo
      || null;

    let targetJid: string | null = null;

    if (ctxInfo?.participant) {
      targetJid = ctxInfo.participant;
    } else if (ctxInfo?.mentionedJid && ctxInfo.mentionedJid.length > 0) {
      targetJid = ctxInfo.mentionedJid[0];
    } else if (args.length > 0) {
      const rawArg = args[0].trim().replace(/^@/, '');
      const digits = rawArg.replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 15) {
        targetJid = `${digits}@s.whatsapp.net`;
      }
    }

    if (!targetJid) {
      await sendHumanLikeResponse(
        sock,
        jid,
        {
          text: `⚠️ *Usage Error:* Mention a user or reply to their message to un-blacklist them.\n\n*Example:*\n- \`${prefix}rm-blacklist @user\``
        },
        { quoted: msg }
      );
      return;
    }

    targetJid = cleanUserJid(targetJid);

    let targetPhone: string | null = null;
    let targetLid: string | null = null;

    if (targetJid.endsWith('@lid')) {
      targetLid = targetJid;
    } else if (targetJid.endsWith('@s.whatsapp.net')) {
      targetPhone = targetJid;
      try {
        const db = getDb();
        const mapping = await db.collection('lid_phone_map').findOne({ phoneJid: targetJid } as any);
        if (mapping) {
          targetLid = String(mapping._id);
        }
      } catch { /* ignore */ }
    }

    const db = getDb();
    const blacklistCol = db.collection(BLACKLIST_COL);

    const userQuery = {
      $or: [
        { userId: targetJid },
        ...(targetPhone ? [{ userId: targetPhone }] : []),
        ...(targetLid ? [{ userId: targetLid }] : [])
      ]
    };

    const result = await blacklistCol.deleteMany({ groupId: jid, ...userQuery } as any);

    await sendHumanLikeResponse(
      sock,
      jid,
      {
        text: result.deletedCount > 0
          ? `✅ *Removed @${targetJid.split('@')[0]} from the sticker-spam blacklist.*`
          : `ℹ️ *@${targetJid.split('@')[0]}* is not on the blacklist.`,
        mentions: [targetJid]
      },
      { quoted: msg }
    );
  },
};
