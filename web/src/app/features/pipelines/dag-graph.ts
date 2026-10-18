import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { TaskNode } from '../../api/models';
import { formatDuration } from '../../shared/format';
import { DagNodeLayout, layoutDag } from './dag-layout';

const KNOWN_STATES = new Set([
  'success',
  'failed',
  'upstream_failed',
  'running',
  'queued',
  'scheduled',
  'skipped',
  'up_for_retry',
  'up_for_reschedule',
  'deferred',
  'restarting',
  'removed',
]);

/** SVG drawing of a DAG run: layered left-to-right, nodes coloured by task state. */
@Component({
  selector: 'app-dag-graph',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './dag-graph.css',
  template: `
    <div class="dag-scroll">
      <svg class="dag" [attr.width]="layout().width" [attr.height]="layout().height"
        [attr.viewBox]="'0 0 ' + layout().width + ' ' + layout().height" role="group" aria-label="Pipeline task graph">
        <defs>
          <marker id="dag-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" class="dag-arrow" />
          </marker>
        </defs>
        @for (e of layout().edges; track e.from + '>' + e.to) {
          <path class="dag-edge" [attr.d]="e.path" marker-end="url(#dag-arrow)" />
        }
        @for (n of layout().nodes; track n.id) {
          <g class="dag-node" [attr.data-state]="stateOf(n)" [attr.transform]="'translate(' + n.x + ',' + n.y + ')'"
            [attr.tabindex]="clickable() ? 0 : null" [attr.role]="clickable() ? 'button' : 'img'"
            [attr.aria-label]="describe(n)" [class.selected]="n.id === selected()"
            (click)="pick(n)" (keydown.enter)="pick(n)" (keydown.space)="$event.preventDefault(); pick(n)">
            <title>{{ describe(n) }}</title>
            <rect [attr.width]="w" [attr.height]="h" rx="9" class="dag-box" />
            <rect width="5" [attr.height]="h" rx="2" class="dag-stripe" />
            <text x="14" y="23" class="dag-name">{{ short(n.id) }}</text>
            <text x="14" y="42" class="dag-meta">{{ meta(n) }}</text>
            @if (n.task.mapped_count) {
              <text [attr.x]="w - 10" y="23" text-anchor="end" class="dag-mapped">×{{ n.task.mapped_count }}</text>
            }
            @if (stateOf(n) === 'running') {
              <circle [attr.cx]="w - 12" cy="40" r="4" class="dag-pulse" />
            }
          </g>
        }
      </svg>
    </div>
  `,
})
export class DagGraph {
  readonly tasks = input.required<TaskNode[]>();
  readonly selected = input<string | null>(null);
  readonly clickable = input(false);
  readonly taskClick = output<TaskNode>();

  protected readonly w = 184;
  protected readonly h = 58;
  protected readonly layout = computed(() => layoutDag(this.tasks(), { nodeWidth: this.w, nodeHeight: this.h }));

  protected stateOf(n: DagNodeLayout<TaskNode>): string {
    const s = n.task.state ?? 'none';
    return KNOWN_STATES.has(s) ? s : 'none';
  }

  protected short(id: string): string {
    return id.length > 22 ? id.slice(0, 21) + '…' : id;
  }

  protected meta(n: DagNodeLayout<TaskNode>): string {
    const state = (n.task.state ?? 'not started').replace(/_/g, ' ');
    const d = formatDuration(n.task.duration);
    return d ? `${state} · ${d}` : state;
  }

  protected describe(n: DagNodeLayout<TaskNode>): string {
    const mapped = n.task.mapped_count ? `, ${n.task.mapped_count} mapped instances` : '';
    const next = n.task.downstream.length ? `, then ${n.task.downstream.join(', ')}` : '';
    return `${n.id}: ${this.meta(n)}${mapped}${next}`;
  }

  protected pick(n: DagNodeLayout<TaskNode>): void {
    if (this.clickable()) this.taskClick.emit(n.task);
  }
}
