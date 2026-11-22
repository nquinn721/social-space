import { describe, expect, it } from 'vitest';
import { addsToLogin, DEFAULT_SIGNUP_BIRTHDAY, numberedHandle, passwordGroup, loginText, migrateWorkspace, planPresence, plusAddress, presenceIssues, renamedProfile } from './brands';
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

  it('keeps series and developer logins on save, and unlinks videos from a series that is gone', () => {
    const brands = [{ id: 'b', name: 'Mia', notes: '' }];
    const categories = [{ id: 'c', brandId: 'b', name: 'Stories' }];
    const story = { id: 's', brandId: 'b', categoryId: 'c', title: 'Knots', premise: '', bible: '', characters: [], episodes: [], aspectRatio: '9:16', duration: 10, createdAt: 1 };
    const video = { id: 'v', brandId: 'b', categoryId: 'c', title: 'Part 1', mediaSource: '', caption: '', posted: [], createdAt: 1, seriesId: 's', episode: 1 };
    const saved = { businessName: '', brands, accounts: [], channels: [], categories, videos: [video], series: [story, { ...story, id: 'gone', brandId: 'nobody' }], developerLogins: { x: { email: 'dev@x.com' } } };
    const migrated = migrateWorkspace(saved);
    expect(migrated.series?.map((item) => item.id)).toEqual(['s']);
    expect(migrated.developerLogins).toEqual({ x: { email: 'dev@x.com' } });
    expect(migrated.videos?.[0].seriesId).toBe('s');
    expect(migrateWorkspace({ ...saved, series: [] }).videos?.[0]).toMatchObject({ seriesId: undefined, episode: undefined });
    expect('series' in migrateWorkspace({ ...saved, series: [] })).toBe(false);
  });

  it('plans a fresh Instagram account and a YouTube channel under the existing Google login', () => {
    const existing = [account('1', 'instagram', 'MassageMentor'), account('2', 'youtube', 'MassageMentor')];
    const instagram = planPresence(existing, 'instagram', 'Massage With Mia', BASE);
    expect(instagram).toMatchObject({ mode: 'new', email: 'softwings25+massagewithmia@gmail.com' });
    expect(instagram.reason).toContain('separate Instagram account');
    expect(planPresence(existing, 'youtube', 'Massage With Mia', BASE)).toMatchObject({ mode: 'attach', email: BASE });
    expect(planPresence([], 'youtube', 'First brand', BASE)).toMatchObject({ mode: 'attach', email: BASE });
  });

  it('starts a new Instagram account even when old accounts share a login', () => {
    const full = ['a', 'b', 'c', 'd'].map((id) => account(id, 'instagram', `Brand ${id}`));
    expect(planPresence(full, 'instagram', 'Massage With Mia', BASE)).toMatchObject({ mode: 'new', email: 'softwings25+massagewithmia@gmail.com' });
  });

  it('does not infer a Facebook Page limit from local counts', () => {
    const pages = Array.from({ length: 101 }, (_, n) => account(String(n), 'facebook', `Brand ${n}`));
    expect(planPresence(pages, 'facebook', 'New brand', BASE)).toMatchObject({ mode: 'attach', email: BASE });
    expect(presenceIssues(pages)).toEqual([]);
  });

  it('asks for a different Google account after 100 saved YouTube channels instead of inventing a Gmail alias', () => {
    const channels = Array.from({ length: 100 }, (_, n) => account(String(n), 'youtube', `Channel ${n}`));
    expect(planPresence(channels, 'youtube', 'New brand', BASE)).toMatchObject({ mode: 'new', email: '' });
    expect(planPresence(channels, 'youtube', 'New brand', BASE).reason).toContain('plus-address is not a new account');
    expect(planPresence(channels, 'youtube', 'New brand', 'softwings25+other@gmail.com')).toMatchObject({ mode: 'new', email: '' });
    expect(planPresence(channels, 'youtube', 'New brand', 'different@gmail.com')).toMatchObject({ mode: 'new', email: 'different@gmail.com' });
  });

  it('counts Gmail aliases and dots as the same YouTube account', () => {
    const channels = Array.from({ length: 100 }, (_, n) => account(String(n), 'youtube', `Channel ${n}`, n % 2 ? 'soft.wings25+brand@gmail.com' : BASE));
    expect(planPresence(channels, 'youtube', 'New brand', BASE)).toMatchObject({ mode: 'new', email: '' });
  });

  it('does not silently switch a YouTube channel to a different saved Google login', () => {
    const existing = [account('old', 'youtube', 'Old brand', 'other@gmail.com')];
    expect(planPresence(existing, 'youtube', 'New brand', BASE)).toMatchObject({ mode: 'new', email: BASE });
  });

  it('gives TikTok and X their own unused email per account', () => {
    expect(planPresence([], 'tiktok', 'Massage With Mia', BASE)).toMatchObject({ mode: 'new', email: 'softwings25+massagewithmia@gmail.com' });
    const taken = [account('1', 'x', 'MassageMentor'), account('2', 'x', 'Old', 'softwings25+massagewithmia@gmail.com')];
    expect(planPresence(taken, 'x', 'Massage With Mia', BASE).email).toBe('softwings25+massagewithmia2@gmail.com');
    expect(plusAddress('me+old@outlook.com', 'mia')).toBe('me+mia@outlook.com');
  });

  it('shares a password with the login a profile joins, or with its own brand, never across brands', () => {
    const ig1 = { ...account('ig1', 'instagram', 'One'), brandId: 'b1' };
    const ig2 = { ...account('ig2', 'instagram', 'Two'), brandId: 'b2' };
    const tt2 = { ...account('tt2', 'tiktok', 'Two', 'softwings25+two@gmail.com'), brandId: 'b2' };
    expect(passwordGroup([ig1, ig2, tt2], ig2)).toEqual(['ig1', 'ig2']);
    expect(passwordGroup([ig1, ig2, tt2], tt2)).toEqual(['tt2']);
    const yt2 = { ...account('yt2', 'youtube', 'Two', 'softwings25+two@gmail.com'), brandId: 'b2' };
    // YouTube signs in with the main Google account: no made-up password, and never one TikTok copies.
    expect(passwordGroup([ig1, ig2, tt2, yt2], yt2)).toEqual([]);
    expect(passwordGroup([ig1, ig2, tt2, yt2], tt2)).toEqual(['tt2']);
  });

  it('knows a profile joining another brand login is not a sign-up', () => {
    const ig1 = { ...account('ig1', 'instagram', 'One'), brandId: 'b1' };
    const ig2 = { ...account('ig2', 'instagram', 'Two'), brandId: 'b2' };
    const tt2 = { ...account('tt2', 'tiktok', 'Two', 'softwings25+two@gmail.com'), brandId: 'b2' };
    expect(addsToLogin([ig1, ig2, tt2], ig2)).toBe(true);
    expect(addsToLogin([ig2, tt2], ig2)).toBe(false);
    expect(addsToLogin([ig1, ig2, tt2], tt2)).toBe(false);
    expect(addsToLogin([ig1, { ...ig2, signupEmail: 'other@gmail.com' }], { ...ig2, signupEmail: 'other@gmail.com' })).toBe(false);
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

  it('signs up profiles not created yet with June 5 1983, and keeps created ones as they are', () => {
    const planned = { ...account('1', 'tiktok', 'Mia'), birthday: '1990-02-22' };
    const bare = account('3', 'instagram', 'Mia');
    const live = { ...account('2', 'instagram', 'Mia'), status: 'active' as const, birthday: '1995-06-15' };
    const migrated = migrateWorkspace({ accounts: [planned, bare, live] });
    expect(DEFAULT_SIGNUP_BIRTHDAY).toBe('1983-06-05');
    expect(migrated.accounts.map((item) => item.birthday)).toEqual(['1983-06-05', '1983-06-05', '1995-06-15']);
  });

  it('adds numbers to a taken username, within each social\'s length limit', () => {
    expect(numberedHandle('bunnywhispers', 'bunnywhispers', 'instagram')).toBe('bunnywhispers1');
    expect(numberedHandle('bunnywhispers', 'bunnywhispers1', 'instagram')).toBe('bunnywhispers2');
    expect(numberedHandle('bunnywhispers', 'bunnywhispers24', 'tiktok')).toBe('bunnywhispers25');
    expect(numberedHandle('@bunnywhispers', 'someoneelse', 'instagram')).toBe('bunnywhispers1');
    expect(numberedHandle('bunnywhisperskindquotes', 'bunnywhisperskindquotes', 'x')).toBe('bunnywhispersk1');
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
