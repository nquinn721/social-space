# Brand profile details and ghost-text suggestions

## Profile details (brand page, Accounts tab)

Each brand has one bio per social and YouTube channel keywords, saved on its profiles (`Account.bio`,
`Account.keywords`).

- When a bio or the keywords are empty, Grok writes suggestions for all of the brand's socials in one request
  (`src/assistant/profileWriter.ts`), each bio fitted to that social's limit (`BIO_LIMITS`). They show as grey
  ghost text; Tab takes one. **Suggest with Grok** asks for new ones.
- **Fill on <social>** / **Fill all N profiles** saves the details, then opens each live profile's editor in the
  brand's own window (the same signed-in folder posting uses) and fills the brand picture (at the social's
  size), name, bio, website and, on YouTube, the keywords. It never presses Save, Submit or Publish.

| Social | Opens | Then |
| --- | --- | --- |
| Instagram | `instagram.com/accounts/edit/` | Picture, bio and website fill in; press Submit. |
| X | `x.com/settings/profile` | Edit profile: picture (not the banner), name, bio, website; press Save. |
| TikTok | `tiktok.com/@handle` | Press Edit profile; picture, name and bio fill in as it opens; press Save. |
| YouTube | `studio.youtube.com` | Customization, Profile: name, description, picture. Keywords: Settings, Channel. |

If the brand's window isn't signed in yet, its sign-in page fills first: TikTok and X with the brand's own
username and password, Instagram and YouTube with the parent login the profile or channel lives under (for
example the main Instagram login or Google account). A signed-out TikTok window starts on TikTok's
email-and-password sign-in and returns to the profile afterwards, since the profile page's own sign-in pop-up
opens on the QR code. Each brand card on the Accounts tab shows that login (username, email, password).

The window keeps filling for 10 minutes as the editor opens or changes step. Back end: `open_profile_editor`
in `src-tauri/src/posting.rs`, fill script `profile_edit_script` in `src-tauri/src/autofill.rs`.

## Ghost text

`src/GhostText.tsx` (`GhostInput`, `GhostTextarea`): while a field is empty, its suggestion shows in grey with a
Tab badge. Tab takes it; typing replaces it; Shift+Tab, or Tab in a field with text, moves focus as usual.

Where suggestions come from:

- Post panel description and hashtags: Grok's caption for the video (`cachedPostSuggestion`, once per video).
- Brand Profile details: bios and YouTube keywords (above).
- Account panel: the bio (Grok, for that social) and the display name (the account name).
