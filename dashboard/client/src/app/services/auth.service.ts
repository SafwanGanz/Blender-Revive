import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, BehaviorSubject } from 'rxjs';
import { map, tap } from 'rxjs/operators';

const API_BASE = 'http://localhost:3001/api';

export interface LoginResponse {
  token: string;
  username: string;
  expiresIn: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private tokenKey = 'blender_dash_token';
  private usernameKey = 'blender_dash_user';
  private authState = new BehaviorSubject<boolean>(this.isLoggedIn());

  isAuthenticated$ = this.authState.asObservable();

  constructor(private http: HttpClient) {}

  login(username: string, password: string): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(`${API_BASE}/auth/login`, { username, password }).pipe(
      tap((res) => {
        this.setToken(res.token);
        localStorage.setItem(this.usernameKey, res.username);
        this.authState.next(true);
      })
    );
  }

  logout(): void {
    localStorage.removeItem(this.tokenKey);
    localStorage.removeItem(this.usernameKey);
    this.authState.next(false);
  }

  private setToken(token: string): void {
    try {
      localStorage.setItem(this.tokenKey, token);
    } catch {
      // Ignore storage errors
    }
  }

  getToken(): string | null {
    try {
      return localStorage.getItem(this.tokenKey);
    } catch {
      return null;
    }
  }

  getUsername(): string {
    try {
      return localStorage.getItem(this.usernameKey) || 'cryso';
    } catch {
      return 'cryso';
    }
  }

  isLoggedIn(): boolean {
    return !!this.getToken();
  }
}