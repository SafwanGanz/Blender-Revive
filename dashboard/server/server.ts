import express from 'express';
import cors from 'cors';
import { MongoClient, Db } from 'mongodb';
import dotenv from 'dotenv';
import path from 'path';

import fs from 'fs';

// Load .env from the project root (handles both development ts-node and production dist/ paths)
let envPath = path.resolve(__dirname, '../../.env');
if (!fs.existsSync(envPath)) {
  envPath = path.resolve(__dirname, '../../../.env');
}
dotenv.config({ path: envPath });

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3001;

app.use(cors());
app.use(express.json());

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

// ─── Helper: Start of today (UTC) ───
function startOfToday(): Date {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  return now;
}

// ─── Helper: N days ago ───
function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ═══════════════════════════════════════════════════
// 1. Overview Stats
// ═══════════════════════════════════════════════════
app.get('/api/stats/overview', async (_req, res) => {
  try {
    const today = startOfToday();

    const [
      messagesToday,
      messagesAllTime,
      totalUsers,
      totalCompanies,
      totalWarnings,
      totalGroups,
    ] = await Promise.all([
      db.collection('group_messages').countDocuments({ timestamp: { $gte: today } }),
      db.collection('group_messages').countDocuments({}),
      db.collection('referrals').countDocuments({ deletedAt: { $exists: false } }),
      db.collection('referrals').distinct('company', { deletedAt: { $exists: false } }).then(c => c.length),
      db.collection('warnings').countDocuments({}),
      db.collection('group_messages').distinct('groupId').then(g => g.length),
    ]);

    res.json({
      messagesToday,
      messagesAllTime,
      totalUsers,
      totalCompanies,
      totalWarnings,
      totalGroups,
    });
  } catch (err) {
    console.error('[API] /api/stats/overview error:', err);
    res.status(500).json({ error: 'Failed to fetch overview stats' });
  }
});

// ═══════════════════════════════════════════════════
// 2. Messages by Hour (Today)
// ═══════════════════════════════════════════════════
app.get('/api/stats/messages-by-hour', async (_req, res) => {
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

    // Fill all 24 hours
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
app.get('/api/stats/messages-by-day', async (_req, res) => {
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

    // Fill missing days
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
app.get('/api/stats/top-groups', async (_req, res) => {
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

    const groups = results.map((r: any) => ({
      groupId: r._id,
      // Display a truncated readable name from the group JID
      name: r._id.replace('@g.us', '').slice(-10),
      count: r.count,
    }));

    res.json(groups);
  } catch (err) {
    console.error('[API] /api/stats/top-groups error:', err);
    res.status(500).json({ error: 'Failed to fetch top groups' });
  }
});

// ═══════════════════════════════════════════════════
// 5. Top Senders (Today)
// ═══════════════════════════════════════════════════
app.get('/api/stats/top-senders', async (_req, res) => {
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
app.get('/api/stats/companies', async (_req, res) => {
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

    // Sort by count descending
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
app.get('/api/stats/registrations-by-day', async (_req, res) => {
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
app.get('/api/stats/warnings', async (_req, res) => {
  try {
    const totalWarnings = await db.collection('warnings').countDocuments({});

    const recentWarnings = await db.collection('warnings')
      .find({})
      .sort({ warnedAt: -1 })
      .limit(10)
      .toArray();

    const warnings = recentWarnings.map((w: any) => ({
      userId: w.userId,
      userName: w.userName || w.userId?.split('@')[0] || 'Unknown',
      groupId: w.groupId,
      reason: w.reason || 'No reason specified',
      warnedAt: w.warnedAt,
      warnNumber: w.warnNumber,
    }));

    res.json({ totalWarnings, recent: warnings });
  } catch (err) {
    console.error('[API] /api/stats/warnings error:', err);
    res.status(500).json({ error: 'Failed to fetch warnings' });
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
