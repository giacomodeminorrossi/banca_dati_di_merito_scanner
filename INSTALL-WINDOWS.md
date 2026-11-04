# Installing on Windows (reviewed commit `bb90888`)

These steps install exactly the reviewed code: commit
`bb90888695b1f035e67e1859b867dcadfa2192f4`, with dependencies taken from its lockfile.
Run every command in **PowerShell** (not as Administrator).

## 1. Prerequisites

| Tool | Version | Official download | Or with winget |
|---|---|---|---|
| Node.js | 22 or newer (current LTS recommended) | https://nodejs.org/en/download | `winget install OpenJS.NodeJS.LTS` |
| Git for Windows | any recent | https://git-scm.com/downloads/win | `winget install Git.Git` |
| Google Chrome **or** Microsoft Edge | current | https://www.google.com/chrome/ (Edge comes with Windows) | n/a |
| Claude Desktop and/or Claude Code | current | https://claude.ai/download, https://code.claude.com/docs | n/a |

You'll also need your SPID, CIE, CNS or eIDAS identity. Python and uv aren't needed.

Close and reopen PowerShell after installing, then check:

```powershell
node --version
```

```powershell
git --version
```

`node --version` must print `v22.x` or higher.

## 2. Download and build

```powershell
cd $env:USERPROFILE
```

```powershell
git clone https://github.com/giacomodeminorrossi/banca_dati_di_merito_scanner.git banca-dati-merito-mcp
```

If the repo is private, Git will ask you to sign in to GitHub. The last argument clones it
into the `banca-dati-merito-mcp` folder that every path below uses.

```powershell
cd banca-dati-merito-mcp
```

```powershell
git checkout --detach bb90888695b1f035e67e1859b867dcadfa2192f4
```

```powershell
git rev-parse HEAD
```

The last command must print `bb90888695b1f035e67e1859b867dcadfa2192f4`. Then install the locked
dependencies (no install scripts) and compile:

```powershell
npm ci --ignore-scripts --no-fund
```

```powershell
.\node_modules\.bin\tsc.cmd -p tsconfig.build.json
```

```powershell
node dist\cli.js --help
```

Don't use `npm run build`: it calls `rm -rf`, which doesn't exist on Windows.

## 3. Sign in once (optional but recommended)

```powershell
node dist\cli.js login
```

A Chrome or Edge window opens on BDP. Sign in as usual. Then check the session:

```powershell
node dist\cli.js stato
```

It should print `"stato": "valida"`. The session lasts about two hours. You can renew it later with
the same command, or by asking Claude to use the `accedi` tool.

## 4. Claude Desktop

Get the exact, JSON-escaped paths for your machine:

```powershell
(Get-Command node).Source.Replace('\', '\\')
```

```powershell
(Resolve-Path .\dist\cli.js).Path.Replace('\', '\\')
```

Open the config file from **Claude Desktop → Settings → Developer → Edit Config**. That opens the
right file even for the Microsoft Store build. Normally it's
`%APPDATA%\Claude\claude_desktop_config.json`. Add the `banca-dati-merito` entry inside
`mcpServers`, keeping any servers already there. Use the two paths printed above:

```json
{
  "mcpServers": {
    "banca-dati-merito": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\YOURNAME\\banca-dati-merito-mcp\\dist\\cli.js"],
      "env": {
        "BDM_DOWNLOAD_DIR": "C:\\Users\\YOURNAME\\Downloads\\banca-dati-merito"
      }
    }
  }
}
```

No `cmd /c` wrapper is needed, because this runs `node.exe` directly rather than `npx`. `env` is
optional; the value shown is the default. Fully quit Claude Desktop (tray icon → Quit) and reopen
it.

## 5. Claude Code

```powershell
claude mcp add --scope user banca-dati-merito -- node "$env:USERPROFILE\banca-dati-merito-mcp\dist\cli.js"
```

```powershell
claude mcp list
```

`banca-dati-merito` should show as connected. Inside a session, `/mcp` lists its 19 tools. Don't
use the upstream `/plugin marketplace add andreadorizza/...`: it runs `npx` against unpinned
dependencies.

## 6. Optional: the research skill

Claude Desktop: zip the folder, then upload it in **Settings → Capabilities → Skills**.

```powershell
Compress-Archive -Path .\skills\ricerca-banca-dati-merito -DestinationPath "$env:USERPROFILE\Desktop\ricerca-banca-dati-merito.zip"
```

Claude Code:

```powershell
Copy-Item -Recurse .\skills\ricerca-banca-dati-merito "$env:USERPROFILE\.claude\skills\ricerca-banca-dati-merito"
```

## 7. Check that it works

1. In a new chat, ask: *"Usa stato_sessione della Banca Dati di Merito."* You should get `valida`, or `assente` followed by an offer to call `accedi`.
2. Ask for a small search, for example: *"Cerca 3 provvedimenti del Tribunale di Bologna sull'usucapione."*
3. If the tools don't appear in Claude Desktop, read `%APPDATA%\Claude\logs\mcp-server-banca-dati-merito.log`.

Recommended hardening, from `SECURITY-REVIEW.md`: in Claude Desktop's tool menu, turn off
`cartelle_personali`, `leggi_cartella_personale` and `ricerche_salvate` if you don't want your BDP
notes sent to the AI. Keep approval on for `accedi` and `scarica_documento`. Run
`node dist\cli.js logout` when you finish working.

## 8. Uninstall

Run these from `$env:USERPROFILE\banca-dati-merito-mcp`:

```powershell
node dist\cli.js logout
```

```powershell
claude mcp remove banca-dati-merito --scope user
```

Remove the `banca-dati-merito` block from `claude_desktop_config.json` and restart Claude Desktop.
Then delete the code and any leftover data:

```powershell
cd $env:USERPROFILE
```

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\banca-dati-merito-mcp"
```

```powershell
Remove-Item -Recurse -Force "$env:APPDATA\banca-dati-merito-mcp" -ErrorAction SilentlyContinue
```

Downloaded PDFs stay in `Downloads\banca-dati-merito`. Delete that folder too if you don't need
them.
