import { describe, expect, it } from 'vitest';
import { brandStatuses, brandSummary, progressLabel, socialStatus, videoProgress } from './brandStatus';
import type { Account, Workspace } from './model';

const account = (id: string, platform: Account['platform'], extra: Partial<Account> = {}): Account => ({ id, platform, label: 'Bunny', handle: 'bunny', status: 'active', notes: '', brandId: 'b', ...extra });
const base = (accounts: Account[]): Workspace => ({ businessName: '', brands: [{ id: 'b', name: 'Bunny', notes: '' }], accounts, channels: [] });

describe('brand status', () => {
  it('keeps YouTube under the main Google account as ready, never as a login to set up', () => {
    const ws = base([account('y', 'youtube', { signupEmail: 'softwings25@gmail.com' })]);
    expect(socialStatus(ws, 'b', 'youtube')).toMatchObject({ kind: 'ready', canPost: true, via: 'browser' });
  });
  it('flags TikTok and X saved with the main Gmail', () => {
    const ws = base([account('t', 'tiktok', { signupEmail: 'softwings25@gmail.com' }), account('x', 'x', { signupEmail: 'softwings25+bunny@gmail.com' })]);
    expect(socialStatus(ws, 'b', 'tiktok')).toMatchObject({ kind: 'main-login', canPost: false, action: { kind: 'own-login' } });
    expect(socialStatus(ws, 'b', 'x')).toMatchObject({ kind: 'ready', canPost: true });
  });
  it('reads Instagram from its connection and waits while it is checked', () => {
    const ws = base([account('i', 'instagram')]);
    expect(socialStatus(ws, 'b', 'instagram').kind).toBe('checking');
    expect(socialStatus(ws, 'b', 'instagram', { connections: { i: { state: 'none', username: '', detail: '' } } })).toMatchObject({ kind: 'connect', action: { kind: 'connect' } });
    expect(socialStatus(ws, 'b', 'instagram', { connections: { i: { state: 'ok', username: 'bunny', detail: '' } } })).toMatchObject({ kind: 'ready', via: 'api', canPost: true });
  });
  it('tells a missing profile from one not created yet, and a missing saved login', () => {
    const ws = base([account('t', 'tiktok', { status: 'planned' }), account('x', 'x')]);
    expect(socialStatus(ws, 'b', 'instagram')).toMatchObject({ kind: 'no-profile', action: { kind: 'create' } });
    expect(socialStatus(ws, 'b', 'tiktok')).toMatchObject({ kind: 'not-created', action: { kind: 'finish-signup' } });
    expect(socialStatus(ws, 'b', 'x', { passwords: { x: false } })).toMatchObject({ kind: 'no-password', canPost: true });
  });
  it('sums a brand up from its own socials only', () => {
    const ws = base([account('i', 'instagram'), account('t', 'tiktok')]);
    expect(brandSummary(brandStatuses(ws, 'b', { connections: { i: { state: 'none', username: '', detail: '' } } })).text).toBe('Ready on 1 of 2 · Instagram: not connected');
    expect(brandSummary(brandStatuses(ws, 'b', { connections: { i: { state: 'ok', username: '', detail: '' } } })).text).toBe('Ready to post on all 2');
  });
  it('labels how far a video is', () => {
    const video = { id: 'v', brandId: 'b', categoryId: 'c', title: 'Hop', mediaSource: '', caption: '', posted: ['instagram' as const], createdAt: 0 };
    expect(progressLabel(videoProgress(video, ['instagram', 'tiktok']))).toBe('Posted on 1 of 2');
    expect(progressLabel(videoProgress(video, ['instagram']))).toBe('Posted');
    expect(progressLabel(videoProgress({ ...video, posted: [] }, ['instagram', 'x']))).toBe('Ready to post');
  });
});
