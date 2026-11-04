import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BdpError } from "./errors.ts";

export const BDP_HOST = "bdp.giustizia.it";
export const BDP_ORIGIN = `https://${BDP_HOST}`;
export const API_PATH = "/api/bdm/frontoffice";
/** Entry point of BDP's own login: redirects to the Ministry's identity provider (SPID, CIE, CNS, eIDAS). */
export const LOGIN_URL = `${BDP_ORIGIN}${API_PATH}/azure`;

/**
 * Searches return results only in CIVILE today, although BDP's statistics already
 * count some PENALE decisions; hence a parameter with this default.
 */
export const DEFAULT_AREA = "CIVILE";

export const DEFAULT_RESULTS = 20;
export const MAX_RESULTS = 50;
/** BDP pages at most the first 10,000 hits of a search (an Elasticsearch result window). */
export const RESULT_WINDOW = 10_000;

const DEFAULT_MIN_INTERVAL_MS = 1000;
const FLOOR_MIN_INTERVAL_MS = 250;

const APP_NAME = "banca-dati-merito-mcp";

/**
 * An environment value as clients actually pass it. Claude Desktop forwards an
 * empty or unresolved `${user_config.x}` literally and does not expand `${HOME}`
 * in defaults, so those placeholders are resolved (or treated as unset) here.
 */
const envValue = (name: string): string | undefined => {
  const raw = process.env[name]?.trim();
  if (!raw || /\$\{user_config\.[^}]*\}/.test(raw)) return undefined;
  return raw
    .replace(/^~(?=$|[/\\])/, homedir())
    .replace(/\$\{HOME\}|\$HOME\b/g, homedir())
    .replace(/\$\{(DOCUMENTS|DESKTOP)\}/g, (_, dir: string) => join(homedir(), dir === "DOCUMENTS" ? "Documents" : "Desktop"));
};

/** Milliseconds between the start of two BDP requests. Configurable, never below the floor. */
export const minIntervalMs = (): number => {
  const raw = envValue("BDM_MIN_INTERVAL_MS");
  if (raw === undefined) return DEFAULT_MIN_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`BDM_MIN_INTERVAL_MS non è un numero: ${raw}`);
  }
  return Math.max(FLOOR_MIN_INTERVAL_MS, parsed);
};

const OFF = new Set(["off", "false", "0", "no"]);
const ON = new Set(["on", "true", "1", "yes", "si", "sì"]);

/**
 * Whether the tools and fields that expose the user's personal area (folders,
 * saved searches, personal notes) are offered to the model. On by default;
 * `BDM_PERSONAL_AREA=off` keeps that data away from the AI provider.
 */
export const personalAreaEnabled = (): boolean => {
  const raw = envValue("BDM_PERSONAL_AREA")?.toLowerCase();
  if (raw === undefined || ON.has(raw)) return true;
  if (OFF.has(raw)) return false;
  throw new Error(`BDM_PERSONAL_AREA deve essere "on" oppure "off": ${raw}`);
};

/**
 * The real location of `path`, following symlinks and Windows junctions: the
 * nearest existing ancestor is resolved by the filesystem and the missing tail
 * is appended. Without this, a link pointing into a synced folder would pass.
 */
const canonical = (path: string): string => {
  let existing = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(existing), ...tail);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return resolve(path);
      tail.unshift(basename(existing));
      existing = parent;
    }
  }
};

/** True when `path` is `folder` or below it (on Windows `relative` ignores case). */
const isInside = (path: string, folder: string): boolean => {
  const rel = relative(folder, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Folders whose content a sync client copies to someone else's servers. */
const syncedFolders = (): string[] => {
  const home = homedir();
  const fromEnv = ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"]
    .map((name) => process.env[name]?.trim())
    .filter((value): value is string => Boolean(value));
  return [
    ...fromEnv,
    join(home, "OneDrive"),
    join(home, "Dropbox"),
    join(home, "Google Drive"),
    join(home, "iCloudDrive"),
    join(home, "Library", "CloudStorage"),
    join(home, "Library", "Mobile Documents"),
  ];
};

/** The synced folder that contains `path`, if any. */
export const syncedFolderOf = (path: string): string | undefined => {
  const real = canonical(path);
  return syncedFolders().find((folder) => isInside(real, canonical(folder)));
};

/** The platform's per-user data folder, used when `BDM_HOME` is unset. */
const defaultAppDir = (): string => {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", APP_NAME);
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), APP_NAME);
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), APP_NAME);
  }
};

/**
 * Per-user folder for the session file and the dedicated browser profile.
 * Both an explicit `BDM_HOME` and the computed default are checked: the default
 * can land in a synced folder too (`XDG_CONFIG_HOME`, `APPDATA`, a symlinked `~/.config`).
 */
export const appDir = (): string => {
  const override = envValue("BDM_HOME");
  const dir = override ?? defaultAppDir();
  // The session file is a live login: in a synced folder it would leave the computer.
  const synced = syncedFolderOf(dir);
  if (synced) {
    const what = override ? `BDM_HOME (${dir})` : `La cartella dati predefinita (${dir})`;
    const fix = override ? "Scegli una cartella locale." : "Imposta BDM_HOME su una cartella locale.";
    throw new BdpError(
      "parametri",
      `${what} è dentro una cartella sincronizzata (${synced}): la sessione uscirebbe dal computer. ${fix}`,
    );
  }
  return dir;
};

export const sessionFile = (): string => join(appDir(), "sessione.json");
export const browserProfileDir = (): string => join(appDir(), "browser-profile");

export const downloadDir = (): string => {
  const configured = envValue("BDM_DOWNLOAD_DIR");
  if (configured === undefined) return join(homedir(), "Downloads", "banca-dati-merito");
  // A relative path would land wherever the client started the server (often "/").
  if (!isAbsolute(configured)) {
    throw new BdpError("parametri", `La cartella per i PDF deve essere un percorso assoluto: ${configured}`);
  }
  return configured;
};
