import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import OverviewPage from './OverviewPage';
import type { Workspace } from '../model';

vi.mock('../VideoLibrary', () => ({ brandSocials: () => [] }));
vi.mock('../InboxList', () => ({ default: () => null }));
vi.mock('../emailService', () => ({ emailConnection: async () => null }));
vi.mock('../assistant/grokClient', () => ({ listModels: async () => [] }));
const linked = vi.hoisted(() => ({ value: [] as string[] }));
vi.mock('../useAyrshare', () => ({ useAyrshare: () => ({
  status: { connected: true, working: true, xKeys: false, account: null, detail: null },
  inputs: () => ({ ayrshare: { connected: true, xKeys: false }, socials: { hasProfile: true, linked: linked.value.map((platform) => ({ platform, name: 'bunny', refresh: false })) } }),
}) }));

afterEach(cleanup);
const workspace: Workspace = {
  businessName: 'Bunny', brands: [{ id: 'b', name: 'Bunny', notes: '' }], channels: [],
  accounts: [{ id: 't', brandId: 'b', platform: 'tiktok', label: 'Bunny', handle: 'bunny', status: 'active', notes: '', signupEmail: 'owner+bunny@gmail.com' }],
};

it('does not flag a social linked on Ayrshare as needing attention', () => {
  linked.value = ['tiktok'];
  render(<OverviewPage workspace={workspace} loaded onNavigate={vi.fn()} onCreateAccounts={vi.fn()} onAddAccount={vi.fn()} onOpenAssistant={vi.fn()}/>);
  expect(screen.queryByRole('button', { name: /Bunny · TikTok/i })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open Bunny' })).toHaveTextContent('Ready on all 1');
});

it('asks to link a social that is not linked on Ayrshare yet', () => {
  linked.value = [];
  render(<OverviewPage workspace={workspace} loaded onNavigate={vi.fn()} onCreateAccounts={vi.fn()} onAddAccount={vi.fn()} onOpenAssistant={vi.fn()}/>);
  expect(screen.getByRole('button', { name: /Bunny · TikTok/i })).toHaveTextContent('Link TikTok');
});
