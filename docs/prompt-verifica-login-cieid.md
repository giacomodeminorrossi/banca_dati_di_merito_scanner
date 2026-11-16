# Prompt di verifica: accesso CieID livello 2 con notifica sul telefono

> Da incollare a un'altra AI con accesso al web (e, se possibile, al repository).
> Obiettivo: verificare i requisiti e raccogliere tutto il necessario per scrivere
> un prompt di implementazione corretto e completo. **Non deve scrivere il codice.**

---

## Ruolo e compito

Sei un analista tecnico. Devi **verificare** fattibilità, requisiti e rischi di una
modifica a un progetto esistente e produrre un **prompt di implementazione** pronto da
dare a un agente di programmazione. Non implementare nulla. Dove non puoi verificare
un fatto, dillo esplicitamente e indica come verificarlo. Non inventare selettori,
URL o comportamenti: distingui sempre **verificato (con fonte)**, **probabile** e
**da verificare sul PC dell'utente**.

## Contesto del progetto

Repository: `banca-dati-merito-mcp`, un server MCP in TypeScript (Node ≥ 22, ESM, file
`.ts` eseguiti direttamente da Node; dipendenze: `@modelcontextprotocol/sdk`,
`playwright-core`, `zod`). Consulta in sola lettura la **Banca Dati di Merito** del
Ministero della Giustizia (`https://bdp.giustizia.it`) usando la sessione personale
dell'utente.

Come funziona oggi il login (`src/session/login.ts`):

- Playwright avvia **Chrome o Edge di sistema** (`channel: "chrome" | "msedge"`),
  visibile (`headless: false`), con un **profilo persistente dedicato**
  (`launchPersistentContext`). Il salvataggio delle password di Chrome è disattivato.
- Naviga su `https://bdp.giustizia.it/api/bdm/frontoffice/azure`, che reindirizza al
  provider d'identità del Ministero (SPID, CIE, CNS, eIDAS).
- **L'utente completa l'accesso a mano**, davanti al PC.
- Il codice interroga ogni 1,5 s `GET /api/bdm/frontoffice/user/current` dall'interno
  della pagina; quando arriva un `upn`, l'accesso è riuscito (timeout: 5 minuti).
- Cattura User-Agent e client hint (`sec-ch-ua*`) di una richiesta all'API e i
  cookie, e li salva in un file locale con permessi 0600. **La sessione è legata al
  browser**: con un altro User-Agent la Banca Dati risponde 401. Dura circa 2 ore.
- Lo strumento MCP `accedi` avvia il login in background; `stato_sessione` ne legge lo
  stato; `esci` cancella sessione e profilo. Da terminale ci sono i comandi `login`,
  `stato` e `logout` (`src/cli.ts`).
- L'ADR `docs/adr/0001-sessione-solo-locale.md` stabilisce che la sessione **non deve
  mai lasciare il computer** dell'utente: nessun componente remoto.

## La modifica desiderata

L'utente non vuole più dover stare davanti al PC per fare il login. Vuole che il
server faccia l'accesso **CIE livello 2 (CieID: credenziali + notifica)** in
automatico, e che a lui arrivi solo la **notifica push dell'app CieID** sul telefono
da autorizzare.

Flusso atteso:

1. Una volta sola, sul PC, l'utente salva identificativo e password CieID nel
   **portachiavi del sistema operativo** (Portachiavi su macOS, Gestione credenziali
   su Windows, Secret Service/libsecret su Linux), con un comando CLI interattivo. La
   password non passa mai dalla chat né dal modello AI.
2. Quando la sessione manca o è scaduta (o quando si chiama `accedi`), il server apre
   Chrome, sceglie CIE → accesso con credenziali (livello 2), compila identificativo e
   password e invia.
3. Il Ministero/CieID manda una notifica push all'app CieID dell'utente, che la
   autorizza dal telefono.
