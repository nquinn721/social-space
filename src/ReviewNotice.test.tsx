import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import ReviewNotice from './ReviewNotice';
import { withReviewState } from './appReviews';

afterEach(cleanup);

it('shows a finished review and can be dismissed', async () => {
  const onDismiss = vi.fn();
  render(<ReviewNotice marks={withReviewState({}, 'tiktok', 'approved', 100)} onOpen={() => undefined} onDismiss={onDismiss}/>);
  expect(screen.getByText(/TikTok app review approved/)).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(onDismiss).toHaveBeenCalledWith(['tiktok']);
});

it('shows nothing while no review has finished', () => {
  const { container } = render(<ReviewNotice marks={withReviewState({}, 'tiktok', 'submitted', 100)} onOpen={() => undefined} onDismiss={() => undefined}/>);
  expect(container).toBeEmptyDOMElement();
});
