# banca-dati-merito-mcp

Server [MCP](https://modelcontextprotocol.io) per consultare la
[Banca Dati di Merito](https://bdp.giustizia.it) del Ministero della Giustizia da un
assistente AI (Claude, Cursor, Windsurf e altri client MCP): cerca, legge e aiuta a
citare i provvedimenti civili di tribunali e corti d'appello e i relativi abstract,
usando **la tua** sessione SPID, CIE, CNS o eIDAS.

> **Progetto non ufficiale.** Non è affiliato al Ministero della Giustizia né
> approvato da esso. Usa le stesse API che il sito della Banca Dati usa nel tuo
> browser, con il tuo accesso personale.

## Cosa fa

| Strumento | A cosa serve |
|---|---|
| `stato_sessione`, `accedi`, `esci` | Controlla la sessione; apre il browser per l'accesso; cancella sessione e profilo del browser |
| `risolvi_criteri` | Trasforma "tribunale di Bologna" nel criterio esatto `ufficio: TRIBUNALE DI BOLOGNA` |
| `cerca_provvedimenti` | Sentenze, ordinanze e decreti per testo (tutte le parole, almeno una, frase esatta), criteri e date |
| `cerca_abstract` | Gli abstract, cioè le sintesi dei principi affermati |
| `leggi_provvedimento` | Metadati completi, esito, abstract collegati, gradi di giudizio, note personali |
| `leggi_testo_provvedimento` | Testo integrale pseudonimizzato, a blocchi |
| `leggi_abstract` | Abstract completo con precedenti conformi e difformi |
| `timeline_provvedimento` | La sequenza dei gradi di giudizio |
| `scarica_documento` | Salva il PDF in una cartella del tuo computer |
| `elenca_valori`, `elenca_uffici`, `cerca_valori` | Materie, ruoli, uffici per distretto, giudici, parole chiave, riferimenti normativi |
| `frequenze_parole_chiave`, `pubblicazioni`, `archivio` | Statistiche e navigazione dell'archivio |
| `cartelle_personali`, `leggi_cartella_personale`, `ricerche_salvate` | La tua area personale, in sola lettura |

Il server è **in sola lettura**: non crea, modifica né cancella nulla nella Banca
Dati. Include anche una skill che insegna all'assistente il metodo di ricerca e di
citazione ([`skills/ricerca-banca-dati-merito`](skills/ricerca-banca-dati-merito/SKILL.md)).

## Requisiti

- Un'identità digitale con cui accedi alla Banca Dati: SPID, CIE, CNS o eIDAS.
- Google Chrome o Microsoft Edge, per la finestra di accesso.
- Node.js 22 o successivo, solo per Claude Code e gli altri client (Claude Desktop ha
  già il suo).

## Dove funziona

Il server gira **sul tuo computer**, perché la sessione con la Banca Dati non deve
uscirne ([ADR 0001](docs/adr/0001-sessione-solo-locale.md)). Per questo funziona solo nei
client che avviano programmi locali:

| Funziona | Non funziona |
|---|---|
| App desktop di Claude (estensione `.mcpb`) | claude.ai dal browser, app di Claude per smartphone |
| Claude Code (plugin) | ChatGPT (browser, smartphone e chat dell'app desktop) |
| Cursor, Windsurf, Zed, Codex e altri client MCP locali | |

Nei client che accettano solo server remoti l'unico modo sarebbe esporre il server su
internet, e con lui la tua sessione: non farlo.

## Installazione

### Claude Desktop

Scarica il file `banca-dati-merito-mcp-<versione>.mcpb` dalle
[release](https://github.com/andreadorizza/banca-dati-merito-mcp/releases) e aprilo:
Claude Desktop lo installa come estensione. Nelle impostazioni dell'estensione puoi
scegliere la cartella per i PDF.

### Claude Code

```
/plugin marketplace add andreadorizza/banca-dati-merito-mcp
/plugin install banca-dati-merito@banca-dati-merito
```

Il plugin installa sia il server sia la skill di ricerca.

### Altri client MCP

Aggiungi il server alla configurazione del client (Cursor, Windsurf, Zed, ecc.):

```json
{
  "mcpServers": {
    "banca-dati-merito": {
      "command": "npx",
      "args": ["-y", "banca-dati-merito-mcp@0.1.2"]
    }
  }
}
```

Per Codex di OpenAI:

```
codex mcp add banca-dati-merito -- npx -y banca-dati-merito-mcp@0.1.2
```

La skill di ricerca è specifica di Claude; negli altri client restano gli strumenti e le
regole che il server stesso invia al modello.

## Accesso

Chiedi all'assistente di accedere alla Banca Dati: lo strumento `accedi` apre una
finestra di Chrome o Edge sulla pagina di accesso del Ministero, dove entri come fai di
solito. Le credenziali non passano mai dal server.

In alternativa, da terminale:

```
npx banca-dati-merito-mcp@0.1.2 login
```

La sessione dura circa **due ore**. Il browser usa un profilo dedicato, separato dal
tuo, in cui il salvataggio delle password è disattivato.

## Privacy e sicurezza

- **La sessione resta sul tuo computer**, in un file leggibile solo dal tuo utente:
  `~/Library/Application Support/banca-dati-merito-mcp/` su macOS,
  `%APPDATA%\banca-dati-merito-mcp\` su Windows, `~/.config/banca-dati-merito-mcp/`
  su Linux. Il server non ha componenti remoti e non contatta altri servizi oltre alla
  Banca Dati ([ADR 0001](docs/adr/0001-sessione-solo-locale.md)). Unica eccezione: se la
  Banca Dati cambia certificato, il server può scaricare il certificato intermedio dal
  server dell'autorità di certificazione indicato nel certificato stesso.
- **Quello che il server legge arriva al modello AI che usi**: testi dei
  provvedimenti, metadati e, se li chiedi, le tue note e cartelle personali. Valuta il
  tuo fornitore AI di conseguenza.
- Per uscire: `npx banca-dati-merito-mcp@0.1.2 logout` cancella la sessione e il profilo
  del browser dedicato.

## Uso responsabile

La Banca Dati è pensata per la consultazione individuale. Il server lo rispetta:

- **una richiesta alla volta** per ogni app che usa il server, con almeno un secondo tra
  l'una e l'altra; una richiesta annullata dal client non parte;
- **al massimo 50 risultati** per chiamata (20 di norma);
- **nessuno strumento di download massivo**.

Ogni chiamata usa il tuo accesso personale: un assistente che cerca in modo mirato
protegge anche il tuo account.

## Configurazione

| Variabile | Predefinito | Effetto |
|---|---|---|
| `BDM_DOWNLOAD_DIR` | `~/Downloads/banca-dati-merito` | Dove `scarica_documento` salva i PDF |
| `BDM_MIN_INTERVAL_MS` | `1000` | Pausa minima tra due richieste (mai sotto 250) |
| `BDM_HOME` | cartella dati del sistema | Dove salvare sessione e profilo del browser. Protezione di base: rifiutata se è dentro OneDrive, Dropbox, Google Drive o iCloud (vale anche per la cartella predefinita). Altri servizi di sincronizzazione (Box, pCloud, Nextcloud…) non vengono riconosciuti: scegli comunque una cartella locale |
| `BDM_PERSONAL_AREA` | `on` | `off` nasconde all'assistente cartelle personali, ricerche salvate e note personali |

## Come funziona

Il sito della Banca Dati è un'applicazione che parla con un backend JSON
(`/api/bdm/frontoffice/`): GraphQL per ricerche e dettagli, REST per testi, documenti
e liste. Il server usa le stesse chiamate. Alcuni dettagli non ovvi:

- La sessione è legata al browser che ha fatto l'accesso: il server ripete lo stesso
  User-Agent e gli stessi client hint, altrimenti la Banca Dati risponde 401.
- Il certificato del sito non include il certificato intermedio, che i browser
  recuperano da soli e Node no. Il server lo include
  ([`src/bdp/tls.ts`](src/bdp/tls.ts)) e, se il sito cambia certificato, lo scarica
  dall'indirizzo indicato nel certificato stesso, accettandolo solo se firmato da
  un'autorità già attendibile.
- Ogni risposta è validata: se la Banca Dati cambia formato, lo strumento restituisce
  un errore chiaro invece di dati vuoti.

Il [glossario](GLOSSARY.md) spiega i termini; [docs/adr](docs/adr) le scelte di
progetto.

## Sviluppo

```
npm install
npm run check      # typecheck e test (Node 22.18+)
npm run build
```

`scripts/record.ts` registra una risposta per ogni endpoint, con la tua sessione, in
`test/fixtures/raw/` (esclusa da git); `scripts/pack-mcpb.sh` crea il pacchetto per
Claude Desktop.

## Crediti

Due progetti precedenti hanno aperto la strada:
[mcp-bdm-civile](https://glama.ai/mcp/servers/avvocati-e-mac/mcp-bdm-civile) di
avvocati-e-mac e [mcp-bdm](https://github.com/slimmanolesta/mcp-bdm) di
slimmanolesta, il cui README ha documentato per primo il legame tra sessione e
User-Agent. Il codice di questo progetto è scritto da zero.

## Licenza

[Apache-2.0](LICENSE).

---

## In English

An unofficial MCP server for Italy's Ministry of Justice **Banca Dati di Merito**
(public database of first- and second-instance civil decisions). It searches and
reads decisions and their abstracts with the user's own SPID/CIE/CNS/eIDAS session,
which never leaves the user's machine. Read-only, rate-limited, Apache-2.0. Tools and
documentation are in Italian because the data and its users are.
