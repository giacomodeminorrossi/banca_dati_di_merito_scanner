import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { z } from "zod";
import { request } from "../src/bdp/http.ts";
import { appDir, browserProfileDir, downloadDir, minIntervalMs, personalAreaEnabled, sessionFile } from "../src/config.ts";
import { BdpError } from "../src/errors.ts";
import { logout, profileInUse } from "../src/session/logout.ts";
import { loadSession, saveSession, type Session } from "../src/session/store.ts";
import { safeFileName } from "../src/tools/read.ts";

const SESSION: Session = {
  version: 1,
  capturedAt: "2026-10-29T06:00:00.000Z",
  expiresAt: "2026-10-29T08:00:00.000Z",
  userAgent: "Mozilla/5.0 test",
  clientHints: {},
  cookies: [],
};

const isCode = (code: BdpError["code"]) => (error: unknown): boolean => error instanceof BdpError && error.code === code;

describe("session file", () => {
  before(async () => {
    process.env.BDM_HOME = await mkdtemp(join(tmpdir(), "bdm-local-"));
  });

  it("round-trips and is readable only by the user", async () => {
    await saveSession(SESSION);
    assert.deepEqual(await loadSession(), SESSION);
    if (process.platform !== "win32") assert.equal((await stat(sessionFile())).mode & 0o777, 0o600);
  });

  it("treats a corrupt file as no session, so the model gets the login hint", async () => {
    await writeFile(sessionFile(), "{ truncated");
    await assert.rejects(loadSession(), isCode("sessione_assente"));
  });
});

describe("request", () => {
  it("never sends a request the client already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      request(SESSION, { method: "GET", path: "materia" }, { signal: controller.signal }),
      isCode("annullata"),
    );
  });
});

describe("safeFileName", () => {
  it("keeps names inside the download folder and valid on every OS", () => {
    assert.equal(safeFileName("../../etc/passwd"), "etcpasswd");
    assert.equal(safeFileName("Trib. Bologna 2571/2025"), "Trib._Bologna_25712025");
    assert.equal(safeFileName("NUL"), "documento_NUL");
    assert.equal(safeFileName("///"), "documento");
  });
});

