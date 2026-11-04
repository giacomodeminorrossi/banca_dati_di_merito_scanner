import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RESULT_WINDOW } from "../config.ts";
import { searchAbstract, searchProvvedimenti, SORT_KEYS, suggest, type SearchParams } from "../bdp/client.ts";
import { ABSTRACT_FIELDS, buildQuery, DATE_FIELDS, PROVVEDIMENTO_FIELDS, TEXT_MODES, type Target } from "../bdp/query.ts";
import { BdpError } from "../errors.ts";
import { areaParam, formatEstremi, pagingParams, READ_ONLY, snippets, targetParam } from "./common.ts";
import { ok, run, withBdp } from "./result.ts";

const criterion = <F extends readonly [string, ...string[]]>(fields: F) =>
  z.object({
    campo: z.enum(fields).describe("Campo della Banca Dati."),
    valore: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Valore esatto come lo usa la Banca Dati (ottienilo con `risolvi_criteri`). Numeri e anni si scrivono senza zeri iniziali, per esempio numero_ruolo 2084.",
      ),
  });

const searchShape = <F extends readonly [string, ...string[]]>(fields: F) => ({
  criteri: z.array(criterion(fields)).max(20).optional().describe("Condizioni sui campi, combinate in AND."),
  escludi: z.array(criterion(fields)).max(10).optional().describe("Condizioni da escludere (AND NOT)."),
  testo: z
    .object({
      valore: z.string().trim().min(1).max(500),
      modalita: z
        .enum(TEXT_MODES)
        .default("tutte")
        .describe("tutte = tutte le parole; almeno_una = almeno una parola; frase_esatta = la frase tale e quale."),
    })
    .optional()
    .describe("Ricerca nel testo."),
  date: z
    .object({
      campo: z
        .enum(DATE_FIELDS)
        .default("data_pubblicazione")
        .describe("data = deposito della minuta; data_pubblicazione = pubblicazione."),
      da: z.string().optional().describe("AAAA-MM-GG"),
      a: z.string().optional().describe("AAAA-MM-GG"),
    })
    .optional(),
  note_personali: z.string().trim().min(1).max(200).optional().describe("Cerca nelle note personali dell'utente."),
  solo_cartelle_personali: z
    .boolean()
    .default(false)
    .describe("Limita ai documenti salvati nelle cartelle personali dell'utente."),
  ordina_per: z.enum(SORT_KEYS).optional().describe("Predefinito: rilevanza se c'è un testo, altrimenti data_pubblicazione."),
  ordine: z.enum(["asc", "desc"]).default("desc"),
  area: areaParam,
  ...pagingParams,
});

const provvedimentiShape = searchShape(PROVVEDIMENTO_FIELDS);
const abstractShape = searchShape(ABSTRACT_FIELDS);

/** With the personal area off, the model is not even offered the parameters that read it. */
const withoutPersonal = <S extends ReturnType<typeof searchShape>>(shape: S) => {
  const { note_personali: _notes, solo_cartelle_personali: _folders, ...rest } = shape;
  return rest;
};

type PersonalKeys = "note_personali" | "solo_cartelle_personali";

type SearchInput = Omit<
  z.output<z.ZodObject<typeof provvedimentiShape>> | z.output<z.ZodObject<typeof abstractShape>>,
  PersonalKeys
> & {
  note_personali?: string | undefined;
  solo_cartelle_personali?: boolean | undefined;
};

const toSearchParams = (target: Target, input: SearchInput): SearchParams => {
  if (input.da + input.quanti > RESULT_WINDOW) {
    throw new BdpError("parametri", `La Banca Dati mostra solo i primi ${RESULT_WINDOW} risultati: restringi la ricerca.`);
  }
  return {
    area: input.area,
    q: buildQuery(target, input),
    from: input.da,
    size: input.quanti,
    sortField: input.ordina_per ?? (input.testo ? "rilevanza" : "data_pubblicazione"),
    sortOrder: input.ordine,
    soloCartellePersonali: input.solo_cartelle_personali ?? false,
    notePersonali: input.note_personali,
  };
};

const pageSummary = (count: number, from: number, returned: number) => ({
  totale: count,
  sfogliabili: Math.min(count, RESULT_WINDOW),
  da: from,
  restituiti: returned,
  ...(from + returned < Math.min(count, RESULT_WINDOW) ? { prossimo_da: from + returned } : {}),
});

/**
 * Repeated in every non-empty result, not only in the tool description: in a live
 * test the model summarised rulings from their snippets without reading any text.
 */
const READ_BEFORE_CITING = {
  provvedimenti:
    "Gli estratti sono frammenti scelti dalla ricerca, non il principio del provvedimento. Prima di attribuire un principio a un provvedimento, leggine il testo con leggi_testo_provvedimento.",
  abstract:
    "Un abstract è una sintesi pubblicata dalla Banca Dati, non una massima ufficiale. Prima di citarlo come principio del provvedimento, verificalo nel testo con leggi_testo_provvedimento (usa provvedimento.id).",
} as const satisfies Record<Target, string>;

const readingNote = (target: Target, returned: number) =>
  returned > 0 ? { avvertenza: READ_BEFORE_CITING[target] } : {};