4. Il browser sul PC completa il redirect; il server salva la sessione come oggi.
5. In caso di errore (password errata, notifica rifiutata o scaduta, pagina cambiata,
   captcha, richiesta di livello 3) il server si ferma, **non riprova in automatico la
   password**, e restituisce un errore chiaro.

Vincoli già decisi: livello 2 confermato dall'utente; sessione e credenziali restano
sul PC; il PC deve restare acceso con il server attivo; nessun servizio esterno
aggiuntivo (niente bot o notifiche proprie); il login manuale attuale resta disponibile
come alternativa.

## Cosa devi verificare

Per ogni punto: risposta, livello di certezza, fonte (link) oppure il modo di
verificarlo sul PC dell'utente.

### A. Flusso CIE / CieID livello 2

1. La Banca Dati di Merito (tramite `/api/bdm/frontoffice/azure`) accetta CIE di
   **livello 2**, o richiede un livello minimo diverso? Ci sono fonti ufficiali?
   Il livello richiesto può dipendere dal servizio?
2. Qual è la **catena di redirect** reale: BDP → Azure AD B2C (o simile) del Ministero
   → pagina di scelta SPID/CIE/CNS/eIDAS → `idserver.servizicie.interno.gov.it` (o
   altro dominio)? Elenca i domini coinvolti.
3. Sul portale CIE (desktop), quali opzioni offre la pagina per il livello 2 (es.
   "username e password + notifica app CieID", "QR code")? Com'è la sequenza esatta
   delle schermate?
4. L'identificativo è il **codice fiscale**, l'email o il numero della carta? La
   password è quella dell'account CieID creato in app/portale?
5. Dopo l'invio della password, la notifica arriva **sempre**, o il portale a volte
   chiede in alternativa un OTP via SMS? Quanto tempo c'è per approvare? Cosa mostra la
   pagina su rifiuto o timeout?
6. Ci sono **captcha**, controlli anti-automazione, rilevamento di Playwright/CDP o
   limiti di tentativi con blocco dell'account? Dopo quanti errori si blocca?
7. Il portale CIE mantiene una **sessione SSO** riutilizzabile (cookie sul dominio
   CIE) che eviti una nuova notifica entro un certo tempo? Quanto dura?
8. C'è un passaggio di **consenso** ("acconsenti a inviare i dati a…") da cliccare a
   ogni accesso?

### B. Portachiavi del sistema da Node.js

9. Quale libreria usare oggi (novembre 2026) per il portachiavi di sistema da
    Node ≥ 22 su macOS, Windows e Linux? `keytar` è archiviato: valuta alternative
    mantenute (es. `@napi-rs/keyring`, `cross-keychain` o comandi di sistema come
    `security` su macOS, `cmdkey`/PowerShell `CredentialManager` su Windows,
    `secret-tool` su Linux). Indica manutenzione, licenza, binari precompilati e
    compatibilità con il pacchetto `.mcpb` di Claude Desktop (`scripts/pack-mcpb.sh`) e
    con `npx`.
10. Come gestire Linux senza Secret Service (server headless): rifiutare, oppure un
    file 0600 con avviso esplicito?

### C. Automazione con Playwright

11. Strategia di selezione robusta per le pagine del Ministero e di CIE (ruoli ARIA,
    etichette, testo visibile) invece di selettori CSS fragili. Indica **cosa serve
    raccogliere dal PC dell'utente** per fissarli: HTML e screenshot di ogni schermata,
    con i campi sensibili oscurati.
12. Il login automatico può girare con la finestra **minimizzata o fuori schermo**
    invece che `headless`, senza cambiare lo User-Agent catturato? La modalità
    headless cambierebbe lo UA (`HeadlessChrome`) e romperebbe il legame della
    sessione: confermalo e proponi un'alternativa.
13. Come impedire che password e identificativo finiscano in log, trace di Playwright,
    screenshot di debug, messaggi d'errore o risposte MCP al modello.
