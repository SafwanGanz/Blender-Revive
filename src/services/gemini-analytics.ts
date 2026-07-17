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

    if (messages.length < 15) {
      console.log(`[Analytics] Skipping group ${groupId} - only has ${messages.length} messages (minimum 15 required).`);
      if (messages.length > 0) {
        await sendHumanLikeResponse(sock, groupId, {
          text: `⚠️ *Not enough messages to generate daily analytics.* A minimum of 15 messages are required in the past 24 hours (Current: ${messages.length}).`
        });
      }
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
3. **Group Story / Summary**: Write a concise summary of the key things that happened in the group today, as bullet points (maximum 10 points). Write from a third-person point of view. Use the real display names of users (e.g. "Virat Pandey asked about...") but do NOT include any JIDs, phone numbers, or @tags. Focus on the topics discussed, decisions made, questions asked, problems solved, interesting moments, and general vibe of the group.

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
  },
  "summary": [
    "First point about what happened today",
    "Second point about another topic or event"
  ]
}
`;

    // 5. Query Gemini model with retry logic & fallback models for robustness
    const modelsToTry = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];
    const MAX_RETRIES_PER_MODEL = 2;
    let aiResponseText = '';
    let lastError: any = null;

    modelLoop: for (const modelName of modelsToTry) {
      const model = ai.getGenerativeModel({
        model: modelName,
        generationConfig: {
          responseMimeType: 'application/json'
        }
      });

      console.log(`[Analytics] Trying Gemini model: ${modelName}`);

      for (let attempt = 1; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
        try {
          const responseResult = await model.generateContent(prompt);
          aiResponseText = responseResult.response.text();
          console.log(`[Analytics] Success with model: ${modelName}`);
          break modelLoop; // Success! Exit both loops.
        } catch (apiErr: any) {
          lastError = apiErr;
          const status = apiErr?.status || apiErr?.response?.status;
          const errMsg = apiErr?.message || '';
          const isRetryable = status === 503 || status === 429 || 
                              errMsg.includes('503') || errMsg.includes('429') || 
                              errMsg.includes('Service Unavailable') || errMsg.includes('high demand');

          if (isRetryable && attempt < MAX_RETRIES_PER_MODEL) {
            const backoffMs = 3000 * Math.pow(2, attempt - 1); // 3s, 6s
            console.warn(`[Analytics] Model ${modelName} returned retryable error (status: ${status || 'unknown'}, msg: ${errMsg}), retrying in ${backoffMs / 1000}s (attempt ${attempt}/${MAX_RETRIES_PER_MODEL})...`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
          } else {
            console.warn(`[Analytics] Model ${modelName} failed on attempt ${attempt}. Error: ${errMsg}`);
            break; // Break retry loop, try next model in modelsToTry
          }
        }
      }
    }

    if (!aiResponseText) {
      console.error(`[Analytics] All Gemini models failed to generate content.`);
      throw lastError || new Error('All Gemini models failed');
    }


    console.log('[Analytics] Gemini raw response:', aiResponseText);

    // 6. Parse result
    let result = {
      productive: { jid: '', name: '', reason: 'Not found today' },
      annoying: { topic: 'Not found today', jid: '', name: '', reason: '' },
      summary: [] as string[]
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

    // Build group story summary (max 10 points, no user tags)
    let storySummary = '';
    if (result.summary && Array.isArray(result.summary) && result.summary.length > 0) {
      const points = result.summary.slice(0, 10);
      storySummary = points.map((point, i) => `  ${i + 1}. ${point}`).join('\n');
    } else {
      storySummary = '  _No notable stories today._';
    }

    const reportMessage = `📊 *Daily Group Analytics (Past 24 Hours)* 📊
━━━━━━━━━━━━━━━━━━━━━━━━━━

🏆 *Most Productive Person (Technical Q&A/Help):*
👉 ${productiveLine}

📈 *Most Active Today (Count based):*
👉 ${mostMessagedTag} (${maxCount} messages)

🙄 *Most Annoying Topic:*
👉 ${annoyingLine}

📖 *Today's Group Story:*
${storySummary}

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
