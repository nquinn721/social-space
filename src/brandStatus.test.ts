import { describe, expect, it } from 'vitest';
import { brandStatuses, brandSummary, needsAttention, progressLabel, socialStatus, videoProgress } from './brandStatus';
import type { Account, Workspace } from './model';

const account = (id: string, platform: Account['platform'], extra: Partial<Account> = {}): Account => ({ id, platform, label: 'Bunny', handle: 'bunny', status: 'active', notes: '', brandId: 'b', ...extra });
const base = (accounts: Account[]): Workspace => ({ businessName: '', brands: [{ id: 'b', name: 'Bunny', notes: '' }], accounts, channels: [] });

describe('brand status', () => {
  it('does not claim a YouTube channel is verified without a current channel check', () => {
    const ws = base([account('y', 'youtube', { signupEmail: 'softwings25@gmail.com' })]);
    expect(socialStatus(ws, 'b', 'youtube')).toMatchObject({ kind: 'verify-session', label: 'Not checked', canPost: true, via: 'browser' });
  });
  it('flags TikTok and X saved with the main Gmail', () => {
    const ws = base([account('t', 'tiktok', { signupEmail: 'softwings25@gmail.com' }), account('x', 'x', { signupEmail: 'softwings25+bunny@gmail.com' })]);
    expect(socialStatus(ws, 'b', 'tiktok')).toMatchObject({ kind: 'main-login', canPost: false, action: { kind: 'own-login' } });
    expect(socialStatus(ws, 'b', 'x')).toMatchObject({ kind: 'verify-session', canPost: true });
  });
  it('reads Instagram from its connection and waits while it is checked', () => {
    const ws = base([account('i', 'instagram')]);
    expect(socialStatus(ws, 'b', 'instagram').kind).toBe('checking');
    expect(socialStatus(ws, 'b', 'instagram', { connections: { i: { state: 'none', username: '', detail: '' } } })).toMatchObject({ kind: 'connect', action: { kind: 'connect' } });
    expect(socialStatus(ws, 'b', 'instagram', { connections: { i: { state: 'ok', username: 'bunny', detail: '' } } })).toMatchObject({ kind: 'ready', via: 'api', canPost: true });
    expect(socialStatus(ws, 'b', 'instagram', { connections: { i: { state: 'ok', username: 'softwings25', detail: '' } } })).toMatchObject({ kind: 'reconnect', label: 'Wrong account', canPost: false });
    expect(socialStatus(ws, 'b', 'instagram', { connections: { i: { state: 'ok', username: 'softwings25', detail: '' } } }).detail).toMatch(/Meta connected @softwings25/);
    expect(socialStatus(ws, 'b', 'instagram', { connections: { i: { state: 'ok', username: '', detail: '' } } })).toMatchObject({ label: 'Identity not verified', canPost: false });
    expect(socialStatus(base([account('i', 'instagram', { handle: '' })]), 'b', 'instagram', { connections: { i: { state: 'ok', username: 'bunny', detail: '' } } })).toMatchObject({ label: 'Identity not verified', canPost: false });
  });
  it('reads a Facebook Page from its connection: a Page name is never a wrong handle, and no login is asked for', () => {
    const ws = base([account('f', 'facebook', { handle: '', signupEmail: 'softwings25@gmail.com' })]);
    expect(socialStatus(ws, 'b', 'facebook').kind).toBe('checking');
    expect(socialStatus(base([]), 'b', 'facebook')).toMatchObject({ kind: 'no-profile', tone: 'todo', action: { kind: 'connect', label: 'Connect Facebook Page' } });
    expect(socialStatus(ws, 'b', 'facebook', { connections: { f: { state: 'none', username: '', detail: '' } } })).toMatchObject({ kind: 'connect', action: { kind: 'connect', label: 'Connect Facebook Page' }, canPost: false });
    expect(socialStatus(ws, 'b', 'facebook', { connections: { f: { state: 'ok', username: 'Bunny Daily', detail: '' } }, passwords: { f: false } })).toMatchObject({ kind: 'ready', via: 'api', canPost: true });
  });
  it('asks to sign in when the brand window is not signed in, and never says Ready then', () => {
    const ws = base([account('t', 'tiktok', { signupEmail: 'softwings25+bunny@gmail.com' }), account('y', 'youtube')]);
    const signIns = { tiktok: { signedIn: false, checkedAt: 0 }, youtube: { signedIn: true, checkedAt: 0 } };
    expect(socialStatus(ws, 'b', 'tiktok', { signIns })).toMatchObject({ kind: 'sign-in', tone: 'todo', action: { kind: 'sign-in' }, canPost: true });
    expect(socialStatus(ws, 'b', 'youtube', { signIns })).toMatchObject({ kind: 'ready', label: 'Signed in', canPost: true });
    expect(socialStatus(ws, 'b', 'youtube', { signIns }).detail).toContain('selected YouTube channel has not been verified');
  });
  it('blocks a last-seen browser account mismatch and does not treat matching or unknown cookies as proof', () => {
    const ws = base([account('t', 'tiktok', { signupEmail: 'softwings25+bunny@gmail.com' })]);
    const signIn = (handle?: string) => ({ tiktok: { signedIn: true, checkedAt: 1, handle } });
    expect(socialStatus(ws, 'b', 'tiktok', { signIns: signIn('other') })).toMatchObject({ label: 'Wrong account', canPost: false, tone: 'problem' });
    expect(socialStatus(ws, 'b', 'tiktok', { signIns: signIn('BUNNY') })).toMatchObject({ kind: 'ready', label: 'Signed in', canPost: true });
    expect(socialStatus(ws, 'b', 'tiktok', { signIns: signIn() }).detail).toContain('username was not available');
    expect(needsAttention(socialStatus(ws, 'b', 'tiktok', { signIns: signIn('BUNNY') }))).toBe(false);
    expect(needsAttention(socialStatus(ws, 'b', 'instagram'))).toBe(false);
  });
  it('tells a missing profile from one not created yet, and a missing saved login', () => {
    const ws = base([account('t', 'tiktok', { status: 'planned' }), account('x', 'x')]);
    expect(socialStatus(ws, 'b', 'instagram')).toMatchObject({ kind: 'no-profile', action: { kind: 'create' } });
    expect(socialStatus(ws, 'b', 'tiktok')).toMatchObject({ kind: 'not-created', action: { kind: 'finish-signup' } });
    expect(socialStatus(ws, 'b', 'x', { passwords: { x: false } })).toMatchObject({ kind: 'verify-session', canPost: true });
  });
  it('sums a brand up from its own socials only', () => {
    const ws = base([account('i', 'instagram'), account('t', 'tiktok')]);
    expect(brandSummary(brandStatuses(ws, 'b', { connections: { i: { state: 'none', username: '', detail: '' } } })).text).toBe('Ready on 0 of 2 · Instagram: not connected +1 more');
    expect(brandSummary(brandStatuses(ws, 'b', { connections: { i: { state: 'ok', username: 'bunny', detail: '' } } })).text).toBe('Ready on 1 of 2 · TikTok: not checked');
  });
  it('labels how far a video is', () => {
    const video = { id: 'v', brandId: 'b', categoryId: 'c', title: 'Hop', mediaSource: '', caption: '', posted: ['instagram' as const], createdAt: 0 };
    expect(progressLabel(videoProgress(video, ['instagram', 'tiktok']))).toBe('Posted on 1 of 2');
    expect(progressLabel(videoProgress(video, ['instagram']))).toBe('Posted');
    expect(progressLabel(videoProgress({ ...video, posted: [] }, ['instagram', 'x']))).toBe('Ready to post');
  });
});
