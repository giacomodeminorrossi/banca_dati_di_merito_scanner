import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BrowserContext, Request } from "playwright-core";
import { z } from "zod";
import { API_PATH, BDP_ORIGIN, browserProfileDir, LOGIN_URL } from "../config.ts";
import { BdpError } from "../errors.ts";
import { saveSession, type Session, type StoredCookie } from "./store.ts";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_MS = 1500;
const BROWSER_CHANNELS = ["chrome", "msedge"] as const;
/** Headers the browser sends that BDP's session may be bound to. */
const REPLAYED_HINTS = ["sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"] as const;

const CurrentUserSchema = z.object({
  upn: z.string().nullish(),
  /** Unix seconds. */
  exp: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).nullish(),
});

type CurrentUser = z.infer<typeof CurrentUserSchema>;

export type LoginState =
  | { status: "inattivo" }
  | { status: "in_corso"; startedAt: string }
  | { status: "riuscito"; finishedAt: string; expiresAt: string | null }
  | { status: "fallito"; finishedAt: string; error: string };

let state: LoginState = { status: "inattivo" };
let running: Promise<Session> | null = null;

export const loginState = (): LoginState => state;

/** True while a login window is open; logout must wait, the profile is in use. */
export const loginInProgress = (): boolean => running !== null;

/**
 * Playwright's test-harness defaults that weaken a browser where people sign in
 * with SPID or CIE: a fixed key instead of the OS keychain for the profile's
 * cookies and passwords, and no phishing protection or security component updates.
 */
const UNSAFE_DEFAULT_ARGS = [
  "--use-mock-keychain",
  "--password-store=basic",
  "--disable-client-side-phishing-detection",
  "--disable-component-update",
];

/** Chrome must not offer to save the identity-provider password in this profile. */
const disablePasswordSaving = async (profile: string): Promise<void> => {
  const file = join(profile, "Default", "Preferences");
  let prefs: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) prefs = { ...parsed };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const profilePrefs = prefs.profile !== null && typeof prefs.profile === "object" ? prefs.profile : {};
  prefs.credentials_enable_service = false;
  prefs.profile = { ...profilePrefs, password_manager_enabled: false };
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(prefs), { mode: 0o600 });
};

const PROFILE_IN_USE = /ProcessSingleton|SingletonLock|already running|existing browser session/i;

const launch = async (): Promise<BrowserContext> => {
  const { chromium } = await import("playwright-core");
  const profile = browserProfileDir();
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await disablePasswordSaving(profile);
  const failures: string[] = [];
  for (const channel of BROWSER_CHANNELS) {
    try {
      // A dedicated persistent profile, separate from the user's own browsing.
      return await chromium.launchPersistentContext(profile, {
        channel,
        headless: false,
        viewport: null,
        ignoreDefaultArgs: UNSAFE_DEFAULT_ARGS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (PROFILE_IN_USE.test(message)) {
        throw new BdpError(
          "login_fallito",
          "Un'altra finestra di accesso è già aperta (forse da un'altra app che usa questo server). Completa l'accesso lì, oppure chiudila e riprova.",
          { cause: error },
        );
      }
      failures.push(`${channel}: ${message.split("\n")[0]}`);
    }
  }
  throw new BdpError(
    "login_fallito",
    `Non trovo Google Chrome né Microsoft Edge per aprire il login. Installane uno e riprova. (${failures.join("; ")})`,
  );
};

/** Errors that only mean "the page navigated while we asked": try again on the next poll. */
const NAVIGATION_RACE = /Execution context was destroyed|Cannot find context|navigat/i;

/**
 * Asks BDP who is signed in, from inside a BDP page. The request must come from
 * the browser: Node-side requests (`context.request`) fail on BDP's incomplete
 * certificate chain, which browsers repair on their own.
 */
const readCurrentUser = async (context: BrowserContext): Promise<CurrentUser | null> => {
  const page = context.pages().find((p) => p.url().startsWith(`${BDP_ORIGIN}/`));
  if (!page) return null;
  let body: unknown;
  try {
    body = await page.evaluate(async (url) => {
      const response = await fetch(url, { credentials: "include" });
      return response.ok ? response.json() : null;
    }, `${API_PATH}/user/current`);
  } catch (error) {
    if (error instanceof Error && NAVIGATION_RACE.test(error.message)) return null;
    throw error;
  }
  if (body === null) return null;
  const parsed = CurrentUserSchema.safeParse(body);
  if (!parsed.success) {
    throw new BdpError("login_fallito", `Risposta inattesa da user/current: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
};

const waitForSignIn = async (context: BrowserContext): Promise<CurrentUser> => {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (context.pages().length === 0) {
      throw new BdpError("login_fallito", "La finestra del login è stata chiusa prima di completare l'accesso.");
    }
    const user = await readCurrentUser(context);
    if (user?.upn) return user;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new BdpError("login_fallito", "Accesso non completato entro 5 minuti.");
};

/** Captures the exact headers the browser sends to BDP's API, after sign-in. */
const captureBrowserHeaders = async (
  context: BrowserContext,
): Promise<{ userAgent: string; clientHints: Record<string, string> }> => {
  const page = context.pages()[0] ?? (await context.newPage());
  // Awaited together: if the navigation fails, the pending wait must not be left
  // to reject unhandled when the context closes (that would kill the MCP server).
  const [apiRequest] = await Promise.all([
    context.waitForEvent("request", {
      predicate: (req: Request) => req.url().startsWith(`${BDP_ORIGIN}${API_PATH}/`),
      timeout: 30_000,
    }),
    page.goto(`${BDP_ORIGIN}/`, { waitUntil: "domcontentloaded" }),
  ]);
  const headers = await apiRequest.allHeaders();
  const userAgent = headers["user-agent"];
  if (!userAgent) throw new BdpError("login_fallito", "Il browser non ha inviato uno User-Agent.");
  const clientHints: Record<string, string> = {};
  for (const name of REPLAYED_HINTS) {
    const value = headers[name];
    if (value) clientHints[name] = value;
  }
  return { userAgent, clientHints };
};

const runLogin = async (): Promise<Session> => {
  const context = await launch();
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    // With a still-valid sign-in in the dedicated profile, the identity provider
    // sends the browser straight back without a new SPID/CIE step.
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    const user = await waitForSignIn(context);
    const { userAgent, clientHints } = await captureBrowserHeaders(context);
    const cookies: StoredCookie[] = (await context.cookies(`${BDP_ORIGIN}${API_PATH}/`)).map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
    }));
    const session: Session = {
      version: 1,
      capturedAt: new Date().toISOString(),
      expiresAt: user.exp ? new Date(user.exp * 1000).toISOString() : null,
      userAgent,
      clientHints,
      cookies,
    };
    await saveSession(session);
    return session;
  } finally {
    await context.close().catch(() => undefined);
  }
};

/** Starts a login in the background and returns at once; the MCP server polls `loginState`. */
export const startLogin = (): LoginState => {
  if (running) return state;
  state = { status: "in_corso", startedAt: new Date().toISOString() };
  running = runLogin();
  running
    .then((session) => {
      state = { status: "riuscito", finishedAt: new Date().toISOString(), expiresAt: session.expiresAt };
    })
    .catch((error: unknown) => {
      state = {
        status: "fallito",
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    })
    .finally(() => {
      running = null;
    });
  return state;
};

/** Blocking login for the CLI. */
export const login = async (): Promise<Session> => {
  startLogin();
  if (!running) throw new BdpError("login_fallito", "Login non avviato.");
  return running;
};