describe("release metadata", () => {
  const version = async (path: string): Promise<string> =>
    z.object({ version: z.string() }).parse(JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"))).version;

  it("uses one version in package.json, the MCPB manifest, the plugin and the README", async () => {
    const pkg = await version("../package.json");
    assert.equal(await version("../manifest.json"), pkg);
    assert.equal(await version("../.claude-plugin/plugin.json"), pkg);
    const plugin = await readFile(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8");
    assert.ok(plugin.includes(`banca-dati-merito-mcp@${pkg}`), "plugin.json must pin the npm version");
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    for (const match of readme.matchAll(/banca-dati-merito-mcp@([\d.]+)/g)) assert.equal(match[1], pkg);
  });
});

describe("configuration from clients", () => {
  const withEnv = <T>(name: string, value: string, read: () => T): T => {
    const previous = process.env[name];
    process.env[name] = value;
    try {
      return read();
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  };

  it("expands the ${HOME} that Claude Desktop passes through unexpanded", () => {
    assert.equal(
      withEnv("BDM_DOWNLOAD_DIR", "${HOME}/Downloads/banca-dati-merito", downloadDir),
      join(homedir(), "Downloads", "banca-dati-merito"),
    );
    assert.equal(withEnv("BDM_DOWNLOAD_DIR", "~/PDF", downloadDir), join(homedir(), "PDF"));
  });

  it("treats an unresolved user_config placeholder or a blank value as unset", () => {
    const fallback = join(homedir(), "Downloads", "banca-dati-merito");
    assert.equal(withEnv("BDM_DOWNLOAD_DIR", "${user_config.download_dir}", downloadDir), fallback);
    assert.equal(withEnv("BDM_DOWNLOAD_DIR", "  ", downloadDir), fallback);
    assert.equal(withEnv("BDM_MIN_INTERVAL_MS", "${user_config.min_interval_ms}", minIntervalMs), 1000);
  });

  it("rejects a relative download folder instead of writing under the client's working directory", () => {
    assert.throws(() => withEnv("BDM_DOWNLOAD_DIR", "Downloads/pdf", downloadDir), isCode("parametri"));
  });

  it("reads the personal-area switch as Claude Desktop passes it", () => {
    assert.equal(withEnv("BDM_PERSONAL_AREA", "${user_config.personal_area}", personalAreaEnabled), true);
    assert.equal(withEnv("BDM_PERSONAL_AREA", "true", personalAreaEnabled), true);
    assert.equal(withEnv("BDM_PERSONAL_AREA", "false", personalAreaEnabled), false);
    assert.equal(withEnv("BDM_PERSONAL_AREA", "OFF", personalAreaEnabled), false);
    assert.throws(() => withEnv("BDM_PERSONAL_AREA", "forse", personalAreaEnabled));
  });

  it("refuses to keep the session in a cloud-synced folder", async () => {
    const synced = await mkdtemp(join(tmpdir(), "bdm-onedrive-"));
    const previousHome = process.env.BDM_HOME;
    try {
      withEnv("OneDrive", synced, () => {
        process.env.BDM_HOME = join(synced, "bdm");
        assert.throws(() => appDir(), isCode("parametri"));
        process.env.BDM_HOME = `${synced}-altro`;
        assert.equal(appDir(), `${synced}-altro`);
      });
    } finally {
      if (previousHome === undefined) delete process.env.BDM_HOME;
      else process.env.BDM_HOME = previousHome;
    }
  });

  it("follows symlinks before deciding a folder is not synced", { skip: process.platform === "win32" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "bdm-link-"));
    const synced = join(root, "Dropbox");
    await mkdir(synced);
    await symlink(synced, join(root, "local-data"));
    const previousHome = process.env.BDM_HOME;
    try {
      withEnv("OneDrive", synced, () => {
        process.env.BDM_HOME = join(root, "local-data", "bdm");
        assert.throws(() => appDir(), isCode("parametri"));
      });
    } finally {
      if (previousHome === undefined) delete process.env.BDM_HOME;
      else process.env.BDM_HOME = previousHome;
    }
  });
  it("recognises Google Drive for desktop wherever it is mounted", async () => {
    const root = await mkdtemp(join(tmpdir(), "bdm-gdrive-"));
    const previousHome = process.env.BDM_HOME;
    try {
      for (const folder of ["My Drive", "il mio drive", "Shared drives"]) {
        process.env.BDM_HOME = join(root, "G", folder, "bdm");
        assert.throws(() => appDir(), isCode("parametri"));
      }
      process.env.BDM_HOME = join(root, "My Drivers", "bdm");
      assert.equal(appDir(), join(root, "My Drivers", "bdm"));
    } finally {
      if (previousHome === undefined) delete process.env.BDM_HOME;
      else process.env.BDM_HOME = previousHome;
    }
  });

  it("recognises a Dropbox folder moved elsewhere, from Dropbox's info.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "bdm-moved-dropbox-"));
    const moved = join(root, "D", "Dropbox (Studio)");
    await mkdir(join(root, "appdata", "Dropbox"), { recursive: true });
    await writeFile(join(root, "appdata", "Dropbox", "info.json"), JSON.stringify({ business: { path: moved } }));
    const previousHome = process.env.BDM_HOME;
    try {
      withEnv("APPDATA", join(root, "appdata"), () => {
        process.env.BDM_HOME = join(moved, "bdm");
        assert.throws(() => appDir(), isCode("parametri"));
        process.env.BDM_HOME = join(root, "D", "locale");
        assert.equal(appDir(), join(root, "D", "locale"));
      });
    } finally {
      if (previousHome === undefined) delete process.env.BDM_HOME;
      else process.env.BDM_HOME = previousHome;
    }
  });

  it("checks the default folder too when BDM_HOME is unset", { skip: process.platform !== "linux" }, async () => {
    const synced = await mkdtemp(join(tmpdir(), "bdm-dropbox-"));
    const previousHome = process.env.BDM_HOME;
    delete process.env.BDM_HOME;
    try {
      withEnv("OneDrive", synced, () => {
        withEnv("XDG_CONFIG_HOME", join(synced, "config"), () => {
          assert.throws(() => appDir(), isCode("parametri"));
        });
        withEnv("XDG_CONFIG_HOME", `${synced}-altro`, () => {
          assert.equal(appDir(), join(`${synced}-altro`, "banca-dati-merito-mcp"));
        });
      });
    } finally {
      if (previousHome !== undefined) process.env.BDM_HOME = previousHome;
    }
  });
});

