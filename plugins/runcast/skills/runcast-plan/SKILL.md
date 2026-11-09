---
name: runcast-plan
description: Plans a new demo or recorded-test video of a web app by interviewing the user step by step — goal, audience, duration, landscape or vertical (YouTube Shorts, Instagram Reels) format, which product areas it touches, whether to use existing records or create new ones and their form fields, the flow screen by screen, on-screen messages, captions, title cards, blurred fields and voice-over — and writes the agreed scenario to <recording folder>/scenarios/<name>.md. Then hands off to the runcast-scenario skill to write the Playwright test. Use when someone wants to create, plan or design a new recording scenario or demo video.
---

# Planning a recording scenario by interview

You talk with the user to produce the **text** of a demo / recording scenario:
`<recording folder>/scenarios/<name>.md` (default folder `tests/recording/`).
It is what the product team reads and approves, and the single source for the
test. Writing test code is not this skill's job; once the text is approved,
switch to the `runcast-scenario` skill.

Template: [`template.md`](template.md). The app's screens, records, known
forms and existing steps: the recording folder's **`PROJECT.md`** (if it is
missing, run the `runcast-setup` skill first). Filled-in examples: the
other `scenarios/*.md` files.

## Interview rules

- **One topic per message, at most 3 questions.** No long questionnaires.
- **Offer a recommendation with every question.** For multiple choice, put
  your recommendation first and mark it "(Recommended)". Use your
  question tool if you have one (e.g. AskUserQuestion); otherwise numbered
  options. If the user says "you decide", go with the recommendation and note
  it in the text.
- **Do not ask what you can find out.** Screen names, buttons, fields and page
  transitions are in the app's code and in `PROJECT.md`. Look there first;
  ask the user only for **decisions** (what to show, which name, which value).
- **Do not invent.** For a screen or action you cannot find in the code, ask
  "I could not find this in the code — how is it done on screen?" or ask for a
  screenshot.
- **Save the draft early.** As soon as the goal is clear, create
  `scenarios/<name>.md` from the template and update it after every phase, so
  nothing is lost if the conversation stops.
- **Speak the user's language.** The scenario text is written in the user's
  language; on-screen messages and narration in the language chosen for the
  video (question 3). Field names in the template stay as they are.

## Phases

### 1. Goal

Ask (over two or three messages; at most three questions each):

1. What should the video show, and who watches it? (customer demo, internal
   training, bug report, release notes...)
