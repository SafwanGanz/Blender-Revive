import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

export type PeriodKey = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all';

interface PeriodOption {
  key: PeriodKey;
  label: string;
}

@Component({
  selector: 'app-period-selector',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="period-selector">
      <button
        *ngFor="let opt of options"
        class="period-btn"
        [class.active]="opt.key === value"
        (click)="onSelect(opt.key)"
      >
        {{ opt.label }}
      </button>
    </div>
  `,
  styles: [`
    .period-selector {
      display: inline-flex;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      padding: 4px;
      gap: 2px;
    }

    .period-btn {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 0.75rem;
      font-weight: 600;
      padding: 6px 12px;
      border-radius: 7px;
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: inherit;
    }

    .period-btn:hover {
      color: #e2e8f0;
      background: rgba(255, 255, 255, 0.05);
    }

    .period-btn.active {
      background: rgba(59, 130, 246, 0.2);
      color: #60a5fa;
    }
  `]
})
export class PeriodSelectorComponent {
  @Input() value: PeriodKey = 'month';
  @Input() options: PeriodOption[] = [
    { key: 'day', label: 'Day' },
    { key: 'week', label: 'Week' },
    { key: 'month', label: 'Month' },
    { key: 'quarter', label: 'Quarter' },
    { key: 'year', label: 'Year' },
  ];
  @Input() includeAll: boolean = false;
  @Output() periodChange = new EventEmitter<PeriodKey>();

  ngOnChanges() {
    if (this.includeAll && !this.options.some(o => o.key === 'all')) {
      this.options = [...this.options, { key: 'all', label: 'All' }];
    }
  }

  onSelect(key: PeriodKey) {
    this.periodChange.emit(key);
  }
}