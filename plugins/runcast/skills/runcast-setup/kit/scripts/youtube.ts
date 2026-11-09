// Uploads a rendered video to YouTube with the YouTube Data API v3.
//
//   node <recording folder>/.kit/cli.ts youtube check                  is the setup complete?
//   node <recording folder>/.kit/cli.ts youtube auth                   sign in once in the browser (stores a refresh token)
//   node <recording folder>/.kit/cli.ts youtube upload <scenario>      upload videos/<scenario>.mp4 with scenarios/<scenario>.youtube.json
//   node <recording folder>/.kit/cli.ts youtube upload <scenario> --force   upload again although it was uploaded before
//
// Secrets live in <recording folder>/.youtube/ (gitignored):
//   client_secret.json  the OAuth client ("Desktop app") downloaded from Google Cloud
//   token.json          written by `auth`; the refresh token for the signed-in channel
//
// The runcast-publish skill walks through the Google Cloud setup and writes the
// metadata file. Runs with plain Node (fetch, no dependencies).
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { kitCommand, loadProject } from "../core/project.ts";

const PROJECT_DIR = (await loadProject()).dir;
const KIT_CMD = kitCommand(PROJECT_DIR);
const SECRETS_DIR = path.join(PROJECT_DIR, ".youtube");
const CLIENT_FILE =
  process.env.YOUTUBE_CLIENT_SECRET_FILE ??
  path.join(SECRETS_DIR, "client_secret.json");
const TOKEN_FILE = path.join(SECRETS_DIR, "token.json");
const SCOPE = "https://www.googleapis.com/auth/youtube.upload";
// Endpoints; overridable only to test the script against a local mock.
const API = process.env.YOUTUBE_API_URL ?? "https://www.googleapis.com";
const TOKEN_URL =
  process.env.YOUTUBE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
/** Upload chunk: a multiple of 256 KiB, as the API requires. */
const CHUNK = 8 * 1024 * 1024;

/** scenarios/<name>.youtube.json: what the video is called and who may see it. */
interface Metadata {
  /**
   * The MP4, relative to the recording folder. Default videos/<scenario>.mp4,
   * else videos/<scenario>-vertical.mp4 (a vertical render).
   */
  video?: string;
  title: string;
  description?: string;
  tags?: Array<string>;
  /** YouTube category id; 28 = Science & Technology, 27 = Education. */
  categoryId?: string;
  privacyStatus: "private" | "unlisted" | "public";
  /** Required by YouTube (COPPA). */
  madeForKids: boolean;
  /** ISO 639-1 of title, description and speech, e.g. "en". */
  language?: string;
  /** Second of the video to use as the thumbnail (needs a channel allowed to set thumbnails). */
  thumbnailAt?: number;
  /** Written after the upload. */
  result?: {
    videoId: string;
    url: string;
    uploadedAt: string;
    privacyStatus: string;
  };
}

interface ClientSecret {
  client_id: string;
  client_secret: string;
}

interface Token {
  refresh_token: string;
  access_token?: string;
  expires_at?: number;
}

const [command, name, ...flags] = process.argv.slice(2);
const usage = `Usage: ${KIT_CMD} youtube <check|auth|upload> [<scenario>] [--force]`;

switch (command) {
  case "check":
    check();
    break;
  case "auth":
    await auth();
    break;
  case "upload":
    if (!name) fail(usage);
    await upload(name, flags.includes("--force"));
    break;
  default:
    fail(usage);
}

// --- check -------------------------------------------------------------------

function check(): void {
  const rel = (file: string) => path.relative(process.cwd(), file);
  const client = existsSync(CLIENT_FILE);
  const token = existsSync(TOKEN_FILE);
  console.log(`${client ? "✓" : "✗"} OAuth client: ${rel(CLIENT_FILE)}`);
  if (client) readClient(); // fails with a clear message when it is not a Desktop app client
  console.log(`${token ? "✓" : "✗"} Signed in: ${rel(TOKEN_FILE)}`);
  if (!client) {
    console.log(
      "\nNext: download the Desktop app OAuth client JSON from Google Cloud to that path.",
    );
  } else if (!token) {
    console.log(`\nNext: ${KIT_CMD} youtube auth`);
  } else {
    console.log(`\nReady: ${KIT_CMD} youtube upload <scenario>`);
  }
}

// --- auth: OAuth for installed apps, loopback redirect + PKCE ----------------