2. Target length? (suggest 60–90 s for an overview, 30–45 s for one feature)
3. Language of the on-screen messages? (suggest English for outside viewers)
4. Video only, or also an end-to-end test (headless, CI)? (suggest both —
   every scenario runs in all modes; for a test you will also ask what each
   step must verify.)

   Only if the answer includes a video (video only, or both), ask about its
   shape; a test-only scenario stays landscape and skips both:

   - **4a. "Landscape or vertical?"** Describe each option by where it is
     watched; the user's goal (question 1) decides which comes first and
     carries "(Recommended)":
     - **Landscape (16:9):** a YouTube video, a website, a presentation or
       documentation.
     - **Vertical (9:16):** YouTube Shorts, Instagram Reels, TikTok.

     If vertical and the target length is over 3 minutes, say so: YouTube
     makes vertical videos of at most 3 minutes Shorts; suggest a shorter
     flow (Shorts and Reels work best under a minute).
   - **4b. Only if vertical: "Which layout?"** Always show all three. First
     decide which to recommend: read "Mobile layout" in `PROJECT.md`; if it
     is missing or looks stale, check the code yourself (viewport meta,
     breakpoints or responsive classes on the screens this scenario uses, a
     mobile menu). Put the recommended option first, marked "(Recommended)",
     with one line of evidence (e.g. "the layout has `md:` breakpoints and a
     `MobileNav` component"). The user picks; never choose for them.
     - **Mobile layout** (`vertical`): the page is 9:16, so the app shows its
       own narrow layout; it fills the frame and reads well on a phone.
       Recommend it when the app has a mobile layout for these screens.
     - **Crop and follow** (`vertical-crop`): the desktop page is recorded;
       the video shows a 9:16 slice of it that follows the action. Readable
       on a phone, but the rest of the page is out of view. Recommend it for
       desktop-only apps when the flow happens in one area of the screen
       (forms, one panel).
     - **Whole page in the middle** (`vertical-fit`): the desktop recording
       across the middle of the frame, captions and cards around it. Nothing
       is cut off, but the content is small (the camera's zoom helps).
       Recommend it for desktop-only apps when the viewer must see the whole
       page (dashboards, layouts spread across the screen).

     When the code does not settle it, say so in the evidence and recommend
     one of the desktop layouts. If the use is "both" and the layout is
     `vertical`, say that the test also runs in the mobile layout (480×854).
     Write the decision ("Format"); the test passes
     `scenario({ format: "vertical" })` (or `"vertical-crop"` /
     `"vertical-fit"`).
5. **"Do you want a voice-over for the video?"** If yes: language, tone
   (formal / friendly), who makes the audio (by hand in the ElevenLabs web app,
   or `node tests/recording/.kit/cli.ts narration generate` with their own API key) and the ElevenLabs
   voice (voice id; may come later). The narration itself is written in
   phase 7, after the test exists, so it fits the steps' real lengths.
6. **"Should the steps' on-screen messages appear as captions?"** (default
   no). If yes, the messages show at the bottom while each step lasts, so keep
   them short (≤ 6 words) and in the video's language. Write the decision
   ("Captions"); the test enables it with `scenario({ captions: true })`.
7. **"Do you want an opening card before the video and a closing card after
   it?"** (default no; each can be chosen alone). A card: brand background,
   the app's logo, a title and an optional subtitle. If yes, ask for each
   title and subtitle; if the user only gives a topic, suggest wording and get
   it approved (title ≤ 6 words, subtitle ≤ 8 words, in the video's language).
   Defaults: opening 3 s, closing 4 s. With a voice-over, ask whether the cards
   should be spoken over (`intro` / `outro` segments in phase 7). Write the
   decision ("Cards"); the test adds
   `scenario({ intro: { title, subtitle }, outro: { ... } })`.
8. **"Is there anything on screen the viewer must not read?"** (server
   addresses, user names, e-mails, other customers' records...). Propose
   candidates from the scenario's screens (e.g. e-mail and phone on a customer
   form); password fields are masked already. Chosen fields blur
   once they hold a value: empty they stay readable, from the first typed
   character on they are blurred, and prefilled on later screens too. Write the decision ("Blur"); the test applies it
   with `scenario({ blur: ['[name="email"]', ...] })`.
9. **"Should the video turn a 3D cube when it moves to another area of the
   app?"** (default no). The cube replaces a step that only moves (opens
   another area, waits for a page to load) and turns from the page before to
   the page after; the step's own clicks are not shown. Mark those steps in
   phase 4 ("Transition"). Write the decision ("Transitions"); the test passes
   `transition: "cube"` to those steps.

Check `scenarios/*.md` first: if a similar scenario exists, ask whether to make
a new one or change that one. Suggest a file name (`kebab-case`, e.g.
`demo-first-order`) and create the draft.

### 2. Records and actions: existing or new?

**a) Product areas.** From the goal, pick the areas of the app the scenario
touches (`PROJECT.md` > "Screen map") and confirm them with the user. Apps are
rarely one chain of screens; think about settings, admin areas, runs, logs,
versions and permissions too.

**b) Records needed.** Which records do the chosen screens need? (e.g. an
order needs its customer; a screen that uses a product needs one to pick.) Put the
list in dependency order: first the records others use.

**c) For each record ask: "Use an existing one, or create a new one?"**

- **Existing:** ask which one (its name). If the user does not know, tell them
  where to look in the app (`PROJECT.md`, the "List" column).
