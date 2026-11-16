# Prompt di implementazione: accesso automatico CieID livello 2

> Da dare a un agente di programmazione (es. Claude Code) che lavora **sul PC
> dell'utente**, nella cartella di questo repository, con accesso a internet. La
> fase 0 richiede la presenza dell'utente una sola volta.

---

## Obiettivo

Questo repository è `banca-dati-merito-mcp`, un server MCP in TypeScript che consulta
la Banca Dati di Merito (`https://bdp.giustizia.it`) con la sessione personale
dell'utente. Oggi il login è manuale: `src/session/login.ts` apre Chrome/Edge con
Playwright, l'utente entra a mano con SPID/CIE, e il server salva cookie, User-Agent
e client hint in un file locale.

Devi aggiungere un **login automatico con CIE livello 2 (CieID)**:

1. L'utente salva una volta **identificativo e password CieID** nel portachiavi del
   sistema operativo, con un comando da terminale.
2. Quando serve un accesso, il server apre Chrome, sceglie "Entra con CIE", sceglie
   la modalità di livello 2, inserisce le credenziali e invia.
3. All'utente arriva la **notifica push dell'app CieID** sul telefono e la autorizza.
4. Il browser completa il redirect e il server salva la sessione **esattamente come
   oggi** (stesso formato di `Session` in `src/session/store.ts`).

L'utente ha confermato che il suo account CieID è di **livello 2** e ha già
verificato in autonomia i termini d'uso: non rimetterli in discussione.

## Fatti già verificati (con fonte) e limiti

