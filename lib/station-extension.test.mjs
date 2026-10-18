import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, Editor, visibleWidth } from "@earendil-works/pi-tui";
import stationExtension from "../extensions/station.ts";

test("the package entry reloads after upgrading a cached native extension and after subsequent edits", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "station-extension-reload-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { loadExtensions } = await import(new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const legacyEntry = join(directory, "extensions/station.mjs");
  mkdirSync(dirname(legacyEntry), { recursive: true });
  writeFileSync(legacyEntry, 'export default function(pi) { pi.registerCommand("station", { description: "Legacy widget", handler() {} }); }\n');
  const before = await loadExtensions([legacyEntry], directory);
  assert.deepEqual(before.errors, []);
  assert.equal(before.extensions[0].commands.get("station").description, "Legacy widget");

  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const [resource] = manifest.pi.extensions;
  const entry = join(directory, resource);
  const source = readFileSync(new URL(`../${resource}`, import.meta.url), "utf8")
    .replace('"../bin/station-client.mjs"', JSON.stringify(fileURLToPath(new URL("../bin/station-client.mjs", import.meta.url))));
  writeFileSync(entry, source);
  const upgraded = await loadExtensions([entry], directory);
  assert.deepEqual(upgraded.errors, []);
  assert.ok(upgraded.extensions[0].entryRenderers.has("pi-station:status"), "reload must replace the old widget implementation");

  writeFileSync(entry, source.replace("Open Pi Station Web/desktop, or stop its background service", "Reloaded station command"));
  const reloaded = await loadExtensions([entry], directory);
  assert.deepEqual(reloaded.errors, []);
  assert.equal(reloaded.extensions[0].commands.get("station").description, "Reloaded station command", "later updates must also reload without restarting pi");
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "station-extension-"));
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_STATION_PORT: process.env.PI_STATION_PORT };
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.PI_STATION_PORT = "0";
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  let command;
  const widgets = new Map();
  const statuses = new Map();
  const notices = [];
  const handlers = new Map();
  const autocomplete = [];
  const entries = [];
  const renderers = new Map();
  stationExtension({
    on(event, handler) { handlers.set(event, handler); },
    registerCommand(name, definition) { assert.equal(name, "station"); command = definition; },
    registerEntryRenderer(type, renderer) { renderers.set(type, renderer); },
    sendMessage() { assert.fail("A status query must not enter model context or trigger a turn"); },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data, id: String(entries.length + 1),
        parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString() });
    },
  });
  const ctx = { mode: "tui", ui: {
    addAutocompleteProvider(factory) { autocomplete.push(factory); },
    setWidget(key, value) { if (value === undefined) widgets.delete(key); else widgets.set(key, value); },
    setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
    notify(message, type) { notices.push({ message, type }); },
  } };
  assert.equal(existsSync(join(directory, "pi-station")), false, "loading the extension has no launch side effects");
  return { directory, command, ctx, widgets, statuses, notices, handlers, autocomplete, entries, renderers };
}

function autocompleteFixture(t) {
  const { directory, command, ctx, handlers, autocomplete } = fixture(t);
  handlers.get("session_start")({}, { ...ctx, mode: "tui" });
  assert.equal(autocomplete.length, 1);
  const base = new CombinedAutocompleteProvider([
    { name: "station", getArgumentCompletions: command.getArgumentCompletions },
    { name: "other", getArgumentCompletions: () => [{ value: "argument", label: "argument" }] },
  ], directory);
  const identity = (text) => text;
  const editor = new Editor({ requestRender() {} }, {
    borderColor: identity,
    selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
  });
  editor.setAutocompleteProvider(autocomplete[0](base));
  return editor;
}

