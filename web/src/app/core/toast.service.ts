import { Injectable, signal } from '@angular/core';

import { apiErrorMessage } from '../api/errors';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

const DURATION_MS: Record<ToastKind, number> = { info: 4000, success: 3500, error: 7000 };

@Injectable({ providedIn: 'root' })
export class ToastService {
  private seq = 0;
  private readonly _toasts = signal<Toast[]>([]);
  readonly toasts = this._toasts.asReadonly();

  show(kind: ToastKind, message: string): void {
    const id = ++this.seq;
    this._toasts.update((list) => [...list.slice(-4), { id, kind, message }]);
    setTimeout(() => this.dismiss(id), DURATION_MS[kind]);
  }

  info(message: string): void {
    this.show('info', message);
  }

  success(message: string): void {
    this.show('success', message);
  }

  /** Show an error; accepts raw errors (HttpErrorResponse, Error) or a message. */
  error(err: unknown, fallback?: string): void {
    this.show('error', typeof err === 'string' ? err : apiErrorMessage(err, fallback));
  }

  dismiss(id: number): void {
    this._toasts.update((list) => list.filter((t) => t.id !== id));
  }
}
