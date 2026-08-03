import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { MongoClient, Db } from 'mongodb';
import dotenv from 'dotenv';
import path from 'path';

import fs from 'fs';
import crypto from 'crypto';

// Load .env from the project root (handles both development ts-node and production dist/ paths)
let envPath = path.resolve(__dirname, '../../.env');
if (!fs.existsSync(envPath)) {
  envPath = path.resolve(__dirname, '../../../.env');
}
dotenv.config({ path: envPath });

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3001;

// ─── Auth configuration (from env) ───
const DASHBOARD_USER = process.env.DASHBOARD_USER || 'cryso';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'test@123';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

app.use(cors());
app.use(express.json());

// ─── JWT Auth Helpers ───
function signToken(username: string): string {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN as any });
}

function authenticate(req: any, res: any, next: any) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized. Please login first.' });
  }
  try {
    const token = authHeader.slice(7);
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token. Please login again.' });
  }
}

// ─── Auth Endpoint: POST /api/auth/login ───
app.post('/api/auth/login', (req: any, res: any) => {
  const { username, password } = req.body || {};
  if (username === DASHBOARD_USER && password === DASHBOARD_PASSWORD) {
    return res.json({
      token: signToken(username),
      username,
      expiresIn: JWT_EXPIRES_IN,
    });
  }
  return res.status(401).json({ error: 'Invalid credentials.' });
});

let db: Db;

async function connectToMongo(): Promise<Db> {
  const uri = process.env.MONGO_URI || 'mongodb://root:rootpassword@localhost:27017/admin';
  const dbName = process.env.MONGO_DB_NAME || 'whatsapp_bot';
  const client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);
  console.log(`[Dashboard API] Connected to MongoDB: ${dbName}`);
  return db;
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

// ─── Start of today (UTC) ───
function startOfToday(): Date {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  return now;
}

