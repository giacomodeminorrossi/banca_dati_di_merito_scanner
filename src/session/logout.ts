import { readlink, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { browserProfileDir } from "../config.ts";
import { BdpError } from "../errors.ts";
import { loginInProgress } from "./login.ts";
import { clearSession } from "./store.ts";

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return errorCode(error) === "EPERM";
  }
};

/**
 * Whether a browser (from any process, e.g. another app running this server)
 * has the dedicated profile open. Chromium marks it with `SingletonLock`, a
 * symlink to "<host>-<pid>", on macOS and Linux, and with a `lockfile` it keeps
 * open, so it cannot be deleted, on Windows. A lock left by a crash is ignored.
 */
export const profileInUse = async (profile = browserProfileDir()): Promise<boolean> => {
  if (process.platform === "win32") {
    try {
      await rm(join(profile, "lockfile"), { force: true });
      return false;
    } catch (error) {
      const code = errorCode(error);
      if (code === "EBUSY" || code === "EPERM" || code === "EACCES") return true;
      throw error;
    }
  }
  let target: string;
  try {
    target = await readlink(join(profile, "SingletonLock"));
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "EINVAL") return false;
    throw error;
  }
  const match = /^(.*)-(\d+)$/.exec(target);
  if (!match) return true;
  const [, host, pid] = match;
  // Another machine's lock (a profile on a shared drive) cannot be checked: assume it is live.
  return host !== hostname() || isAlive(Number(pid));
};

const LOGIN_OPEN =
  "È aperta una finestra di accesso alla Banca Dati (forse da un'altra app che usa questo server): completa l'accesso o chiudi la finestra, poi riprova a uscire.";

/**
 * Deletes the session file and the dedicated browser profile. The profile holds
 * BDP and identity-provider cookies too: keeping it would let the next login
 * skip authentication. Refuses while a login window is open, in this process or
 * another, because that login would save a new session right after.
 */
export const logout = async (): Promise<void> => {
  if (loginInProgress() || (await profileInUse())) throw new BdpError("parametri", LOGIN_OPEN);
  await clearSession();
  await rm(browserProfileDir(), { recursive: true, force: true });
};