- **New:** ask for the fields of **the form on its add screen**. Read the
  fields, required ones and limits from the code (`PROJECT.md` > "Finding a
  screen's form"; known forms are listed there) and suggest a value for each.
  For multi-step forms (e.g. choose a type, then that type's form) ask for the
  type first.
- **"I'll give the name, you fill in the rest":** the user may give only a
  name. Fill the other fields yourself: descriptions realistic, matching the
  name and the video's goal and within the limits (e.g. "Northwind Traders"
  → note "Wholesale customer since 2019"); leave choice fields at the form's
  default. Write what you filled in to the text and show it at the summary as
  "filled in by me", so the user can change it. **Exception: secret and
  environment-specific values** (passwords, connection addresses, keys,
  tokens, server names): never invent them; ask the user.
- **A new parent makes its children new.** An existing child cannot live in a
  new parent; ask lower levels directly as new. Records that are only
  **assigned or referenced** are picked from existing ones; if none exists,
  creating one is a separate record to ask about.
- **Records that need secrets** (connections, directory or SSO settings, user
  passwords): suggest an existing one for a demo first. If a new one is
  created, secrets become settings in `.env.local`, never written in the text;
  discuss whether they show on screen (see question 8).
- **Changing an existing record** changes real data. Say so; suggest a new
  record for the demo where possible.
- **Admin-only screens** (marked in `PROJECT.md`): ask whether the account
  that signs in is an admin.

**d) Actions.** For what is shown without creating a record (running
something, previews, logs, versions, parameters, queries, granting access...),
ask what exactly is shown: which item, which values, whether the video waits
for a long-running result or only starts it. Results that depend on the
environment may differ between takes: say so and add it to "Open questions".

**e) Settings and clean-up.** Every variable value (name, description, chosen
record, condition, query) becomes a setting: `<PREFIX>_<NAME>` (e.g.
`SALES_PROJECT`), with a scenario-specific prefix; the sign-in account's
settings are shared (see `PROJECT.md`). Suggest names that look real to the
viewer; never `test`, `asdf`. Every new record is written to the real backend:
write in the text what must be deleted before the next take.

### 3. Flow draft

Propose a step list from the goal (5–12 steps), then ask: "Anything to add,
remove or reorder?"

A scenario is a sequence of reusable **steps** (`PROJECT.md` > "Step
catalog"). Map every row of the draft to an existing step (e.g. `login`,
`createCustomer`); mark rows without one "New step needed". Do not have the user
describe sign-in or other existing steps again: reuse the step, ask only for
its values.

Then ask: **"From which step should the video start?"** Earlier steps run fast
and silently before recording (`REC_FROM`); e.g. sign-in and setup can happen
off camera. Do not ask message, length or focus for steps that are not seen.

Then look for steps **in the middle** the viewer need not watch: long waits
(an import, a report being built, a slow page), repeated work (the third of
three similar records), setup between two parts of the story. Propose to run
them **off camera**: the recording pauses during the step and goes on with
the next one (a short cross-fade joins them); the step still runs and is still
tested. Ask: "Shall these run off camera?" and mark them "Off camera" in the
flow. A pause can only start and end at a step boundary: if only part of a
step is boring, propose splitting it.

While drafting:

- Take screens and transitions from `PROJECT.md`; every step should be doable
  with existing helpers where possible. Mark the rest "New helper needed".
- Account for the app's known behaviours (`PROJECT.md`).
- Give the subject of the video the biggest share of time; keep sign-in and
  navigation short.

### 4. Step details

Settle the steps in groups of 2–3. For each step:

| Field         | Question / decision                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Screen        | Which page? (confirm in the code)                                                                      |
| What happens  | Clicks, typing, choices in order; the values entered                                                   |
| On-screen msg | The step's short message (≤ 6 words); written to `steps.json` with the step's time                     |
| Length        | Roughly how many seconds                                                                               |
| Focus         | Where the viewer should look once the step is done: the element that carries its message (see below), and its transition if it differs |
| Check         | What must be on screen when the step ends (a success message, a new row, a total...). The test's value |
| Transition    | Only if chosen in phase 1: does a cube turn replace this step? Only for steps that just move elsewhere |

**Focus decides the camera.** Work it out yourself from the goal and the
screen, then confirm: what should the viewer see when this step ends? After
sign-in it is the dashboard's cards, after saving the new row, after a run its
result. Name one concrete element (one card, the new row, the total), not
"the page"; find it in the code so the test can point the camera at it
(`show`). This matters most for vertical videos: with `vertical-crop` only a
slice of the page is visible, and a step that clicks nothing (a `hold`, a page
that opens) shows nothing useful unless its Focus is set. Steps whose own
clicks carry the message need no Focus ("—").

