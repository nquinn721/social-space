import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChannelManagement, { ChannelOverview } from './ChannelManagement';
import type { Workspace } from './model';

const workspace: Workspace = {
  businessName: 'Example LLC', brands: [],
  accounts: [{ id: 'yt-account', platform: 'youtube', label: 'Business account', handle: 'business', status: 'active', notes: '' }, { id: 'x-account', platform: 'x', label: 'X account', handle: 'studio', status: 'active', notes: '' }],
  channels: [],
};
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('channel management', () => {
  it('saves a local channel reference with a matching account', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(true);
    render(<ChannelManagement workspace={workspace} busy={false} loaded onSave={onSave} onOpen={vi.fn()}/>);
    await user.click(screen.getAllByRole('button', { name: /add a channel/i })[0]);
    const dialog = screen.getByRole('dialog', { name: 'Add a channel' });
    await user.type(within(dialog).getByLabelText('Channel name'), 'Our videos');
    await user.type(within(dialog).getByLabelText('Handle optional'), '@ourvideos');
    await user.selectOptions(within(dialog).getByLabelText('Related account optional'), 'yt-account');
    expect(within(dialog).queryByRole('option', { name: /X account/ })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Add channel' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave).toHaveBeenCalledWith({ ...workspace, channels: [expect.objectContaining({ platform: 'youtube', name: 'Our videos', handle: 'ourvideos', accountId: 'yt-account' })] }, 'Channel added to your workspace.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('filters by platform and only removes a local reference after confirmation', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(true);
    const open = vi.fn().mockResolvedValue(undefined);
    const record = { id: 'ch-1', platform: 'youtube' as const, name: 'Example videos', handle: 'example', accountId: 'yt-account', notes: 'Primary' };
    const saved = { ...workspace, channels: [record] };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ChannelManagement workspace={saved} busy={false} loaded onSave={onSave} onOpen={open}/>);
    await user.click(screen.getByRole('button', { name: /Instagram 0/ }));
    expect(screen.queryByText('Example videos')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /YouTube 1/ }));
    expect(screen.getByRole('button', { name: 'Edit Example videos' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open YouTube' }));
    expect(open).toHaveBeenCalledWith('youtube', 'manage');
    await user.click(screen.getByRole('button', { name: 'Edit Example videos' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('will not delete the channel'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ ...workspace, channels: [] }, 'Channel removed from this workspace.'));
  });

  it('summarizes saved destinations without implying a platform connection', () => {
    const open = vi.fn();
    render(<ChannelOverview workspace={{ ...workspace, channels: [{ id: '1', platform: 'instagram', name: 'Shop', handle: '', accountId: null, notes: '' }] }} onView={open}/>);
    expect(screen.getByText('01')).toBeInTheDocument();
    expect(screen.getByText('channel saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Manage channels/ })).toBeInTheDocument();
  });
});

