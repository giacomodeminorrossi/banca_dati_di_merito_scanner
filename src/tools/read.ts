import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { downloadDir } from "../config.ts";
import { BdpError } from "../errors.ts";
import {
  getAbstract,
  getCartelleDelDocumento,
  getDocumento,
  getProvvedimento,
  getTestoProvvedimento,
  getTimeline,
} from "../bdp/client.ts";
import { areaParam, formatEstremi, idParam, READ_ONLY, targetParam } from "./common.ts";
import { ok, withBdp } from "./result.ts";

const DEFAULT_CHUNK = 20_000;
const MAX_CHUNK = 60_000;
const PROGRESS_INTERVAL_MS = 2000;

const estremi = (item: Parameters<typeof formatEstremi>[0] & Record<string, unknown>) => ({
  id: item.id,
  tipo: item.tipo,
  ufficio: item.ufficio,
  ...formatEstremi(item),
  data: item.data,
  data_pubblicazione: item.data_pubblicazione,
});

const notFound = (what: string, id: string): BdpError =>
  new BdpError("parametri", `Nessun ${what} con id ${id} nella Banca Dati.`);

/** Names Windows reserves for devices, whatever the extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** A file name a lawyer recognises, safe on every OS. */
export const safeFileName = (name: string): string => {
  const cleaned =
    name
      .normalize("NFKD")
      .replace(/[^\w.\- ]+/g, "")
      .replace(/\s+/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 120) || "documento";
  return WINDOWS_RESERVED.test(cleaned) ? `documento_${cleaned}` : cleaned;
};