async function auth(): Promise<void> {
  const client = readClient();
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const redirectUri = `http://127.0.0.1:${port}`;

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();

  console.log(
    "Sign in with the Google account that owns the YouTube channel:\n",
  );
  console.log(`  ${url.toString()}\n`);
  openBrowser(url.toString());
  console.log("Waiting for the browser (5 minutes)...");

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for sign-in.")),
      300_000,
    );
    server.on("request", (request, response) => {
      const query = new URL(request.url ?? "/", redirectUri).searchParams;
      const error = query.get("error");
      const received = query.get("code");
      if (!error && !received) {
        response.writeHead(404).end();
        return;
      }
      const ok = !error && query.get("state") === state;
      response
        .writeHead(ok ? 200 : 400, {
          "content-type": "text/html; charset=utf-8",
        })
        .end(
          ok
            ? "<h2>Signed in. You can close this tab and return to the terminal.</h2>"
            : `<h2>Sign-in failed: ${error ?? "state mismatch"}</h2>`,
        );
      clearTimeout(timer);
      if (ok && received) resolve(received);
      else reject(new Error(`Sign-in failed: ${error ?? "state mismatch"}`));
    });
  })
    .catch((error: unknown) =>
      fail(error instanceof Error ? error.message : String(error)),
    )
    .finally(() => server.close());

  const tokens = await tokenRequest({
    client_id: client.client_id,
    client_secret: client.client_secret,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  if (!tokens.refresh_token) {
    fail(
      "Google returned no refresh token. Remove the app's access in your Google account and run auth again.",
    );
  }
  saveToken({
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
  });
  console.log(
    `\nSigned in. Token saved to ${path.relative(process.cwd(), TOKEN_FILE)}.`,
  );
}

// --- upload ------------------------------------------------------------------

async function upload(scenario: string, force: boolean): Promise<void> {
  const metaFile = findMetadata(scenario);
  const meta = JSON.parse(readFileSync(metaFile, "utf-8")) as Metadata;
  const base = path.basename(metaFile, ".youtube.json");
  if (meta.result && !force) {
    fail(
      `Already uploaded: ${meta.result.url} (${meta.result.uploadedAt}). Use --force to upload again.`,
    );
  }
  validate(meta, metaFile);
  const landscape = path.join("videos", `${base}.mp4`);
  const vertical = path.join("videos", `${base}-vertical.mp4`);
  const video = path.resolve(
    PROJECT_DIR,
    meta.video ??
      (!existsSync(path.resolve(PROJECT_DIR, landscape)) &&
      existsSync(path.resolve(PROJECT_DIR, vertical))
        ? vertical
        : landscape),
  );
  if (!existsSync(video))
    fail(`No video: ${path.relative(process.cwd(), video)}. Render it first.`);
  const size = statSync(video).size;
  const token = await accessToken();

  // 1. Start a resumable session with the metadata.
  const body = {
    snippet: {
      title: meta.title,
      description: meta.description ?? "",
      tags: meta.tags ?? [],
      categoryId: meta.categoryId ?? "28",
      ...(meta.language
        ? {
            defaultLanguage: meta.language,
            defaultAudioLanguage: meta.language,
          }
        : {}),
    },
    status: {
      privacyStatus: meta.privacyStatus,
      selfDeclaredMadeForKids: meta.madeForKids,
    },
  };
  const start = await fetch(
    `${API}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(size),
        "x-upload-content-type": "video/mp4",
      },
      body: JSON.stringify(body),
    },
  );
  const session = start.headers.get("location");
  if (!start.ok || !session)
    fail(`Could not start the upload: ${await apiError(start)}`);

  // 2. Send the file in chunks; retry a chunk on network or server errors.
  const file = readFileSync(video);
  let offset = 0;
  let uploaded: { id: string } | null = null;
  console.log(
    `Uploading ${path.basename(video)} (${(size / 1e6).toFixed(1)} MB) as "${meta.title}"...`,
  );
  while (!uploaded) {
    const end = Math.min(offset + CHUNK, size);
    let response: Response | null = null;
    for (let attempt = 1; attempt <= 5 && !response; attempt++) {
      try {
        const r = await fetch(session, {
          method: "PUT",
          headers: {
            "content-length": String(end - offset),
            "content-range": `bytes ${offset}-${end - 1}/${size}`,
          },
          body: file.subarray(offset, end),
        });
        if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
        response = r;
      } catch (error) {
        if (attempt === 5) fail(`Upload failed: ${String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      }
    }
    if (!response) fail("Upload failed.");
    if (response.status === 308) {
      // Resume Incomplete: continue after what the server has.
      const range = /bytes=0-(\d+)/.exec(response.headers.get("range") ?? "");
      offset = range ? Number(range[1]) + 1 : offset;
      process.stdout.write(`\r  ${Math.round((offset / size) * 100)}%`);
    } else if (response.ok) {
      uploaded = (await response.json()) as { id: string };
      process.stdout.write("\r  100%\n");
    } else {
      fail(`Upload failed: ${await apiError(response)}`);
    }
  }

  const url = `https://youtu.be/${uploaded.id}`;
  meta.result = {
    videoId: uploaded.id,
    url,
    uploadedAt: new Date().toISOString(),
    privacyStatus: meta.privacyStatus,
  };
  writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`Uploaded (${meta.privacyStatus}): ${url}`);
  console.log(`Studio: https://studio.youtube.com/video/${uploaded.id}/edit`);

  if (meta.thumbnailAt !== undefined)
    await setThumbnail(uploaded.id, video, meta.thumbnailAt, token);
}

