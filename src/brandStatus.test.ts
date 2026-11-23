import { describe, expect, it } from 'vitest';
import { brandStatuses, brandSummary, chipLabel, needsAttention, progressLabel, socialStatus, videoProgress, type StatusInputs } from './brandStatus';
import type { Account, Workspace } from './model';

const account = (id: string, platform: Account['platform'], extra: Partial<Account> = {}): Account => ({ id, platform, label: 'Bunny', handle: 'bunny', status: 'active', notes: '', brandId: 'b', signupEmail: 'softwings25+bunny@gmail.com', ...extra });
const base = (accounts: Account[]): Workspace => ({ businessName: '', brands: [{ id: 'b', name: 'Bunny', notes: '' }], accounts, channels: [] });
const connected = (linked: StatusInputs['socials'] = { hasProfile: true, linked: [] }, xKeys = true): StatusInputs => ({ ayrshare: { connected: true, xKeys }, socials: linked });

describe('brand status', () => {
  it('tells a missing profile from one not created yet', () => {
    const ws = base([account('t', 'tiktok', { status: 'planned' })]);
    expect(socialStatus(ws, 'b', 'instagram')).toMatchObject({ kind: 'no-profile', action: { kind: 'create' }, canPost: false });
    expect(socialStatus(ws, 'b', 'tiktok', connected())).toMatchObject({ kind: 'not-created', action: { kind: 'finish-signup' }, canPost: false });
  });
  it('flags Instagram, Facebook, TikTok and X saved with the main Gmail, but not YouTube', () => {
    const ws = base([account('t', 'tiktok', { signupEmail: 'softwings25@gmail.com' }), account('y', 'youtube', { signupEmail: 'softwings25@gmail.com' })]);
    expect(socialStatus(ws, 'b', 'tiktok', connected())).toMatchObject({ kind: 'main-login', canPost: false, action: { kind: 'own-login' } });
    expect(socialStatus(ws, 'b', 'youtube', connected())).toMatchObject({ kind: 'not-linked' });
  });
  it('walks through what Ayrshare needs: the key, the brand profile, then each linked social', () => {
    const ws = base([account('i', 'instagram')]);
    expect(socialStatus(ws, 'b', 'instagram')).toMatchObject({ kind: 'checking', canPost: false });
    expect(socialStatus(ws, 'b', 'instagram', { ayrshare: { connected: false, xKeys: false } })).toMatchObject({ kind: 'no-ayrshare', action: { kind: 'connect-ayrshare' } });
    expect(socialStatus(ws, 'b', 'instagram', { ayrshare: { connected: true, xKeys: false } })).toMatchObject({ kind: 'checking', tone: 'checking' });
    expect(socialStatus(ws, 'b', 'instagram', connected(null))).toMatchObject({ kind: 'checking', tone: 'problem' });
    expect(socialStatus(ws, 'b', 'instagram', connected({ hasProfile: false, linked: [] }))).toMatchObject({ kind: 'no-brand-profile', action: { kind: 'setup-posting' } });
    expect(socialStatus(ws, 'b', 'instagram', connected())).toMatchObject({ kind: 'not-linked', action: { kind: 'link' }, canPost: false });
    const ready = socialStatus(ws, 'b', 'instagram', connected({ hasProfile: true, linked: [{ platform: 'instagram', name: 'bunny', refresh: false }] }));
    expect(ready).toMatchObject({ kind: 'ready', canPost: true, linkedAs: 'bunny' });
    expect(ready.detail).toContain('@bunny');
    expect(socialStatus(ws, 'b', 'instagram', connected({ hasProfile: true, linked: [{ platform: 'instagram', name: 'bunny', refresh: true }] }))).toMatchObject({ kind: 'relink', canPost: true, action: { kind: 'link' } });
  });
  it('needs the X app keys before X can post', () => {
    const ws = base([account('x', 'x')]);
    const linked = { hasProfile: true, linked: [{ platform: 'x' as const, name: 'bunny', refresh: false }] };
    expect(socialStatus(ws, 'b', 'x', connected(linked, false))).toMatchObject({ kind: 'no-x-keys', canPost: false, action: { kind: 'x-keys' } });
    expect(socialStatus(ws, 'b', 'x', connected(linked, true))).toMatchObject({ kind: 'ready', canPost: true });
  });
  it('sums a brand up from its own socials only', () => {
    const ws = base([account('i', 'instagram'), account('t', 'tiktok')]);
    expect(brandSummary(brandStatuses(ws, 'b', { ayrshare: { connected: false, xKeys: false } })).short).toBe('Connect Ayrshare to post');
    expect(brandSummary(brandStatuses(ws, 'b', connected({ hasProfile: false, linked: [] }))).short).toBe('Set up posting');
    const one = connected({ hasProfile: true, linked: [{ platform: 'instagram', name: 'bunny', refresh: false }] });
    expect(brandSummary(brandStatuses(ws, 'b', one)).text).toBe('Ready on 1 of 2 · TikTok: not linked');
    expect(needsAttention(socialStatus(ws, 'b', 'tiktok', one))).toBe(true);
    expect(needsAttention(socialStatus(ws, 'b', 'instagram', one))).toBe(false);
    expect(chipLabel(socialStatus(ws, 'b', 'tiktok', one))).toBe('Link');
  });
  it('labels how far a video is', () => {
    const video = { id: 'v', brandId: 'b', categoryId: 'c', title: 'Hop', mediaSource: '', caption: '', posted: ['instagram' as const], createdAt: 0 };
    expect(progressLabel(videoProgress(video, ['instagram', 'tiktok']))).toBe('Posted on 1 of 2');
    expect(progressLabel(videoProgress(video, ['instagram']))).toBe('Posted');
    expect(progressLabel(videoProgress({ ...video, posted: [] }, ['instagram', 'x']))).toBe('Waiting in queue');
    expect(progressLabel(videoProgress({ ...video, posted: [] }, ['instagram', 'x']), 2)).toBe('Scheduled');
  });
});
