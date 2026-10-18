import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { WorkspacesApi } from '../../api/workspaces.service';
import { ToastService } from '../../core/toast.service';
import { WorkspaceContext } from '../../core/workspace-context';
import { ConfirmService } from '../../shared/confirm';
import { ApiKeySection } from './api-key-section';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// Regression: the form used (ngSubmit) without a form directive, so Save did a native
// form submit (page reload) and the key never reached the API.
describe('ApiKeySection', () => {
  const status = { configured: false, hint: null, updated_at: null, model: 'claude-opus-5-5' };
  let setApiKey: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setApiKey = vi.fn(() => of({ ...status, configured: true, hint: '…abcd' }));
    TestBed.configureTestingModule({
      imports: [ApiKeySection],
      providers: [
        { provide: WorkspacesApi, useValue: { apiKey: () => of(status), setApiKey, deleteApiKey: vi.fn() } },
        { provide: WorkspaceContext, useValue: { isAdmin: signal(true), require: () => 'ws-1' } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
        { provide: ConfirmService, useValue: { confirm: vi.fn() } },
      ],
    });
  });

  it('sends the key when Save is clicked and does not submit the page', async () => {
    const fixture = TestBed.createComponent(ApiKeySection);
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    const input = el.querySelector('input[type=password]') as HTMLInputElement;
    input.value = '  sk-ant-api03-0123456789abcd  ';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const form = el.querySelector('form') as HTMLFormElement;
    const submit = new Event('submit', { cancelable: true, bubbles: true });
    form.dispatchEvent(submit);
    await settle();
    fixture.detectChanges();

    expect(submit.defaultPrevented).toBe(true);
    expect(setApiKey).toHaveBeenCalledWith('ws-1', 'sk-ant-api03-0123456789abcd');
    expect(el.textContent).toContain('…abcd');
  });
});
