import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SetupTracker from './SetupTracker';
import type { Account } from './model';

vi.mock('./setupService', () => ({ openSetupPage: vi.fn(async () => undefined) }));
import { openSetupPage } from './setupService';

const yt: Account = { id: 'yt', platform: 'youtube', label: 'Animals', handle: 'animals', status: 'active', notes: '', brandId: 'animals' };
const brands = [{ id: 'animals', name: 'Animals', notes: '' }];
afterEach(cleanup);

describe('setup tracker', () => {
  it('lets each step be done from where it is listed', async () => {
    const onMark = vi.fn();
    const onConnect = vi.fn();
    const user = userEvent.setup();
    render(<SetupTracker accounts={[yt]} brands={brands} apps={{ google: 'client' }} connections={{ yt: { state: 'expired', username: 'animals', detail: 'Google stopped accepting this connection.' } }} passwords={{ yt: true }} marks={{}} onMark={onMark} onConnect={onConnect}/>);
    const group = screen.getByRole('group', { name: 'YouTube setup' });
    expect(within(group).getByText('4 left')).toBeInTheDocument();
    const published = within(group).getByRole('listitem', { name: 'Consent screen published (In production)' });
    await user.click(within(published).getByRole('button', { name: 'Mark done' }));
    expect(onMark).toHaveBeenCalledWith('youtube:app:published', true);
    await user.click(within(published).getByRole('button', { name: /Open consent screen/ }));
    expect(openSetupPage).toHaveBeenCalledWith('google-consent');
    const connection = within(group).getByRole('listitem', { name: 'Animals (@animals): connected for posting' });
    expect(within(connection).getByText('Google stopped accepting this connection.')).toBeInTheDocument();
    await user.click(within(connection).getByRole('button', { name: 'Reconnect' }));
    expect(onConnect).toHaveBeenCalledWith(yt);
    expect(within(group).queryByText(/set up in Social Space/)).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Show finished'));
    expect(within(group).getByText('Google Cloud app set up in Social Space')).toBeInTheDocument();
  });

  it('shows a ticked step with when it was ticked, and can undo it', async () => {
    const onMark = vi.fn();
    const user = userEvent.setup();
    render(<SetupTracker accounts={[yt]} brands={brands} apps={{ google: 'client' }} connections={{}} passwords={{}} marks={{ 'youtube:app:api': Date.UTC(2026, 10, 11, 12) }} onMark={onMark}/>);
    await user.click(screen.getByLabelText('Show finished'));
    const api = screen.getByRole('listitem', { name: 'YouTube Data API v3 enabled' });
    expect(within(api).getByText(/Ticked/)).toBeInTheDocument();
    await user.click(within(api).getByRole('button', { name: 'Undo' }));
    expect(onMark).toHaveBeenCalledWith('youtube:app:api', false);
  });
});