**Transitions between shown areas.** Once the Focus of every step is settled,
if the video shows **more than one** area this way, ask: **"How should the
video move from one shown area to the next?"** Options, recommended first:

- **Slide** (`slide`): the new area pushes the old one out sideways. Recommend
  it when several areas are shown one after another (cards, panels, tabs).
- **Pan** (`pan`): the camera glides over the page to the next area; calm,
  keeps the viewer's sense of where things are. Recommend it when the areas
  are close together or there are only two.
- **Fade** (`fade`): a soft cross-fade.
- **Cube** (`cube`): a 3D cube turn; lively, use sparingly.
- **Cut** (`cut`): at once, like a jump cut.

The answer is the scenario's default; a step may differ (e.g. a cube only into
the last area). Write it ("Show transitions: slide; step 5: cube"); the test
passes `scenario({ showTransition: "slide" })`, and a step's own as
`show: { target, transition }`.

Do not ask for details the user need not know (selectors, waits); ask only for
decisions visible on screen. Update the text, then move to the next group.

### 5. Review and approval

Complete the text and summarise for the user:

- Do the step lengths add up to the target length (±20%)? If not, ask what to
  shorten.
- Does the "Records" table have an existing / new decision for every record,
  and the fields of new ones? List the values you filled in separately
  ("filled in by me"). No secret values in the text.
- Is the "Actions" table filled (or "None")?
- Are the preparation list and the clean-up before another take clear?
- Anything left in "Open questions"?
- Are steps needing new helpers listed?
- Does every step that only shows something (no clicks the viewer follows)
  have a Focus? For `vertical-crop`, every such step needs one.

Then ask: "The scenario text is ready — shall I write the test?"

### 6. Writing the test

After approval, load the `runcast-scenario` skill and follow it:

1. Write missing helpers (`helpers/`) and steps (`steps/`) and add them to the
   catalogs in `PROJECT.md`.
2. Write `scenarios/<name>.spec.ts` as a step list (`scenario({ steps })`);
   on-screen messages are the steps' `note`; the file's top comment links the
   `.md`.
3. Add settings to `.env.example`, the scenario to the README's scenario table.
4. Run the checks. **Never run anything that writes to the backend without
   asking the user first.**

The `.md` and the `.spec.ts` stay in sync: when one changes, change the other.

### 7. Voice-over (if chosen in phase 1)

The narration is one audio segment per **recorded** step:
`scenarios/<name>.narration.json` (example:
[`narration.example.json`](narration.example.json)). The narration never
changes the recording: the renderer fits each segment to its step. A segment
starts with its step; a voice longer than its step (plus the gap after it,
`gapMs`) holds the step's last frame until it ends; a step longer than its
voice loses time from its loading waits (scenario `compressWaits`, default
on), and what is left is silence. A changed text needs new audio and a new
`render`, never a new recording.

**a) Learn the steps' real lengths.** Ask the user (it writes to the backend),
then record the video once: `node tests/recording/.kit/cli.ts video <name>`
(it does not need the narration). Without a video yet, a timing rehearsal
works too: `node tests/recording/.kit/cli.ts rehearsal <name>` (headless and
not recorded, at the video's pace). If neither is possible, use the lengths in
the flow table and say so.

**b) Write the text.** Create the file (`language`; `wordsPerMinute` — start
low: 150 for English, 100 for Turkish and other languages with long words
(an estimate that is too high makes steps run past their voice); `gapMs`: 400;
`voice.modelId`: `eleven_multilingual_v2`; `voice.voiceId`: the user's voice).
Then run `node tests/recording/.kit/cli.ts narration plan <name>`: it shows each step's own length
(from the newest video, else the rehearsal) and the **word budget** that fits. Write each segment to its budget:

- **Segment = step.** `step` is the step's id. Write no segments for steps
  before `REC_FROM` (not recorded).
- **Card segments.** If the scenario has opening / closing cards and the user
  wants them spoken over, write `step: "intro"` (first) and `step: "outro"`
  (last). They play over the card, which stretches to the audio; no budget,
  but keep them short (1–2 sentences: what the video shows / a closing line).
- **Fit the time.** Stay within ±15% of the budget. Under the budget means
  silence or a shortened wait; over it holds the step's last frame (an idle
  screen).
  Do not cover a long step with one sentence or give a short step a long
  text. Suggest splitting a step if needed.
