import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { onPasswordSaved, setAccountPassword } from './profileService';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
afterEach(() => vi.clearAllMocks());

describe('saved passwords', () => {
  it('tells every open view of that account when its password is saved', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const same = vi.fn();
    const other = vi.fn();
    const stop = onPasswordSaved('a1', same);
    onPasswordSaved('b2', other);
    await setAccountPassword('a1', 'x');
    expect(invoke).toHaveBeenCalledWith('set_account_password', { accountId: 'a1', password: 'x' });
    expect(same).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
    stop();
    await setAccountPassword('a1', 'y');
    expect(same).toHaveBeenCalledOnce();
  });
});
