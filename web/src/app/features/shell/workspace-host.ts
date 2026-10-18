import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { WorkspaceContext } from '../../core/workspace-context';

/** Re-creates the workspace pages whenever the current workspace changes. */
@Component({
  selector: 'app-workspace-host',
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `@for (id of current(); track id) {<router-outlet />}`,
})
export class WorkspaceHost {
  private readonly ctx = inject(WorkspaceContext);
  protected readonly current = computed(() => [this.ctx.wsId() ?? '']);
}
