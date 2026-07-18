import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

const API_BASE = 'http://localhost:3001/api/stats';

export interface OverviewStats {
  messagesToday: number;
  messagesAllTime: number;
  totalUsers: number;
  totalCompanies: number;
  totalWarnings: number;
  totalGroups: number;
}

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

@Injectable({ providedIn: 'root' })
export class DashboardService {
  constructor(private http: HttpClient) {}

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
}
