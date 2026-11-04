#!/usr/bin/env node
import { sessionFile } from "./config.ts";
import { BdpError, hintFor } from "./errors.ts";
import { login } from "./session/login.ts";
import { logout } from "./session/logout.ts";
import { checkSession } from "./session/status.ts";

const USAGE = `banca-dati-merito-mcp — server MCP non ufficiale per la Banca Dati di Merito

Uso:
  banca-dati-merito-mcp            avvia il server MCP (stdio), per i client MCP
  banca-dati-merito-mcp login      apre il browser per l'accesso (SPID, CIE, CNS, eIDAS)
  banca-dati-merito-mcp stato      controlla la sessione salvata
  banca-dati-merito-mcp logout     cancella la sessione e il profilo del browser dedicato
`;

const main = async (args: string[]): Promise<void> => {
  const [command] = args;
  switch (command) {
    case undefined:
    case "serve": {
      const { serve } = await import("./server.ts");
      await serve();
      return;
    }
    case "login": {
      console.log("Si apre il browser: completa l'accesso alla Banca Dati di Merito (massimo 5 minuti).");
      const session = await login();
      console.log(`Accesso riuscito. Sessione salvata in ${sessionFile()}.`);
      if (session.expiresAt) console.log(`Scade alle ${new Date(session.expiresAt).toLocaleString("it-IT")}.`);
      return;
    }
    case "stato": {
      console.log(JSON.stringify(await checkSession(), null, 2));
      return;
    }
    case "logout": {
      await logout();
      console.log("Sessione e profilo del browser cancellati.");
      return;
    }
    case "--help":
    case "-h":
    case "help":
      console.log(USAGE);
      return;
    default:
      console.error(`Comando sconosciuto: ${command}\n\n${USAGE}`);
      process.exitCode = 2;
  }
};

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof BdpError) {
    console.error(`${error.message}\n${hintFor(error.code)}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