describe("logout", { skip: process.platform === "win32" }, () => {
  before(async () => {
    process.env.BDM_HOME = await mkdtemp(join(tmpdir(), "bdm-logout-"));
  });

  /** A long-lived process started the way Playwright starts the browser on `profile`. */
  const fakeBrowser = async (profile: string): Promise<ChildProcess> => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", `--user-data-dir=${profile}`], { stdio: "ignore" });
    child.unref();
    await once(child, "spawn");
    return child;
  };

  const lockProfile = async (pid: number): Promise<void> => {
    await mkdir(browserProfileDir(), { recursive: true });
    await symlink(`${hostname()}-${pid}`, join(browserProfileDir(), "SingletonLock"));
  };

  it("sees a browser that another process has open on the profile", async () => {
    const profile = await mkdtemp(join(tmpdir(), "bdm-profile-"));
    assert.equal(await profileInUse(profile), false);
    const browser = await fakeBrowser(profile);
    try {
      await symlink(`${hostname()}-${browser.pid}`, join(profile, "SingletonLock"));
      assert.equal(await profileInUse(profile), true);
    } finally {
      browser.kill();
    }
  });

  it("ignores a stale lock whose PID now belongs to another program", { skip: process.platform !== "linux" }, async () => {
    const profile = await mkdtemp(join(tmpdir(), "bdm-profile-"));
    // This test process is alive but is not a browser using the profile.
    await symlink(`${hostname()}-${process.pid}`, join(profile, "SingletonLock"));
    assert.equal(await profileInUse(profile), false);
  });

  it("ignores the lock a crashed browser left behind", async () => {
    const profile = await mkdtemp(join(tmpdir(), "bdm-profile-"));
    await symlink(`${hostname()}-2147483646`, join(profile, "SingletonLock"));
    assert.equal(await profileInUse(profile), false);
  });

  it("still deletes a session already stored in a folder that is now refused", async () => {
    const synced = await mkdtemp(join(tmpdir(), "bdm-onedrive-"));
    const previous = { home: process.env.BDM_HOME, onedrive: process.env.OneDrive };
    try {
      process.env.OneDrive = synced;
      process.env.BDM_HOME = join(synced, "bdm");
      await mkdir(join(synced, "bdm", "browser-profile"), { recursive: true });
      await writeFile(join(synced, "bdm", "sessione.json"), "{}");
      assert.throws(() => sessionFile(), isCode("parametri"));
      await logout();
      await assert.rejects(access(join(synced, "bdm", "sessione.json")));
      await assert.rejects(access(join(synced, "bdm", "browser-profile")));
    } finally {
      process.env.BDM_HOME = previous.home;
      if (previous.onedrive === undefined) delete process.env.OneDrive;
      else process.env.OneDrive = previous.onedrive;
    }
  });

  it("refuses to log out while a login window is open, and keeps the session", async () => {
    await saveSession(SESSION);
    const browser = await fakeBrowser(browserProfileDir());
    try {
      await lockProfile(browser.pid ?? 0);
      await assert.rejects(logout(), isCode("parametri"));
      await access(sessionFile());
    } finally {
      browser.kill();
    }
  });
});
