import { describe, expect, it } from 'vitest';
import { openCount, setupNeeds, type SetupInputs } from './setupNeeds';
import { migrateWorkspace } from './brands';
import type { Account } from './model';

const profile = (id: string, platform: Account['platform'], status: Account['status'] = 'active'): Account => ({ id, platform, label: 'Animals', handle: 'animals', status, notes: '', brandId: 'animals' });
const base = (accounts: Account[], extra: Partial<SetupInputs> = {}): SetupInputs => ({ accounts, brands: [{ id: 'animals', name: 'Animals', notes: '' }], apps: { meta: '1', google: null, tiktok: null, x: null }, connections: {}, passwords: {}, marks: {}, ...extra });
const find = (inputs: SetupInputs, id: string) => setupNeeds(inputs).flatMap((group) => group.needs).find((need) => need.id === id);

describe('setup needs', () => {
  it('lists only the socials the brands use, with the developer app first', () => {
    const groups = setupNeeds(base([profile('ig', 'instagram'), profile('yt', 'youtube')]));
    expect(groups.map((group) => group.platform)).toEqual(['instagram', 'youtube']);
    expect(groups[0].needs[0]).toMatchObject({ id: 'instagram:app', status: 'done' });
    expect(groups[1].needs[0]).toMatchObject({ id: 'youtube:app', status: 'todo', action: { kind: 'setup-app', provider: 'google' } });
  });

  it('tracks YouTube publishing, audit and quota, and Instagram account prerequisites', () => {
    const inputs = base([profile('ig', 'instagram'), profile('yt', 'youtube')]);
    expect(find(inputs, 'youtube:app:published')?.title).toMatch(/Consent screen published/);
    expect(find(inputs, 'youtube:app:audit')?.why).toMatch(/Private/);
    expect(find(inputs, 'youtube:app:quota')?.optional).toBe(true);
    expect(find(inputs, 'ig:professional')?.title).toBe('Animals (@animals): Professional account (Business or Creator)');
    expect(find(inputs, 'ig:page')?.page?.id).toBe('meta-business');
  });

  it('tracks X plan and TikTok review and audit', () => {
    const inputs = base([profile('x1', 'x'), profile('tt', 'tiktok')]);
    expect(find(inputs, 'x:app:plan')?.manual).toBe(true);
    expect(find(inputs, 'tiktok:app:review')).toBeDefined();
    expect(find(inputs, 'tiktok:app:audit')?.why).toMatch(/private/);
  });

  it('shows connection health from the check, including a connection the social stopped accepting', () => {
    const inputs = base([profile('yt', 'youtube'), profile('x1', 'x')], { connections: { yt: { state: 'expired', username: 'animals', detail: 'Google stopped accepting this connection.' }, x1: { state: 'ok', username: 'animals', detail: 'Renews by itself.' } } });
    expect(find(inputs, 'yt:connected')).toMatchObject({ status: 'problem', why: 'Google stopped accepting this connection.' });
    expect(find(inputs, 'x1:connected')).toMatchObject({ status: 'done', why: 'Connected as @animals. Renews by itself.' });
    expect(find(base([profile('yt', 'youtube')]), 'yt:connected')?.status).toBe('checking');
  });

  it('counts manual ticks, saved sign-ins and not-yet-created profiles', () => {
    const accounts = [profile('x1', 'x'), profile('x2', 'x', 'planned')];
    const before = base(accounts, { apps: { x: 'client' }, connections: { x1: { state: 'ok', username: 'a', detail: '' } }, passwords: { x1: false } });
    expect(openCount(setupNeeds(before))).toBe(4); // read/write, plan, sign-in, create x2
    const after = { ...before, passwords: { x1: true }, marks: { 'x:app:auth': 1, 'x:app:plan': 2 } };
    expect(find(after, 'x:app:plan')).toMatchObject({ status: 'done', markedAt: 2 });
    expect(openCount(setupNeeds(after))).toBe(1);
    expect(find(after, 'x2:connected')).toBeUndefined();
    expect(find(after, 'x2:created')?.status).toBe('todo');
  });

  it('keeps ticks with the workspace and drops those of removed profiles', () => {
    const workspace = migrateWorkspace({ businessName: '', brands: [{ id: 'animals', name: 'Animals', notes: '' }], accounts: [profile('ig', 'instagram')], channels: [], setup: { 'instagram:app:roles': 5, 'ig:professional': 6, 'gone:page': 7 } });
    expect(workspace.setup).toEqual({ 'instagram:app:roles': 5, 'ig:professional': 6 });
    expect(migrateWorkspace({ businessName: '', brands: [], accounts: [], channels: [] })).not.toHaveProperty('setup');
  });
});
