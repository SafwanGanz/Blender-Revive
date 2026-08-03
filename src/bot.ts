import makeWASocket, {
  DisconnectReason,
  makeCacheableSignalKeyStore,
  proto,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import dotenv from 'dotenv';
import { getDb } from './db/mongodb';
import { useMongoDBAuthState } from './auth/mongo-auth';
import { queueMessage } from './queue/message-queue';
import { storeLidPhoneMapping, captureGroupParticipantMappings, resolvePhoneFromLid } from './db/lid-phone-map';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Suppress noisy "Closing session" dumps from libsignal's session_record.js.
// libsignal uses console.info to log entire SessionEntry objects on every session close,
// flooding the terminal with hundreds of lines of binary buffer data.
const originalConsoleInfo = console.info;
console.info = (...args: any[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('Closing session')) return;
  originalConsoleInfo.apply(console, args);
};

// Initialize the pino logger for Baileys.
// Changing log level to 'warn' to hide verbose protocol frames and decrypt retries, 
// leaving only critical connection statuses and warnings.
const logger = pino({ level: 'warn' });

let sockInstance: any = null;

// --- Connection state management ---
// Tracks whether the socket is currently connected and alive.
// All async/delayed operations MUST check this before using the socket.
let isConnected = false;

// Track all active setTimeout handles so we can cancel them on disconnect.
// This prevents delayed callbacks (welcome messages, privacy tokens, etc.)
// from firing on a dead socket and causing cascading errors.
const activeTimeouts = new Set<ReturnType<typeof setTimeout>>();

/**
 * Creates a tracked setTimeout that auto-cleans up and can be cancelled on disconnect.
 */
function trackedTimeout(fn: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const handle = setTimeout(() => {
    activeTimeouts.delete(handle);
    fn();
  }, delayMs);
  activeTimeouts.add(handle);
  return handle;
}

/**
 * Cancels all pending tracked timeouts. Called on every disconnect.
 */
function cancelAllPendingTimeouts(): void {
  for (const handle of activeTimeouts) {
    clearTimeout(handle);
  }
  activeTimeouts.clear();
  console.log('[Bot] Cancelled all pending background timeouts.');
}

// Exponential backoff state for reconnection
let reconnectAttempt = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 5000; // 5 seconds
const MAX_RECONNECT_DELAY_MS = 60000; // 60 seconds cap

/**
 * Utility to normalize JIDs.
 */
function cleanJid(jid: string): string {
  const parts = jid.split('@');
  const user = parts[0].split(':')[0];
  const domain = parts[1] || 's.whatsapp.net';
  return `${user}@${domain}`;
}

/**
 * Returns the active WhatsApp socket instance.
 */
export function getSocket() {
  return sockInstance;
}

/**
 * Returns whether the socket is currently connected.
 */
export function isSocketConnected(): boolean {
  return isConnected;
}

/**
 * Main function to initialize and start the WhatsApp Bot.
 * Handles authentication, database state sync, socket events, and auto-reconnection.
 */
export async function startWhatsAppBot(): Promise<any> {
  const db = getDb();
  const sessionId = process.env.SESSION_ID || 'blender-revive-session';

  console.log(`[Bot] Initializing session: ${sessionId}...`);

  // Load custom MongoDB authentication state
  const { state, saveCreds } = await useMongoDBAuthState(db, sessionId);

  // Fetch the latest WhatsApp Web version dynamically to avoid 405/connection close errors
  let version: any = [2, 3000, 1015901307]; // Fallback version
  try {
    const latestVersion = await fetchLatestBaileysVersion();
    version = latestVersion.version;
    console.log(`[Bot] Successfully fetched latest WhatsApp Web version: ${version.join('.')}`);
  } catch (err) {
    console.warn('[Bot] Failed to fetch latest WhatsApp version, using fallback version.', err);
  }

  // Establish WASocket connection
  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false, // We will custom print with qrcode-terminal for better styling
    auth: {
      creds: state.creds,
      // Wrap MongoDB key store with in-memory caching to optimize read speed!
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    // High-performance connection tuning
    connectTimeoutMs: 60000,          // Wait up to 60s for initial handshake
    keepAliveIntervalMs: 15000,       // Send keep-alive ping frames every 15s (reduced from 30s for better connection persistence)
    defaultQueryTimeoutMs: 90000,     // Wait up to 90s for queries (resolves 'init queries' timeouts)
    emitOwnEvents: false,             // Do not process messages sent by ourselves in listeners
  });

  sockInstance = sock;

  // 1. Credentials sync event
  sock.ev.on('creds.update', async () => {
    await saveCreds();
  });

  // 1b. Capture LID → Phone JID mappings from WhatsApp's phone number sharing protocol.
  // This fires when WhatsApp reveals the phone number behind a LID.
  // Note: chats.phoneNumberShare is deprecated/not emitted in Baileys v7.
  // (sock.ev.on as any)('chats.phoneNumberShare', async ({ lid, jid }: any) => {
  //   console.log(`[Bot] Phone number share captured: ${lid} -> ${jid}`);
  //   await storeLidPhoneMapping(lid, jid);
  // });

  // 1c. Capture LID↔Phone mappings from contact sync events.
  // These fire during history sync and whenever contacts are updated.
  // Contact objects may contain both `lid` (LID) and `id`/`jid` (phone) fields.
  const captureContactMappings = async (contacts: Array<{ id: string; lid?: string; jid?: string; name?: string; notify?: string; verifiedName?: string }>) => {
    const db = getDb();
    const mapCollection = db.collection('lid_phone_map');
    const referralsCollection = db.collection('referrals');

    const mapOps: any[] = [];
    const referralOps: any[] = [];

    for (const contact of contacts) {
      const lid = contact.id?.endsWith('@lid') ? contact.id : (contact.lid?.endsWith('@lid') ? contact.lid : null);
      const phoneJid = contact.id?.endsWith('@s.whatsapp.net') ? contact.id : (contact.jid?.endsWith('@s.whatsapp.net') ? contact.jid : null);

      if (lid && phoneJid) {
        mapOps.push({
          updateOne: {
            filter: { _id: lid },
            update: {
              $set: {
                phoneJid,
                updatedAt: new Date(),
              },
            },
            upsert: true,
          },
        });
      }

      // Capture and update name if available and username is currently 'Unknown'
      const name = contact.notify || contact.name || contact.verifiedName;
      if (name && name !== 'Unknown') {
        if (lid) {
          referralOps.push({
            updateOne: {
              filter: { _id: lid, username: 'Unknown' } as any,
              update: { $set: { username: name } }
            }
          });
        }
        if (phoneJid) {
          referralOps.push({
            updateOne: {
              filter: { _id: phoneJid, username: 'Unknown' } as any,
              update: { $set: { username: name } }
            }
          });
          referralOps.push({
            updateOne: {
              filter: { phoneJid: phoneJid, username: 'Unknown' } as any,
              update: { $set: { username: name } }
            }
          });
        }
      }
    }

    try {
      const promises: Promise<any>[] = [];
      if (mapOps.length > 0) {
        promises.push(mapCollection.bulkWrite(mapOps, { ordered: false }));
      }
      if (referralOps.length > 0) {
        promises.push(referralsCollection.bulkWrite(referralOps, { ordered: false }));
      }
      if (promises.length > 0) {
        await Promise.all(promises);
        // Only log when actual LID mappings were written (skip no-op contact syncs)
        if (mapOps.length > 0) {
          console.log(`[Bot] Mapped ${mapOps.length} LID→Phone contacts, updated ${referralOps.length} usernames.`);
        }
      }
    } catch (err) {
      console.error('[Bot] Bulk contact write failed:', err);
    }
  };

  /**
   * Captures group names (subjects) to the `groups` collection so the KPI
   * dashboard can display readable group names instead of raw JID hashes.
   */
  const captureGroupNames = async (groups: Record<string, any>): Promise<void> => {
    try {
      const db = getDb();
      const groupsCollection = db.collection('groups');
      const ops: any[] = [];

      for (const [gid, group] of Object.entries(groups)) {
        const name = group.subject;
        if (!name) continue;
        ops.push({
          updateOne: {
            filter: { _id: gid },
            update: { $set: { name, updatedAt: new Date() } },
            upsert: true,
          },
        });
      }

      if (ops.length > 0) {
        await groupsCollection.bulkWrite(ops, { ordered: false });
        console.log(`[Bot] Captured ${ops.length} group names.`);
      }
    } catch (err) {
      console.error('[Bot] Failed to capture group names:', err);
    }
  };

  sock.ev.on('contacts.upsert', async (contacts: any[]) => {
    await captureContactMappings(contacts);
  });

  sock.ev.on('contacts.update', async (contacts: any[]) => {
    await captureContactMappings(contacts);
  });

  // 1d. Capture mappings from history sync (contains contacts with both id and lid)
  sock.ev.on('messaging-history.set', async ({ contacts }: any) => {
    if (contacts && Array.isArray(contacts)) {
      console.log(`[Bot] History sync: ${contacts.length} contacts, scanning for LID mappings...`);
      await captureContactMappings(contacts);
    }
  });

  // 2. Connection updates (QR generation, opened, closed)
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n[Bot] Scan this QR Code to log in:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'connecting') {
      console.log('[Bot] Connecting to WhatsApp...');
    }

    if (connection === 'open') {
      console.log('[Bot] Connection successfully established with WhatsApp!');
      isConnected = true;
      reconnectAttempt = 0; // Reset backoff counter on successful connection

      // Check account reachout timelock status
      trackedTimeout(async () => {
        if (!isConnected) return;
        try {
          const timelockStatus = await sock.fetchAccountReachoutTimelock();
          console.log(`[Bot] Reachout Timelock Status:`, JSON.stringify(timelockStatus));
          if (timelockStatus.isActive) {
            const endsAt = timelockStatus.timeEnforcementEnds;
            console.warn(`[Bot] ⚠️ Account is under REACH-OUT TIME-LOCK! Ends at: ${endsAt ? endsAt.toISOString() : 'unknown'}`);
          } else {
            console.log('[Bot] ✅ Account is NOT under reach-out time-lock.');
          }
        } catch (err) {
          if (!isConnected) return; // Swallow errors if we disconnected mid-flight
          console.error('[Bot] Failed to fetch reachout timelock status:', err);
        }
      }, 3000);

      // Proactively issue privacy tokens for known contacts
      trackedTimeout(async () => {
        if (!isConnected) return;
        try {
          const lidMapCollection = getDb().collection('lid_phone_map');
          const allMappings = await lidMapCollection.find({}).toArray();
          const lids = allMappings.map((m: any) => m.lid).filter((lid: string) => lid && lid.endsWith('@lid'));
          
          if (lids.length > 0) {
            console.log(`[Bot] Proactively issuing privacy tokens for ${lids.length} known contacts...`);
            // Issue in batches of 10 to avoid overwhelming the server
            for (let i = 0; i < lids.length; i += 10) {
              if (!isConnected) {
                console.log('[Bot] Connection lost during privacy token issuance, aborting.');
                return;
              }
              const batch = lids.slice(i, i + 10);
              try {
                await sock.issuePrivacyTokens(batch);
              } catch (batchErr: any) {
                if (!isConnected) return;
                // Silently skip failed batches — non-critical operation
              }
              // Small delay between batches
              await new Promise(r => setTimeout(r, 500));
            }
            console.log(`[Bot] Privacy token issuance complete.`);
          }
        } catch (err) {
          if (!isConnected) return;
          console.error('[Bot] Proactive token issuance failed (non-fatal):', err);
        }
      }, 8000);

      // Background: Scan all groups to harvest LID↔Phone participant mappings & usernames.
      // This runs once on each connection open, building the mapping table so
      // DM mentions can resolve LIDs to clickable phone JIDs.
      trackedTimeout(async () => {
        if (!isConnected) return;
        try {
          console.log('[Bot] Starting background group scan for LID→Phone mappings and usernames...');
          const groups = await sock.groupFetchAllParticipating();
          if (!isConnected) return;
          const groupIds = Object.keys(groups);

          // Capture group names (subjects) for KPI dashboard display
          await captureGroupNames(groups);

          for (const gid of groupIds) {
            if (!isConnected) {
              console.log('[Bot] Connection lost during group scan, aborting.');
              return;
            }
            const group = groups[gid];
            if (group.participants) {
              await captureGroupParticipantMappings(group.participants);
            }
          }

          console.log(`[Bot] Group scan complete: ${groupIds.length} groups scanned.`);
        } catch (err) {
          if (!isConnected) return;
          console.error('[Bot] Background group scan failed (non-fatal):', err);
        }
      }, 5000); // Wait 5s after connection to avoid flooding
    }

    if (connection === 'close') {
      // Capture whether we were previously connected (for smart 401 handling)
      const wasConnected = isConnected;

      // Mark as disconnected IMMEDIATELY to stop all in-flight async operations
      isConnected = false;
      sockInstance = null;

      // Cancel all pending delayed operations (welcome messages, privacy tokens, group scans)
      cancelAllPendingTimeouts();

      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const reasonTag = (lastDisconnect?.error as any)?.data?.content?.[0]?.tag
        || (lastDisconnect?.error as any)?.output?.payload?.message
        || 'unknown';

      // Smart reconnection logic:
      // - 401 (loggedOut/device_removed) BEFORE ever connecting = dead credentials, don't retry
      // - 401 AFTER being connected (mid-session) = transient, retry with backoff
      // - Other codes (408 timeout, 503 unavailable, etc.) = always retry
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isDeadCredentials = isLoggedOut && !wasConnected;
      const canRetry = reconnectAttempt < MAX_RECONNECT_ATTEMPTS;
      const shouldReconnect = !isDeadCredentials && (!isLoggedOut || canRetry);

      console.log(
        `[Bot] Connection closed. Reason: ${reasonTag} (code: ${statusCode}). ` +
        `Was connected: ${wasConnected}. Attempt: ${reconnectAttempt + 1}/${MAX_RECONNECT_ATTEMPTS}. Reconnecting: ${shouldReconnect}`
      );

      if (isDeadCredentials) {
        console.log('[Bot] ❌ Credentials are invalid (401 before connection was established).');
        console.log('[Bot] Please delete credentials in MongoDB and re-scan QR code.');
        return;
      }

      if (shouldReconnect) {
        reconnectAttempt++;
        // Exponential backoff: 5s, 10s, 20s, 40s, 60s, 60s...
        const delay = Math.min(
          BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempt - 1),
          MAX_RECONNECT_DELAY_MS
        );
        console.log(`[Bot] Re-establishing connection in ${delay / 1000}s (attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})...`);
        setTimeout(() => startWhatsAppBot(), delay);
      } else {
        console.log('[Bot] ❌ Exhausted all reconnection attempts.');
        console.log('[Bot] Please delete credentials in MongoDB and re-scan QR code to reconnect.');
      }
    }
  });

  // 2b. Welcome message and verification for new group participants
  // NOTE: Welcome DMs are DISABLED to prevent cascading crashes when the socket
  // disconnects during the 15-35s delay window. Only a lightweight group mention
  // is sent, guarded by connection state checks.
  sock.ev.on('group-participants.update', async (update) => {
    const { id, participants, action } = update;

    // Only handle when users join/are added to the group
    if (action === 'add') {
      console.log(`[Bot] Participants added to group ${id}:`, participants);
      
      // Delay the welcome message processing by 15 seconds to allow the user to fully join the chat
      trackedTimeout(async () => {
        // GUARD: Abort if connection was lost during the delay
        if (!isConnected) {
          console.log('[Bot] Skipping welcome message — connection lost during delay.');
          return;
        }

        try {
          const db = getDb();
          const referralsCollection = db.collection('referrals');
          const prefix = process.env.BOT_PREFIX || '/';

          // Import sendHumanLikeResponse dynamically to avoid circular dependencies
          const { sendHumanLikeResponse } = await import('./commands');

          // Bot identification details
          const envBotNumber = process.env.BOT_NUMBER || '';
          const cleanEnvBotNumber = envBotNumber.replace(/\D/g, ''); // Extract only digits
          const botJid = sock.user?.id ? cleanJid(sock.user.id) : '';

          // Collect unregistered participants for a single group welcome
          const unregisteredMentions: { targetJid: string }[] = [];

          for (const participant of participants) {
            if (!isConnected) return; // Bail mid-loop if disconnected

            const cleanedParticipant = cleanJid(participant.id);

            // Skip if the participant is the bot itself
            const isBot = (botJid && cleanedParticipant === botJid) || 
                          (cleanEnvBotNumber && cleanedParticipant.split('@')[0] === cleanEnvBotNumber);
            if (isBot) continue;

            // Resolve phone JID from LID if needed (DB-only, no socket query to be safe)
            let resolvedPhone: string | null = null;
            if (cleanedParticipant.endsWith('@lid')) {
              try {
                const { getPhoneJidFromLid } = await import('./db/lid-phone-map');
                resolvedPhone = await getPhoneJidFromLid(cleanedParticipant);
              } catch (err) {
                console.error(`[Bot] Failed to resolve phone JID for participant: ${cleanedParticipant}`, err);
              }
            }

            try {
              // Check if they are registered in the database
              const existing = await referralsCollection.findOne({
                $or: [
                  { _id: cleanedParticipant },
                  ...(resolvedPhone ? [{ phoneJid: resolvedPhone }] : [])
                ],
                deletedAt: { $exists: false }
              } as any);

              if (!existing) {
                const targetJid = resolvedPhone || cleanedParticipant;
                unregisteredMentions.push({ targetJid });

                // --- WELCOME DMs DISABLED ---
                // DMs were causing cascading Connection Closed errors when the socket
                // disconnected during the stagger delays. The group mention below
                // is sufficient to notify new joiners.
                // To re-enable, uncomment the DM block below and add connection guards.
              }
            } catch (err) {
              console.error(`[Bot] Failed to verify registration status for participant ${cleanedParticipant}:`, err);
            }
          }

          // Send a short group welcome message after an extra delay
          // to allow WhatsApp cipher key exchange to complete for the new member
          if (unregisteredMentions.length > 0) {
            trackedTimeout(async () => {
              // GUARD: Check connection again before sending
              if (!isConnected) {
                console.log('[Bot] Skipping group welcome — connection lost during delay.');
                return;
              }
              try {
                const mentionTags = unregisteredMentions.map(u => `@${u.targetJid.split('@')[0]}`).join(' ');
                const mentionJids = unregisteredMentions.map(u => u.targetJid);

                const groupWelcome = `🎁 *Welcome!* ${mentionTags}\n\nRegister with \`${prefix}reg-ref <companyName>\` to unlock referral access! 💬`;

                await sendHumanLikeResponse(sock, id, {
                  text: groupWelcome,
                  mentions: mentionJids
                });
              } catch (grpErr) {
                if (!isConnected) return; // Swallow if disconnected
                console.error('[Bot] Failed to send group welcome message:', grpErr);
              }
            }, 20000); // Additional 20s delay (35s total from join)
          }
        } catch (err) {
          if (!isConnected) return;
          console.error('[Bot] Failed to process delayed welcome message:', err);
        }
      }, 15000);
    }
  });

  // 3. Message Upsert Event
  // Whenever a new message is received (in group or private chat), we queue it instantly.
  sock.ev.on('messages.upsert', async (m) => {
    if (m.type === 'notify') {
      for (const msg of m.messages) {
        // Optimization: Pre-filter out messages without body content (e.g. protocol messages) before queueing
        if (!msg.message) continue;

        // Capture and update name if available and username is currently 'Unknown'
        const senderJid = msg.key.participant || msg.key.remoteJid;
        const pushName = msg.pushName;
        if (senderJid && pushName && pushName !== 'Unknown') {
          const cleanSender = cleanJid(senderJid);
          try {
            const referralsCollection = getDb().collection('referrals');
            await referralsCollection.updateOne(
              { _id: cleanSender, username: 'Unknown' } as any,
              { $set: { username: pushName } }
            );
            if (cleanSender.endsWith('@s.whatsapp.net')) {
              await referralsCollection.updateOne(
                { phoneJid: cleanSender, username: 'Unknown' } as any,
                { $set: { username: pushName } }
              );
            }
          } catch (err) {
            // ignore
          }
        }

        // Log incoming DM messages to a file
        const jid = msg.key.remoteJid;
        if (jid && !jid.endsWith('@g.us') && jid !== 'status@broadcast' && !msg.key.fromMe) {
          try {
            const logsDir = path.join(__dirname, '../logs');
            if (!fs.existsSync(logsDir)) {
              fs.mkdirSync(logsDir, { recursive: true });
            }
            const logFilePath = path.join(logsDir, 'dm-messages.log');
            const logEntry = {
              timestamp: new Date().toISOString(),
              remoteJid: jid,
              pushName: msg.pushName,
              message: msg,
            };
            const serialized = JSON.stringify(logEntry, (key, val) => {
              if (val && (val.type === 'Buffer' || val instanceof Uint8Array || (val.constructor && val.constructor.name === 'Uint8Array'))) {
                return '[Buffer/Uint8Array]';
              }
              return val;
            }, 2);
            fs.appendFileSync(logFilePath, `${serialized}\n---\n`);
          } catch (err) {
            console.error('[Bot] Failed to log DM message:', err);
          }
        }

        // Log incoming group messages to MongoDB for Gemini analytics
        if (jid && jid.endsWith('@g.us')) {
          try {
            const cleanSender = senderJid ? cleanJid(senderJid) : cleanJid(jid);
            const { getMessageText } = await import('./commands');
            const msgText = getMessageText(msg).trim();
            if (msgText) {
              const groupMessagesCol = getDb().collection('group_messages');
              await groupMessagesCol.insertOne({
                _id: msg.key.id as any,
                groupId: jid,
                senderJid: cleanSender,
                senderName: msg.pushName || 'Unknown',
                text: msgText,
                timestamp: new Date((msg.messageTimestamp as number) * 1000 || Date.now())
              });
            }
          } catch (err) {
            console.error('[Bot] Failed to log group message to DB:', err);
          }
        }

        try {
          // Push to Redis Queue for async processing
          await queueMessage(msg);
        } catch (error) {
          console.error('[Bot] Failed to enqueue incoming message:', error);
        }
      }
    }
  });

  return sock;
}
