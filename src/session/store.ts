import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { API_PATH, BDP_HOST, sessionFile } from "../config.ts";
import { BdpError } from "../errors.ts";

const StoredCookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  /** Unix seconds; -1 for a browser-session cookie. */
  expires: z.number(),
});

export type StoredCookie = z.infer<typeof StoredCookieSchema>;

const SessionSchema = z.object({
  version: z.literal(1),
  capturedAt: z.iso.datetime(),
  /** From BDP's `user/current` `exp`; null when BDP did not report one. */
  expiresAt: z.iso.datetime().nullable(),
  /**
   * BDP binds the session to the browser that logged in: the same cookies with a
   * different User-Agent get 401 on data endpoints. So we replay the exact headers
   * that browser sent.
   */
  userAgent: z.string().min(1),
  clientHints: z.record(z.string(), z.string()),
  cookies: z.array(StoredCookieSchema),
});

export type Session = z.infer<typeof SessionSchema>;

const invalidSessionFile = (cause: unknown): BdpError =>
  new BdpError("sessione_assente", `Il file di sessione ${sessionFile()} non è leggibile.`, { cause });

export const loadSession = async (): Promise<Session | null> => {
  let raw: string;
  try {
    raw = await readFile(sessionFile(), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw invalidSessionFile(error);
  }
  const parsed = SessionSchema.safeParse(json);
  if (!parsed.success) throw invalidSessionFile(parsed.error);
  return parsed.data;
};

/**
 * Written to a private temporary file and renamed into place, so a crash or a
 * second app saving at the same moment never leaves a truncated session file.
 */
export const saveSession = async (session: Session): Promise<void> => {
  const file = sessionFile();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    // `mode` is filtered by the umask; enforce it before the file becomes visible.
    // On Windows this is a no-op, and the per-user %APPDATA% ACL protects the file.
    await chmod(temp, 0o600);
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
};

const domainMatches = (cookieDomain: string, host: string): boolean => {
  const domain = cookieDomain.startsWith(".") ? cookieDomain.slice(1) : cookieDomain;
  return host === domain || host.endsWith(`.${domain}`);
};

/** RFC 6265 §5.1.4, for requests under the API path. */
const pathMatches = (cookiePath: string, requestPath: string): boolean =>
  requestPath === cookiePath ||
  requestPath.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);

/**
 * Cookies a browser would send to BDP's API. Selection is by rule, not by name,
 * so a cookie BDP adds or renames after a login still travels.
 * Names containing ":" come from the identity provider's pages and would break the header.
 */
export const cookieHeader = (session: Session, now = Date.now()): string =>
  session.cookies
    .filter(
      (cookie) =>
        domainMatches(cookie.domain, BDP_HOST) &&
        !cookie.name.includes(":") &&
        pathMatches(cookie.path, `${API_PATH}/`) &&
        (cookie.expires === -1 || cookie.expires * 1000 > now),
    )
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");

export const isExpired = (session: Session, now = Date.now()): boolean =>
  session.expiresAt !== null && Date.parse(session.expiresAt) <= now;
