import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DevAppSetupGuide from './DevAppSetupGuide';
import { GUIDES, lineParts, readPastedKeys } from './devAppGuides';
import { embedSetupPage } from './setupService';

vi.mock('./setupService', () => ({ embedSetupPage: vi.fn() }));
vi.mock('./profileService', () => ({ closeEmbeddedPage: vi.fn(async () => undefined), setEmbeddedBounds: vi.fn(async () => undefined) }));
vi.mock('./instagramService', () => ({ INSTAGRAM_REDIRECT_URI: 'https://nquinn721.github.io/socialspace/instagram' }));
vi.mock('./socialConnectService', () => ({ YOUTUBE_REDIRECT_URI: 'http://127.0.0.1:49174/socialspace/youtube', TIKTOK_REDIRECT_URI: 'http://localhost:49175/socialspace/tiktok/' }));
beforeEach(() => { vi.mocked(embedSetupPage).mockReset().mockResolvedValue('site-embed-1'); });
afterEach(cleanup);

describe('guided developer-app setup', () => {
  it('opens each step\'s developer page inside the app and keeps it for steps without one', async () => {
    const user = userEvent.setup();
    render(<DevAppSetupGuide provider="tiktok" working={false} onSave={vi.fn()} onCancel={vi.fn()}/>);
    await waitFor(() => expect(embedSetupPage).toHaveBeenLastCalledWith('tiktok-login', expect.anything()));
    await user.click(screen.getByRole('button', { name: /Done, next step/ }));
    await waitFor(() => expect(embedSetupPage).toHaveBeenLastCalledWith('tiktok-apps', expect.anything()));
    await user.click(screen.getByRole('button', { name: /Done, next step/ }));
    expect(screen.getByText(/Step 3 of 8: Fill in the app details/)).toBeInTheDocument();
    expect(embedSetupPage).toHaveBeenCalledTimes(2);
  });

  it('shows the redirect address with a Copy button', async () => {
    const user = userEvent.setup();
    render(<DevAppSetupGuide provider="tiktok" working={false} onSave={vi.fn()} onCancel={vi.fn()}/>);
    await user.click(screen.getByRole('button', { name: /Add the redirect address/ }));
    expect(screen.getByText('http://localhost:49175/socialspace/tiktok/')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe('http://localhost:49175/socialspace/tiktok/');
    expect(screen.getByRole('button', { name: /Copied/ })).toBeInTheDocument();
  });

  it('takes the keys on the last step and saves them', async () => {
    const onSave = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(<DevAppSetupGuide provider="tiktok" working={false} onSave={onSave} onCancel={vi.fn()}/>);
    expect(screen.queryByRole('form', { name: 'TikTok keys' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Copy the client key and secret/ }));
    const form = screen.getByRole('form', { name: 'TikTok keys' });
    const save = within(form).getByRole('button', { name: 'Save and connect' });
    expect(save).toBeDisabled();
    await navigator.clipboard.writeText('  awkey123 ');
    await user.click(within(form).getByRole('button', { name: 'Paste Client key' }));
    await user.type(within(form).getByLabelText('Client secret'), 'secret-value');
    await user.click(save);
    expect(onSave).toHaveBeenCalledWith('awkey123', 'secret-value', '');
  });

  it('fills both Google fields from a pasted client JSON', async () => {
    const user = userEvent.setup();
    render(<DevAppSetupGuide provider="google" working={false} onSave={vi.fn()} onCancel={vi.fn()}/>);
    await user.click(screen.getByRole('button', { name: /Copy the client ID and secret/ }));
    await navigator.clipboard.writeText('{"installed":{"client_id":"1-a.apps.googleusercontent.com","client_secret":"GOCSPX-x"}}');
    await user.click(screen.getByRole('button', { name: 'Paste Client ID' }));
    expect(screen.getByLabelText('Client ID')).toHaveValue('1-a.apps.googleusercontent.com');
    expect(screen.getByLabelText('Client secret')).toHaveValue('GOCSPX-x');
  });

  it('closes on Escape', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<DevAppSetupGuide provider="x" working={false} onSave={vi.fn()} onCancel={onCancel}/>);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('guide content', () => {
  it('ends every social\'s guide on the step that takes its keys, with real pages', () => {
    for (const guide of Object.values(GUIDES)) {
      expect(guide.fields.length).toBeGreaterThan(0);
      expect(guide.steps.at(-1)?.optional).toBeFalsy();
      expect(guide.steps.some((step) => step.page)).toBe(true);
    }
    expect(GUIDES.meta.fields.map((field) => field.key)).toEqual(['id', 'secret', 'config']);
    expect(GUIDES.x.fields.map((field) => field.key)).toEqual(['id']);
  });

  it('marks site labels in step text', () => {
    expect(lineParts('Press *Log in* now')).toEqual([{ text: 'Press ', label: false }, { text: 'Log in', label: true }, { text: ' now', label: false }]);
  });

  it('reads plain keys and Google client JSON', () => {
    expect(readPastedKeys('  abc ')).toEqual({ id: 'abc' });
    expect(readPastedKeys('{"web":{"client_id":"id","client_secret":"s"}}')).toEqual({ id: 'id', secret: 's' });
    expect(readPastedKeys('{not json')).toEqual({ id: '{not json' });
  });
});
