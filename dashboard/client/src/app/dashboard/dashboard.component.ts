import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BaseChartDirective } from 'ng2-charts';
import { ChartConfiguration, ChartData } from 'chart.js';
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  BarController,
  BarElement,
  DoughnutController,
  ArcElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { StatsCardComponent } from '../components/stats-card/stats-card.component';
import {
  PeriodSelectorComponent,
  PeriodKey,
} from '../components/period-selector/period-selector.component';
import { HeatmapData } from '../services/dashboard.service';
import { AuthService } from '../services/auth.service';
import { Router } from '@angular/router';
import {
  DashboardService,
  OverviewStats,
  TopSender,
  WarningEntry,
  CompanyEntry,
  CommandUsageStats,
  ChatTypeBreakdown,
  GroupEngagement,
  DauWauMauPoint,
  NewVsReturningPoint,
  PeriodTrend,
  MessageTypeBreakdown,
  BotHealth,
  WarnedUser,
  WarningGroup,
  ActiveGroup,
  TopCompanyEntry,
} from '../services/dashboard.service';

Chart.register(
  LineController,
  LineElement,
  PointElement,
  BarController,
  BarElement,
  DoughnutController,
  ArcElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
  Filler,
);

type TabKey =
  | 'overview'
  | 'commands'
  | 'groups'
  | 'users'
  | 'warnings'
  | 'companies'
  | 'health';

const CHART_PALETTE = [
  '#3b82f6',
  '#8b5cf6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#06b6d4',
  '#ec4899',
  '#6366f1',
  '#84cc16',
  '#f97316',
];

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    BaseChartDirective,
    StatsCardComponent,
    PeriodSelectorComponent,
  ],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
})
export class DashboardComponent implements OnInit, OnDestroy {
  // Expose Math to templates (Angular templates don't have access to globals)
  math = Math;

  // ── Tab state ──
  activeTab: TabKey = 'overview';
  tabs: { key: TabKey; label: string; icon: string }[] = [
    { key: 'overview', label: 'Overview', icon: '📊' },
    { key: 'commands', label: 'Commands', icon: '💻' },
    { key: 'groups', label: 'Groups', icon: '👥' },
    { key: 'users', label: 'Users', icon: '🧑‍💻' },
    { key: 'warnings', label: 'Warnings', icon: '⚠️' },
    { key: 'companies', label: 'Companies', icon: '🏢' },
    { key: 'health', label: 'Health', icon: '🩺' },
  ];

  // ── Overview data ──
  overview: OverviewStats = {
    messagesToday: 0,
    messagesAllTime: 0,
    totalUsers: 0,
    totalCompanies: 0,
    totalWarnings: 0,
    totalGroups: 0,
    commandsToday: 0,
    commandsAllTime: 0,
    dau: 0,
    mau: 0,
  };
  topSenders: TopSender[] = [];
  recentWarnings: WarningEntry[] = [];
  topCompanies: CompanyEntry[] = [];
  lastUpdated: Date = new Date();
  private refreshInterval: any;

  // ── Period state ──
  groupPeriod: PeriodKey = 'month';
  userPeriod: PeriodKey = 'month';
  companyPeriod: PeriodKey = 'month';
  commandPeriod: string = '30d';

  // ── Command analytics ──
  commandStats: CommandUsageStats = { total: 0, commands: [] };
  chatTypeBreakdown: ChatTypeBreakdown = { dm: 0, group: 0, total: 0 };
  messageTypeBreakdown: MessageTypeBreakdown = {
    days: 30,
    totalMessages: 0,
    commandMessages: 0,
    regularMessages: 0,
  };

  // ── Groups analytics ──
  activeGroups: ActiveGroup[] = [];
  groupEngagement: GroupEngagement | null = null;
  selectedGroupId: string = '';
  messagesByGroup: { groupId: string; name: string; messages: number }[] = [];