/** A frame of the video as the custom thumbnail. A refusal is a warning, not a failure. */
async function setThumbnail(
  videoId: string,
  video: string,
  at: number,
  token: string,
) {
  const image = path.join(tmpdir(), `youtube-thumb-${videoId}.jpg`);
  try {
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-ss",
      String(at),
      "-i",
      video,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      image,
    ]);
    const response = await fetch(
      `${API}/upload/youtube/v3/thumbnails/set?videoId=${videoId}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "image/jpeg",
        },
        body: readFileSync(image),
      },
    );
    console.log(
      response.ok
        ? `Thumbnail set (frame at ${at} s).`
        : `Warning: thumbnail not set (${await apiError(response)}). Custom thumbnails need a channel allowed to use them (phone verification in YouTube Studio).`,
    );
  } catch (error) {
    console.log(`Warning: thumbnail not set: ${String(error)}`);
  } finally {
    rmSync(image, { force: true });
  }
}

// --- helpers -----------------------------------------------------------------

function readClient(): ClientSecret {
  if (!existsSync(CLIENT_FILE)) {
    fail(
      `No OAuth client file: ${path.relative(process.cwd(), CLIENT_FILE)}. ` +
        "Download the Desktop app client JSON from Google Cloud > APIs & Services > Credentials.",
    );
  }
  const data = JSON.parse(readFileSync(CLIENT_FILE, "utf-8")) as {
    installed?: ClientSecret;
    web?: unknown;
  };
  if (!data.installed) {
    fail(
      data.web
        ? 'This is a "Web application" client. Create an OAuth client of type "Desktop app" instead.'
        : "Not an OAuth client JSON from Google Cloud.",
    );
  }
  return data.installed;
}

async function accessToken(): Promise<string> {
  if (!existsSync(TOKEN_FILE))
    fail(`Not signed in yet: ${KIT_CMD} youtube auth`);
  const token = JSON.parse(readFileSync(TOKEN_FILE, "utf-8")) as Token;
  if (token.access_token && (token.expires_at ?? 0) > Date.now() + 60_000) {
    return token.access_token;
  }
  const client = readClient();
  const fresh = await tokenRequest(
    {
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    },
    // An expired or revoked refresh token: sign in again.
    `Sign-in expired or was revoked: ${KIT_CMD} youtube auth. (OAuth apps in Testing mode get tokens that expire after 7 days.)`,
  );
  saveToken({
    refresh_token: fresh.refresh_token ?? token.refresh_token,
    access_token: fresh.access_token,
    expires_at: Date.now() + fresh.expires_in * 1000,
  });
  return fresh.access_token;
}

async function tokenRequest(
  params: Record<string, string>,
  onInvalidGrant?: string,
): Promise<{
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !data.access_token) {
    if (data.error === "invalid_grant" && onInvalidGrant) fail(onInvalidGrant);
    fail(
      `Token request failed: ${data.error ?? response.status} ${data.error_description ?? ""}`,
    );
  }
  return {
    access_token: data.access_token,
    expires_in: data.expires_in ?? 3600,
    refresh_token: data.refresh_token,
  };
}

function saveToken(token: Token): void {
  mkdirSync(SECRETS_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, `${JSON.stringify(token, null, 2)}\n`, {
    mode: 0o600,
  });
}

function validate(meta: Metadata, file: string): void {
  const problems: Array<string> = [];
  if (!meta.title || meta.title.length > 100)
    problems.push("title: 1–100 characters");
  if (/[<>]/.test(meta.title)) problems.push("title: no < or >");
  if ((meta.description ?? "").length > 5000)
    problems.push("description: at most 5000 characters");
  if (/[<>]/.test(meta.description ?? ""))
    problems.push("description: no < or >");
  if ((meta.tags ?? []).join(",").length > 500)
    problems.push("tags: at most 500 characters in total");
  if (!["private", "unlisted", "public"].includes(meta.privacyStatus)) {
    problems.push("privacyStatus: private, unlisted or public");
  }
  if (typeof meta.madeForKids !== "boolean")
    problems.push("madeForKids: true or false");
  if (problems.length)
    fail(`${path.basename(file)}:\n  ${problems.join("\n  ")}`);
}

function findMetadata(prefix: string): string {
  const dir = path.join(PROJECT_DIR, "scenarios");
  const all = readdirSync(dir).filter((f) => f.endsWith(".youtube.json"));
  const matches = all.filter((f) => f.startsWith(prefix));
  if (matches.length !== 1) {
    fail(
      `"${prefix}" ${matches.length === 0 ? "has no" : "matches several"} scenarios/*.youtube.json` +
        (all.length
          ? `. Available: ${all.join(", ")}`
          : ". The runcast-publish skill writes one."),
    );
  }
  return path.join(dir, matches.join(""));
}

async function apiError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const data = JSON.parse(text) as {
      error?: { message?: string; errors?: Array<{ reason?: string }> };
    };
    const reason = data.error?.errors?.[0]?.reason;
    return `${response.status} ${reason ? `${reason}: ` : ""}${data.error?.message ?? text}`;
  } catch {
    return `${response.status} ${text.slice(0, 300)}`;
  }
}

function openBrowser(url: string): void {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer"
        : "xdg-open";
  try {
    spawn(opener, [url], { stdio: "ignore", detached: true })
      .on("error", () => undefined)
      .unref();
  } catch {
    // The URL is printed; the user can open it by hand.
  }
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
