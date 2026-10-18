import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'muted';

const TONES: Record<string, Tone> = {
  ready: 'success',
  success: 'success',
  ok: 'success',
  answered: 'success',
  enabled: 'success',
  pending: 'muted',
  queued: 'muted',
  scheduled: 'muted',
  processing: 'info',
  running: 'info',
  deferred: 'info',
  restarting: 'info',
  up_for_retry: 'warning',
  up_for_reschedule: 'warning',
  no_evidence: 'warning',
  refused: 'warning',
  skipped: 'neutral',
  disabled: 'neutral',
  none: 'neutral',
  failed: 'danger',
  upstream_failed: 'danger',
  error: 'danger',
  removed: 'neutral',
  owner: 'info',
  admin: 'info',
  editor: 'neutral',
  viewer: 'muted',
};

const LABELS: Record<string, string> = {
  no_evidence: 'no evidence',
  upstream_failed: 'upstream failed',
  up_for_retry: 'retrying',
  up_for_reschedule: 'rescheduled',
};

/** A small coloured status pill. Tone is inferred from the value unless given. */
@Component({
  selector: 'app-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="badge" [attr.data-tone]="resolvedTone()">
    @if (dot()) {<span class="badge-dot" aria-hidden="true"></span>}{{ label() }}</span>`,
})
export class Badge {
  readonly value = input.required<string | null | undefined>();
  readonly tone = input<Tone | null>(null);
  readonly text = input<string | null>(null);
  readonly dot = input(false);

  protected readonly resolvedTone = computed(() => this.tone() ?? TONES[this.value() ?? 'none'] ?? 'neutral');
  protected readonly label = computed(() => {
    const v = this.value() ?? 'none';
    return this.text() ?? LABELS[v] ?? v.replace(/_/g, ' ');
  });
}