- **Narrate what is on screen, as it happens.** A segment describes that
  step's screen in order; it does not talk about the previous or next step.
  The first words match the step's first movement (the viewer sees what they
  hear).
- **Write for speech:** short sentences (at most 15 words); numbers in words;
  abbreviations as they are spoken (spelled out, or expanded); product and
  record names exactly as on screen (if a setting changes, change the text);
  no emoji, Markdown, parentheses, slashes or quotes. Punctuation is enough
  for pauses; `<break time="0.5s" />` only with models that support it (such
  as `eleven_multilingual_v2`), at most once per segment and under 3 s; never
  with v3 / v4 models.
- **No secrets:** passwords, server names, connection addresses are never
  spoken.
- **Tone:** fits the audience (phase 1); first person plural, present tense
  describing the screen ("we create", "we choose").

Show the text step by step and get it approved. Fill the "Narration" section
of the scenario text.

**c) Audio and real lengths.** First ask: "Do you have an ElevenLabs API key?"
If yes suggest **by command**, otherwise **single take** (in the browser, no
key). Three ways:

- **By command:** the user adds `ELEVENLABS_API_KEY` (and, if needed,
  `ELEVENLABS_VOICE_ID`) to `.env.local` and runs
  `node tests/recording/.kit/cli.ts narration generate <name>`. It makes the segments in order
  (giving neighbouring text as context so the voice flows), writes them to
  `narration/<name>/` and stores the real lengths in the narration file.
  Unchanged segments are not regenerated. Never ask for the API key or have
  it pasted in the chat: the user writes it to the file.
- **By hand:** the user makes each segment in the ElevenLabs web app with the
  same voice and settings, saves it as `narration/<name>/<NN>-<step id>.mp3`
  (e.g. `03-create-customer.mp3`), then runs `node tests/recording/.kit/cli.ts narration measure <name>`.
- **Single take:** when the API cannot use the chosen voice (library voices
  return 402 `paid_plan_required` on free plans) or making segments one by one
  is tedious: `node tests/recording/.kit/cli.ts narration script <name>` writes the whole text, with
  1.5 s `<break>`s between segments, to `narration/<name>/full-text.txt`. The
  user generates it in the web app in one go and saves `narration/<name>/full.mp3`;
  `node tests/recording/.kit/cli.ts narration split <name>` cuts it at the pause after each
  segment's last sentence (ElevenLabs does not always honour `<break>`; it
  aligns by sentence lengths) and measures the parts. One take keeps the tone
  even, but changing one segment means regenerating all. Choose the model
  **Eleven Multilingual v2** in the web app: v3 and v4 ignore `<break>`, so
  there are no pauses and splitting fails.

When the first segments arrive, `generate` / `measure` / `split` print the
voice's measured speaking rate; if it differs from `wordsPerMinute`, set it to
the measured value and adjust the remaining texts to the new budgets (`plan`
shows estimate and real length side by side). Voices differ a lot: the same
model spoke English at ~175 and Turkish at ~95 words per minute. A segment whose text changed needs new audio.

**d) Check, then render.** `node tests/recording/.kit/cli.ts render <name> --check`
(no video, seconds; without a recording yet, `video <name>` first). It prints
a fit table (also in `.captures/<name>/render-report.json`): per step its
natural length, the voice, the frame held, the wait shortened and the silence
left; and draws each step's last frame into
`.captures/<name>/check/sheet.png`. Lengthen segments with long silence;
shorten ones that hold a frame for long. After changing a text, make its
audio again (step c) and check again. Then
`node tests/recording/.kit/cli.ts render <name>` for the MP4 (a vertical one
goes to `videos/<name>-vertical.mp4`).

### 8. Publishing (optional)

When the video is done, ask whether it should go to YouTube; if yes, switch
to the `runcast-publish` skill.
