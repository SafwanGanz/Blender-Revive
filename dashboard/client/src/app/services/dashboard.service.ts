import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

const API_BASE = 'http://localhost:3001/api/stats';

// ─── Overview ───
export interface OverviewStats {
  messagesToday: number;
  messagesAllTime: number;
  totalUsers: number;
  totalCompanies: number;
  totalWarnings: number;
  totalGroups: number;
  commandsToday: number;
  commandsAllTime: number;
  dau: number;
  mau: number;
}

// ─── Messages ───
export interface HourlyMessage {
  hour: number;
  count: number;
}

export interface DailyMessage {
  date: string;
  count: number;
}

export interface TopGroup {
  groupId: string;
  name: string;
  count: number;
}

export interface TopSender {
  jid: string;
  name: string;
  count: number;
}

// ─── Companies ───
export interface CompanyEntry {
  company: string;
  displayName: string;
  rank: string;
  count: number;
}

export interface CompanyStats {
  rankBreakdown: { A: number; B: number; unranked: number };
  companies: CompanyEntry[];
}

// ─── Warnings ───
export interface WarningEntry {
  userId: string;
  userName: string;
  groupId: string;
  reason: string;
  warnedAt: string;
  warnNumber: number;
}

export interface WarningStats {
  totalWarnings: number;
  recent: WarningEntry[];
}

export interface WarningTrendPoint {
  period: string;
  count: number;
}

export interface WarningFunnel {
  funnel: { stage: string; users: number }[];
}

export interface WarnedUser {
  userId: string;
  name: string;
  totalWarnings: number;
  groups: number;
}

export interface WarningGroup {
  groupId: string;
  name: string;
  count: number;
}

// ─── Command Usage ───
export interface CommandUsageEntry {
  command: string;
  count: number;
  pct: number;
}

export interface CommandUsageStats {
  total: number;
  commands: CommandUsageEntry[];
}

export interface TrendPoint {
  date: string;
  count: number;
}

export interface ChatTypeBreakdown {
  dm: number;
  group: number;
  total: number;
}

// ─── Groups & Engagement ───
export interface ActiveGroup {
  groupId: string;
  name: string;
  activeUsers: number;
  messages: number;
}

export interface GroupEngagement {
  groupId: string;
  name: string;
  period: string;
  messages: number;
  activeUsers: number;
  topSenders: TopSender[];
}

// ─── User Engagement ───
export interface DauWauMauPoint {
  date: string;
  dau: number;
  wau: number;
  mau: number;
}

export interface NewVsReturningPoint {
  date: string;
  newUsers: number;
  returning: number;
}

export interface PeriodTrend {
  period: string;
  trend: { period: string; count: number }[];
}

export interface HeatmapData {
  days: number;
  grid: number[][];
}

// ─── Message Analytics ───
export interface MessageTypeBreakdown {
  days: number;
  totalMessages: number;
  commandMessages: number;
  regularMessages: number;
}

export interface GroupMessages {
  period: string;
  groups: { groupId: string; name: string; messages: number }[];
}

// ─── Company Growth ───
export interface CompanyGrowth {
  period: string;
  series: { company: string; points: { period: string; count: number }[] }[];
}

export interface TopCompanyEntry extends CompanyEntry {}

// ─── Bot Health ───
export interface BotHealth {
  serverTime: string;
  messagesToday: number;
  commandsToday: number;
  totalThroughputToday: number;
  avgResponseTimeMs: number | null;
  p95ResponseTimeMs: number | null;
}

@Injectable({ providedIn: 'root' })
export class DashboardService {
  constructor(private http: HttpClient) {}

  // ── Overview & Messages ──
  getOverview(): Observable<OverviewStats> {
    return this.http.get<OverviewStats>(`${API_BASE}/overview`);
  }

  getMessagesByHour(): Observable<HourlyMessage[]> {
    return this.http.get<HourlyMessage[]>(`${API_BASE}/messages-by-hour`);
  }

  getMessagesByDay(): Observable<DailyMessage[]> {
    return this.http.get<DailyMessage[]>(`${API_BASE}/messages-by-day`);
  }

  getTopGroups(): Observable<TopGroup[]> {
    return this.http.get<TopGroup[]>(`${API_BASE}/top-groups`);
  }

  getTopSenders(): Observable<TopSender[]> {
    return this.http.get<TopSender[]>(`${API_BASE}/top-senders`);
  }

  getCompanies(): Observable<CompanyStats> {
    return this.http.get<CompanyStats>(`${API_BASE}/companies`);
  }

