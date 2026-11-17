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

it('shows the observed browser session as unverified and needing attention on the overview', async () => {
  const workspace: Workspace = {
    businessName: 'Bunny', brands: [{ id: 'b', name: 'Bunny', notes: '' }], channels: [],
    accounts: [{ id: 't', brandId: 'b', platform: 'tiktok', label: 'Bunny', handle: 'bunny', status: 'active', notes: '', signupEmail: 'owner+bunny@gmail.com' }],
  };
  render(<OverviewPage workspace={workspace} loaded onNavigate={vi.fn()} onCreateAccounts={vi.fn()} onAddAccount={vi.fn()} onOpenAssistant={vi.fn()}/>);
  expect(screen.getByRole('button', { name: /Bunny · TikTok.*session was detected/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open Bunny' })).toHaveTextContent('Session detected');
});
