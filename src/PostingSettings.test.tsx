import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import PostingSettings from './PostingSettings';

afterEach(cleanup);

it('explains that X requires manual posting', () => {
  render(<PostingSettings/>);
  expect(screen.getByText(/X opens its posting page for you to enter everything yourself/)).toBeInTheDocument();
  expect(screen.getByText(/attach the video, enter the text, and post yourself/)).toBeInTheDocument();
});
