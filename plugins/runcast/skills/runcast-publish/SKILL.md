---
name: runcast-publish
description: Publishes a rendered Runcast video to YouTube — checks the video, walks the user step by step through the one-time Google Cloud setup (project, YouTube Data API v3, OAuth consent screen, Desktop app client), has them sign in in their own browser, drafts the title, description, tags and privacy from the scenario text for approval, then runs the upload script and reports the link. Use when someone wants to upload, publish or share a rendered demo video on YouTube ("upload the demo to YouTube", in any language).
---

# Publishing a video to YouTube

Runcast renders videos to `<recording folder>/videos/<name>.mp4`, vertical
ones (format `vertical`, `vertical-crop` or `vertical-fit`) to
`videos/<name>-vertical.mp4`.
This skill takes one of them to YouTube with `node tests/recording/.kit/cli.ts youtube`
(`.kit/scripts/youtube.ts`, YouTube Data API v3, no extra dependencies).

Talk with the user in their language. Give **one setup step per message** and
wait until they say it is done; check what you can with
`node tests/recording/.kit/cli.ts youtube check` instead of asking.

## Rules

- **Secrets stay out of the chat.** Never ask for, print or read aloud the
  OAuth client secret, codes or tokens. The user saves the downloaded JSON to
  the path you give; the script reads it. Do not open or display
  `.youtube/client_secret.json` or `.youtube/token.json`.
- **The user signs in themselves.** `auth` opens Google's sign-in page in their
  browser; never sign in, pick an account or approve consent for them, and
  never type credentials anywhere.
- **Uploading publishes content: confirm first.** Before `upload`, show the
  file, title, privacy and "made for kids" setting and wait for a clear yes.
  `public` needs the user to say public explicitly; suggest `unlisted` or
  `private` first.
- **No double uploads.** The script refuses a scenario that was uploaded
  before (its metadata has a `result`). Use `--force` only when the user asks
  for a second copy.
- Quota: YouTube allows about 100 uploads per day per project by default.

## 1. The video

1. Find the recording folder (the one with `recording.config.ts`, default
   `tests/recording/`) and ask which scenario's video to publish if it is not
   clear. List `videos/*.mp4` with their dates.
2. If the MP4 is missing or older than the scenario's last change, offer to
   render it first (`node tests/recording/.kit/cli.ts video <name>`, or `node tests/recording/.kit/cli.ts render
<name>` for the last capture). Recording writes to the app's backend: ask
   before running it.
3. If both a landscape and a vertical MP4 exist, ask which one to publish
   (each upload is a separate YouTube video; one metadata file uploads one,
   so a second one needs its own copy of the metadata with `video` set).
4. **A vertical video is a Short** when it is at most 3 minutes long: YouTube
   decides that by itself from the shape and length, the upload is the same.
   Check the length (`ffprobe`); if it is longer, say that it will be an
   ordinary vertical video, not a Short.
5. Suggest the user watches the video once before publishing.

## 2. One-time setup (skip what `check` reports as done)

Run `node tests/recording/.kit/cli.ts youtube check`. For a missing OAuth client, guide these steps
one by one (the Google Cloud console changes its menus now and then; describe
the goal of each step so the user can find it):

1. **Project:** open https://console.cloud.google.com/, sign in with the
   Google account that owns (or manages) the YouTube channel, and create a
   project (e.g. "Demo videos") or pick an existing one.
2. **API:** APIs & Services > Library > search "YouTube Data API v3" >
   Enable.
3. **Consent screen:** Google Auth Platform (OAuth consent screen) > Get
   started: app name (e.g. "Demo video uploader"), support e-mail, audience
   **External**, contact e-mail, agree, Create. Then Audience > Test users >
   add the channel owner's Google account.
   - In **Testing** status, sign-ins expire after 7 days; `upload` then asks
     to run `auth` again. To avoid that, the user can press "Publish app"
     (Production): for personal use Google shows an "unverified app" warning
     at sign-in, which is fine for their own app.
4. **Client:** Google Auth Platform > Clients (or APIs & Services >
   Credentials) > Create client > Application type **Desktop app** > name >
   Create > **Download JSON**.
