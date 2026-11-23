import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Video, Workspace } from '../model';
import type { Ayrshare } from '../useAyrshare';
import type { Results } from '../useResults';
import type { Comment } from '../results';
import TodayPage from './TodayPage';
import CalendarPage from './CalendarPage';
import CommentsPage from './CommentsPage';
import ResultsPage from './ResultsPage';

const mocks = vi.hoisted(() => ({ ayrshare: {} as Partial<Ayrshare>, results: {} as Partial<Results> }));
vi.mock('../useAyrshare', () => ({ useAyrshare: () => mocks.ayrshare }));
vi.mock('../useResults', () => ({ useResults: () => mocks.results }));
vi.mock('../assistant/grokClient', () => ({ listModels: vi.fn(async () => ['grok']) }));
afterEach(cleanup);

const now = Date.now();
const later = (hours: number) => { const day = new Date(now); day.setHours(23, 30, 0, 0); return Math.min(day.getTime(), now + hours * 3_600_000); };
const video = (id: string, extra: Partial<Video> = {}): Video => ({ id, brandId: 'b', categoryId: 'c', title: id, mediaSource: 'C:\\v.mp4', caption: 'Hi', posted: [], createdAt: 1, ...extra });
const workspace = (videos: Video[]): Workspace => ({ businessName: '', brands: [{ id: 'b', name: 'Bunny', notes: '' }], categories: [{ id: 'c', brandId: 'b', name: 'Hops' }], accounts: [{ id: 'a', platform: 'tiktok', label: 'Bunny', handle: 'bunny', status: 'active', notes: '', brandId: 'b', signupEmail: 'x+bunny@gmail.com' }], channels: [], videos });
const comment: Comment = { id: '17', platform: 'instagram', brandId: 'b', videoId: 'hop', postId: 'p', author: 'amy', text: 'So cute!', at: now - 3_600_000, answered: false };

beforeEach(() => {
  mocks.ayrshare = {
    status: { connected: true, working: true, xKeys: true, account: 'me', detail: null }, auto: { running: false },
    brands: { b: { socials: { hasProfile: true, linked: [{ platform: 'tiktok', name: 'bunny', refresh: false }] } } },
    inputs: () => ({ ayrshare: { connected: true, xKeys: true }, socials: { hasProfile: true, linked: [{ platform: 'tiktok', name: 'bunny', refresh: false }] } }),
    send: vi.fn(async (_video: string, _platform: Video['posted'][number], at?: number) => ({ post: { id: 'n', at: at ?? 0, state: 'scheduled' as const } })),
    cancel: vi.fn(async () => {}), retry: vi.fn(async () => {}), isSending: () => false,
  };
  mocks.results = { posts: {}, followers: {}, history: {}, comments: [comment], handled: {}, open: [comment], loading: false, error: '', readAt: null,
    refresh: vi.fn(async () => {}), reply: vi.fn(async () => {}), skip: vi.fn(), draft: vi.fn(async () => 'Thank you, Amy!') };
});