  getRegistrationsByDay(): Observable<DailyMessage[]> {
    return this.http.get<DailyMessage[]>(`${API_BASE}/registrations-by-day`);
  }

  getWarnings(): Observable<WarningStats> {
    return this.http.get<WarningStats>(`${API_BASE}/warnings`);
  }

  // ── Command Usage ──
  getCommandUsage(period: string = 'all'): Observable<CommandUsageStats> {
    return this.http.get<CommandUsageStats>(`${API_BASE}/command-usage?period=${period}`);
  }

  getCommandUsageTrend(days: number = 30): Observable<TrendPoint[]> {
    return this.http.get<TrendPoint[]>(`${API_BASE}/command-usage-trend?days=${days}`);
  }

  getCommandUsageByChatType(days: number = 30): Observable<ChatTypeBreakdown> {
    return this.http.get<ChatTypeBreakdown>(`${API_BASE}/command-usage-by-chat-type?days=${days}`);
  }

  // ── Active Users Per Group ──
  getActiveUsersByGroup(period: string = 'month', limit: number = 10): Observable<{ period: string; groups: ActiveGroup[] }> {
    return this.http.get<{ period: string; groups: ActiveGroup[] }>(`${API_BASE}/active-users-by-group?period=${period}&limit=${limit}`);
  }

  getGroupEngagement(groupId: string, period: string = 'month'): Observable<GroupEngagement> {
    return this.http.get<GroupEngagement>(`${API_BASE}/group-engagement/${encodeURIComponent(groupId)}?period=${period}`);
  }

  // ── User Engagement ──
  getDauWauMau(days: number = 30): Observable<DauWauMauPoint[]> {
    return this.http.get<DauWauMauPoint[]>(`${API_BASE}/dau-wau-mau?days=${days}`);
  }

  getNewVsReturning(days: number = 30): Observable<NewVsReturningPoint[]> {
    return this.http.get<NewVsReturningPoint[]>(`${API_BASE}/new-vs-returning?days=${days}`);
  }

  getRegistrationTrend(period: string = 'month'): Observable<PeriodTrend> {
    return this.http.get<PeriodTrend>(`${API_BASE}/registration-trend?period=${period}`);
  }

  getUserActivityHeatmap(days: number = 30): Observable<HeatmapData> {
    return this.http.get<HeatmapData>(`${API_BASE}/user-activity-heatmap?days=${days}`);
  }

  // ── Message Analytics ──
  getMessagesByPeriod(period: string = 'month'): Observable<PeriodTrend> {
    return this.http.get<PeriodTrend>(`${API_BASE}/messages-by-period?period=${period}`);
  }

  getMessageTypeBreakdown(days: number = 30): Observable<MessageTypeBreakdown> {
    return this.http.get<MessageTypeBreakdown>(`${API_BASE}/message-type-breakdown?days=${days}`);
  }

  getMessagesByGroup(period: string = 'month', limit: number = 10): Observable<GroupMessages> {
    return this.http.get<GroupMessages>(`${API_BASE}/messages-by-group?period=${period}&limit=${limit}`);
  }

  // ── Warning Analytics ──
  getWarningsByPeriod(period: string = 'month'): Observable<PeriodTrend> {
    return this.http.get<PeriodTrend>(`${API_BASE}/warnings-by-period?period=${period}`);
  }

  getWarningOutcomes(): Observable<WarningFunnel> {
    return this.http.get<WarningFunnel>(`${API_BASE}/warning-outcomes`);
  }

  getTopWarnedUsers(limit: number = 10): Observable<{ users: WarnedUser[] }> {
    return this.http.get<{ users: WarnedUser[] }>(`${API_BASE}/top-warned-users?limit=${limit}`);
  }

  getWarningsByGroup(period: string = 'month'): Observable<{ period: string; groups: WarningGroup[] }> {
    return this.http.get<{ period: string; groups: WarningGroup[] }>(`${API_BASE}/warnings-by-group?period=${period}`);
  }

  // ── Company Growth ──
  getTopCompaniesByRegistration(): Observable<{ companies: TopCompanyEntry[] }> {
    return this.http.get<{ companies: TopCompanyEntry[] }>(`${API_BASE}/top-companies-by-registration`);
  }

  getCompanyGrowth(period: string = 'month'): Observable<CompanyGrowth> {
    return this.http.get<CompanyGrowth>(`${API_BASE}/company-growth?period=${period}`);
  }

  // ── Bot Health ──
  getBotHealth(): Observable<BotHealth> {
    return this.http.get<BotHealth>(`${API_BASE}/bot-health`);
  }
}