5. **Save it** as `<recording folder>/.youtube/client_secret.json` (create
   the folder). The folder is gitignored; check that `.youtube/` is in the
   recording folder's `.gitignore` before the file is saved, and add it if not.

Run `check` again; it also tells a wrong client type ("Web application")
apart from the right one.

## 3. Sign in

Run `node tests/recording/.kit/cli.ts youtube auth` (it waits up to 5 minutes; run it in the
background or with a long timeout). It prints a Google URL and opens it in the
user's browser. Tell the user:

- choose the Google account, and if asked, the **channel** (brand account) to
  upload to;
- on "Google hasn't verified this app", click Advanced > Go to <app name>:
  it is their own app;
- allow "Manage your YouTube videos" (upload only), then return here.

When it prints "Signed in", the refresh token is in `.youtube/token.json` and
later uploads need no browser.

## 4. Title, description, privacy

Draft `scenarios/<name>.youtube.json` from the scenario text
(`scenarios/<name>.md`: goal, audience, cards, narration language) and show it
for approval:

```json
{
  "title": "Create your first order in Example App",
  "description": "How to add a customer and place an order...\n\nChapters:\n0:00 Intro\n0:05 New customer",
  "tags": ["example app", "orders", "tutorial"],
  "categoryId": "28",
  "privacyStatus": "unlisted",
  "madeForKids": false,
  "language": "en",
  "thumbnailAt": 1.5
}
```

- **title:** ≤ 100 characters, the video's language; often the opening
  card's title. **description:** ≤ 5000 characters, a few plain sentences;
  chapters from the steps' start times in `.results/<test>/steps.json`
  (shifted by the opening card's length) if the video is long enough; no
  `<` or `>`.
- **tags:** a handful of real search terms, ≤ 500 characters in total.
- **categoryId:** `28` Science & Technology (default), `27` Education.
- **privacyStatus:** ask; recommend `unlisted` (link only) or `private`.
- **madeForKids:** YouTube requires it; product demos are `false`, confirm
  with the user.
- **language:** ISO 639-1 of title, description and speech.
- **thumbnailAt** (optional): a second of the video for the thumbnail, e.g.
  the opening card. Custom thumbnails need a channel allowed to use them
  (phone verification in YouTube Studio); otherwise the script warns and
  YouTube picks one.
- **video** (optional): another MP4 than `videos/<name>.mp4`, relative to the
  recording folder. Without it the script takes `videos/<name>.mp4`, and
  `videos/<name>-vertical.mp4` only when there is no landscape one; set it
  to publish the vertical video when both exist.
- **For a Short:** a short title, `#Shorts` at the end of the title or
  description (optional; it helps viewers find it, YouTube does not need it),
  no chapters, and leave out `thumbnailAt` (Shorts thumbnails are picked in
  the YouTube app).

Secrets, server addresses or customer data never go into the metadata.

## 5. Upload

After the user's explicit yes (see Rules): `node tests/recording/.kit/cli.ts youtube upload <name>`.
It uploads in chunks with a progress line, retries a failed chunk, sets the
thumbnail if asked, prints the link and the YouTube Studio link, and writes
`result` (video id, link, time, privacy) into the metadata file.

Report the link. Mention that YouTube processes the video for a few minutes
before HD is available, and that privacy, title and the rest can be changed
later in YouTube Studio. The metadata file can be committed with the
scenario; the `.youtube/` folder never.

## Problems

| Message                                 | What to do                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| No OAuth client file / Web application  | Section 2, steps 4–5: a **Desktop app** client JSON at the right path                       |
| `access_denied` at sign-in              | The account is not a test user (step 3), or the user cancelled                              |
| Sign-in expired or was revoked          | `node tests/recording/.kit/cli.ts youtube auth` again (Testing apps: every 7 days)          |
| `quotaExceeded` / `uploadLimitExceeded` | Daily limit reached; try tomorrow                                                           |
| `youtubeSignupRequired`                 | The Google account has no YouTube channel yet: create one at youtube.com, then upload again |
| Thumbnail not set                       | Verify the channel in YouTube Studio, or set the thumbnail by hand there                    |