describe('Today', () => {
  it('shows what goes out today, what needs Nate, and schedules the ready videos', async () => {
    const ws = workspace([video('hop', { scheduled: { tiktok: { id: 'p', at: later(1), state: 'scheduled' } } }), video('jump'), video('fail', { scheduled: { tiktok: { id: 'q', at: now - 3_600_000, state: 'failed', error: 'Too long' } } })]);
    render(<TodayPage workspace={ws} loaded onNavigate={vi.fn()} onOpenBrand={vi.fn()} onNewBrand={vi.fn()}/>);
    const going = screen.getByRole('region', { name: 'Going out today' });
    expect(within(going).getByText('hop')).toBeInTheDocument();
    expect(within(going).getAllByText('Bunny · Hops').length).toBeGreaterThan(0);
    const needs = screen.getByRole('region', { name: 'Needs you' });
    expect(within(needs).getByText(/fail didn't post on TikTok/)).toBeInTheDocument();
    expect(within(needs).getByText('1 comment to answer')).toBeInTheDocument();
    // TikTok is linked on Ayrshare, so nothing about logins or sign-ups shows.
    expect(within(needs).queryByText(/Sign up|Fix login|Link socials/)).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(needs).getByRole('button', { name: /Retry/ }));
    expect(mocks.ayrshare.retry).toHaveBeenCalledWith('fail', 'tiktok');
    await user.click(screen.getByRole('button', { name: /Schedule 1 ready video/ }));
    expect(mocks.ayrshare.send).toHaveBeenCalledWith('jump', 'tiktok', expect.any(Number));
  });

  it('shows one Link socials item per brand for what Ayrshare has not linked, and links in one click', async () => {
    mocks.ayrshare = { ...mocks.ayrshare, link: vi.fn(async () => {}), inputs: () => ({ ayrshare: { connected: true, xKeys: true }, socials: { hasProfile: true, linked: [] } }) };
    const ws = workspace([]);
    ws.accounts.push({ ...ws.accounts[0], id: 'y', platform: 'youtube', status: 'planned' }, { ...ws.accounts[0], id: 'i', platform: 'instagram', signupEmail: 'softwings25@gmail.com' });
    render(<TodayPage workspace={ws} loaded onNavigate={vi.fn()} onOpenBrand={vi.fn()} onNewBrand={vi.fn()}/>);
    const needs = screen.getByRole('region', { name: 'Needs you' });
    const item = within(needs).getByRole('button', { name: /Link socials · Bunny/ });
    expect(item).toHaveTextContent('Instagram, TikTok, YouTube');
    expect(within(needs).queryByText(/Sign up|Fix login/)).not.toBeInTheDocument();
    await userEvent.setup().click(item);
    expect(mocks.ayrshare.link).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
  });
});

describe('Calendar', () => {
  it('shows the week with posts and open slots, and moves or unschedules a post', async () => {
    const at = later(1);
    const ws = workspace([video('hop', { scheduled: { tiktok: { id: 'p', at, state: 'scheduled' } } })]);
    render(<CalendarPage workspace={ws} loaded busy={false} onSave={vi.fn(async () => true)} onOpenBrand={vi.fn()} onOpenSettings={vi.fn()}/>);
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^hop,/ }));
    const detail = screen.getByRole('region', { name: 'hop details' });
    await user.click(within(detail).getByRole('button', { name: /Unschedule/ }));
    expect(mocks.ayrshare.cancel).toHaveBeenCalledWith('hop', 'tiktok');
    await user.click(screen.getByRole('button', { name: 'Next week' }));
    expect(screen.getAllByText(/· open/)).toHaveLength(21);
  });
  it('fills open slots with the ready videos', async () => {
    render(<CalendarPage workspace={workspace([video('jump')])} loaded busy={false} onSave={vi.fn(async () => true)} onOpenBrand={vi.fn()} onOpenSettings={vi.fn()}/>);
    await userEvent.setup().click(screen.getByRole('button', { name: /Fill open slots \(1\)/ }));
    expect(mocks.ayrshare.send).toHaveBeenCalledWith('jump', 'tiktok', expect.any(Number));
  });
});

describe('Comments', () => {
  it('drafts a reply with Grok, and sends it or skips', async () => {
    render(<CommentsPage workspace={workspace([video('hop')])}/>);
    const card = screen.getByRole('listitem', { name: 'Comment from amy on Instagram' });
    expect(within(card).getByText('So cute!')).toBeInTheDocument();
    expect(await within(card).findByDisplayValue('Thank you, Amy!')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(card).getByRole('button', { name: /Send reply/ }));
    expect(mocks.results.reply).toHaveBeenCalledWith(comment, 'Thank you, Amy!');
    await user.click(within(card).getByRole('button', { name: 'Skip' }));
    expect(mocks.results.skip).toHaveBeenCalledWith(comment);
  });
});

describe('Results', () => {
  it('sums the posts of the range and lists the top videos', () => {
    const ws = workspace([video('hop', { posted: ['tiktok'], postedAt: { tiktok: now - 86_400_000 }, scheduled: { tiktok: { id: 'p', at: now - 86_400_000, state: 'posted' } } })]);
    mocks.results = { ...mocks.results, posts: { p: { views: 1200, likes: 80, comments: 4, shares: 3, at: now } } };
    render(<ResultsPage workspace={ws}/>);
    expect(screen.getAllByText('1.2K').length).toBeGreaterThan(0);
    expect(within(screen.getByRole('region', { name: 'Top videos' })).getByText('hop')).toBeInTheDocument();
  });
});