// ─── N days ago ───
function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ─── For a given period key, return the matching start-of-period as a Date ───
function periodStartDate(period: string): Date {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  switch (period) {
    case 'day':
      return now;
    case 'week': {
      const d = daysAgo(7);
      return d;
    }
    case 'month': {
      const d = new Date();
      d.setUTCDate(1);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
    case 'quarter': {
      const d = new Date();
      const month = d.getUTCMonth();
      const quarterStartMonth = Math.floor(month / 3) * 3;
      d.setUTCMonth(quarterStartMonth, 1);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
    case 'year': {
      const d = new Date();
      d.setUTCMonth(0, 1);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
    default:
      return now;
  }
}

// ─── Date → formatted period label for the requested period type ───
function periodLabel(period: string, date: Date): string {
  switch (period) {
    case 'quarter': {
      const q = Math.floor(date.getUTCMonth() / 3) + 1;
      return `${date.getUTCFullYear()} Q${q}`;
    }
    case 'year':
      return String(date.getUTCFullYear());
    case 'month':
    default:
      return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }
}

// ─── Group name resolver ───
// Looks up a friendly group name from the `groups` collection (populated by the
// bot's background group scan). Falls back to truncated JID if not yet captured.
let groupNameCache: Map<string, string> | null = null;
let groupNameCacheAt = 0;

async function getGroupNameMap(): Promise<Map<string, string>> {
  const now = Date.now();
  // Refresh cache every 60s
  if (!groupNameCache || now - groupNameCacheAt > 60000) {
    try {
      const groups = await db.collection('groups').find({}, { projection: { name: 1 } }).toArray();
      groupNameCache = new Map<string, string>();
      for (const g of groups) {
        if (g.name) {
          groupNameCache.set(String(g._id), String(g.name));
          // Also store without @g.us for easy lookup by numeric ID
          const base = String(g._id).replace(/@g\.us$/, '');
          groupNameCache.set(base, String(g.name));
        }
      }
      groupNameCacheAt = now;
    } catch (err) {
      console.error('[API] Failed to fetch group names:', err);
      if (!groupNameCache) groupNameCache = new Map<string, string>();
    }
  }
  return groupNameCache;
}

async function groupDisplayName(groupId: string): Promise<string> {
  const map = await getGroupNameMap();
  const name = map.get(groupId) || map.get(groupId.replace(/@g\.us$/, ''));
  if (name) return name;
  return groupId.replace('@g.us', '').slice(-10);
}

// ─── Read period filter from query params with sane defaults ───
function getPeriod(req: any): string {
  const p = (req.query.period as string) || 'month';
  return ['day', 'week', 'month', 'quarter', 'year'].includes(p) ? p : 'month';
}

function getDays(req: any): number {
  const d = parseInt(req.query.days as string, 10);
  if (!isNaN(d) && d > 0 && d <= 365) return d;
  if (!isNaN(d) && d > 365) return 365;
  return 30;
}

function getLimit(req: any): number {
  const l = parseInt(req.query.limit as string, 10);
  if (!isNaN(l) && l > 0 && l <= 50) return l;
  return 10;
}

function todayISO(): string {
  return new Date().toISOString().split('T')[0];
}

// ═══════════════════════════════════════════════════
// 1. Overview Stats
// ═══════════════════════════════════════════════════
app.get('/api/stats/overview', authenticate, async (_req, res) => {
  try {
    const today = startOfToday();

    const [
      messagesToday,
      messagesAllTime,
      totalUsers,
      totalCompanies,
      totalWarnings,
      totalGroups,
      commandsToday,
      commandsAllTime,
      dau,
      mau,
    ] = await Promise.all([
      db.collection('group_messages').countDocuments({ timestamp: { $gte: today } }),
      db.collection('group_messages').countDocuments({}),
      db.collection('referrals').countDocuments({ deletedAt: { $exists: false } }),
      db.collection('referrals').distinct('company', { deletedAt: { $exists: false } }).then(c => c.length),
      db.collection('warnings').countDocuments({}),
      db.collection('group_messages').distinct('groupId').then(g => g.length),
      db.collection('command_usage').countDocuments({ timestamp: { $gte: today } }),
      db.collection('command_usage').countDocuments({}),
      // DAU = unique senders today across all messages + commands
      db.collection('group_messages').distinct('senderJid', { timestamp: { $gte: today } }).then(u =>
        u.concat(
          (db.collection('command_usage').find({ timestamp: { $gte: today } }).toArray()) as any
        ).length
      ).catch(() => 0),
      // MAU = users registered this month (approx: unique senders in last 30d)
      db.collection('group_messages').distinct('senderJid', { timestamp: { $gte: daysAgo(30) } }).then(u =>
        u.concat(
          (db.collection('command_usage').find({ timestamp: { $gte: daysAgo(30) } }).toArray()) as any
        ).length
      ).catch(() => 0),
    ]);

    res.json({
      messagesToday,
      messagesAllTime,
      totalUsers,
      totalCompanies,
      totalWarnings,
      totalGroups,
      commandsToday,
      commandsAllTime,
      dau,
      mau,
    });
  } catch (err) {
    console.error('[API] /api/stats/overview error:', err);
    res.status(500).json({ error: 'Failed to fetch overview stats' });
  }
});

// ═══════════════════════════════════════════════════
// 2. Messages by Hour (Today)
// ═══════════════════════════════════════════════════
app.get('/api/stats/messages-by-hour', authenticate, async (_req, res) => {
  try {
    const today = startOfToday();

    const pipeline = [
      { $match: { timestamp: { $gte: today } } },
      {
        $group: {
          _id: { $hour: '$timestamp' },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 as const } },
    ];

    const results = await db.collection('group_messages').aggregate(pipeline).toArray();

    const hourly = Array.from({ length: 24 }, (_, i) => {
      const match = results.find((r: any) => r._id === i);
      return { hour: i, count: match ? match.count : 0 };
    });

    res.json(hourly);
  } catch (err) {
    console.error('[API] /api/stats/messages-by-hour error:', err);
    res.status(500).json({ error: 'Failed to fetch hourly messages' });
  }
});

// ═══════════════════════════════════════════════════
// 3. Messages by Day (Last 7 Days)
// ═══════════════════════════════════════════════════
app.get('/api/stats/messages-by-day', authenticate, async (_req, res) => {
  try {
    const sevenDaysAgo = daysAgo(7);

    const pipeline = [
      { $match: { timestamp: { $gte: sevenDaysAgo } } },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$timestamp' },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 as const } },
    ];

    const results = await db.collection('group_messages').aggregate(pipeline).toArray();

    const days: { date: string; count: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const match = results.find((r: any) => r._id === dateStr);
      days.push({ date: dateStr, count: match ? match.count : 0 });
    }

    res.json(days);
  } catch (err) {
    console.error('[API] /api/stats/messages-by-day error:', err);
    res.status(500).json({ error: 'Failed to fetch daily messages' });
  }
});

// ═══════════════════════════════════════════════════
// 4. Top Groups (Today)
// ═══════════════════════════════════════════════════
app.get('/api/stats/top-groups', authenticate, async (_req, res) => {
  try {
    const today = startOfToday();

    const pipeline = [
      { $match: { timestamp: { $gte: today } } },
      {
        $group: {
          _id: '$groupId',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 as const } },
      { $limit: 5 },
    ];

    const results = await db.collection('group_messages').aggregate(pipeline).toArray();

    const groups = await Promise.all(results.map(async (r: any) => ({
      groupId: r._id,
      name: await groupDisplayName(r._id),
      count: r.count,
    })));

    res.json(groups);
  } catch (err) {
    console.error('[API] /api/stats/top-groups error:', err);
    res.status(500).json({ error: 'Failed to fetch top groups' });
  }
});

// ═══════════════════════════════════════════════════
// 5. Top Senders (Today)
// ═══════════════════════════════════════════════════
app.get('/api/stats/top-senders', authenticate, async (_req, res) => {
  try {
    const today = startOfToday();

    const pipeline = [
      { $match: { timestamp: { $gte: today } } },
      {
        $group: {
          _id: '$senderJid',
          name: { $last: '$senderName' },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 as const } },
      { $limit: 10 },
    ];

    const results = await db.collection('group_messages').aggregate(pipeline).toArray();

    const senders = results.map((r: any) => ({
      jid: r._id,
      name: r.name || r._id.split('@')[0],
      count: r.count,
    }));

    res.json(senders);
  } catch (err) {
    console.error('[API] /api/stats/top-senders error:', err);
    res.status(500).json({ error: 'Failed to fetch top senders' });
  }
});

// ═══════════════════════════════════════════════════
// 6. Company Breakdown
// ═══════════════════════════════════════════════════
app.get('/api/stats/companies', authenticate, async (_req, res) => {
  try {
    const referrals = await db.collection('referrals')
      .find({ deletedAt: { $exists: false } })
      .toArray();

    const verifications = await db.collection('company_verifications').find({}).toArray();
    const vMap = new Map<string, any>();
    for (const v of verifications) {
      vMap.set(v._id as unknown as string, v);
      if (v.canonicalName) {
        vMap.set(v.canonicalName.toUpperCase().replace(/[\s_]+/g, '_'), v);
      }
    }

    const companyCounts: Record<string, number> = {};
    for (const r of referrals) {
      companyCounts[r.company] = (companyCounts[r.company] || 0) + 1;
    }

    let rankACount = 0;
    let rankBCount = 0;
    let unrankedCount = 0;

    const companies = Object.entries(companyCounts).map(([company, count]) => {
      const lookupKey = company.toUpperCase().replace(/[\s_]+/g, '_');
      const cache = vMap.get(lookupKey);
      const rank = cache ? cache.rank : 'unranked';
      const displayName = cache ? cache.displayName : company.replace(/_/g, ' ');

      if (rank === 'A') rankACount++;
      else if (rank === 'B') rankBCount++;
      else unrankedCount++;

      return { company, displayName, rank, count };
    });

    companies.sort((a, b) => b.count - a.count);

    res.json({
      rankBreakdown: { A: rankACount, B: rankBCount, unranked: unrankedCount },
      companies,
    });
  } catch (err) {
    console.error('[API] /api/stats/companies error:', err);
    res.status(500).json({ error: 'Failed to fetch company stats' });
  }
});

// ═══════════════════════════════════════════════════
// 7. Registrations by Day (Last 7 Days)
// ═══════════════════════════════════════════════════
app.get('/api/stats/registrations-by-day', authenticate, async (_req, res) => {
  try {
    const sevenDaysAgo = daysAgo(7);

    const pipeline = [
      { $match: { createdAt: { $gte: sevenDaysAgo }, deletedAt: { $exists: false } } },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 as const } },
    ];

    const results = await db.collection('referrals').aggregate(pipeline).toArray();

    const days: { date: string; count: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const match = results.find((r: any) => r._id === dateStr);
      days.push({ date: dateStr, count: match ? match.count : 0 });
    }

    res.json(days);
  } catch (err) {
    console.error('[API] /api/stats/registrations-by-day error:', err);
    res.status(500).json({ error: 'Failed to fetch registration stats' });
  }
});

// ═══════════════════════════════════════════════════
// 8. Warnings
// ═══════════════════════════════════════════════════
app.get('/api/stats/warnings', authenticate, async (_req, res) => {
  try {
    const totalWarnings = await db.collection('warnings').countDocuments({});

    const recentWarnings = await db.collection('warnings')
      .find({})
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();

    const warnings = recentWarnings.map((w: any) => ({
      userId: w.userId,
      userName: w.userName || w.userId?.split('@')[0] || 'Unknown',
      groupId: w.groupId,
      reason: w.reason || 'No reason specified',
      warnedAt: w.createdAt,
      warnNumber: w.warnNumber,
    }));

    res.json({ totalWarnings, recent: warnings });
  } catch (err) {
    console.error('[API] /api/stats/warnings error:', err);
    res.status(500).json({ error: 'Failed to fetch warnings' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 9. COMMAND USAGE ANALYTICS
// ═══════════════════════════════════════════════════════════════════

// ─── Top Commands (period=7d|30d|90d|1y|all) ───
app.get('/api/stats/command-usage', authenticate, async (req, res) => {
  try {
    const period = (req.query.period as string) || 'all';
    const daysMap: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
    const days = daysMap[period];
    const match: any = {};
    if (days) match.timestamp = { $gte: daysAgo(days) };

    const pipeline = [
      { $match: match },
      { $group: { _id: '$commandName', count: { $sum: 1 } } },
      { $sort: { count: -1 as const } },
    ];
    const results = await db.collection('command_usage').aggregate(pipeline).toArray();

    const total = results.reduce((acc: number, r: any) => acc + r.count, 0);
    const commands = results.map((r: any) => ({
      command: r._id,
      count: r.count,
      pct: total > 0 ? Math.round((r.count / total) * 1000) / 10 : 0,
    }));

    res.json({ total, commands });
  } catch (err) {
    console.error('[API] /api/stats/command-usage error:', err);
    res.status(500).json({ error: 'Failed to fetch command usage' });
  }
});

// ─── Command Usage Trend (daily counts over N days) ───
app.get('/api/stats/command-usage-trend', authenticate, async (req, res) => {
  try {
    const days = getDays(req);
    const since = daysAgo(days - 1);

    const pipeline = [
      { $match: { timestamp: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 as const } },
    ];

    const results = await db.collection('command_usage').aggregate(pipeline).toArray();

    // Fill missing days
    const daysArr: { date: string; count: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const match = results.find((r: any) => r._id === dateStr);
      daysArr.push({ date: dateStr, count: match ? match.count : 0 });
    }

    res.json(daysArr);
  } catch (err) {
    console.error('[API] /api/stats/command-usage-trend error:', err);
    res.status(500).json({ error: 'Failed to fetch command usage trend' });
  }
});

// ─── Command Usage by Chat Type (DM vs Group) ───
app.get('/api/stats/command-usage-by-chat-type', authenticate, async (req, res) => {
  try {
    const days = getDays(req);
    const since = daysAgo(days);

    const pipeline = [
      { $match: { timestamp: { $gte: since } } },
      { $group: { _id: '$chatType', count: { $sum: 1 } } },
    ];

    const results = await db.collection('command_usage').aggregate(pipeline).toArray();

    const dm = results.find((r: any) => r._id === 'dm')?.count || 0;
    const group = results.find((r: any) => r._id === 'group')?.count || 0;

    res.json({ dm, group, total: dm + group });
  } catch (err) {
    console.error('[API] /api/stats/command-usage-by-chat-type error:', err);
    res.status(500).json({ error: 'Failed to fetch chat type breakdown' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 10. ACTIVE USERS PER GROUP (month/quarter/year)
// ═══════════════════════════════════════════════════════════════════

// ─── Most Active Groups by unique active users for a period ───
app.get('/api/stats/active-users-by-group', authenticate, async (req, res) => {
  try {
    const period = getPeriod(req);
    const limit = getLimit(req);
    const since = periodStartDate(period);

    const pipeline = [
      { $match: { timestamp: { $gte: since } } },
      {
        $group: {
          _id: '$groupId',
          activeUsers: { $addToSet: '$senderJid' },
          messages: { $sum: 1 },
        },
      },
      {
        $project: {
          groupId: '$_id',
          activeUsers: { $size: '$activeUsers' },
          messages: 1,
        },
      },
      { $sort: { activeUsers: -1 as const } },
      { $limit: limit },
    ];

    const results = await db.collection('group_messages').aggregate(pipeline).toArray();

    const groups = await Promise.all(results.map(async (r: any) => ({
      groupId: r.groupId,
      name: await groupDisplayName(r.groupId),
      activeUsers: r.activeUsers,
      messages: r.messages,
    })));

    res.json({ period, groups });
  } catch (err) {
    console.error('[API] /api/stats/active-users-by-group error:', err);
    res.status(500).json({ error: 'Failed to fetch active users by group' });
  }
});

// ─── Detailed engagement for a single group ───
app.get('/api/stats/group-engagement/:groupId', authenticate, async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const period = getPeriod(req);
    const since = periodStartDate(period);

    const pipeline: any[] = [
      { $match: { groupId, timestamp: { $gte: since } } },
      {
        $group: {
          _id: null,
          messages: { $sum: 1 },
          activeUsers: { $addToSet: '$senderJid' },
          topSenders: {
            $push: { senderJid: '$senderJid', senderName: '$senderName' },
          },
        },
      },
      {
        $project: {
          messages: 1,
          activeUsers: { $size: '$activeUsers' },
          topSenders: 1,
          _id: 0,
        },
      },
    ];

    const result = (await db.collection('group_messages').aggregate(pipeline).toArray())[0];

    if (!result) {
      res.json({ groupId, period, messages: 0, activeUsers: 0, topSenders: [] });
      return;
    }

    // Aggregate top senders
    const senderCounts = new Map<string, { name: string; count: number }>();
    for (const s of result.topSenders) {
      const key = s.senderJid;
      const existing = senderCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        senderCounts.set(key, { name: s.senderName || key.split('@')[0], count: 1 });
      }
    }
    const topSenders = Array.from(senderCounts.entries())
      .map(([jid, v]) => ({ jid, name: v.name, count: v.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    res.json({
      groupId,
      name: await groupDisplayName(groupId),
      period,
      messages: result.messages,
      activeUsers: result.activeUsers,
      topSenders,
    });
  } catch (err) {
    console.error('[API] /api/stats/group-engagement error:', err);
    res.status(500).json({ error: 'Failed to fetch group engagement' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 11. USER ENGAGEMENT & RETENTION
// ═══════════════════════════════════════════════════════════════════

// ─── DAU / WAU / MAU trend for last N days ───
app.get('/api/stats/dau-wau-mau', authenticate, async (req, res) => {
  try {
    const days = Math.min(getDays(req), 90);
    const since = daysAgo(days - 1);

    // Normalize: group all messages+commands by day, collecting unique senders per day
    const pipeline = [
      { $match: { timestamp: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
          users: { $addToSet: '$senderJid' },
        },
      },
      { $sort: { _id: 1 as const } },
    ];

    const daily = await db.collection('group_messages').aggregate(pipeline).toArray();

    const dailyMap = new Map<string, Set<string>>();
    for (const r of daily) {
      dailyMap.set(r._id, new Set(r.users));
    }

    const trend: { date: string; dau: number; wau: number; mau: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];

      const dau = dailyMap.get(dateStr)?.size || 0;

      // WAU = unique users in last 7 days ending at this date
      const wauUsers = new Set<string>();
      for (let j = 0; j < 7; j++) {
        const dd = new Date(d);
        dd.setDate(dd.getDate() - j);
        const ds = dd.toISOString().split('T')[0];
        const users = dailyMap.get(ds);
        if (users) for (const u of users) wauUsers.add(u);
      }

      // MAU = unique users in last 30 days ending at this date
      const mauUsers = new Set<string>();
      for (let j = 0; j < 30; j++) {
        const dd = new Date(d);
        dd.setDate(dd.getDate() - j);
        const ds = dd.toISOString().split('T')[0];
        const users = dailyMap.get(ds);
        if (users) for (const u of users) mauUsers.add(u);
      }

      trend.push({ date: dateStr, dau, wau: wauUsers.size, mau: mauUsers.size });
    }

    res.json(trend);
  } catch (err) {
    console.error('[API] /api/stats/dau-wau-mau error:', err);
    res.status(500).json({ error: 'Failed to fetch active user trends' });
  }
});

// ─── New vs Returning users per day ───
app.get('/api/stats/new-vs-returning', authenticate, async (req, res) => {
  try {
    const days = getDays(req);
    const since = daysAgo(days - 1);

    // All users who ever messaged before `since` = returning cohort
    const priorUsers = await db.collection('group_messages').distinct('senderJid', {
      timestamp: { $lt: since },
    });
    const priorSet = new Set(priorUsers);

    const pipeline = [
      { $match: { timestamp: { $gte: since } } },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
            user: '$senderJid',
          },
        },
      },
      { $sort: { '_id.date': 1 as const } },
    ];

    const results = await db.collection('group_messages').aggregate(pipeline).toArray();

    const daily = new Map<string, { newUsers: Set<string>; returning: Set<string> }>();
    for (const r of results) {
      const date = r._id.date;
      const user = r._id.user;
      if (!daily.has(date)) daily.set(date, { newUsers: new Set(), returning: new Set() });
      const bucket = daily.get(date)!;
      if (priorSet.has(user)) bucket.returning.add(user);
      else {
        bucket.newUsers.add(user);
        priorSet.add(user); // a user is only "new" once
      }
    }

    const trend: { date: string; newUsers: number; returning: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const bucket = daily.get(dateStr);
      trend.push({
        date: dateStr,
        newUsers: bucket?.newUsers.size || 0,
        returning: bucket?.returning.size || 0,
      });
    }

    res.json(trend);
  } catch (err) {
    console.error('[API] /api/stats/new-vs-returning error:', err);
    res.status(500).json({ error: 'Failed to fetch new vs returning users' });
  }
});

// ─── Registration trend by period (month/quarter/year) ───
app.get('/api/stats/registration-trend', authenticate, async (req, res) => {
  try {
    const period = getPeriod(req);
    const format = period === 'year' ? '%Y' : period === 'quarter' ? '%Y-%m' : '%Y-%m';
    const since = period === 'year' ? new Date(Date.UTC(2000, 0, 1)) : daysAgo(1095); // All-time / 3y

    const pipeline = [
      { $match: { createdAt: { $gte: since }, deletedAt: { $exists: false } } },
      {
        $group: {
          _id: { $dateToString: { format, date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 as const } },
    ];

    const results = await db.collection('referrals').aggregate(pipeline).toArray();

    // Re-map quarter groups into synthetic labels
    const trend = results.map((r: any) => {
      if (period === 'quarter') {
        const [y, m] = r._id.split('-').map(Number);
        const q = Math.floor((m - 1) / 3) + 1;
        return { period: `${y} Q${q}`, count: r.count };
      }
      return { period: r._id, count: r.count };
    });

    // For month period, ensure last 12 months exist
    if (period === 'month') {
      const map = new Map(trend.map((t: any) => [t.period, t.count]));
      const filled: { period: string; count: number }[] = [];
      for (let i = 11; i >= 0; i--) {
        const d = new Date();
        d.setUTCDate(1);
        d.setUTCMonth(d.getUTCMonth() - i);
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        filled.push({ period: key, count: map.get(key) || 0 });
      }
      res.json({ period, trend: filled });
      return;
    }

    res.json({ period, trend });
  } catch (err) {
    console.error('[API] /api/stats/registration-trend error:', err);
    res.status(500).json({ error: 'Failed to fetch registration trend' });
  }
});

// ─── User activity heatmap (hour of day × day of week, last N days) ───
app.get('/api/stats/user-activity-heatmap', authenticate, async (req, res) => {
  try {
    const days = getDays(req);
    const since = daysAgo(days - 1);

    const pipeline = [
      { $match: { timestamp: { $gte: since } } },
      {
        $group: {
          _id: {
            hour: { $hour: '$timestamp' },
            dayOfWeek: { $dayOfWeek: '$timestamp' }, // 1=Sunday ... 7=Saturday
          },
          count: { $sum: 1 },
        },
      },
    ];

    const results = await db.collection('group_messages').aggregate(pipeline).toArray();

    // Build 24×7 grid (rows = hours 0-23, cols = Mon-Sun)
    const grid: number[][] = Array.from({ length: 24 }, () => Array(7).fill(0));
    for (const r of results) {
      const hour = r._id.hour;
      // Convert Mongo dayOfWeek (1=Sun..7=Sat) to (0=Mon..6=Sun)
      let day = r._id.dayOfWeek - 2;
      if (day < 0) day = 6;
      grid[hour][day] = r.count;
    }

    res.json({ days, grid });
  } catch (err) {
    console.error('[API] /api/stats/user-activity-heatmap error:', err);
    res.status(500).json({ error: 'Failed to fetch activity heatmap' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 12. MESSAGE VOLUME ANALYTICS
// ═══════════════════════════════════════════════════════════════════

// ─── Messages by period (month/quarter/year) ───
app.get('/api/stats/messages-by-period', authenticate, async (req, res) => {
  try {
    const period = getPeriod(req);
    const format =
      period === 'year' ? '%Y' :
      period === 'quarter' ? '%Y-%m' :
      '%Y-%m';

    const since =
      period === 'year' ? daysAgo(1825) : // 5 years
      period === 'quarter' ? daysAgo(1095) : // 3 years
      daysAgo(730); // 2 years

    const pipeline = [
      { $match: { timestamp: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format, date: '$timestamp' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 as const } },
    ];

    const results = await db.collection('group_messages').aggregate(pipeline).toArray();

    const trend = results.map((r: any) => {
      if (period === 'quarter') {
        const [y, m] = r._id.split('-').map(Number);
        const q = Math.floor((m - 1) / 3) + 1;
        return { period: `${y} Q${q}`, count: r.count };
      }
      return { period: r._id, count: r.count };
    });

    res.json({ period, trend });
  } catch (err) {
    console.error('[API] /api/stats/messages-by-period error:', err);
    res.status(500).json({ error: 'Failed to fetch messages by period' });
  }
});

// ─── Command vs regular message breakdown ───
app.get('/api/stats/message-type-breakdown', authenticate, async (req, res) => {
  try {
    const days = getDays(req);
    const since = daysAgo(days);

    const totalMessages = await db.collection('group_messages').countDocuments({ timestamp: { $gte: since } });
    const commandMessages = await db.collection('command_usage').countDocuments({ timestamp: { $gte: since } });

    res.json({
      days,
      totalMessages,
      commandMessages,
      regularMessages: totalMessages - commandMessages,
    });
  } catch (err) {
    console.error('[API] /api/stats/message-type-breakdown error:', err);
    res.status(500).json({ error: 'Failed to fetch message type breakdown' });
  }
});

// ─── Messages per group for a period ───
app.get('/api/stats/messages-by-group', authenticate, async (req, res) => {
  try {
    const period = getPeriod(req);
    const limit = getLimit(req);
    const since = periodStartDate(period);

    const pipeline = [
      { $match: { timestamp: { $gte: since } } },
      {
        $group: {
          _id: '$groupId',
          messages: { $sum: 1 },
        },
      },
      { $sort: { messages: -1 as const } },
      { $limit: limit },
    ];

    const results = await db.collection('group_messages').aggregate(pipeline).toArray();

    const groups = await Promise.all(results.map(async (r: any) => ({
      groupId: r._id,
      name: await groupDisplayName(r._id),
      messages: r.messages,
    })));

    res.json({ period, groups });
  } catch (err) {
    console.error('[API] /api/stats/messages-by-group error:', err);
    res.status(500).json({ error: 'Failed to fetch messages by group' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 13. WARNING ANALYTICS
// ═══════════════════════════════════════════════════════════════════

// ─── Warnings by period ───
app.get('/api/stats/warnings-by-period', authenticate, async (req, res) => {
  try {
    const period = getPeriod(req);
    const format = period === 'year' ? '%Y' : '%Y-%m';

    const pipeline = [
      {
        $group: {
          _id: { $dateToString: { format, date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 as const } },
    ];

    const results = await db.collection('warnings').aggregate(pipeline).toArray();
    res.json({ period, trend: results.map((r: any) => ({ period: r._id, count: r.count })) });
  } catch (err) {
    console.error('[API] /api/stats/warnings-by-period error:', err);
    res.status(500).json({ error: 'Failed to fetch warnings by period' });
  }
});

// ─── Warning funnel: users by warning count ───
app.get('/api/stats/warning-outcomes', authenticate, async (_req, res) => {
  try {
    const pipeline = [
      {
        $group: {
          _id: { groupId: '$groupId', userId: '$userId' },
          count: { $sum: 1 },
        },
      },
      {
        $group: {
          _id: '$count',
          users: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 as const } },
    ];

    const results = await db.collection('warnings').aggregate(pipeline).toArray();

    // funnel[i] = number of users with at least i+1 warnings
    const total = results.reduce((acc: number, r: any) => acc + r.users, 0);
    const funnel = [
      { stage: 'Warned 1+', users: total },
      { stage: 'Warned 2+', users: results.filter((r: any) => r._id >= 2).reduce((acc: number, r: any) => acc + r.users, 0) },
      { stage: 'Warned 3+', users: results.filter((r: any) => r._id >= 3).reduce((acc: number, r: any) => acc + r.users, 0) },
    ];

    res.json({ funnel });
  } catch (err) {
    console.error('[API] /api/stats/warning-outcomes error:', err);
    res.status(500).json({ error: 'Failed to fetch warning outcomes' });
  }
});

// ─── Top warned users ───
app.get('/api/stats/top-warned-users', authenticate, async (req, res) => {
  try {
    const limit = getLimit(req);

    const pipeline = [
      {
        $group: {
          _id: { userId: '$userId', groupId: '$groupId' },
          count: { $sum: 1 },
        },
      },
      {
        $group: {
          _id: '$_id.userId',
          totalWarnings: { $sum: '$count' },
          groups: { $sum: 1 },
        },
      },
      { $sort: { totalWarnings: -1 as const } },
      { $limit: limit },
    ];

    const results = await db.collection('warnings').aggregate(pipeline).toArray();

    const users = results.map((r: any) => ({
      userId: r._id,
      name: r._id.split('@')[0],
      totalWarnings: r.totalWarnings,
      groups: r.groups,
    }));

    res.json({ users });
  } catch (err) {
    console.error('[API] /api/stats/top-warned-users error:', err);
    res.status(500).json({ error: 'Failed to fetch top warned users' });
  }
});

// ─── Warnings by group ───
app.get('/api/stats/warnings-by-group', authenticate, async (req, res) => {
  try {
    const period = getPeriod(req);
    const since = periodStartDate(period);

    const pipeline = [
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$groupId', count: { $sum: 1 } } },
      { $sort: { count: -1 as const } },
      { $limit: 10 },
    ];

    const results = await db.collection('warnings').aggregate(pipeline).toArray();

    const groups = await Promise.all(results.map(async (r: any) => ({
      groupId: r._id,
      name: await groupDisplayName(r._id),
      count: r.count,
    })));

    res.json({ period, groups });
  } catch (err) {
    console.error('[API] /api/stats/warnings-by-group error:', err);
    res.status(500).json({ error: 'Failed to fetch warnings by group' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 14. COMPANY GROWTH ANALYTICS
// ═══════════════════════════════════════════════════════════════════

// ─── Top companies by registration count ───
app.get('/api/stats/top-companies-by-registration', authenticate, async (_req, res) => {
  try {
    const pipeline = [
      { $match: { deletedAt: { $exists: false } } },
      {
        $group: {
          _id: '$company',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 as const } },
      { $limit: 15 },
    ];

    const results = await db.collection('referrals').aggregate(pipeline).toArray();

    // Get display names from verifications
    const verifications = await db.collection('company_verifications').find({}).toArray();
    const vMap = new Map<string, any>();
    for (const v of verifications) {
      vMap.set(v._id as unknown as string, v);
      if (v.canonicalName) vMap.set(v.canonicalName.toUpperCase().replace(/[\s_]+/g, '_'), v);
    }

    const companies = results.map((r: any) => {
      const lookupKey = r._id.toUpperCase().replace(/[\s_]+/g, '_');
      const cache = vMap.get(lookupKey);
      return {
        company: r._id,
        displayName: cache ? cache.displayName : r._id.replace(/_/g, ' '),
        rank: cache ? cache.rank : 'unranked',
        count: r.count,
      };
    });

    res.json({ companies });
  } catch (err) {
    console.error('[API] /api/stats/top-companies-by-registration error:', err);
    res.status(500).json({ error: 'Failed to fetch top companies' });
  }
});

// ─── Company growth: registrations per period per top company ───
app.get('/api/stats/company-growth', authenticate, async (req, res) => {
  try {
    const period = getPeriod(req);
    const format = period === 'year' ? '%Y' : '%Y-%m';

    // Top 8 companies by total registrations
    const topCompanies = await db.collection('referrals').aggregate([
      { $match: { deletedAt: { $exists: false } } },
      { $group: { _id: '$company', count: { $sum: 1 } } },
      { $sort: { count: -1 as const } },
      { $limit: 8 },
    ]).toArray();

    const companyNames = topCompanies.map((c: any) => c._id);

    const pipeline = [
      {
        $match: {
          company: { $in: companyNames },
          deletedAt: { $exists: false },
        },
      },
      {
        $group: {
          _id: {
            company: '$company',
            period: { $dateToString: { format, date: '$createdAt' } },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.period': 1 as const } },
    ];

    const results = await db.collection('referrals').aggregate(pipeline).toArray();

    const series: { company: string; points: { period: string; count: number }[] }[] = companyNames.map((c): { company: string; points: { period: string; count: number }[] } => ({
      company: c,
      points: [],
    }));

    for (const r of results) {
      const seriesItem = series.find((s) => s.company === r._id.company);
      if (seriesItem) {
        seriesItem.points.push({ period: r._id.period, count: r.count });
      }
    }

    res.json({ period, series });
  } catch (err) {
    console.error('[API] /api/stats/company-growth error:', err);
    res.status(500).json({ error: 'Failed to fetch company growth' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 15. BOT HEALTH & SYSTEM KPIs
// ═══════════════════════════════════════════════════════════════════

app.get('/api/stats/bot-health', authenticate, async (_req, res) => {
  try {
    const today = startOfToday();
    const now = new Date();

    // Message throughput today
    const messagesToday = await db.collection('group_messages').countDocuments({ timestamp: { $gte: today } });

    // Commands today
    const commandsToday = await db.collection('command_usage').countDocuments({ timestamp: { $gte: today } });

    // Average + p95 command response time (computed in JS for MongoDB 6.x compatibility)
    const latencyRows = await db.collection('command_usage').aggregate([
      { $group: { _id: null, avg: { $avg: '$responseTimeMs' }, values: { $push: '$responseTimeMs' } } },
    ]).toArray();
    const latency = latencyRows[0];

    let p95 = null;
    if (latency && latency.values && latency.values.length > 0) {
      const sorted = [...latency.values].sort((a: number, b: number) => a - b);
      const idx = Math.ceil(sorted.length * 0.95) - 1;
      p95 = sorted[Math.max(0, idx)];
    }

    res.json({
      serverTime: now.toISOString(),
      messagesToday,
      commandsToday,
      totalThroughputToday: messagesToday + commandsToday,
      avgResponseTimeMs: latency ? Math.round(latency.avg) : null,
      p95ResponseTimeMs: p95 ? Math.round(p95) : null,
    });
  } catch (err) {
    console.error('[API] /api/stats/bot-health error:', err);
    res.status(500).json({ error: 'Failed to fetch bot health' });
  }
});

// ═══════════════════════════════════════════════════
// Start Server
// ═══════════════════════════════════════════════════
async function start() {
  try {
    await connectToMongo();
    app.listen(PORT, () => {
      console.log(`[Dashboard API] Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[Dashboard API] Failed to start:', err);
    process.exit(1);
  }
}

start();