# Sign-up flows on each social

What each social's own sign-up looks like, page by page, and what Social Space does on each page.
Checked against the live pages on 2026-11-12. Sites change their pages often: when a step stops
filling, look at the page again and update this file, `FILL_SCRIPT` in `src-tauri/src/autofill.rs`
and the step list in `src/signupFlows.ts` together.

## Ground rules

- Social Space fills fields and picks birthday menu values. **Nate presses every button** (Next, Send
  code, Submit, Sign up) and does every captcha, puzzle and phone check himself.
- No detection evasion, no hidden or background automation, no virtual SMS numbers.
- The page is shown inside the Create accounts window; each new page or step is filled as it appears.
- A code emailed to the sign-up address (Gmail plus-address `softwings25+<brand>@gmail.com` for TikTok
  and X) is entered on the page within seconds and also shown at the bottom right with a Copy button,
  both on the page and in the Social Space window.
- The sign-up birthday is June 5 1983 (`DEFAULT_SIGNUP_BIRTHDAY` in `src/brands.ts`).
- When a page needs Nate (TikTok's QR code, a puzzle, a phone number), the banner at the top of the page
  says what to do.

## TikTok

Opens at `https://www.tiktok.com/signup/phone-or-email/email`, skipping the "Use phone or email /
Continue with Facebook / Continue with Google" chooser at `/signup`.

| Step | Page | Fields and buttons | Who |
| --- | --- | --- | --- |
| 1 | Sign up, email | Birthday: three menus drawn by TikTok (`div[role=combobox]`, aria-label "Month/Day/Year. Double-tap for more options", options `[role=option]` with ids like `Month-options-item-5`). Email (`input[name=email]`, `autocomplete=email`). Password (`autocomplete=new-password`). | App fills |
| 2 | Same page | **Send code** button (`data-e2e=send-code-button`). TikTok may show a slide or rotate puzzle first. | Nate |
| 3 | Same page | 6-digit code box (placeholder "Enter 6-digit code"). Code comes from TikTok's email. | App fills, copy box shows |
| 4 | Same page | **Next** (`type=submit`). | Nate |
| 5 | "Continue on the TikTok app, for security purposes" | A QR code only. TikTok wants the sign-up finished in its phone app. Scan it with TikTok on the phone and finish there using the email, password and birthday from Sign-up details. | Nate |
| 6 | Create username | Username box. | App fills, Nate presses Sign up |

After the account exists (on the phone or the web), press "TikTok account is created" in Social Space so
it is marked live with its saved email and password.

## Instagram

Opens at `https://www.instagram.com/accounts/emailsignup/` ("Get started on Instagram with a Meta Account").

| Step | Page | Fields and buttons | Who |
| --- | --- | --- | --- |
| 1 | Sign-up form | "Mobile number or email" (text input, label only), Password, Birthday menus (`div[role=combobox]` aria-label "Select Month/Day/Year"), "Full name", Username (`input[type=search][role=combobox]`, aria-label "Username"). | App fills |
| 2 | Same page | **Submit** (`div[role=button]`). | Nate |
| 3 | Confirmation code | Code from Instagram's email. | App fills, copy box shows |
| 4 | Next, then any captcha or phone check | | Nate |

Up to 5 Instagram profiles share one login (`LOGIN_RULES` in `src/brands.ts`), so later brands are added
from the signed-in account instead of signing up again.

## YouTube (Google)

A brand's channel lives under the shared Google account, so the normal path is
`https://www.youtube.com/create_channel` while signed in: channel name and handle are filled, Nate presses
Create channel.

A brand new Google account (Make a new Gmail) goes through `https://accounts.google.com/signup`, which
redirects to `/lifecycle/steps/signup/...`, one step per page:

| Step | Page | Fields | Who |
| --- | --- | --- | --- |
| 1 | Enter your name | `input#firstName`, `input#lastName` (optional) | App fills, Nate presses Next |
| 2 | Basic information | Month (`select#month`), Day (`input#day`), Year (`input#year`), Gender (`select#gender`) | App fills date, Nate picks gender and presses Next |
| 3 | Choose your Gmail address | Suggested addresses or "Create your own" with `input[name=Username]` | App fills username, Nate picks and presses Next |
| 4 | Create a strong password | `input[name=Passwd]`, `input[name=PasswdAgain]` | App fills, Nate presses Next |
| 5 | Confirm you're not a robot / phone number | Nate's own phone number and the texted code | Nate |
| 6 | Review, Privacy and Terms | | Nate |

## X

Opens at `https://x.com/i/flow/signup`, which now lands on `https://x.com/i/jf/onboarding/web?mode=signup`:
"Continue with phone / Google / Apple", or "Email or username" (`input[name=username_or_email]`) and
Continue.

| Step | Page | Fields | Who |
| --- | --- | --- | --- |
| 1 | Onboarding | Email box | App fills, Nate presses Continue or Create account |
| 2 | Create your account | Name, Email, Date of birth (`<select>` Month, Day, Year) | App fills, Nate presses Next |
| 3 | Puzzle (Arkose) if shown | | Nate |
| 4 | We sent you a code | Code from X's email | App fills, copy box shows |
| 5 | You'll need a password | Password | App fills, Nate presses Next |
| 6 | What should we call you? | Username | App fills, Nate presses Next |
