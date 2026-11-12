import type { Platform } from './model';

/** Who does a sign-up step: the app fills it, or Nate has to (buttons, puzzles, phone checks). */
export type StepBy = 'app' | 'you';
export type SignupStep = { title: string; by: StepBy; detail: string };

/**
 * Each social's real sign-up, page by page, as of 2026-11. The app opens the first page and fills
 * every field it can as each page appears; Nate presses every button and does the checks.
 * Full notes (fields, selectors, where codes and checks show up) are in docs/signup-flows.md.
 */
export const SIGNUP_FLOWS: Record<Platform, SignupStep[]> = {
  tiktok: [
    { title: 'Email sign-up form', by: 'app', detail: 'Opens straight on "Sign up with email" and picks the birthday, email and password.' },
    { title: 'Send code', by: 'you', detail: 'Press Send code. TikTok may show a puzzle first.' },
    { title: 'Verification code', by: 'app', detail: 'The 6-digit code from your inbox is entered, and shows bottom right to copy.' },
    { title: 'Next', by: 'you', detail: 'Press Next.' },
    { title: 'Finish in the TikTok app', by: 'you', detail: 'If TikTok shows a QR code, scan it with TikTok on your phone and finish there with the details on the right.' },
    { title: 'Username', by: 'app', detail: 'The brand username is filled. Press Sign up.' },
  ],
  instagram: [
    { title: 'Sign-up form', by: 'app', detail: 'Email, password, birthday, full name and username are filled on one page.' },
    { title: 'Submit', by: 'you', detail: 'Press Submit.' },
    { title: 'Confirmation code', by: 'app', detail: 'The code Instagram emails is entered, and shows bottom right to copy.' },
    { title: 'Next and any check', by: 'you', detail: 'Press Next. Solve a captcha or phone check if one appears.' },
  ],
  youtube: [
    { title: 'Google sign-in', by: 'you', detail: 'Sign in to the Google account that holds your channels.' },
    { title: 'Create a channel', by: 'app', detail: 'The channel name and handle are filled.' },
    { title: 'Create channel', by: 'you', detail: 'Press Create channel.' },
    { title: 'New Google account instead', by: 'app', detail: 'Google sign-up fills name, birthday and username page by page; you pick gender, press Next and do any phone check.' },
  ],
  x: [
    { title: 'Create account', by: 'you', detail: 'Choose Create account, or use email on the first page.' },
    { title: 'Name, email, birthday', by: 'app', detail: 'Name, email and the birthday menus are filled.' },
    { title: 'Next and puzzle', by: 'you', detail: 'Press Next and solve the puzzle if X shows one.' },
    { title: 'Verification code', by: 'app', detail: 'The code X emails is entered, and shows bottom right to copy.' },
    { title: 'Password and username', by: 'app', detail: 'Password, then username, are filled. You press Next on each.' },
  ],
};
