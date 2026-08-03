import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="login-container">
      <div class="login-card">
        <div class="login-logo">
          <span class="logo-icon">⚡</span>
        </div>
        <h1 class="login-title">BlenderRevive</h1>
        <p class="login-subtitle">KPI Dashboard — Secure Access</p>

        <form (ngSubmit)="onSubmit()" class="login-form">
          <div class="form-group">
            <label for="username">Username</label>
            <input
              id="username"
              type="text"
              [(ngModel)]="username"
              name="username"
              placeholder="Enter username"
              autocomplete="username"
              required
            />
          </div>

          <div class="form-group">
            <label for="password">Password</label>
            <input
              id="password"
              type="password"
              [(ngModel)]="password"
              name="password"
              placeholder="Enter password"
              autocomplete="current-password"
              required
            />
          </div>

          <div *ngIf="error" class="login-error">{{ error }}</div>

          <button type="submit" class="login-btn" [disabled]="loading">
            {{ loading ? 'Signing in…' : 'Sign In' }}
          </button>
        </form>

        <p class="login-footer">Protected dashboard • JWT authenticated</p>
      </div>
    </div>
  `,
  styles: [`
    .login-container {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      background: radial-gradient(ellipse at top, rgba(59, 130, 246, 0.08), transparent 50%),
                  radial-gradient(ellipse at bottom, rgba(139, 92, 246, 0.06), transparent 50%);
    }

    .login-card {
      width: 100%;
      max-width: 380px;
      background: rgba(255, 255, 255, 0.04);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 20px;
      padding: 40px 32px;
      text-align: center;
      animation: fadeInUp 0.5s ease both;
    }

    .login-logo {
      width: 60px;
      height: 60px;
      margin: 0 auto 16px;
      border-radius: 16px;
      background: linear-gradient(135deg, rgba(59, 130, 246, 0.25), rgba(139, 92, 246, 0.25));
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(59, 130, 246, 0.2);
    }

    .logo-icon {
      font-size: 1.8rem;
    }

    .login-title {
      font-size: 1.4rem;
      font-weight: 800;
      color: #f1f5f9;
      margin: 0;
    }

    .login-subtitle {
      font-size: 0.8rem;
      color: #64748b;
      margin: 6px 0 28px;
    }

    .login-form {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .form-group {
      text-align: left;
    }

    label {
      display: block;
      font-size: 0.75rem;
      font-weight: 600;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }

    input {
      width: 100%;
      padding: 12px 14px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 10px;
      color: #f1f5f9;
      font-size: 0.9rem;
      font-family: inherit;
      transition: border-color 0.2s ease;
      box-sizing: border-box;
    }

    input:focus {
      outline: none;
      border-color: rgba(59, 130, 246, 0.5);
    }

    input::placeholder {
      color: #475569;
    }

    .login-error {
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #f87171;
      font-size: 0.8rem;
      padding: 10px 12px;
      border-radius: 8px;
    }

    .login-btn {
      width: 100%;
      padding: 13px;
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      border: none;
      border-radius: 10px;
      color: white;
      font-size: 0.9rem;
      font-weight: 700;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.25s ease;
      margin-top: 4px;
    }

    .login-btn:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 8px 24px rgba(59, 130, 246, 0.3);
    }

    .login-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .login-footer {
      font-size: 0.7rem;
      color: #475569;
      margin-top: 24px;
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

    @media (max-width: 480px) {
      .login-card {
        padding: 32px 24px;
      }
    }
  `],
})
export class LoginComponent {
  username: string = '';
  password: string = '';
  error: string = '';
  loading: boolean = false;

  constructor(private auth: AuthService, private router: Router) {}

  onSubmit() {
    if (!this.username || !this.password) {
      this.error = 'Please enter both username and password.';
      return;
    }

    this.loading = true;
    this.error = '';

    this.auth.login(this.username, this.password).subscribe({
      next: () => {
        this.router.navigate(['/']);
      },
      error: (err) => {
        this.loading = false;
        this.error = err.status === 401 ? 'Invalid credentials.' : 'Login failed. Please try again.';
      },
    });
  }
}