import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GhostInput, GhostTextarea, ghostOf } from './GhostText';

afterEach(cleanup);

function Field({ multiline = false, suggestion }: { multiline?: boolean; suggestion?: string }) {
  const [value, setValue] = useState('');
  const props = { 'aria-label': 'Bio', value, suggestion, onAccept: setValue, placeholder: 'Your bio' };
  return <>{multiline ? <GhostTextarea {...props} onChange={(event) => setValue(event.target.value)}/> : <GhostInput {...props} onChange={(event) => setValue(event.target.value)}/>}<button>next</button></>;
}

describe('ghost text', () => {
  it('shows only while empty', () => {
    expect(ghostOf('', 'Hi')).toBe('Hi');
    expect(ghostOf('typed', 'Hi')).toBe('');
    expect(ghostOf('', '  ')).toBe('');
  });

  it.each([false, true])('Tab takes the suggestion and typing replaces it (multiline %s)', async (multiline) => {
    const user = userEvent.setup();
    render(<Field multiline={multiline} suggestion="Calm hands"/>);
    const box = screen.getByLabelText('Bio');
    expect(box).toHaveAttribute('placeholder', 'Calm hands');
    expect(screen.getByText('Tab')).toBeInTheDocument();
    box.focus();
    await user.keyboard('{Tab}');
    expect(box).toHaveValue('Calm hands');
    expect(box).toHaveFocus();
    await user.clear(box);
    await user.type(box, 'Mine');
    expect(box).toHaveValue('Mine');
    expect(screen.queryByText('Tab')).toBeNull();
    // With text in it, Tab moves on as usual.
    await user.keyboard('{Tab}');
    expect(screen.getByRole('button', { name: 'next' })).toHaveFocus();
  });

  it('keeps the normal placeholder and Tab without a suggestion', async () => {
    const user = userEvent.setup();
    render(<Field/>);
    const box = screen.getByLabelText('Bio');
    expect(box).toHaveAttribute('placeholder', 'Your bio');
    box.focus();
    await user.keyboard('{Tab}');
    expect(box).toHaveValue('');
    expect(screen.getByRole('button', { name: 'next' })).toHaveFocus();
  });
});
