# Sign-up flows on each social

What each social's own sign-up looks like, page by page, and what Social Space does on each page.
Checked against the live pages on 2026-11-12. Sites change their pages often: when a step stops
filling, look at the page again and update this file, `FILL_SCRIPT` in `src-tauri/src/autofill.rs`
and the step list in `src/signupFlows.ts` together.

## Ground rules

- In Create accounts, **Suggest** offers five ideas, even with an empty idea field. Reroll one or all,
  then select an idea to add it to the form. **Fill form** uses that idea to suggest the account name,
  username and description. Both actions need the configured xAI key; profile images are generated separately.
- Social Space fills supported fields and birthday menus where available. **Nate presses every button**
  (Next, Send code, Submit, Sign up) and completes each captcha, puzzle and phone check himself.
- No detection evasion, no hidden or background automation, no virtual SMS numbers.
- The page is shown inside the Create accounts window. Instagram and TikTok fields may fill as each
  step appears; X is manual. YouTube and Facebook receive only clearly identified channel or Page names.
- New Instagram, TikTok and X accounts have separate passwords stored in Windows Credential Manager.
  Each can use a brand-specific plus-address (for example `softwings25+<brand>@gmail.com`), which is an
  alias for the existing inbox rather than a new mailbox. Availability depends on the providers.
- Codes from the inbox can be filled on supported Instagram and TikTok pages. For X, YouTube and
  Facebook, copy the code and enter it yourself.
- New accounts have no prefilled birthday; enter the correct date when a service asks. Dates already
  saved for existing profiles are preserved.
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

Each new brand is planned as a separate Instagram account with its own password. Existing accounts
are not changed when this planning preference changes.

## YouTube (Google)

A brand's channel lives under the shared Google account, so the normal path is
`https://www.youtube.com/create_channel` while signed in. Social Space fills a clearly identified channel
name field when available; Nate signs in, checks the details and presses Create channel. The app plans
up to 100 channels per Google account based on saved profiles; verify the actual count in YouTube.

A brand new Google account (Make a new Gmail) goes through `https://accounts.google.com/signup`, which
redirects to `/lifecycle/steps/signup/...`, one step per page:

| Step | Page | Fields | Who |
| --- | --- | --- | --- |
| 1 | Enter your name | `input#firstName`, `input#lastName` (optional) | App fills, Nate presses Next |
| 2 | Basic information | Month (`select#month`), Day (`input#day`), Year (`input#year`), Gender (`select#gender`) | App fills date, Nate picks gender and presses Next |
| 3 | Choose your Gmail address | Suggested addresses or "Create your own" with `input[name=Username]` | App fills username, Nate picks and presses Next |
| 4 | Create a strong password | `input[name=Passwd]`, `input[name=PasswdAgain]` | Nate chooses and enters it |
| 5 | Confirm you're not a robot / phone number | Nate's own phone number and the texted code | Nate |
| 6 | Review, Privacy and Terms | | Nate |

## X

Opens X's sign-up page. X signup and profile editing are manual: use the wizard's copy buttons for
the email, username and saved password, enter the details yourself, and complete any checks on X.

## Facebook

Each brand gets a Facebook Page managed with the existing Facebook login. The wizard opens the Pages
area in the business portfolio and can fill a clearly identified Page name field. Sign in with your
existing Facebook account, create the Page, and review its details yourself. Social Space never creates
a password for the Page or fills the Facebook login password.
