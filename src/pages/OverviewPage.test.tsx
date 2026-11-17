import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import OverviewPage from './OverviewPage';
import type { Workspace } from '../model';

vi.mock('../VideoLibrary', () => ({ brandSocials: () => [] }));
vi.mock('../InboxList', () => ({ default: () => null }));
vi.mock('../emailService', () => ({ emailConnection: async () => null }));
vi.mock('../assistant/grokClient', () => ({ listModels: async () => [] }));
vi.mock('../setupService', () => ({ useSetupStatus: () => ({ connections: {}, passwords: {} }) }));
vi.mock('../useSignIns', () => ({ useSignIns: () => ({ b: { tiktok: { signedIn: true, checkedAt: 1 } } }) }));

afterEach(cleanup);

it('does not flag an observed signed-in browser session as needing attention', async () => {
  const workspace: Workspace = {
    businessName: 'Bunny', brands: [{ id: 'b', name: 'Bunny', notes: '' }], channels: [],
    accounts: [{ id: 't', brandId: 'b', platform: 'tiktok', label: 'Bunny', handle: 'bunny', status: 'active', notes: '', signupEmail: 'owner+bunny@gmail.com' }],
  };
  render(<OverviewPage workspace={workspace} loaded onNavigate={vi.fn()} onCreateAccounts={vi.fn()} onAddAccount={vi.fn()} onOpenAssistant={vi.fn()}/>);
  expect(screen.queryByRole('button', { name: /Bunny · TikTok/i })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open Bunny' })).toHaveTextContent('Ready on all 1');
});