  // ── Users analytics ──
  heatmapData: HeatmapData = { days: 30, grid: [] };
  heatmapHours: string[] = Array.from(
    { length: 24 },
    (_, i) => `${String(i).padStart(2, '0')}:00`,
  );
  heatmapDays: string[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // ── Warnings analytics ──
  warningFunnel: { stage: string; users: number }[] = [];
  topWarnedUsers: WarnedUser[] = [];
  warningsByGroup: WarningGroup[] = [];

  // ── Companies analytics ──
  topCompaniesByReg: TopCompanyEntry[] = [];

  // ── Health analytics ──
  botHealth: BotHealth = {
    serverTime: '',
    messagesToday: 0,
    commandsToday: 0,
    totalThroughputToday: 0,
    avgResponseTimeMs: null,
    p95ResponseTimeMs: null,
  };

  // ══════════════════════════════════════════════════════════════
  // CHART CONFIGURATIONS
  // ══════════════════════════════════════════════════════════════

  // ── Messages by Hour (Line) ──
  hourlyChartData: ChartData<'line'> = { labels: [], datasets: [] };
  hourlyChartOptions: ChartConfiguration<'line'>['options'] = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.9)',
        titleColor: '#e2e8f0',
        bodyColor: '#94a3b8',
        borderColor: 'rgba(59, 130, 246, 0.3)',
        borderWidth: 1,
        padding: 12,
        cornerRadius: 8,
      },
    },
    scales: {
      x: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#64748b', font: { size: 11 } },
      },
      y: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#64748b', font: { size: 11 } },
        beginAtZero: true,
      },
    },
    elements: { line: { tension: 0.4 }, point: { radius: 3, hoverRadius: 6 } },
  };

  // ── Messages by Day (Bar) ──
  weeklyChartData: ChartData<'bar'> = { labels: [], datasets: [] };
  weeklyChartOptions: ChartConfiguration<'bar'>['options'] = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.9)',
        titleColor: '#e2e8f0',
        bodyColor: '#94a3b8',
        borderColor: 'rgba(139, 92, 246, 0.3)',
        borderWidth: 1,
        padding: 12,
        cornerRadius: 8,
      },
    },
    scales: {
      x: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#64748b', font: { size: 11 } },
      },
      y: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#64748b', font: { size: 11 } },
        beginAtZero: true,
      },
    },
  };

  // ── Top Groups (Horizontal Bar) ──
  groupsChartData: ChartData<'bar'> = { labels: [], datasets: [] };
  groupsChartOptions: ChartConfiguration<'bar'>['options'] = {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.9)',
        titleColor: '#e2e8f0',
        bodyColor: '#94a3b8',
        padding: 12,
        cornerRadius: 8,
      },
    },
    scales: {
      x: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#64748b', font: { size: 11 } },
        beginAtZero: true,
      },
      y: {
        grid: { display: false },
        ticks: { color: '#94a3b8', font: { size: 12 } },
      },
    },
  };

  // ── Company Breakdown (Doughnut) ──
  companyChartData: ChartData<'doughnut'> = { labels: [], datasets: [] };
  companyChartOptions: ChartConfiguration<'doughnut'>['options'] = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '65%',
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          color: '#94a3b8',
          font: { size: 12 },
          padding: 16,
          usePointStyle: true,
          pointStyleWidth: 12,
        },
      },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.9)',
        titleColor: '#e2e8f0',
        bodyColor: '#94a3b8',
        padding: 12,
        cornerRadius: 8,
      },
    },
  };

  // ── Command Usage Distribution (Doughnut) ──
  commandChartData: ChartData<'doughnut'> = { labels: [], datasets: [] };
  commandChartOptions: ChartConfiguration<'doughnut'>['options'] = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '60%',
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          color: '#94a3b8',
          font: { size: 11 },
          padding: 12,
          usePointStyle: true,
          pointStyleWidth: 10,
        },
      },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.9)',
        titleColor: '#e2e8f0',
        bodyColor: '#94a3b8',
        padding: 12,
        cornerRadius: 8,
      },
    },
  };

  // ── Command Usage Trend (Line) ──
  commandTrendChartData: ChartData<'line'> = { labels: [], datasets: [] };
  commandTrendChartOptions: ChartConfiguration<'line'>['options'] = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.9)',
        titleColor: '#e2e8f0',
        bodyColor: '#94a3b8',
        padding: 12,
        cornerRadius: 8,
      },
    },
    scales: {
      x: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#64748b', font: { size: 11 } },
      },
      y: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#64748b', font: { size: 11 } },
        beginAtZero: true,
      },
    },
    elements: { line: { tension: 0.35 }, point: { radius: 2, hoverRadius: 5 } },
  };

  // ── DM vs Group (Doughnut) ──
  chatTypeChartData: ChartData<'doughnut'> = { labels: [], datasets: [] };
  chatTypeChartOptions: ChartConfiguration<'doughnut'>['options'] = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '65%',
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          color: '#94a3b8',
          font: { size: 12 },
          padding: 16,
          usePointStyle: true,
          pointStyleWidth: 12,
        },
      },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.9)',
        titleColor: '#e2e8f0',
        bodyColor: '#94a3b8',
        padding: 12,
        cornerRadius: 8,
      },
    },
  };

  // ── Message Type Breakdown (Doughnut) ──
  msgTypeChartData: ChartData<'doughnut'> = { labels: [], datasets: [] };

  // ── DAU/WAU/MAU (Multi-line) ──
  dauWauMauChartData: ChartData<'line'> = { labels: [], datasets: [] };
  dauWauMauChartOptions: ChartConfiguration<'line'>['options'] = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          color: '#94a3b8',
          font: { size: 11 },
          padding: 16,
          usePointStyle: true,
          pointStyleWidth: 10,
        },
      },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.9)',
        titleColor: '#e2e8f0',
        bodyColor: '#94a3b8',
        padding: 12,
        cornerRadius: 8,
      },
    },
    scales: {
      x: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#64748b', font: { size: 10 } },
      },
      y: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#64748b', font: { size: 10 } },
        beginAtZero: true,
      },
    },
    elements: {
      line: { tension: 0.3 },
      point: { radius: 1.5, hoverRadius: 4 },
    },
  };

  // ── New vs Returning (Stacked Bar) ──
  newVsReturningChartData: ChartData<'bar'> = { labels: [], datasets: [] };
  newVsReturningChartOptions: ChartConfiguration<'bar'>['options'] = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          color: '#94a3b8',
          font: { size: 11 },
          padding: 16,
          usePointStyle: true,
          pointStyleWidth: 10,
        },
      },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.9)',
        titleColor: '#e2e8f0',
        bodyColor: '#94a3b8',
        padding: 12,
        cornerRadius: 8,
      },
    },
    scales: {
      x: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#64748b', font: { size: 10 } },
        stacked: true,
      },
      y: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#64748b', font: { size: 10 } },
        beginAtZero: true,
        stacked: true,
      },
    },
  };

  // ── Registration Trend (Bar) ──
  registrationTrendChartData: ChartData<'bar'> = { labels: [], datasets: [] };
  registrationTrendChartOptions: ChartConfiguration<'bar'>['options'] = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.9)',
        titleColor: '#e2e8f0',
        bodyColor: '#94a3b8',
        padding: 12,
        cornerRadius: 8,
      },
    },
    scales: {
      x: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#64748b', font: { size: 10 } },
      },
      y: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#64748b', font: { size: 10 } },
        beginAtZero: true,
      },
    },
  };

  // ── Message Volume by Period (Bar) ──
  msgVolumeChartData: ChartData<'bar'> = { labels: [], datasets: [] };
  msgVolumeChartOptions: ChartConfiguration<'bar'>['options'] = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.9)',
        titleColor: '#e2e8f0',
        bodyColor: '#94a3b8',
        padding: 12,
        cornerRadius: 8,
      },
    },
    scales: {
      x: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#64748b', font: { size: 10 } },
      },
      y: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#64748b', font: { size: 10 } },
        beginAtZero: true,
      },
    },
  };

  // ── Company Growth (Multi-line) ──
  companyGrowthChartData: ChartData<'line'> = { labels: [], datasets: [] };
  companyGrowthChartOptions: ChartConfiguration<'line'>['options'] = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          color: '#94a3b8',
          font: { size: 10 },
          padding: 12,
          usePointStyle: true,
          pointStyleWidth: 8,
        },
      },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.9)',
        titleColor: '#e2e8f0',
        bodyColor: '#94a3b8',
        padding: 12,
        cornerRadius: 8,
      },
    },
    scales: {
      x: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#64748b', font: { size: 10 } },
      },
      y: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#64748b', font: { size: 10 } },
        beginAtZero: true,
      },
    },
    elements: { line: { tension: 0.3 }, point: { radius: 2, hoverRadius: 4 } },
  };

  // ── Warnings by Period (Bar) ──
  warningsPeriodChartData: ChartData<'bar'> = { labels: [], datasets: [] };
  warningsPeriodChartOptions: ChartConfiguration<'bar'>['options'] = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.9)',
        titleColor: '#e2e8f0',
        bodyColor: '#94a3b8',
        padding: 12,
        cornerRadius: 8,
      },
    },
    scales: {
      x: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#64748b', font: { size: 10 } },
      },
      y: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#64748b', font: { size: 10 } },
        beginAtZero: true,
      },
    },
  };

  // ── Warning Funnel (Horizontal Bar) ──
  warningFunnelChartData: ChartData<'bar'> = { labels: [], datasets: [] };
  warningFunnelChartOptions: ChartConfiguration<'bar'>['options'] = {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.9)',
        titleColor: '#e2e8f0',
        bodyColor: '#94a3b8',
        padding: 12,
        cornerRadius: 8,
      },
    },
    scales: {
      x: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#64748b', font: { size: 11 } },
        beginAtZero: true,
      },
      y: {
        grid: { display: false },
        ticks: { color: '#94a3b8', font: { size: 12 } },
      },
    },
  };

  // ── Warnings by Group (Horizontal Bar) ──
  warningsByGroupChartData: ChartData<'bar'> = { labels: [], datasets: [] };
  warningsByGroupChartOptions: ChartConfiguration<'bar'>['options'] = {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.9)',
        titleColor: '#e2e8f0',
        bodyColor: '#94a3b8',
        padding: 12,
        cornerRadius: 8,
      },
    },
    scales: {
      x: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { color: '#64748b', font: { size: 11 } },
        beginAtZero: true,
      },
      y: {
        grid: { display: false },
        ticks: { color: '#94a3b8', font: { size: 12 } },
      },
    },
  };

  // ── Company rank helpers (safe for strict templates) ──
  get rankA(): number {
    return this.companyChartData.datasets[0]?.data?.[0] || 0;
  }

  get rankB(): number {
    return this.companyChartData.datasets[0]?.data?.[1] || 0;
  }

  // ── Warning funnel helpers (safe for strict templates) ──
  get warnedOnce(): number {
    return this.warningFunnel[0]?.users || 0;
  }

  get warnedTwice(): number {
    return this.warningFunnel[1]?.users || 0;
  }

  get warnedThrice(): number {
    return this.warningFunnel[2]?.users || 0;
  }

  // ── Heatmap helpers ──
  heatmapMax: number = 1;
  heatmapCellColor(count: number): string {
    if (count === 0) return 'rgba(255,255,255,0.02)';
    const ratio = count / this.heatmapMax;
    const alpha = 0.15 + ratio * 0.85;
    return `rgba(59, 130, 246, ${alpha.toFixed(2)})`;
  }

  constructor(private dashboardService: DashboardService, private auth: AuthService, private router: Router) {}

  logout() {
    this.auth.logout();
    this.router.navigate(['/login']);
  }

  ngOnInit() {
    this.loadAllData();
    this.refreshInterval = setInterval(() => this.loadAllData(), 30000);
  }

  ngOnDestroy() {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
  }

  // ── Tab switching ──
  setTab(tab: TabKey) {
    this.activeTab = tab;
  }

  // ── Period changes ──
  onGroupPeriodChange(period: PeriodKey) {
    this.groupPeriod = period;
    if (period === 'day' || period === 'week') {
      // Active users by group supports month/quarter/year server-side; fall back to month for day/week
      this.loadGroupData('month');
    } else {
      this.loadGroupData(period);
    }
  }

  onUserPeriodChange(period: PeriodKey) {
    this.userPeriod = period;
    this.loadRegistrationTrend(period);
  }

  onCompanyPeriodChange(period: PeriodKey) {
    this.companyPeriod = period;
    this.loadCompanyData(period);
  }

  onCommandPeriodChange(period: string) {
    this.commandPeriod = period;
    this.loadCommandData();
  }

  // ══════════════════════════════════════════════════
  // DATA LOADING
  // ══════════════════════════════════════════════════

  loadAllData() {
    // Overview (always loaded)
    this.dashboardService.getOverview().subscribe((data) => {
      this.overview = data;
      this.lastUpdated = new Date();
    });

    this.dashboardService.getMessagesByHour().subscribe((data) => {
      this.hourlyChartData = {
        labels: data.map((d) => `${d.hour}:00`),
        datasets: [
          {
            data: data.map((d) => d.count),
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            fill: true,
            borderWidth: 2,
            pointBackgroundColor: '#3b82f6',
          },
        ],
      };
    });

    this.dashboardService.getMessagesByDay().subscribe((data) => {
      this.weeklyChartData = {
        labels: data.map((d) => {
          const date = new Date(d.date);
          return date.toLocaleDateString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
          });
        }),
        datasets: [
          {
            data: data.map((d) => d.count),
            backgroundColor: CHART_PALETTE.slice(0, data.length),
            borderRadius: 8,
            borderSkipped: false,
          },
        ],
      };
    });

    this.dashboardService.getTopGroups().subscribe((data) => {
      this.groupsChartData = {
        labels: data.map((d) => `Group ...${d.name}`),
        datasets: [
          {
            data: data.map((d) => d.count),
            backgroundColor: CHART_PALETTE.slice(0, data.length),
            borderRadius: 6,
            borderSkipped: false,
          },
        ],
      };
    });

    this.dashboardService.getTopSenders().subscribe((data) => {
      this.topSenders = data;
    });

    this.dashboardService.getCompanies().subscribe((data) => {
      this.topCompanies = data.companies.slice(0, 8);
      this.companyChartData = {
        labels: ['Rank A (Enterprise)', 'Rank B (Startups)', 'Unranked'],
        datasets: [
          {
            data: [
              data.rankBreakdown.A,
              data.rankBreakdown.B,
              data.rankBreakdown.unranked,
            ],
            backgroundColor: [
              'rgba(59, 130, 246, 0.8)',
              'rgba(139, 92, 246, 0.8)',
              'rgba(100, 116, 139, 0.6)',
            ],
            borderColor: ['#3b82f6', '#8b5cf6', '#64748b'],
            borderWidth: 2,
            hoverOffset: 8,
          },
        ],
      };
    });

    this.dashboardService.getWarnings().subscribe((data) => {
      this.recentWarnings = data.recent;
    });

    this.dashboardService.getBotHealth().subscribe((data) => {
      this.botHealth = data;
    });

    // Command analytics
    this.loadCommandData();

    // Group analytics
    this.loadGroupData(
      this.groupPeriod === 'day' || this.groupPeriod === 'week'
        ? 'month'
        : this.groupPeriod,
    );

    // User engagement
    this.dashboardService
      .getDauWauMau(30)
      .subscribe((data: DauWauMauPoint[]) => {
        this.dauWauMauChartData = {
          labels: data.map((d) => d.date),
          datasets: [
            {
              label: 'DAU',
              data: data.map((d) => d.dau),
              borderColor: '#3b82f6',
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
              fill: false,
              borderWidth: 2,
              pointRadius: 1.5,
              tension: 0.3,
            },
            {
              label: 'WAU',
              data: data.map((d) => d.wau),
              borderColor: '#8b5cf6',
              backgroundColor: 'rgba(139, 92, 246, 0.1)',
              fill: false,
              borderWidth: 2,
              pointRadius: 1.5,
              tension: 0.3,
            },
            {
              label: 'MAU',
              data: data.map((d) => d.mau),
              borderColor: '#10b981',
              backgroundColor: 'rgba(16, 185, 129, 0.1)',
              fill: false,
              borderWidth: 2,
              pointRadius: 1.5,
              tension: 0.3,
            },
          ],
        };
      });

    this.dashboardService
      .getNewVsReturning(30)
      .subscribe((data: NewVsReturningPoint[]) => {
        this.newVsReturningChartData = {
          labels: data.map((d) => d.date),
          datasets: [
            {
              label: 'New Users',
              data: data.map((d) => d.newUsers),
              backgroundColor: 'rgba(16, 185, 129, 0.7)',
              borderRadius: 3,
            },
            {
              label: 'Returning',
              data: data.map((d) => d.returning),
              backgroundColor: 'rgba(59, 130, 246, 0.7)',
              borderRadius: 3,
            },
          ],
        };
      });

    this.loadRegistrationTrend(
      this.userPeriod === 'day' || this.userPeriod === 'week'
        ? 'month'
        : this.userPeriod,
    );

    this.dashboardService
      .getUserActivityHeatmap(30)
      .subscribe((data: HeatmapData) => {
        this.heatmapData = data;
        this.heatmapMax = Math.max(1, ...data.grid.flat());
      });

    // Message analytics
    this.dashboardService
      .getMessageTypeBreakdown(30)
      .subscribe((data: MessageTypeBreakdown) => {
        this.messageTypeBreakdown = data;
        this.msgTypeChartData = {
          labels: ['Command Messages', 'Regular Messages'],
          datasets: [
            {
              data: [data.commandMessages, data.regularMessages],
              backgroundColor: [
                'rgba(139, 92, 246, 0.8)',
                'rgba(59, 130, 246, 0.8)',
              ],
              borderColor: ['#8b5cf6', '#3b82f6'],
              borderWidth: 2,
              hoverOffset: 8,
            },
          ],
        };
      });

    this.dashboardService
      .getMessagesByPeriod('month')
      .subscribe((data: PeriodTrend) => {
        this.msgVolumeChartData = {
          labels: data.trend.map((t) => t.period),
          datasets: [
            {
              data: data.trend.map((t) => t.count),
              backgroundColor: CHART_PALETTE,
              borderRadius: 5,
              borderSkipped: false,
            },
          ],
        };
      });

    // Warning analytics
    this.dashboardService
      .getWarningsByPeriod('month')
      .subscribe((data: PeriodTrend) => {
        this.warningsPeriodChartData = {
          labels: data.trend.map((t) => t.period),
          datasets: [
            {
              data: data.trend.map((t) => t.count),
              backgroundColor: 'rgba(239, 68, 68, 0.7)',
              borderRadius: 6,
              borderSkipped: false,
            },
          ],
        };
      });

    this.dashboardService.getWarningOutcomes().subscribe((data) => {
      this.warningFunnel = data.funnel;
      this.warningFunnelChartData = {
        labels: data.funnel.map((f) => f.stage),
        datasets: [
          {
            data: data.funnel.map((f) => f.users),
            backgroundColor: [
              'rgba(59, 130, 246, 0.7)',
              'rgba(245, 158, 11, 0.7)',
              'rgba(239, 68, 68, 0.7)',
            ],
            borderRadius: 6,
            borderSkipped: false,
          },
        ],
      };
    });

    this.dashboardService.getTopWarnedUsers(10).subscribe((data) => {
      this.topWarnedUsers = data.users;
    });

    this.dashboardService.getWarningsByGroup('month').subscribe((data) => {
      this.warningsByGroup = data.groups;
      this.warningsByGroupChartData = {
        labels: data.groups.map((g) => `Group ...${g.name}`),
        datasets: [
          {
            data: data.groups.map((g) => g.count),
            backgroundColor: data.groups.map(
              (_, i) => `rgba(239, 68, 68, ${0.9 - i * 0.08})`,
            ),
            borderRadius: 6,
            borderSkipped: false,
          },
        ],
      };
    });

    // Company analytics
    this.dashboardService.getTopCompaniesByRegistration().subscribe((data) => {
      this.topCompaniesByReg = data.companies;
    });

    this.loadCompanyData(
      this.companyPeriod === 'day' || this.companyPeriod === 'week'
        ? 'month'
        : this.companyPeriod,
    );
  }

  loadCommandData() {
    // Command period options: 7d, 30d, 90d, 1y, all
    const periodMap: Record<string, string> = {
      '7d': '7d',
      '30d': '30d',
      '90d': '90d',
      '1y': '1y',
      all: 'all',
    };
    const period = periodMap[this.commandPeriod] || '30d';

    this.dashboardService
      .getCommandUsage(period)
      .subscribe((data: CommandUsageStats) => {
        this.commandStats = data;
        this.commandChartData = {
          labels: data.commands.slice(0, 8).map((c) => `/${c.command}`),
          datasets: [
            {
              data: data.commands.slice(0, 8).map((c) => c.count),
              backgroundColor: CHART_PALETTE.map((c) => c + 'CC'),
              borderColor: CHART_PALETTE,
              borderWidth: 1.5,
              hoverOffset: 8,
            },
          ],
        };
      });

    const days =
      period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : 365;
    this.dashboardService.getCommandUsageTrend(days).subscribe((data) => {
      this.commandTrendChartData = {
        labels: data.map((d) => d.date),
        datasets: [
          {
            data: data.map((d) => d.count),
            borderColor: '#8b5cf6',
            backgroundColor: 'rgba(139, 92, 246, 0.1)',
            fill: true,
            borderWidth: 2,
            pointBackgroundColor: '#8b5cf6',
          },
        ],
      };
    });

    this.dashboardService
      .getCommandUsageByChatType(Math.min(days, 90))
      .subscribe((data: ChatTypeBreakdown) => {
        this.chatTypeBreakdown = data;
        this.chatTypeChartData = {
          labels: ['Group Chat', 'Direct Messages'],
          datasets: [
            {
              data: [data.group, data.dm],
              backgroundColor: [
                'rgba(59, 130, 246, 0.8)',
                'rgba(16, 185, 129, 0.8)',
              ],
              borderColor: ['#3b82f6', '#10b981'],
              borderWidth: 2,
              hoverOffset: 8,
            },
          ],
        };
      });
  }

  loadGroupData(period: PeriodKey) {
    if (period === 'day' || period === 'week') period = 'month';

    this.dashboardService
      .getActiveUsersByGroup(period, 10)
      .subscribe((data) => {
        this.activeGroups = data.groups;
        this.groupsChartData = {
          labels: data.groups.map((g) => `Group ...${g.name}`),
          datasets: [
            {
              data: data.groups.map((g) => g.activeUsers),
              backgroundColor: CHART_PALETTE.slice(0, data.groups.length),
              borderRadius: 6,
              borderSkipped: false,
            },
          ],
        };
      });

    this.dashboardService.getMessagesByGroup(period, 10).subscribe((data) => {
      this.messagesByGroup = data.groups;
    });
  }

  loadRegistrationTrend(period: PeriodKey) {
    if (period === 'day' || period === 'week') period = 'month';
    this.dashboardService
      .getRegistrationTrend(period)
      .subscribe((data: PeriodTrend) => {
        this.registrationTrendChartData = {
          labels: data.trend.map((t) => t.period),
          datasets: [
            {
              data: data.trend.map((t) => t.count),
              backgroundColor: 'rgba(16, 185, 129, 0.7)',
              borderRadius: 6,
              borderSkipped: false,
            },
          ],
        };
      });
  }

  loadCompanyData(period: PeriodKey) {
    if (period === 'day' || period === 'week') period = 'month';
    this.dashboardService.getCompanyGrowth(period).subscribe((data) => {
      // Build union of all period labels across series
      const allLabels = new Set<string>();
      for (const s of data.series) {
        for (const p of s.points) allLabels.add(p.period);
      }
      const labels = Array.from(allLabels).sort();

      this.companyGrowthChartData = {
        labels,
        datasets: data.series.map((s, i) => {
          const color = CHART_PALETTE[i % CHART_PALETTE.length];
          const values = labels.map((lbl) => {
            const point = s.points.find((p) => p.period === lbl);
            return point ? point.count : 0;
          });
          return {
            label: s.company.replace(/_/g, ' '),
            data: values,
            borderColor: color,
            backgroundColor: color + '33',
            fill: false,
            borderWidth: 2,
            pointRadius: 2,
            tension: 0.3,
          };
        }),
      };
    });
  }
}
