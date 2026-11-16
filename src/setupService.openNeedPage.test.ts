import { describe, expect, it, vi } from 'vitest';
import type { Account } from './model';
import type { Need } from './setupNeeds';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined), isTauri: () => true }));
vi.mock('./postingService', () => ({ openProfilePage: vi.fn(async () => undefined) }));
import { invoke } from '@tauri-apps/api/core';
import { openProfilePage } from './postingService';
import { openNeedPage } from './setupService';

const mia: Account = { id: 'ig', platform: 'instagram', label: 'Mia', handle: 'massagewithmia', status: 'active', notes: '', brandId: 'mia', signupEmail: 'softwings25@gmail.com' };
const need = (page: Need['page']): Need => ({ id: 'ig:professional', platform: 'instagram', accountId: 'ig', title: 't', why: 'w', status: 'todo', manual: true, page });

describe('opening a step page', () => {
  it('opens a profile\'s own settings in the brand\'s window, never the shared one', async () => {
    await openNeedPage(need({ id: 'instagram-settings', label: 'Open', brandWindow: true }), [mia]);
    expect(openProfilePage).toHaveBeenCalledWith(expect.objectContaining({ platform: 'instagram', brandId: 'mia', handle: 'massagewithmia', inBrowser: false, target: 'settings' }));
    expect(invoke).not.toHaveBeenCalled();
  });
  it('opens other pages in the app window', async () => {
    await openNeedPage(need({ id: 'meta-business', label: 'Open' }), [mia]);
    expect(invoke).toHaveBeenCalledWith('open_setup_page', { page: 'meta-business' });
  });
});
