import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loginState, startLogin } from "../session/login.ts";
import { logout } from "../session/logout.ts";
import { checkSession } from "../session/status.ts";
import { ok, run } from "./result.ts";

export const registerSessionTools = (server: McpServer): void => {
  server.registerTool(
    "stato_sessione",
    {
      title: "Stato della sessione",
      description:
        "Dice se c'è una sessione valida con la Banca Dati di Merito e quando scade, e lo stato di un eventuale accesso in corso. Chiamalo prima di una serie di ricerche.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => run(async () => ok({ ...(await checkSession()), accesso: loginState() })),
  );

  server.registerTool(
    "accedi",
    {
      title: "Accedi alla Banca Dati",
      description:
        "Apre una finestra di Chrome o Edge sulla pagina di accesso della Banca Dati di Merito, dove l'utente entra con SPID, CIE, CNS o eIDAS. Ritorna subito: chiedi all'utente di completare l'accesso nella finestra, poi controlla con stato_sessione. La sessione dura circa due ore.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    () =>
      run(async () => {
        const state = startLogin();
        return ok({
          accesso: state,
          istruzioni:
            "Si è aperta (o è già aperta) una finestra del browser sulla Banca Dati di Merito. L'utente deve completare l'accesso entro 5 minuti; poi usa stato_sessione per verificare.",
        });
      }),
  );

  server.registerTool(
    "esci",
    {
      title: "Esci dalla Banca Dati",
      description:
        "Chiude la sessione sul computer dell'utente: cancella il file di sessione e il profilo del browser dedicato (compresi i cookie dell'identità digitale). Usalo quando l'utente ha finito o chiede di uscire. Dopo, per cercare di nuovo servirà `accedi`.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    () =>
      run(async () => {
        await logout();
        return ok({ esito: "Sessione e profilo del browser cancellati da questo computer." });
      }),
  );
};
