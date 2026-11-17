import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import IdeaSuggestionsModal from './IdeaSuggestionsModal';

afterEach(cleanup);

const ideas = ['A calm massage studio', 'Mindful routines at home', 'Simple mobility tips', 'A guide to better rest', 'Massage for busy people'];
function setup(overrides: Partial<Parameters<typeof IdeaSuggestionsModal>[0]> = {}) {
  const props = { ideas, loadingAll: false, loadingIndex: null, error: '', onSelect: vi.fn(), onRerollAll: vi.fn(), onReroll: vi.fn(), onClose: vi.fn(), ...overrides };
  return { props, ...render(<IdeaSuggestionsModal {...props}/>) };
}

describe('idea suggestions', () => {
  it('lets someone choose an idea or reroll one or all without triggering another action', async () => {
    const user = userEvent.setup();
    const { props } = setup();
    expect(screen.getByRole('dialog', { name: 'Find your idea' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(props.onRerollAll).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Reroll suggestion 2' }));
    expect(props.onReroll).toHaveBeenCalledWith(1);
    expect(props.onSelect).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Reroll all' }));
    expect(props.onRerollAll).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: /Simple mobility tips/ }));
    expect(props.onSelect).toHaveBeenCalledWith('Simple mobility tips');
  });

  it('keeps keyboard focus inside, closes only the nested dialog on Escape, and restores focus', async () => {
    const outerEscape = vi.fn();
    const onOuterKey = (event: KeyboardEvent) => { if (event.key === 'Escape') outerEscape(); };
    window.addEventListener('keydown', onOuterKey);
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const { props, unmount } = setup();
    const close = screen.getByRole('button', { name: 'Close suggestions' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Reroll all' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(outerEscape).not.toHaveBeenCalled();
    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
    window.removeEventListener('keydown', onOuterKey);
  });

  it('shows errors and prevents actions while suggestions are loading', () => {
    const { rerender, props } = setup({ ideas: [], loadingAll: true });
    expect(screen.getByText('Finding ideas…')).toHaveAttribute('role', 'status');
    expect(screen.getByRole('button', { name: 'Reroll all' })).toBeDisabled();
    rerender(<IdeaSuggestionsModal {...props} ideas={ideas} loadingAll={false} loadingIndex={2} error="Could not get ideas."/>);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not get ideas.');
    expect(screen.getByRole('button', { name: 'Reroll suggestion 3' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /A calm massage studio/ })).toBeDisabled();
  });
});
