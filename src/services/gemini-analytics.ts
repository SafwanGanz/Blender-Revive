import { GoogleGenerativeAI } from '@google/generative-ai';
import { getDb } from '../db/mongodb';
import { sendHumanLikeResponse } from '../commands';

// Initialize the Google Gen AI SDK
const apiKey = process.env.GEMINI_API_KEY || '';
const ai = new GoogleGenerativeAI(apiKey);

interface GroupMessage {
  _id: string;
  groupId: string;
  senderJid: string;
  senderName: string;
  text: string;
  timestamp: Date;
}

export async function runGroupAnalytics(sock: any, groupId: string): Promise<void> {
  try {
    const db = getDb();
    const groupMessagesCol = db.collection<GroupMessage>('group_messages');

    // 1. Fetch messages from the last 24 hours
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const messages = await groupMessagesCol
      .find({
        groupId: groupId,
        timestamp: { $gte: oneDayAgo }
      })
      .sort({ timestamp: 1 })
      .toArray();

    if (messages.length < 10) {
      console.log(`[Analytics] Skipping group ${groupId} - only has ${messages.length} messages (minimum 10 required).`);
      return;
    }

    console.log(`[Analytics] Running Gemini analytics for group ${groupId} with ${messages.length} messages.`);

    // 2. Count messages per sender (Most messaged today is solely based on counts)
    const senderCounts: { [jid: string]: { name: string; count: number } } = {};
    for (const msg of messages) {
      if (!senderCounts[msg.senderJid]) {
        senderCounts[msg.senderJid] = { name: msg.senderName, count: 0 };
      }
      senderCounts[msg.senderJid].count++;
    }

    let mostMessagedJid = '';
    let maxCount = 0;
    for (const [jid, data] of Object.entries(senderCounts)) {
      if (data.count > maxCount) {
        maxCount = data.count;
        mostMessagedJid = jid;
      }
    }

    const mostMessagedTag = mostMessagedJid ? `@${mostMessagedJid.split('@')[0]}` : 'Not found today';

    // 3. Format messages history for Gemini
    const chatLog = messages
      .map(msg => `[${msg.senderName} (${msg.senderJid})]: ${msg.text}`)
      .join('\n');

    // 4. Construct prompt for Gemini
    const prompt = `
You are a helpful group chat assistant. You are analyzing the chat log of a WhatsApp group from the past 24 hours.
Below is the chat transcript:
---
${chatLog}
---

Your task is to identify:
1. **Most productive person**: Select the user JID (in format "number@s.whatsapp.net" or "number@lid") who asked or answered good technical questions, helped others, or shared valuable technical info. Explain briefly why they were chosen.
2. **Most annoying topic**: Give the topic name that was repetitive, annoying, spammy, or complaining, and identify the user JID (in format "number@s.whatsapp.net" or "number@lid") who initiated or was most responsible/annoying about it.

Please output the response exactly in this JSON format:
{
  "productive": {
    "jid": "user_jid_here or empty string if not found",
    "name": "user_name_here",
    "reason": "short explanation of why they were chosen or 'No outstanding productive technical discussions today.'"
  },
  "annoying": {
    "topic": "topic name or 'Not found today'",
    "jid": "user_jid_here or empty string if not found",
    "name": "user_name_here",
    "reason": "short explanation of why this topic/person was annoying"
  }
}
`;

    // 5. Query Gemini model (using gemini-1.5-flash as it is fast and cheap for transcripts)
    let aiResponseText = '';
    try {
      const model = ai.getGenerativeModel({
        model: 'gemini-1.5-flash',
        generationConfig: {
          responseMimeType: 'application/json'
        }
      });
      const responseResult = await model.generateContent(prompt);
      aiResponseText = responseResult.response.text();
    } catch (apiErr) {
      console.error('[Analytics] Gemini API call failed:', apiErr);
      throw apiErr;
    }

    console.log('[Analytics] Gemini raw response:', aiResponseText);

    // 6. Parse result
    let result = {
      productive: { jid: '', name: '', reason: 'Not found today' },
      annoying: { topic: 'Not found today', jid: '', name: '', reason: '' }
    };

    try {
      result = JSON.parse(aiResponseText);
    } catch (parseErr) {
      console.error('[Analytics] Failed to parse Gemini response as JSON. Trying simple regex/cleanup...');
      const match = aiResponseText.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          result = JSON.parse(match[0]);
        } catch (_) {}
      }
    }

    // 7. Format output report message
    const mentions: string[] = [];
    if (mostMessagedJid) mentions.push(mostMessagedJid);
    
    let productiveLine = 'Not found today';
    if (result.productive && result.productive.jid) {
      const pJid = result.productive.jid;
      mentions.push(pJid);
      productiveLine = `@${pJid.split('@')[0]} (${result.productive.name}) - ${result.productive.reason}`;
    } else if (result.productive && result.productive.reason) {
      productiveLine = result.productive.reason;
    }

    let annoyingLine = 'Not found today';
    if (result.annoying && result.annoying.topic && result.annoying.topic !== 'Not found today') {
      const aJid = result.annoying.jid;
      if (aJid) {
        mentions.push(aJid);
        annoyingLine = `*${result.annoying.topic}* by @${aJid.split('@')[0]} (${result.annoying.name}) ${result.annoying.reason ? `- ${result.annoying.reason}` : ''}`;
      } else {
        annoyingLine = `*${result.annoying.topic}* - ${result.annoying.reason || 'No specific person tagged.'}`;
      }
    }

    const reportMessage = `📊 *Daily Group Analytics (Past 24 Hours)* 📊
━━━━━━━━━━━━━━━━━━━━━━━━━━

🏆 *Most Productive Person (Technical Q&A/Help):*
👉 ${productiveLine}

📈 *Most Active Today (Count based):*
👉 ${mostMessagedTag} (${maxCount} messages)

🙄 *Most Annoying Topic:*
👉 ${annoyingLine}

━━━━━━━━━━━━━━━━━━━━━━━━━━
_Generated automatically using Gemini AI_ 🤖`;

    // 8. Post to the group
    await sendHumanLikeResponse(sock, groupId, {
      text: reportMessage,
      mentions: mentions
    });

    console.log(`[Analytics] Successfully sent analytics report to group ${groupId}`);

  } catch (err) {
    console.error(`[Analytics] Error running group analytics for ${groupId}:`, err);
  }
}