const writeUnique = async (dir: string, base: string, data: Buffer): Promise<string> => {
  await mkdir(dir, { recursive: true });
  for (let n = 0; n < 1000; n++) {
    const path = join(dir, n === 0 ? `${base}.pdf` : `${base} (${n}).pdf`);
    try {
      await writeFile(path, data, { flag: "wx" });
      return path;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new BdpError("parametri", `Troppi file con il nome ${base} in ${dir}.`);
};

/** The personal-folders switch, offered only when the personal area is on. */
const cartelleShape = (enabled: boolean, what: string): { includi_cartelle?: z.ZodDefault<z.ZodBoolean> } =>
  enabled
    ? {
        includi_cartelle: z
          .boolean()
          .default(false)
          .describe(`Aggiunge le cartelle personali dell'utente che contengono ${what}.`),
      }
    : {};

const wantsCartelle = (args: object): boolean =>
  "includi_cartelle" in args && args.includi_cartelle === true;

export const registerReadTools = (server: McpServer, { personalArea }: { personalArea: boolean }): void => {
  const notes = personalArea ? ", e le note personali dell'utente" : "";
  server.registerTool(
    "leggi_provvedimento",
    {
      title: "Leggi provvedimento",
      description:
        `Restituisce i metadati completi di un provvedimento: estremi, giudici, materia, parole chiave, riferimenti normativi, esito, gli abstract che ne derivano, i provvedimenti precedente e successivo nel giudizio${notes}.`,
      inputSchema: {
        id: idParam,
        ...cartelleShape(personalArea, "il provvedimento"),
        area: areaParam,
      },
      annotations: READ_ONLY,
    },
    (args, { signal }) =>
      withBdp(signal, async (ctx) => {
        const { id, area } = args;
        const item = await getProvvedimento(ctx, id, area);
        if (!item) throw notFound("provvedimento", id);
        const cartelle = personalArea && wantsCartelle(args) ? await getCartelleDelDocumento(ctx, "provvedimenti", id) : undefined;
        return ok({
          ...estremi(item),
          distretto: item.distretto,
          materia: item.materia,
          ruolo: item.ruolo,
          presidente: item.presidente,
          relatore: item.relatore,
          giudice_assegnatario_fascicolo: item.giudice_assegnatario_fascicolo,
          parole_chiave: item.parola_chiave,
          riferimenti_normativi: item.riferimento_normativo,
          esito: item.esito,
          annotazione: item.annotazione,
          abstract: (item.abstract ?? []).map((a) => ({ ...estremi(a), titolo: a.titolo })),
          provvedimento_precedente: (item.provvedimento_precedente ?? []).map(estremi),
          provvedimento_successivo: (item.provvedimento_successivo ?? []).map(estremi),
          ...(personalArea
            ? {
                note_personali: item.note,
                note_sul_documento: (item.anonymized_document_note ?? []).map((note) => ({
                  testo: note.text,
                  pagina: note.page_number,
                  autore: [note.author?.name, note.author?.family_name].filter(Boolean).join(" ") || null,
                  aggiornata: note.last_update_date,
                })),
              }
            : {}),
          ...(cartelle ? { cartelle_personali: cartelle } : {}),
        });
      }),
  );

  server.registerTool(
    "leggi_testo_provvedimento",
    {
      title: "Leggi testo del provvedimento",
      description:
        "Restituisce il testo integrale del provvedimento, pseudonimizzato dalla Banca Dati (le parti diventano Parte_1, Controparte_1 ecc.). I testi lunghi arrivano a blocchi: se `continua` è vero, richiama con `da_carattere` uguale a `prossimo_da`.",
      inputSchema: {
        id: idParam,
        da_carattere: z.number().int().min(0).default(0),
        max_caratteri: z.number().int().min(1000).max(MAX_CHUNK).default(DEFAULT_CHUNK),
      },
      annotations: READ_ONLY,
    },
    ({ id, da_carattere, max_caratteri }, { signal }) =>
      withBdp(signal, async (ctx) => {
        const testo = await getTestoProvvedimento(ctx, id);
        const end = Math.min(testo.length, da_carattere + max_caratteri);
        return ok({
          id,
          lunghezza_totale: testo.length,
          da_carattere,
          a_carattere: end,
          continua: end < testo.length,
          ...(end < testo.length ? { prossimo_da: end } : {}),
          testo: testo.slice(da_carattere, end),
        });
      }),
  );

  server.registerTool(
    "leggi_abstract",
    {
      title: "Leggi abstract",
      description:
        `Restituisce un abstract completo: titolo, testo del principio, estremi del provvedimento da cui deriva, precedenti conformi e difformi collegati dalla Banca Dati${notes}.`,
      inputSchema: {
        id: idParam,
        ...cartelleShape(personalArea, "l'abstract"),
        area: areaParam,
      },
      annotations: READ_ONLY,
    },
    (args, { signal }) =>
      withBdp(signal, async (ctx) => {
        const { id, area } = args;
        const item = await getAbstract(ctx, id, area);
        if (!item) throw notFound("abstract", id);
        const cartelle = personalArea && wantsCartelle(args) ? await getCartelleDelDocumento(ctx, "abstract", id) : undefined;
        const riferimento = (a: { id: string; titolo?: string | null | undefined } & Parameters<typeof estremi>[0]) => ({
          id: a.id,
          titolo: a.titolo,
          ufficio: a.ufficio,
          ...formatEstremi(a),
          data_pubblicazione: a.data_pubblicazione,
        });
        return ok({
          id: item.id,
          titolo: item.titolo,
          testo: item.testo,
          provvedimento: item.provvedimento ? estremi(item.provvedimento) : null,
          distretto: item.distretto,
          materia: item.materia,
          ruolo: item.ruolo,
          parole_chiave: item.parola_chiave,
          riferimenti_normativi: item.riferimento_normativo,
          esito: item.esito,
          annotazione: item.annotazione,
          precedenti_conformi: (item.precedente_conforme ?? []).map(riferimento),
          precedenti_difformi: (item.precedente_difforme ?? []).map(riferimento),
          ...(personalArea ? { note_personali: item.note } : {}),
          ...(cartelle ? { cartelle_personali: cartelle } : {}),
        });
      }),
  );

  server.registerTool(
    "timeline_provvedimento",
    {
      title: "Timeline del giudizio",
      description: "Restituisce la sequenza dei gradi di giudizio collegati a un provvedimento, come la mostra la Banca Dati.",
      inputSchema: { id: idParam },
      annotations: READ_ONLY,
    },
    ({ id }, { signal }) => withBdp(signal, async (ctx) => ok((await getTimeline(ctx, id)).map(estremi))),
  );

  server.registerTool(
    "scarica_documento",
    {
      title: "Scarica documento",
      description:
        "Salva il PDF di un provvedimento o di un abstract nella cartella di download configurata dall'utente (predefinita: Download/banca-dati-merito) e restituisce il percorso del file. Non sovrascrive file esistenti. La Banca Dati può impiegare oltre mezzo minuto a generare il PDF. Per leggere il contenuto usa leggi_testo_provvedimento o leggi_abstract.",
      inputSchema: {
        tipo: targetParam,
        id: idParam,
        nome_file: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .optional()
          .describe("Nome del file senza estensione, per esempio 'Trib Bologna 2571-2025'. Predefinito: tipo e id."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ tipo, id, nome_file }, extra) =>
      withBdp(extra.signal, async (ctx) => {
        // BDP builds PDFs slowly; progress lets clients that support it extend their timeout.
        const progressToken = extra._meta?.progressToken;
        let lastSent = 0;
        const onProgress =
          progressToken === undefined
            ? undefined
            : (received: number, total: number | undefined) => {
                if (Date.now() - lastSent < PROGRESS_INTERVAL_MS && received !== total) return;
                lastSent = Date.now();
                void extra
                  .sendNotification({
                    method: "notifications/progress",
                    params: { progressToken, progress: received, ...(total ? { total } : {}), message: "Scaricamento del PDF" },
                  })
                  .catch(() => undefined);
              };
        const pdf = await getDocumento(ctx, tipo, id, onProgress);
        // The client gave up and told the model the call failed: a file now would be an orphan.
        if (extra.signal.aborted) throw new BdpError("annullata", "Scaricamento annullato.");
        const path = await writeUnique(downloadDir(), safeFileName(nome_file ?? `${tipo}-${id.slice(0, 16)}`), pdf);
        return ok({ salvato_in: path, byte: pdf.length });
      }),
  );
};
