import { describe, expect, it } from 'vitest';
import { accountCountLabel, createAccount, getPlatform, normalizeHandle, PLATFORMS } from './model';

describe('workspace account details', () => {
  it('normalizes handles and trims account details', () => {
    const account = createAccount('instagram', '  Studio  ', '  @@studio  ', 'active', '  Notes  ');
    expect(account).toMatchObject({ platform: 'instagram', label: 'Studio', handle: 'studio', status: 'active', notes: 'Notes' });
    expect(account.id).toBeTruthy();
    expect(normalizeHandle(' @ ')).toBe('');
  });
  it('covers each supported platform and formats counts', () => {
    expect(PLATFORMS.map((platform) => platform.id)).toEqual(['instagram', 'tiktok', 'youtube', 'x']);
    expect(getPlatform('youtube').name).toBe('YouTube');
    expect(accountCountLabel(1)).toBe('1 account');
    expect(accountCountLabel(2)).toBe('2 accounts');
  });
});
