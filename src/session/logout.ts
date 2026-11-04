import { readFile, readlink, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { storedPaths } from "../config.ts";
import { BdpError } from "../errors.ts";
import { loginInProgress } from "./login.ts";

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
export const profileInUse = async (profile = storedPaths().profile): Promise<boolean> => {
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
  if (host !== hostname()) return true;
  return holdsProfile(Number(pid), profile);
};

/**
 * Whether `pid` is a browser using `profile`. After a crash and a reboot the
 * lock's PID can belong to an unrelated process; where `/proc` shows the command
 * line (Linux), the lock counts only if that process opened this profile, as
 * Chromium itself checks. Elsewhere any live process counts.
 */
const holdsProfile = async (pid: number, profile: string): Promise<boolean> => {
  if (!isAlive(pid)) return false;
  let cmdline: string;
  try {
    cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return true;
  }
  const flag = "--user-data-dir=";
  return cmdline.split("\0").some((arg) => arg.startsWith(flag) && resolve(arg.slice(flag.length)) === resolve(profile));
};

const LOGIN_OPEN =
  "È aperta una finestra di accesso alla Banca Dati (forse da un'altra app che usa questo server): completa l'accesso o chiudi la finestra, poi riprova a uscire.";

/**
 * Deletes the session file and the dedicated browser profile, even from a
 * folder the synced-folder check now refuses. The profile holds
 * BDP and identity-provider cookies too: keeping it would let the next login
 * skip authentication. Refuses while a login window is open, in this process or
 * another, because that login would save a new session right after.
 */
export const logout = async (): Promise<void> => {
  // Unchecked paths: credentials already stored in a synced folder must still be removable.
  const { session, profile } = storedPaths();
  if (loginInProgress() || (await profileInUse(profile))) throw new BdpError("parametri", LOGIN_OPEN);
  await rm(session, { force: true });
  await rm(profile, { recursive: true, force: true });
};
