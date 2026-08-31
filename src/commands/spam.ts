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
    ).catch(() => {});
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

interface PendingSticker {
  timer: NodeJS.Timeout;
  jid: string;
  senderJid: string;
  msg: proto.IWebMessageInfo;
}
const pendingStickers = new Map<string, PendingSticker>();

const pendingKey = (jid: string, id: string) => `${jid}:${id}`;

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
  if (!enabled) return null;

  const message = msg.message as any;
  if (!message?.stickerMessage) return null;

  const senderJid = cleanUserJid(msg.key.participant || msg.key.remoteJid!);
  const pkey = pendingKey(jid, msg.key.id!);

  // Same sticker event can arrive more than once — don't stack timers.
  if (pendingStickers.has(pkey)) return null;

  await sendHumanLikeResponse(sock, jid, {
    text: `🕐 @${senderJid.split('@')[0]} sticker spotted, delete it within ${STICKER_GRACE_SECONDS}s or you'll catch a spam warning.`,
    mentions: [senderJid]
  }, { quoted: msg });

  const timer = setTimeout(async () => {
    pendingStickers.delete(pkey);

    // Admin may have switched protection off while the timer was running.
    if (!(await getSpamEnabled(jid))) return;

    const liveSock = getSocket();
    if (!liveSock || !isSocketConnected()) return;

    await applyStickerViolation(liveSock, jid, senderJid, msg);
  }, STICKER_GRACE_MS);

  pendingStickers.set(pkey, { timer, jid, senderJid, msg });
  return null;
}

// If the sender deletes the sticker for everyone before the grace window ends,
// drop the pending timer so no warning is issued.
export function handleStickerRevoke(sock: any, msg: proto.IWebMessageInfo): void {
  const origKey = (msg.message as any)?.protocolMessage?.key;
  if (!origKey?.id || !origKey?.remoteJid) return;

  const pkey = pendingKey(origKey.remoteJid, origKey.id);
  const pending = pendingStickers.get(pkey);
  if (!pending) return;

  clearTimeout(pending.timer);
  pendingStickers.delete(pkey);

  sendHumanLikeResponse(sock, pending.jid, {
    text: `✅ @${pending.senderJid.split('@')[0]} deleted it in time, no warning this round.`,
    mentions: [pending.senderJid]
  }, { quoted: msg }).catch(() => { });
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