- **Livello 2 CIE** = credenziali (numero CIE, codice fiscale o email, più password)
  e secondo fattore: notifica push sull'app CieID (sblocco con impronta, volto o
  codice app a 6 cifre) oppure OTP via SMS, a scelta dell'utente nell'app. Non
  serve la lettura NFC della carta (che serve solo al livello 3). Fonti:
  [money.it](https://www.money.it/CieID-app-carta-d-identita-elettronica-come-funziona-a-cosa-serve),
  [aranzulla.it – come accedere con CIE](https://www.aranzulla.it/come-accedere-con-cie-1345513.html),
  [manuale "Entra con CIE"](https://www.cartaidentita.interno.gov.it/downloads/2023/06/Manuale-Entra-con-CIE.pdf).
- Sul portale CIE (desktop) c'è una schermata di **scelta della modalità** con
  un'opzione tipo "Prosegui con smartphone"; il **timeout** dell'autenticazione è
  un errore previsto (codice 21 nel
  [manuale tecnico CIE](https://docs.italia.it/italia/cie/cie-manuale-tecnico-docs/it/master/overview.html)).
- La Banca Dati si raggiunge con SPID, CIE o CNS tramite il portale del Ministero
  ([manuale utente BDP](https://bdp.giustizia.it/media/Banca_Dati_di_Merito_Pubblica-Manuale_Utente.pdf)).
  Il punto d'ingresso del progetto è `https://bdp.giustizia.it/api/bdm/frontoffice/azure`.
- Libreria per il portachiavi: **`@napi-rs/keyring`** (binding di `keyring-rs`,
  mantenuta, binari precompilati, sostituto di `keytar` che è archiviato). Su
  Linux usa Secret Service via D-Bus.

**Non verificato** (i siti del Ministero non erano raggiungibili durante l'analisi):
etichette esatte di campi e pulsanti, i domini precisi della catena di redirect,
presenza di captcha o di una schermata di consenso, durata dell'attesa della
notifica, comportamento dopo password errate. Per questo esiste la **fase 0**: non
scrivere selettori prima di averla completata.

## Vincoli non negoziabili

1. **La password non compare mai** in: log, `console.*`, messaggi d'errore,
   risposte MCP, trace o video di Playwright, screenshot, file di debug, cronologia
   della shell, argomenti di processo, variabili d'ambiente. Prima di qualunque
   screenshot di debug, svuota o maschera tutti gli `input[type=password]`.
2. **Credenziali solo nel portachiavi del sistema** (servizio
   `banca-dati-merito-mcp`). Mai in `manifest.json`, `user_config`, `.env`, file di
   configurazione o repository. Se il portachiavi non è disponibile, rifiuta con un
   messaggio chiaro: **nessun ripiego su file**.
3. **Inserisci la password solo su host attesi**: prima di compilare, confronta
   `new URL(page.url())` (protocollo `https:` e hostname **esatto**) con una lista
   chiusa di host, presi dalla fase 0 e definiti in `src/config.ts`. Fai lo stesso
   controllo sul frame che contiene il campo, se è un iframe. Se l'host non è in
   lista: fermati, non compilare nulla, errore `login_fallito`.
4. **Nessun nuovo tentativo automatico della password.** Password errata, notifica
   rifiutata, timeout, captcha, richiesta di livello 3, pagina sconosciuta:
   interrompi, chiudi il browser e restituisci un errore che spiega cosa fare. Dopo
   un errore di credenziali, disattiva il login automatico finché l'utente non
   reimposta le credenziali (salva un flag in `appDir()`).
5. **Limite di frequenza**: al massimo un login automatico ogni 10 minuti, un solo
   login alla volta (riusa `running` / `loginInProgress()` in
   `src/session/login.ts` e il controllo del lock del profilo in
   `src/session/logout.ts`).
6. **Mai `headless`**: lo User-Agent diventerebbe `HeadlessChrome` e la sessione,
   legata allo User-Agent catturato, non funzionerebbe con il login manuale né con
   le richieste del server. Usa la finestra normale. Come opzione, porta la
   finestra fuori schermo (`--window-position=-32000,-32000`), ma **solo dopo aver
   verificato** che lo User-Agent e i client hint catturati siano identici a quelli
   del login manuale.
7. **Nessun nuovo dominio contattato** oltre alla catena di login ufficiale e alla
   Banca Dati. Nessun servizio di notifica, bot o telemetria.
8. Il **login manuale resta** com'è oggi e diventa il ripiego: se il login
   automatico non è configurato o fallisce, `accedi` funziona come prima.
9. Lo stile resta quello del progetto: TypeScript `strict`, ESM, file `.ts`
   eseguiti da Node ≥ 22, validazione con `zod`, errori come `BdpError` di
   `src/errors.ts`, messaggi per l'utente in italiano, commenti nel codice in
   inglese. Niente nuove dipendenze oltre a `@napi-rs/keyring`.

## Fase 0 – Ricognizione delle pagine (prima di scrivere il flusso)

Crea `scripts/recon-login.ts` che:

- usa lo stesso `launch()` di `src/session/login.ts`, ma con un profilo
  **temporaneo** (non quello dedicato), così parte senza SSO già attivo;
- apre `LOGIN_URL`; l'utente fa il login a mano scegliendo CIE e livello 2;
- a ogni navigazione del frame principale (`page.on("framenavigated")`) e a ogni
  cambiamento visibile del DOM salva in `test/fixtures/raw/login-recon/` (cartella
  già esclusa da git, verificalo in `.gitignore`):
  - URL e hostname;
  - uno screenshot, dopo aver mascherato gli `input[type=password]` e i campi che
    contengono il codice fiscale o l'email;
  - l'albero di accessibilità (`page.accessibility.snapshot()` o
    `locator.ariaSnapshot()`), con i valori dei campi rimossi;
  - l'HTML della pagina con gli attributi `value` rimossi;
- non registra trace, video o richieste di rete.

Fai eseguire lo script all'utente (`node scripts/recon-login.ts`) e chiedigli di
fare **due prove**: una autorizzando la notifica, una rifiutandola o lasciandola
scadere. Poi chiedigli di provare **una password sbagliata una sola volta**, per
vedere il messaggio d'errore (avvisalo del rischio di blocco: una sola prova).

Dai materiali raccolti, ricava e documenta in un commento in
`src/session/autologin.ts`:

- la lista esatta degli host della catena di login;
- per ogni schermata: come riconoscerla (titolo, intestazione, testo) e quale
  elemento usare (ruolo ARIA più nome accessibile, poi etichetta, poi testo
  visibile; CSS solo come ultima scelta);
- i testi che indicano: attesa della notifica, notifica rifiutata, timeout,
  credenziali errate, account bloccato, captcha, consenso al trasferimento dei dati,
  richiesta di un livello superiore, scelta OTP via SMS.

Se la ricognizione mostra un **captcha** o la sola possibilità del livello 3,
fermati e riferisci all'utente: la funzione non va implementata così.

## Fase 1 – Credenziali nel portachiavi

Nuovo file `src/session/credentials.ts`:

- `saveCredentials(id, password)`, `loadCredentials()`, `deleteCredentials()`,
  `hasCredentials()` con `@napi-rs/keyring` (`new Entry(service, account)`).
  Servizio `banca-dati-merito-mcp`; un'entry per l'identificativo e una per la
  password, oppure un'unica entry JSON validata con zod.
- Errori chiari se il portachiavi non è disponibile (es. Linux senza Secret Service):
  `BdpError("login_fallito", …)` che spiega come usare il login manuale.
- La password resta in memoria il meno possibile; nessun `toString` o `JSON` che
  la includa nei messaggi d'errore.

Nuovi comandi in `src/cli.ts` (aggiorna anche `USAGE`):

- `credenziali imposta`: chiede identificativo e password **in modo interattivo**,
  con la password **non mostrata a schermo** (TTY in raw mode, niente eco). Rifiuta
  se lo standard input non è un terminale. Mai la password come argomento.
- `credenziali cancella`
- `credenziali stato`: dice solo se ci sono credenziali salvate e se il login
  automatico è sospeso dopo un errore; non mostra mai la password.
- `login --automatico`: esegue il login automatico in modo bloccante e stampa
  l'esito.

`logout` (CLI) e lo strumento MCP `esci` cancellano sessione e profilo come oggi.
Le credenziali le cancellano solo se si passa l'opzione esplicita
(`logout --anche-credenziali`; per `esci` un parametro booleano
`ancheCredenziali`, predefinito `false`). Aggiorna le descrizioni.

**Pacchetto `.mcpb`:** `@napi-rs/keyring` installa il binario solo per la
piattaforma su cui gira `npm ci`. `scripts/pack-mcpb.sh` gira su `ubuntu-latest`
(`.github/workflows/release.yml`), quindi il bundle conterrebbe solo il binario
Linux. Correggi lo script perché includa i pacchetti precompilati per
`darwin-arm64`, `darwin-x64`, `win32-x64-msvc`, `win32-arm64-msvc` e
`linux-x64-gnu` (installali esplicitamente nella cartella di staging con
`--force`) e aggiungi un controllo che fallisce se ne manca uno. Verifica anche
`npx banca-dati-merito-mcp` su Windows e macOS.

## Fase 2 – Flusso automatico

Nuovo file `src/session/autologin.ts`, che riusa `launch()`, `waitForSignIn()`,
`captureBrowserHeaders()` e il salvataggio di `runLogin()` (rifattorizza
`src/session/login.ts` per condividerli, senza cambiare il comportamento del login
manuale).

Flusso, con una **macchina a stati esplicita** e un timeout per ogni stato:

1. Carica le credenziali; se mancano, o se l'automatico è sospeso, errore chiaro e
   suggerimento del login manuale.
2. Apri `LOGIN_URL` con il profilo dedicato. Se il profilo ha ancora un SSO valido,
   la Banca Dati può risultare già autenticata: controlla subito `user/current`, come
   fa `waitForSignIn`.
3. Riconosci ogni schermata con gli indicatori della fase 0. Su una schermata non
   riconosciuta: screenshot mascherato in una cartella di debug locale,
   chiusura e errore `login_fallito` con il percorso dello screenshot.
4. Sulla scelta del provider: CIE. Sulla scelta della modalità: quella di livello 2
   con credenziali e smartphone.
5. Controllo dell'host (vincolo 3), poi `fill` di identificativo e password e invio.
6. Stato "in attesa della notifica": esponi questo stato nel `LoginState` (nuovo
   stato, es. `{ status: "in_attesa_notifica" }`) così `stato_sessione` può dire
   all'utente di guardare il telefono. Attendi fino al timeout del portale, al
   massimo 5 minuti (`LOGIN_TIMEOUT_MS`).
7. Se compare la schermata di consenso, accettala solo se il testo corrisponde a
   quello registrato nella fase 0.
8. Al rientro sulla Banca Dati: `waitForSignIn`, `captureBrowserHeaders`, salvataggio
   della sessione come oggi.
9. Ogni errore riconosciuto (credenziali errate, notifica rifiutata, timeout, blocco,
   captcha, livello superiore richiesto) diventa un `BdpError("login_fallito", …)` con
   un messaggio italiano specifico. Le credenziali errate attivano la sospensione
   (vincolo 4).

Il browser viene sempre chiuso nel `finally`.

## Fase 3 – Integrazione MCP

- `accedi`: se ci sono credenziali e l'automatico non è sospeso, avvia il login
  automatico in background e restituisce subito un messaggio del tipo "Ti ho
  mandato la notifica sull'app CieID: autorizzala, poi controllo con
  stato_sessione". Altrimenti fa il login manuale di oggi. Aggiungi un parametro
  opzionale `modalita: "automatica" | "manuale"`.
- **Avvio automatico alla scadenza:** quando uno strumento di dati fallisce con
  `sessione_assente` o `sessione_scaduta` (vedi `requireSession` in
  `src/session/status.ts` e `run` in `src/tools/result.ts`) e le credenziali sono
  configurate, avvia il login automatico **una volta**, nel rispetto del limite di
  frequenza, e restituisci un errore che dice al modello: "notifica inviata,
  chiedi all'utente di autorizzarla e riprova dopo con stato_sessione". Non
  attendere la notifica dentro la chiamata dello strumento: le chiamate MCP hanno
  timeout lato client.
- Rendi l'avvio automatico disattivabile con una variabile
  `BDM_AUTO_LOGIN` (`on`/`off`, predefinito `on` se ci sono credenziali), letta in
  `src/config.ts` come le altre, e con la voce corrispondente in `manifest.json`
  (`user_config`, booleano). Nessuna credenziale in `manifest.json`.
- Aggiorna gli hint in `src/errors.ts`, le descrizioni degli strumenti e il
  `manifest.json` (`tools`).

## Fase 4 – Test

Con `node:test`, come nei test esistenti (`test/local.test.ts`):

- **Pagine finte**: un piccolo server HTTP locale che imita le schermate rilevate
  nella fase 0 (scelta provider, scelta modalità, credenziali, attesa notifica,
  esiti). Usa le pagine finte per testare la macchina a stati con Playwright:
  successo, password errata, notifica rifiutata, timeout, captcha, pagina
  sconosciuta, consenso. Rendi configurabili gli host attesi e il punto d'ingresso
  solo per i test (non tramite variabili documentate per l'utente).
- **Controllo dell'host**: con un host non in lista la password non viene mai
  compilata (verifica che il campo resti vuoto e che `fill` non venga chiamato).
- **Nessuna fuga della password**: con una password-sentinella (es.
  `SENTINELLA-NON-LOGGARE`), cattura stdout, stderr, messaggi d'errore, risposte
  MCP e file creati nelle cartelle di debug, e verifica che la sentinella non
  compaia da nessuna parte.
- **Credenziali**: salva, leggi e cancella con un nome di servizio di test; salta il
  test (non fallirlo) dove il portachiavi non è disponibile, come in CI Linux.
- **Limite di frequenza e sospensione**: due avvii ravvicinati ne eseguono uno solo;
  dopo credenziali errate non parte nulla finché non si reimpostano.
- `npm run check` deve passare.

## Fase 5 – Documentazione

- `README.md`: sezione "Accesso automatico con CieID (livello 2)" con: requisiti
  (account CieID livello 2, app CieID con notifiche attive, PC acceso con il
  server), comandi, cosa succede alla scadenza, come disattivarlo, come cancellare
  le credenziali, rischi.
- Nuovo `docs/adr/0003-credenziali-nel-portachiavi.md`: perché le credenziali
  restano solo nel portachiavi locale, perché non c'è ripiego su file, perché
  nessun nuovo tentativo automatico. L'ADR 0001 resta valido (la sessione non esce
  dal computer): aggiungi un rimando.
- `SECURITY-REVIEW.md`: nuove superfici (portachiavi, compilazione automatica,
  controllo degli host, screenshot di debug mascherati).

## Criteri di accettazione

1. Sul PC dell'utente, `credenziali imposta` e poi `login --automatico` fanno
   arrivare la notifica CieID; dopo l'autorizzazione la sessione viene salvata e
   `stato` risponde "valida".
2. Da Claude Desktop o Claude Code, con la sessione scaduta, una ricerca avvia il
   login automatico, arriva la notifica, e dopo l'autorizzazione la stessa ricerca
   funziona.
3. Rifiutando la notifica o lasciandola scadere, il server restituisce un errore
   chiaro e non manda un'altra notifica da solo.
4. Con una password sbagliata il server si ferma dopo un solo tentativo e sospende
   il login automatico.
5. Il login manuale funziona come prima.
6. I test di "nessuna fuga della password" e del controllo degli host passano.
7. Il pacchetto `.mcpb` contiene i binari del portachiavi per tutte le piattaforme
   indicate.

## Cosa consegnare

- Commit piccoli, uno per fase, con messaggi in inglese nello stile del repository.
- Alla fine, un riepilogo per l'utente in italiano semplice: cosa è stato fatto,
  come si usa (comandi esatti), cosa è stato provato davvero sul suo PC e cosa no,
  eventuali problemi rimasti.