14. Come evitare due login automatici in parallelo (più app che usano lo stesso
    server/profilo; oggi esiste già un controllo del lock del profilo in
    `src/session/logout.ts`).

### D. Integrazione nel progetto

15. Dove si aggancia il login automatico: solo su `accedi`, oppure anche in automatico
    quando una chiamata riceve 401 o la sessione è scaduta? Valuta il rischio di
    notifiche inattese o ripetute e proponi un limite (es. al massimo un tentativo
    automatico ogni N minuti, mai più di uno dopo un rifiuto).
16. Nuovi comandi CLI e strumenti MCP necessari (es. `credenziali imposta`,
    `credenziali cancella`, `login --automatico`) e come `esci`/`logout` deve
    comportarsi con le credenziali salvate.
17. Variabili d'ambiente o impostazioni dell'estensione `.mcpb` (`manifest.json`) da
    aggiungere, ad esempio per attivare/disattivare la modalità automatica.
18. Test: cosa si può testare senza la vera pagina CIE (pagine HTML finte servite in
    locale e simulate con Playwright, stati di errore) e cosa resta un test manuale.
19. Documenti da aggiornare: README, `SECURITY-REVIEW.md`, nuovo ADR (o modifica
    dell'ADR 0001) per la custodia delle credenziali.

## Cosa devi consegnare

1. **Tabella delle verifiche**: per ognuno dei 19 punti, risposta, certezza
   (verificato / probabile / da verificare) e fonte.
2. **Bloccanti**: cosa impedirebbe la modifica (es. livello 3 obbligatorio, captcha,
   divieto esplicito nei termini) e alternative (es. QR code con app CieID).
3. **Checklist per l'utente**: le cose che solo l'utente può fare o fornire sul suo
   PC. Per ognuna: istruzioni passo passo semplici, in italiano, e cosa oscurare.
   Esempi: catturare HTML e screenshot di ogni schermata del login CIE, verificare se
   la notifica arriva sempre, indicare sistema operativo e client MCP usato.
4. **Prompt di implementazione** completo e autosufficiente per un agente di
   programmazione che lavora su questo repository. Deve contenere:
   - obiettivo e flusso;
   - file da toccare, partendo dagli esistenti (`src/session/login.ts`,
     `src/session/store.ts`, `src/session/logout.ts`, `src/tools/session.ts`,
     `src/cli.ts`, `src/config.ts`, `src/errors.ts`, `manifest.json`, README, ADR);
   - requisiti di sicurezza non negoziabili (vedi sotto);
   - gestione di ogni caso d'errore;
   - selettori o strategia di selezione, marcando come segnaposto ciò che va
     confermato con i dati dell'utente;
   - test da scrivere e criteri di accettazione verificabili;
   - stile del codice coerente con il progetto (TypeScript strict, ESM, zod, messaggi
     utente in italiano, commenti in inglese, errori tramite `BdpError`).
5. **Domande aperte** rimaste per l'utente, al massimo 5, ciascuna con una risposta
   consigliata.

## Requisiti di sicurezza da includere nel prompt finale

- La password non viene mai stampata, loggata, inclusa in errori, risposte MCP,
  screenshot o trace; i campi password vengono oscurati prima di qualsiasi screenshot
  di debug.
- Credenziali solo nel portachiavi di sistema; mai in variabili d'ambiente, file di
  configurazione, `manifest.json` o repository.
- Nessun nuovo dominio contattato oltre a quelli della catena di login ufficiale e alla
  Banca Dati.
- Il browser compila la password **solo** se l'URL della pagina corrente è su un
  dominio atteso, in HTTPS, con verifica esatta dell'host (protezione da redirect o
  phishing).
- Nessun nuovo tentativo automatico dopo password errata, notifica rifiutata o scaduta;
  limite di frequenza ai login automatici.
- `esci`/`logout` offre di cancellare anche le credenziali; esiste un comando
  dedicato per cancellarle.
- Il login manuale attuale resta disponibile e diventa il ripiego quando quello
  automatico fallisce.
