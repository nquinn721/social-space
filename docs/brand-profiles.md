# Brand bio and ghost-text suggestions

## Video ideas and stories

In a brand's **Posts** tab, choose a category, select **Make a video**, and use **Suggest video prompts**.
Grok suggests five ideas using the brand and category. Each idea includes complete prompts and available
clip lengths. Reroll the choices or an individual idea, then choose a scene to put its prompt and length
in the video form. You can edit it before making the video. Multi-scene ideas are separate clips; generate
each scene individually and combine them in a video editor. Grok Imagine offers 1–15-second clips here;
clips with character references use at most 10 seconds.

In the brand's **Stories** tab, choose **New story**, enter an optional direction and generate a draft.
Review or reroll the complete story before saving it. A saved story has an editable narrative, a story
bible, characters and parts. Edit a part's summary, script, video prompt or caption yourself, or ask Grok
to write its script. Add a part manually or use **Continue with Grok** to append another part and its
written continuation. Videos generated for a part appear under that part as well as in Posts.

Grok writing uses the configured xAI source. Video generation uses the selected video source; both may
incur provider charges.

## Bio (brand page, Accounts tab)

Each brand has one bio for every social by default (one box, held to the tightest limit, TikTok's 80
characters), and YouTube channel keywords, saved on its profiles (`Account.bio`, `Account.keywords`). When the
saved bios differ, or after **Use a different bio per social**, each social gets its own box.

- When a bio or the keywords are empty, Grok writes suggestions for all of the brand's socials in one request
  (`src/assistant/profileWriter.ts`), each bio fitted to that social's limit (`BIO_LIMITS`). They show as grey
  ghost text; Tab takes one. **Suggest with Grok** asks for new ones.
- The **Fill on** row (one button per live social, plus **All N**) saves the details, then opens each live profile's editor in the
  brand's own window (the same signed-in folder posting uses) and fills the brand picture (at the social's
  size), name, bio, website and, on YouTube, the keywords. It never presses Save, Submit or Publish.

| Social | Opens | Then |
| --- | --- | --- |
| Instagram | `instagram.com/accounts/edit/` | Picture, bio and website fill in; press Submit. |
| X | `x.com/settings/profile` | Edit profile: picture (not the banner), name, bio, website; press Save. |
| TikTok | `tiktok.com/@handle` | Press Edit profile; picture, name and bio fill in as it opens; press Save. |
| YouTube | `studio.youtube.com` | Customization, Profile: name, description, picture. Keywords: Settings, Channel. |

If the brand's window isn't signed in yet, its sign-in page fills first: TikTok with the brand's own
username and password, Instagram and YouTube with the parent login the profile or channel lives under (for
example the main Instagram login or Google account). A signed-out TikTok window starts on TikTok's
email-and-password sign-in and returns to the profile afterwards, since the profile page's own sign-in pop-up
opens on the QR code. Each social's line on the Accounts tab shows that login (username, email, password) under Details, with
**Reset password**: the social's forgot-password page in the brand window, the email and a new password filled
in, saved only after **It worked, save it** (`open_password_reset` / `save_reset_password` in `posting.rs`).

Each brand has its own persistent browser folder, shared by that brand's profile and posting windows. This lets
different brands stay signed in to different accounts on the same social; the social may still expire a session
or require sign-in again. The account row shows **Signed in** when a session was last detected. Open **View**
to check it; the app refreshes the status while the window is open. On TikTok, a username seen on the page is
compared with the saved profile. A Google session does not identify YouTube's selected channel: the saved brand
channel and the channel selected in YouTube may differ, so check the upload window before publishing. X sign-in
and profile editing are manual.

The window keeps filling for 10 minutes as the editor opens or changes step. Back end: `open_profile_editor`
in `src-tauri/src/posting.rs`, fill script `profile_edit_script` in `src-tauri/src/autofill.rs`.

## Ghost text

`src/GhostText.tsx` (`GhostInput`, `GhostTextarea`): while a field is empty, its suggestion shows in grey with a
Tab badge. Tab takes it; typing replaces it; Shift+Tab, or Tab in a field with text, moves focus as usual.

Where suggestions come from:

- Post panel description and hashtags: Grok's caption for the video (`cachedPostSuggestion`, once per video).
- Brand Bio: bios and YouTube keywords (above).
- Account panel: the bio (Grok, for that social) and the display name (the account name).
