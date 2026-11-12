import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGNUP_BIRTHDAY, loginText, migrateWorkspace, planPresence, plusAddress, presenceIssues, renamedProfile } from './brands';
import type { Account } from './model';

const BASE = 'softwings25@gmail.com';
const account = (id: string, platform: Account['platform'], label: string, signupEmail = BASE, handle = label.toLowerCase()): Account => ({ id, platform, label, handle, status: 'planned', notes: '', signupEmail });

describe('brand model', () => {
  it('moves saved accounts onto brands by name and keeps them on later runs', () => {
    const saved = { businessName: 'SoftWings LLC', accounts: [account('1', 'instagram', 'MassageMentor'), account('2', 'tiktok', 'MassageMentor'), account('3', 'instagram', 'MassageWithMia')], channels: [] };
    const migrated = migrateWorkspace(saved);
    expect(migrated.brands.map((brand) => brand.name)).toEqual(['MassageMentor', 'MassageWithMia']);
    expect(migrated.accounts[0].brandId).toBe(migrated.accounts[1].brandId);
    expect(migrated.accounts.every((item) => item.status === 'planned')).toBe(true);
    expect(migrateWorkspace(migrated)).toEqual(migrated);
  });

  it('adds Instagram and YouTube profiles to an existing login that has room', () => {
    const existing = [account('1', 'instagram', 'MassageMentor'), account('2', 'youtube', 'MassageMentor')];
    const instagram = planPresence(existing, 'instagram', 'Massage With Mia', BASE);
    expect(instagram).toMatchObject({ mode: 'attach', email: BASE });
    expect(instagram.reason).toContain('2 of 5');
    expect(planPresence(existing, 'youtube', 'Massage With Mia', BASE)).toMatchObject({ mode: 'attach', email: BASE });
  });

  it('starts a new Instagram login once five profiles share one', () => {
    const full = ['a', 'b', 'c', 'd', 'e'].map((id) => account(id, 'instagram', `Brand ${id}`));
    expect(planPresence(full, 'instagram', 'Massage With Mia', BASE)).toMatchObject({ mode: 'new', email: 'softwings25+massagewithmia@gmail.com' });
  });

  it('gives TikTok and X their own unused email per account', () => {
    expect(planPresence([], 'tiktok', 'Massage With Mia', BASE)).toMatchObject({ mode: 'new', email: BASE });
    const taken = [account('1', 'x', 'MassageMentor'), account('2', 'x', 'Old', 'softwings25+massagewithmia@gmail.com')];
    expect(planPresence(taken, 'x', 'Massage With Mia', BASE).email).toBe('softwings25+massagewithmia2@gmail.com');
    expect(plusAddress('me+old@outlook.com', 'mia')).toBe('me+mia@outlook.com');
  });

  it('flags shared emails on TikTok and X and duplicate usernames', () => {
    const issues = presenceIssues([account('1', 'tiktok', 'One', BASE, 'same'), account('2', 'tiktok', 'Two', BASE, 'same'), account('3', 'instagram', 'One'), account('4', 'instagram', 'Two')]);
    expect(issues.filter((issue) => issue.accountId === '2').map((issue) => issue.text)).toEqual([
      'Another TikTok account already uses softwings25@gmail.com. TikTok needs a different email for each account.',
      '@same is used by another TikTok profile here. Each needs its own username.',
    ]);
    expect(issues.some((issue) => issue.accountId === '4')).toBe(false);
  });

  it('describes where a profile signs in, in plain words', () => {
    const workspace = migrateWorkspace({ accounts: [account('1', 'instagram', 'MassageMentor'), account('2', 'instagram', 'Massage With Mia'), account('3', 'tiktok', 'Massage With Mia', 'softwings25+mia@gmail.com')] });
    expect(loginText(workspace.accounts[1], workspace)).toBe('Signs in with softwings25@gmail.com, shared with MassageMentor.');
    expect(loginText(workspace.accounts[2], workspace)).toBe('Its own TikTok account, signed up with softwings25+mia@gmail.com.');
  });

  it('moves profiles not created yet off the old default birthday, but keeps live ones', () => {
    const planned = { ...account('1', 'tiktok', 'Mia'), birthday: '1995-06-15' };
    const live = { ...account('2', 'instagram', 'Mia'), status: 'active' as const, birthday: '1995-06-15' };
    const migrated = migrateWorkspace({ accounts: [planned, live] });
    expect(DEFAULT_SIGNUP_BIRTHDAY).toBe('1983-06-05');
    expect(migrated.accounts.map((item) => item.birthday)).toEqual(['1983-06-05', '1995-06-15']);
  });

  it('gives profiles not created yet the new brand name as username and email tag', () => {
    const planned = account('1', 'tiktok', 'softwings25', 'softwings25+softwings25@gmail.com', 'softwings25');
    const renamed = renamedProfile(planned, 'softwings25', 'Massage With Mia');
    expect(renamed).toMatchObject({ label: 'Massage With Mia', handle: 'massagewithmia', signupEmail: 'softwings25+massagewithmia@gmail.com' });
    const shared = renamedProfile(account('2', 'instagram', 'softwings25', BASE, 'softwings25'), 'softwings25', 'Massage With Mia');
    expect(shared.signupEmail).toBe(BASE);
    const live = renamedProfile({ ...planned, status: 'active' }, 'softwings25', 'Massage With Mia');
    expect(live).toMatchObject({ label: 'Massage With Mia', handle: 'softwings25', signupEmail: 'softwings25+softwings25@gmail.com' });
  });
});
