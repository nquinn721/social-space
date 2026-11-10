import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import XPublisher from './XPublisher';
import * as service from './xService';

vi.mock('./xService', () => ({ xConnection: vi.fn(), connectX: vi.fn(), disconnectX: vi.fn(), postToX: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe('X publishing', () => {
  it('connects and publishes a post', async () => {
    vi.mocked(service.xConnection).mockResolvedValue(null);
    vi.mocked(service.connectX).mockResolvedValue({ id: '1', username: 'example', name: 'Example' });
    vi.mocked(service.postToX).mockResolvedValue({ id: 'post-1', text: 'Hello' });
    const user = userEvent.setup();
    render(<XPublisher />);
    await user.type(await screen.findByLabelText('X OAuth 2.0 client ID'), 'client-id');
    await user.click(screen.getByRole('button', { name: 'Connect X account' }));
    expect(service.connectX).toHaveBeenCalledWith('client-id', undefined);
    expect(await screen.findByText(/Connected as @example/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Your post'), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Post to X' }));
    expect(service.postToX).toHaveBeenCalledWith('Hello', undefined);
    expect(await screen.findByText('Your post was published to X.')).toBeInTheDocument();
    expect(screen.getByLabelText('Your post')).toHaveValue('');
  });

  it('reports connection failures without claiming the account is connected', async () => {
    vi.mocked(service.xConnection).mockResolvedValue(null);
    vi.mocked(service.connectX).mockRejectedValue(new Error('Authorization failed'));
    const user = userEvent.setup();
    render(<XPublisher />);
    await user.type(await screen.findByLabelText('X OAuth 2.0 client ID'), 'client-id');
    await user.click(screen.getByRole('button', { name: 'Connect X account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Authorization failed');
    expect(screen.getByLabelText('X OAuth 2.0 client ID')).toHaveValue('client-id');
    expect(screen.queryByLabelText('Your post')).not.toBeInTheDocument();
  });

  it('retains a post after a failed request so the user can review it', async () => {
    vi.mocked(service.xConnection).mockResolvedValue({ id: '1', username: 'example', name: 'Example' });
    vi.mocked(service.postToX).mockRejectedValue(new Error('Request failed'));
    const user = userEvent.setup();
    render(<XPublisher />);
    await user.type(await screen.findByLabelText('Your post'), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Post to X' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed');
    expect(screen.getByLabelText('Your post')).toHaveValue('Hello');
    expect(screen.getByText(/check X before trying again/)).toBeInTheDocument();
  });
});
