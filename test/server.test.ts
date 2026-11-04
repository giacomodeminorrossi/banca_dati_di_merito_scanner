import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { sessionFile } from "../src/config.ts";
import { createServer, type ServerOptions } from "../src/server.ts";
import { saveSession } from "../src/session/store.ts";

const connect = async (options: ServerOptions = { personalArea: true }): Promise<Client> => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(options).connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
};

/** Tools that change something on the user's machine; every other tool only reads. */
const LOCAL_SIDE_EFFECTS = new Set(["accedi", "esci", "scarica_documento"]);

describe("MCP server", () => {
  before(async () => {
    process.env.BDM_HOME = await mkdtemp(join(tmpdir(), "bdm-test-"));
  });

  it("marks every BDP tool read-only, except the ones with local side effects", async () => {
    const { tools } = await (await connect()).listTools();
    assert.ok(tools.length >= 15);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, !LOCAL_SIDE_EFFECTS.has(tool.name), tool.name);
      assert.equal(tool.inputSchema.type, "object", tool.name);
      assert.ok(tool.description && tool.description.length > 40, tool.name);
    }
  });

  it("tells the model to read the full text before citing a search result", async () => {
    // Claude Desktop cannot load the skill, so the tool descriptions must carry this rule.
    const { tools } = await (await connect()).listTools();
    for (const name of ["cerca_provvedimenti", "cerca_abstract"]) {
      assert.match(tools.find((t) => t.name === name)?.description ?? "", /leggi_testo_provvedimento/, name);
    }
  });

  it("lists the same tools as the Claude Desktop manifest", async () => {
    const { tools } = await (await connect()).listTools();
    const manifest = z
      .object({ tools: z.array(z.object({ name: z.string() })) })
      .parse(JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8")));
    assert.deepEqual(
      manifest.tools.map((t) => t.name).sort(),
      tools.map((t) => t.name).sort(),
    );
  });

  it("answers a data call without a session with the login hint, not a crash", async () => {
    const result = await (await connect()).callTool({ name: "cerca_provvedimenti", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /accedi/);
  });

  it("rejects paging beyond BDP's result window before calling BDP", async () => {
    const result = await (await connect()).callTool({
      name: "cerca_provvedimenti",
      arguments: { da: 9990, quanti: 20 },
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /10000 risultati/);
  });

  it("tells the model that what BDP returns is data, not instructions", async () => {
    const client = await connect();
    assert.match(client.getInstructions() ?? "", /non istruzioni/);
  });

  it("logs out without a session, and deletes a saved one", async () => {
    const client = await connect();
    const empty = await client.callTool({ name: "esci", arguments: {} });
    assert.notEqual(empty.isError, true);
    await saveSession({
      version: 1,
      capturedAt: "2026-10-29T06:00:00.000Z",
      expiresAt: null,
      userAgent: "Mozilla/5.0 test",
      clientHints: {},
      cookies: [],
    });
    const result = await client.callTool({ name: "esci", arguments: {} });
    assert.notEqual(result.isError, true);
    await assert.rejects(access(sessionFile()));
  });
});

describe("MCP server with the personal area off", () => {
  before(async () => {
    process.env.BDM_HOME = await mkdtemp(join(tmpdir(), "bdm-test-"));
  });

  const PERSONAL_TOOLS = ["cartelle_personali", "leggi_cartella_personale", "ricerche_salvate"];
  const PERSONAL_PARAMS = ["note_personali", "solo_cartelle_personali", "includi_cartelle"];

  it("offers neither the personal tools nor the parameters that read the personal area", async () => {
    const { tools } = await (await connect({ personalArea: false })).listTools();
    const names = tools.map((t) => t.name);
    for (const name of PERSONAL_TOOLS) assert.ok(!names.includes(name), name);
    for (const tool of tools) {
      const params = Object.keys(tool.inputSchema.properties ?? {});
      for (const param of PERSONAL_PARAMS) assert.ok(!params.includes(param), `${tool.name}.${param}`);
      assert.doesNotMatch(tool.description ?? "", /note personali/, tool.name);
    }
  });

  it("still offers them when the personal area is on", async () => {
    const { tools } = await (await connect({ personalArea: true })).listTools();
    const names = tools.map((t) => t.name);
    for (const name of PERSONAL_TOOLS) assert.ok(names.includes(name), name);
    const search = tools.find((t) => t.name === "cerca_provvedimenti");
    assert.ok(Object.keys(search?.inputSchema.properties ?? {}).includes("note_personali"));
  });
});
