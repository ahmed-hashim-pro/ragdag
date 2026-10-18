import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { WorkspaceContext } from '../../core/workspace-context';
import { ApiKeySection } from './api-key-section';
import { AuditSection } from './audit-section';
import { GeneralSection } from './general-section';
import { InvitationsSection } from './invitations-section';
import { MembersSection } from './members-section';
import { UsageSection } from './usage-section';

@Component({
  selector: 'app-settings-page',
  imports: [GeneralSection, ApiKeySection, MembersSection, InvitationsSection, UsageSection, AuditSection],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page" style="max-width: 1000px">
      <div class="page-head">
        <div class="page-title">
          <h1>Workspace settings</h1>
          <p>{{ ctx.workspaceName() }} · you are <strong>{{ ctx.role() }}</strong></p>
        </div>
      </div>
      <div class="stack-lg">
        <app-api-key-section />
        <app-usage-section />
        <app-members-section />
        @if (ctx.isAdmin()) {
          <app-invitations-section />
          <app-audit-section />
        }
        <app-general-section />
      </div>
    </div>
  `,
})
export class SettingsPage {
  protected readonly ctx = inject(WorkspaceContext);
}
