# Security review: banca-dati-merito-mcp

This repository is a copy of
[andreadorizza/banca-dati-merito-mcp](https://github.com/andreadorizza/banca-dati-merito-mcp)
(Apache-2.0, © Andrea Dorizza). Commit `bb90888` is upstream, unmodified. The changes made
afterwards are listed under "Changes made after the review".

- **Reviewed commit:** `bb90888695b1f035e67e1859b867dcadfa2192f4` (upstream release v0.1.2; pin by this hash)
- **Review date:** 2026-11-04
- **Verdict:** safe with caveats

How the review was done: every file under `src/` was read line by line, along with
`package.json`, `package-lock.json`, `manifest.json`, `.claude-plugin/`, `.github/workflows/`,
`scripts/pack-mcpb.sh`, the README, the ADRs and the skill. The lockfile passed
`npm audit` with 0 vulnerabilities. The bundled TLS certificate was checked with `openssl`. The
published npm package 0.1.2 was downloaded and compared with the source. The repo's own tests
and build were **not** run, because the review sandbox doesn't allow running downloaded code.

## What it does

It's a local stdio MCP server with 19 tools for searching and reading the Banca Dati di Merito
(bdp.giustizia.it). You sign in with SPID/CIE/CNS/eIDAS in a real Chrome or Edge window.
The server saves the session cookies and replays them against BDP's own front-office API.
Every tool is read-only, except `scarica_documento`, which saves a PDF to disk.

## Findings

| # | Area | Finding | Where | Severity |
|---|---|---|---|---|
| 1 | Network | Only `bdp.giustizia.it` is contacted, on a hard-coded host (`config.ts:5-9`, `http.ts:92-101`). It receives only the cookies, the User-Agent and client hints captured at login, plus the query. No telemetry and no other services. | `src/config.ts:5`, `src/bdp/http.ts:64-101` | info |
| 2 | Network | A TLS fallback handles a missing intermediate certificate. It runs only on `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. It opens an unverified TLS connection to BDP that sends nothing, then fetches the issuer certificate over plain HTTP from the URL inside BDP's own certificate (normally `crt.sectigo.com`). The certificate is accepted only if a root already in Node's store signed it. This is the only possible non-BDP host. | `src/bdp/tls.ts:102-150`, `src/bdp/http.ts:142-150` | low |
| 3 | Credentials | No API keys. The BDP session (a JWT cookie, about 2 h) is stored **in plaintext** in `%APPDATA%\banca-dati-merito-mcp\sessione.json`. On Windows the `chmod` call does nothing, so the file is protected only by your user profile's ACL. Any program running as you can read it and act as you in BDP until it expires. It is never logged or sent anywhere except BDP. | `src/session/store.ts:62-75`, `src/session/login.ts:174-189` | medium |
| 4 | Credentials | The dedicated browser profile `%APPDATA%\banca-dati-merito-mcp\browser-profile` keeps BDP and identity-provider cookies. A still-valid identity-provider sign-in can skip the SPID/CIE step. It is removed only by `logout`. The good part: Playwright's unsafe defaults (mock keychain, basic password store, phishing protection off) are removed, and password saving is turned off. | `src/session/login.ts:39-79,169-171`, `src/cli.ts:38-44` | low |
| 5 | Files | Reads and writes only `%APPDATA%\banca-dati-merito-mcp\` and the PDF folder (default `%USERPROFILE%\Downloads\banca-dati-merito`, from `BDM_DOWNLOAD_DIR`). The model can't pick the folder. It picks only a file name, which is sanitized: no separators, no leading dots, Windows reserved names handled, 120-character limit. Files are never overwritten (`wx`). | `src/config.ts:53-77`, `src/tools/read.ts:34-62,241` | info |
| 6 | Exec | There's no `child_process`, `exec`, `eval` or `new Function` anywhere. The only `page.evaluate` fetches a constant URL. The one dynamic import is a fixed module. Ids from the model are URL-encoded, and Lucene query values are quoted and escaped. Input is validated with zod and length limits. | `src/session/login.ts:111-114`, `src/bdp/client.ts:158,187,197`, `src/bdp/query.ts:61-63` | none found |
| 7 | Prompt injection | Rulings, abstracts, metadata and your BDP personal notes and folders reach the model unfiltered, as JSON text. The source is a government database of court decisions plus notes you wrote, so the risk is low. Even if injected text did get through, the tools can't send data off the machine, run commands or write outside the PDF folder. | `src/tools/result.ts:6-8`, `src/tools/read.ts:101-107`, `src/tools/personal.ts` | low |
| 8 | Privacy | Your personal folders, saved searches and notes go to your AI provider if the model calls `cartelle_personali`, `leggi_cartella_personale`, `ricerche_salvate` or `includi_cartelle`. Comments by note authors can include their names. | `src/tools/personal.ts`, `src/bdp/graphql.ts:91-98` | low |
| 9 | Install | No `preinstall`, `install` or `postinstall` scripts. `prepack` runs only when publishing. None of the 99 locked packages has an install script, and all of them resolve from `registry.npmjs.org`. `playwright-core` doesn't download browsers. It uses your installed Chrome or Edge. | `package.json:31-38`, `package-lock.json` | none found |
| 10 | Supply chain | GitHub Actions are pinned by SHA. npm publishing uses trusted publishing with SLSA provenance. The npm `banca-dati-merito-mcp@0.1.2` has `gitHead` = the reviewed commit, and its `dist/` matches the source. **But** the npm package ships without a lockfile, so `npx banca-dati-merito-mcp@0.1.2` resolves the newest `^` dependency versions, which weren't reviewed. Build from this repo with `npm ci` instead. | `.github/workflows/release.yml`, `package.json:42-46` | low |
| 11 | Obfuscation | The only encoded blob is a PEM certificate. It's the real Sectigo-issued "Telecom Italia Trust Technologies RSA OV SSL CA 2" intermediate, SHA-256 `E8:02:61:13:...:FA:BE`, CA:TRUE pathlen 0, valid 2025-11-06 to 2035-11-05, and `openssl verify` passes against the system roots. No minified code. Test fixtures are sanitized JSON. | `src/bdp/tls.ts:18-54` | none found |
| 12 | Maturity | 11 commits, all on 2026-10-29, by one author (`dori <andreadorizza@gmail.com>`, same as the npm maintainer). Very new, with no track record. It's an unofficial client for a government API, used under your own identity. | `git log` | caveat |
| 13 | Windows | `npm run build` uses `rm -rf`, which doesn't exist in `cmd.exe`, so it fails on Windows. Run `npx tsc -p tsconfig.build.json` instead. | `package.json:34` | functional |

## Dependencies (from the lockfile)

| Package | Version | Notes |
|---|---|---|
| `@modelcontextprotocol/sdk` | 1.32.2 | Official MCP SDK |
| `playwright-core` | 1.64.1 | Microsoft; no browser download |
| `zod` | 4.6.7 | Widely used validation library |
| `typescript` (dev) | 5.9.3 | Microsoft |
| `@types/node` (dev) | 22.20.5 | DefinitelyTyped |

`npm audit --package-lock-only`: **0 vulnerabilities**. No typosquats or unknown packages
among the direct dependencies.

## Recommended restrictions

1. Install from this repo at the pinned commit with `npm ci`, not with `npx` or the upstream plugin marketplace.
2. In Claude Desktop, turn off the personal-area tools (`cartelle_personali`, `leggi_cartella_personale`, `ricerche_salvate`) if you don't want your notes sent to the AI provider.
3. Keep tool approval on ("ask") for `accedi` and `scarica_documento`.
4. Run `node dist\cli.js logout` when you finish a work session. It deletes the session file and the browser profile.
5. Don't point `BDM_HOME` or `BDM_DOWNLOAD_DIR` at a synced folder (OneDrive, Dropbox). The session file would leave your machine.
6. Don't pull upstream changes without reviewing the diff first.

## Changes made after the review (branch `miglioramenti`)

The changes are on top of `bb90888`. Each one has tests: `npm run check` passes 61 tests, up from 51.

| Change | Addresses | Files |
|---|---|---|
| `BDM_PERSONAL_AREA=off` (Claude Desktop: "Area personale") hides the 3 personal-area tools, the `note_personali` / `solo_cartelle_personali` / `includi_cartelle` parameters, and the note fields in `leggi_provvedimento` / `leggi_abstract`. On by default, as upstream. | Finding 8 | `src/config.ts`, `src/server.ts`, `src/tools/search.ts`, `src/tools/read.ts`, `manifest.json` |
| New `esci` tool. It deletes the session file and the browser profile, and refuses while a login window is open, including one opened by another app running this server (it checks Chromium's profile lock). The CLI `logout` uses the same code. | Findings 3–4 | `src/session/logout.ts`, `src/tools/session.ts`, `src/cli.ts` |
| A data folder inside OneDrive, Dropbox, Google Drive or iCloud is refused, so the session file can't be synced off the machine. The check covers both an explicit `BDM_HOME` and the default folder (`XDG_CONFIG_HOME`, `APPDATA`, `~/Library/Application Support`). Google Drive for desktop is recognised by the folders it creates (`My Drive`, `Il mio Drive`, `Shared drives`, `Drive condivisi`), so its `G:` drive and mirror folders are refused too. Symlinks and Windows junctions are followed before the check. | Finding 3 | `src/config.ts` |
| The server instructions say that texts, abstracts and notes are data, not instructions. | Finding 7 | `src/server.ts` |
| `npm run build` no longer uses `rm -rf`, so it works on Windows. | Finding 13 | `package.json` |
| `note_personali` search text is capped at 200 characters. | Input limits | `src/tools/search.ts` |

Not changed: the session file is still plaintext. Node has no built-in Windows DPAPI, and the
other programs that could read it run as you anyway. Logging out after each session (`esci`) is
the mitigation.

## Alternative considered and rejected: slimmanolesta/mcp-bdm @ 1a0be71

- The model can write `.md` files to any folder (`server.py:36-58,193-205`). The only limit is a root folder that the model can change itself with `bdm_set_workflow` (`server.py:231-256`).
- The document id isn't URL-encoded (`endpoints.py:298-300`), so a crafted id can reach other paths on the same API with your session.
- Which host your session cookie goes to is set by `config.json`, or by the `BDM_API_BASE` environment variable (`config.py:263-286`).
- Dependencies aren't pinned (`>=`) and there's no lockfile. Setup upgrades pip and downloads Playwright Chromium (`setup_manolesta.py:96-100`), so the installed code can't be pinned.
- No rate limiting, Playwright's unsafe defaults are left in place (`auth.py:59-70`), it's Windows-only, and its author calls it "a reference, not plug-and-play".
