# <Scenario title>

<!-- Written in the user's language; keep the field names below as they are. -->

- **Goal:** <What the video shows, in one sentence>
- **Audience:** <customers / internal team / ...>
- **Target length:** <~N s>
- **On-screen language:** <English / ...>
- **Use:** <video / test / both>
- **Format:** <landscape (16:9) / vertical, mobile layout (`vertical`) / vertical, crop and follow (`vertical-crop`) / vertical, whole page in the middle (`vertical-fit`)> (vertical: 9:16 for YouTube Shorts, Instagram Reels; why this layout)
- **Captions:** <yes / no> (yes: on-screen messages show at the bottom of the video)
- **Cards:** <none / opening: "<title>" — "<subtitle>" (3 s) / closing: "<title>" — "<subtitle>" (4 s)>
- **Blur:** <none / blurred fields, e.g. E-mail, Phone (blurred once filled)>
- **App sound:** <no / yes: volume 0–1 (default 1), under the voice-over 0–1 of it (default 0.3)>
- **Dialogs:** <none / accept (default) / dismiss; per-step answers, e.g. step 4: cancel the confirm>
- **Permissions:** <none / each allowed or blocked, e.g. geolocation: allow, notifications: block (the video draws Chrome's prompt when the page asks)>
- **Downloads:** <none / per step: the file, whether it opens on screen afterwards (and how long), what the test checks in it>
- **Scenes:** <none / `<name>` (step N, `<step id>`): purpose; beats `a`, `b`, `c`; ~N s; transition; approved>
- **Transitions:** <none / cube on step N (`<step id>`): the step is replaced by a cube turn to the next screen>
- **Show transitions:** <pan / slide / fade / cube / cut between shown areas (Focus); per-step exceptions, e.g. step 5: cube>
- **Recording starts at:** <step 1 / step N (`REC_FROM=N`): earlier steps run silently before recording>
- **Test:** [`<name>.spec.ts`](<name>.spec.ts)
- **Status:** <draft / approved>

## Records

Every record the scenario uses or creates, in dependency order (first those
others use). "Filled by": did the user give the value, or did the AI suggest
it? Secret values (passwords, connection details) never go here, only the
setting's name.

| Record     | Kind        | Decision         | Name (setting)              | Other fields  | Filled by   |
| ---------- | ----------- | ---------------- | --------------------------- | ------------- | ----------- |
| <Product>  | <Catalog>   | <existing / new> | <name> (`<PREFIX>_PRODUCT`) | <...>         | <user / AI> |
| <Customer> | <Customers> | <new>            | <...> (`<PREFIX>_CUSTOMER`) | <E-mail: ...> | <...>       |

## Actions

What the video shows without creating records (runs, previews, logs,
versions, queries, granting access...). Otherwise "None".

| Action              | Where       | Details                                         | Note                                   |
| ------------------- | ----------- | ----------------------------------------------- | -------------------------------------- |
| <Export the report> | <Reports >> | <Which date range; does the video wait for it?> | <Length varies; start it, show status> |

## Preparation

What must exist before the take (not created in the video):

- <e.g. a product that the order can pick (`<PREFIX>_PRODUCT`)>

## Created in the video, and clean-up

| Record     | Name (setting)      | Before another take |
| ---------- | ------------------- | ------------------- |
| <Customer> | `<PREFIX>_CUSTOMER` | <Delete or rename>  |

## Settings (`.env.local`)

| Setting           | Default | Description |
| ----------------- | ------- | ----------- |
| `<PREFIX>_<NAME>` | <value> | <what for>  |

## Flow

| #   | Step (steps/)                 | Length  | Screen  | What happens                      | On-screen message | Focus  | Check                 |
| --- | ----------------------------- | ------- | ------- | --------------------------------- | ----------------- | ------ | --------------------- |
| 1   | `login`                       | <0–6 s> | <Login> | <User name and password, Sign in> | <Sign in>         | <The dashboard's first card (`show`)> | <Left the login page> |
| 2   | <`createCustomer` / new step> | <...>   | <...>   | <...>                             | <...>             | <...>  | <...>                 |
| 3   | <`importOrders`> **Off camera** | —     | <...>   | <Starts the import, waits for it> | —                 | —      | <Import finished>     |

Focus: the element the viewer should look at once the step is done (the
camera frames it: `show`); "—" when the step's own clicks carry it. Steps that
run silently before recording (before `REC_FROM`) or **off camera** (cut out
of the video, marked in the Step column) leave Length, On-screen message and
Focus as "—".

Total: <~N s>

## Narration

- **Wanted:** <yes / no>
- **Language, tone:** <en, friendly>
- **Voice:** <ElevenLabs voice id or name; model eleven_multilingual_v2>
- **Audio:** <`node tests/recording/.kit/cli.ts narration generate` / by hand + `measure` / single take + `split`>
- **File:** `<name>.narration.json`

| #   | Step    | Narration | Budget (words) | Length             |
| --- | ------- | --------- | -------------- | ------------------ |
| 1   | `login` | <text>    | <...>          | <estimate / audio> |

## Closing

<The last screen and closing line; the camera returns to the full view>

## New steps and helpers needed

- <Step N: what, on which screen; new step or new helper — or "None">

## Open questions

- <Unanswered decision — or "None">