test("selecting each station action with Enter submits it immediately", async (t) => {
  for (const [index, action] of ["web", "desktop", "stop", "status"].entries()) {
    const editor = autocompleteFixture(t);
    const submissions = [];
    editor.onSubmit = (text) => submissions.push(text);
    editor.handleInput("/");
    await new Promise(setImmediate);
    for (const char of "station ") editor.handleInput(char);
    await new Promise(setImmediate);
    for (let i = 0; i < index; i++) editor.handleInput("\u001b[B");
    editor.handleInput("\r");
    assert.deepEqual(submissions, [`/station ${action}`]);
    assert.equal(editor.getText(), "");
  }
});

test("Tab still completes station actions, and Enter on other commands keeps its normal behavior", async (t) => {
  const editor = autocompleteFixture(t);
  const submissions = [];
  editor.onSubmit = (text) => submissions.push(text);
  editor.setText("/station ");
  editor.handleInput("s");
  await new Promise(setImmediate);
  editor.handleInput("\u001b[B");
  editor.handleInput("\t");
  assert.equal(editor.getText().trim(), "/station status");
  assert.deepEqual(submissions, []);
  editor.setText("/other ");
  editor.handleInput("a");
  await new Promise(setImmediate);
  editor.handleInput("\r");
  assert.equal(editor.getText(), "/other argument");
  assert.deepEqual(submissions, []);
});

test("RPC and print sessions do not install a terminal autocomplete wrapper", (t) => {
  const { ctx, handlers, autocomplete } = fixture(t);
  for (const mode of ["rpc", "print"]) handlers.get("session_start")({}, { ...ctx, mode });
  assert.deepEqual(autocomplete, []);
});

test("status appends separate transcript entries without adding model context or a fixed panel", async (t) => {
  const { command, ctx, widgets, statuses, notices, entries, renderers } = fixture(t);
  // A closed ephemeral listener provides a free port without launching Pi Station.
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.PI_STATION_PORT = String(server.address().port);
  await new Promise((resolve) => server.close(resolve));
  widgets.set("pi-station", ["Background: running"]);
  await command.handler("status", ctx);
  await command.handler("status", ctx);
  assert.equal(entries.length, 2, "successive replies must be separate transcript entries");
  const report = entries[0].data.text.split("\n");
  assert.doesNotMatch(entries[0].data.text, /^(?:CLI|Background):/m);
  assert.ok(report.includes("Web: not running"));
  assert.ok(report.includes("Desktop: not running"));
  assert.ok(report.some((line) => line.startsWith("Log: ")));
  assert.equal(statuses.size, 0);
  assert.equal(widgets.has("pi-station"), false, "a status reply must not pin a new panel above the editor");
  assert.deepEqual(notices, [], "terminal status replies must not use replaceable notifications");
  assert.deepEqual(buildSessionContext(entries).messages, [], "pi excludes custom entries from model context");
  const component = renderers.get(entries[0].customType)(entries[0], {}, {});
  assert.match(component.render(120).join("\n"), /Pi Station status/);
  assert.ok(component.render(42).every((line) => visibleWidth(line) <= 42), "long paths must wrap within the terminal width");
});

test("status failures append transcript entries after progress is cleared", async (t) => {
  const { command, ctx, widgets, statuses, notices, entries } = fixture(t);
  await command.handler("status", ctx);
  assert.equal(widgets.size, 0);
  assert.match(entries.at(-1).data.text, /Pi Station:.*PI_STATION_PORT/);
  assert.equal(entries.at(-1).data.level, "error");
  assert.equal(statuses.size, 0);
  assert.deepEqual(notices, []);
  assert.deepEqual(buildSessionContext(entries).messages, []);
});

test("RPC status replies use the standard UI protocol instead of terminal entry renderers", async (t) => {
  const { command, ctx, notices, entries } = fixture(t);
  await command.handler("status", { ...ctx, mode: "rpc" });
  assert.deepEqual(entries, []);
  assert.match(notices.at(-1).message, /Pi Station:.*PI_STATION_PORT/);
  assert.equal(notices.at(-1).type, "error");
});
