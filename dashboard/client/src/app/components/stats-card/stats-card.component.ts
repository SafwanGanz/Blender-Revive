import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-stats-card',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="stats-card" [style.--accent]="accentColor">
      <div class="card-icon">{{ icon }}</div>
      <div class="card-content">
        <span class="card-value">{{ animatedValue | number }}</span>
        <span class="card-label">{{ label }}</span>
        <span class="card-subtitle" *ngIf="subtitle">{{ subtitle }}</span>
      </div>
    </div>
  `,
  styles: [`
    .stats-card {
      background: rgba(255, 255, 255, 0.04);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 24px;
      display: flex;
      align-items: center;
      gap: 18px;
      transition: transform 0.3s ease, box-shadow 0.3s ease, border-color 0.3s ease;
      animation: fadeInUp 0.5s ease both;
    }

    .stats-card:hover {
      transform: translateY(-4px);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
      border-color: var(--accent, #3b82f6);
    }

    .card-icon {
      font-size: 2.2rem;
      width: 56px;
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 14px;
      background: linear-gradient(135deg, var(--accent, #3b82f6), transparent);
      opacity: 0.9;
      flex-shrink: 0;
    }

    .card-content {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .card-value {
      font-size: 1.8rem;
      font-weight: 700;
      color: #f1f5f9;
      line-height: 1.1;
    }

    .card-label {
      font-size: 0.85rem;
      font-weight: 500;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .card-subtitle {
      font-size: 0.75rem;
      color: #64748b;
      margin-top: 2px;
    }

    @keyframes fadeInUp {
      from {
        opacity: 0;
        transform: translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
  `]
})
export class StatsCardComponent {
  @Input() icon: string = '📊';
  @Input() label: string = '';
  @Input() value: number = 0;
  @Input() subtitle: string = '';
  @Input() accentColor: string = '#3b82f6';

  animatedValue: number = 0;

  ngOnChanges() {
    this.animateValue(this.value);
  }

  private animateValue(target: number) {
    const duration = 800;
    const start = this.animatedValue;
    const diff = target - start;
    const startTime = performance.now();

    const step = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      this.animatedValue = Math.round(start + diff * eased);
      if (progress < 1) {
        requestAnimationFrame(step);
      }
    };

    requestAnimationFrame(step);
  }
}
