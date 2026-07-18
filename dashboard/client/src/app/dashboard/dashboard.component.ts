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
  DashboardService,
  OverviewStats,
  TopSender,
  WarningEntry,
  CompanyEntry,
} from '../services/dashboard.service';

Chart.register(
  LineController, LineElement, PointElement,
  BarController, BarElement,
  DoughnutController, ArcElement,
  CategoryScale, LinearScale,
  Tooltip, Legend, Filler
);

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, BaseChartDirective, StatsCardComponent],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
})
export class DashboardComponent implements OnInit, OnDestroy {
  overview: OverviewStats = {
    messagesToday: 0,
    messagesAllTime: 0,
    totalUsers: 0,
    totalCompanies: 0,
    totalWarnings: 0,
    totalGroups: 0,
  };

  topSenders: TopSender[] = [];
  recentWarnings: WarningEntry[] = [];
  topCompanies: CompanyEntry[] = [];
  lastUpdated: Date = new Date();
  private refreshInterval: any;

  // ── Messages by Hour (Line Chart) ──
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
    elements: {
      line: { tension: 0.4 },
      point: { radius: 3, hoverRadius: 6 },
    },
  };

  // ── Messages by Day (Bar Chart) ──
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

  constructor(private dashboardService: DashboardService) {}

  ngOnInit() {
    this.loadAllData();
    this.refreshInterval = setInterval(() => this.loadAllData(), 30000);
  }

  ngOnDestroy() {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
  }

  loadAllData() {
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
          return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        }),
        datasets: [
          {
            data: data.map((d) => d.count),
            backgroundColor: [
              'rgba(139, 92, 246, 0.7)',
              'rgba(59, 130, 246, 0.7)',
              'rgba(16, 185, 129, 0.7)',
              'rgba(245, 158, 11, 0.7)',
              'rgba(239, 68, 68, 0.7)',
              'rgba(236, 72, 153, 0.7)',
              'rgba(99, 102, 241, 0.7)',
            ],
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
            backgroundColor: [
              'rgba(59, 130, 246, 0.7)',
              'rgba(139, 92, 246, 0.7)',
              'rgba(16, 185, 129, 0.7)',
              'rgba(245, 158, 11, 0.7)',
              'rgba(239, 68, 68, 0.7)',
            ],
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
            data: [data.rankBreakdown.A, data.rankBreakdown.B, data.rankBreakdown.unranked],
            backgroundColor: ['rgba(59, 130, 246, 0.8)', 'rgba(139, 92, 246, 0.8)', 'rgba(100, 116, 139, 0.6)'],
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
  }
}