/**
 * Autocomplete also suggests full text and personal notes, which have their own
 * parameters; only fields the matching search accepts are passed on as criteria.
 */
const CRITERION_FIELDS = {
  provvedimenti: new Set<string>(PROVVEDIMENTO_FIELDS),
  abstract: new Set<string>(ABSTRACT_FIELDS),
} as const satisfies Record<Target, ReadonlySet<string>>;

const SEARCH_TOOL = { provvedimenti: "cerca_provvedimenti", abstract: "cerca_abstract" } as const satisfies Record<
  Target,
  string
>;

export const registerSearchTools = (server: McpServer, { personalArea }: { personalArea: boolean }): void => {
  server.registerTool(
    "risolvi_criteri",
    {
      title: "Risolvi criteri di ricerca",
      description:
        "Trasforma un nome detto dall'utente (un tribunale, una città, un giudice, un tema) nei criteri esatti della Banca Dati, con il campo giusto. Usalo prima di cercare per ufficio, distretto, giudice, parola chiave o materia: i criteri funzionano solo con il valore esatto.",
      inputSchema: {
        testo: z.string().trim().min(2).max(200).describe("Il nome o il tema, come lo dice l'utente."),
        tipo: targetParam.default("provvedimenti"),
        area: areaParam,
      },
      annotations: READ_ONLY,
    },
    ({ testo, tipo, area }, { signal }) =>
      withBdp(signal, async (ctx) => {
        const suggestions = await suggest(ctx, tipo, testo, area);
        const criteri = suggestions
          .filter((s) => CRITERION_FIELDS[tipo].has(s.type))
          .map((s) => ({ campo: s.type, valore: s.text, etichetta: s.label }));
        return ok({
          criteri,
          nota:
            criteri.length === 0
              ? "Nessun criterio corrispondente: usa il parametro `testo` della ricerca."
              : `Passa i criteri scelti in \`criteri\` di ${SEARCH_TOOL[tipo]}, con lo stesso campo e valore.`,
        });
      }),
  );

  server.registerTool(
    "cerca_provvedimenti",
    {
      title: "Cerca provvedimenti",
      description:
        "Cerca sentenze, ordinanze e decreti di merito nella Banca Dati, per testo, criteri di campo e date. Senza filtri restituisce gli ultimi pubblicati. Restituisce estremi, metadati, estratti evidenziati e gli abstract collegati. Gli estratti sono frammenti: non bastano per dire che cosa ha deciso un provvedimento. Prima di riferire il principio o l'esito di un provvedimento, leggine il testo con leggi_testo_provvedimento.",
      inputSchema: personalArea ? provvedimentiShape : withoutPersonal(provvedimentiShape),
      annotations: READ_ONLY,
    },
    (input, { signal }) =>
      run(async () => {
        // Parameters are checked before the session, so a bad call never waits on BDP.
        const params = toSearchParams("provvedimenti", input);
        return withBdp(signal, async (ctx) => {
        const page = await searchProvvedimenti(ctx, params);
        return ok({
          ...pageSummary(page.count, input.da, page.items.length),
          ...readingNote("provvedimenti", page.items.length),
          risultati: page.items.map((item) => ({
            id: item.id,
            tipo: item.tipo,
            ufficio: item.ufficio,
            ...formatEstremi(item),
            data: item.data,
            data_pubblicazione: item.data_pubblicazione,
            distretto: item.distretto,
            materia: item.materia,
            ruolo: item.ruolo,
            parole_chiave: item.parola_chiave,
            riferimenti_normativi: item.riferimento_normativo,
            presidente: item.presidente,
            relatore: item.relatore,
            giudice_assegnatario_fascicolo: item.giudice_assegnatario_fascicolo,
            estratti: snippets(item.estratto),
            abstract: item.abstract ?? [],
          })),
        });
        });
      }),
  );

  server.registerTool(
    "cerca_abstract",
    {
      title: "Cerca abstract",
      description:
        "Cerca gli abstract della Banca Dati, cioè le sintesi dei principi affermati nei provvedimenti. Usalo per gli orientamenti su una questione. Un abstract non è una massima ufficiale: prima di citarlo come principio di un provvedimento, verificalo nel testo con leggi_testo_provvedimento. Senza filtri restituisce gli ultimi pubblicati.",
      inputSchema: personalArea ? abstractShape : withoutPersonal(abstractShape),
      annotations: READ_ONLY,
    },
    (input, { signal }) =>
      run(async () => {
        const params = toSearchParams("abstract", input);
        return withBdp(signal, async (ctx) => {
        const page = await searchAbstract(ctx, params);
        return ok({
          ...pageSummary(page.count, input.da, page.items.length),
          ...readingNote("abstract", page.items.length),
          risultati: page.items.map((item) => ({
            id: item.id,
            titolo: item.titolo,
            testo: item.testo,
            provvedimento: {
              id: item.provvedimento?.id ?? null,
              tipo: item.tipo,
              ufficio: item.ufficio,
              ...formatEstremi(item),
              data: item.data,
              data_pubblicazione: item.data_pubblicazione,
            },
            distretto: item.distretto,
            materia: item.materia,
            parole_chiave: item.parola_chiave,
            riferimenti_normativi: item.riferimento_normativo,
            estratti: snippets(item.estratto),
          })),
        });
        });
      }),
  );
};
