import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CombinedAutocompleteProvider, Editor } from "@earendil-works/pi-tui";
import stationExtension from "../extensions/station.mjs";

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
  stationExtension({
    on(event, handler) { handlers.set(event, handler); },
    registerCommand(name, definition) { assert.equal(name, "station"); command = definition; },
    sendMessage() { assert.fail("A status query must not enter model context or trigger a turn"); },
    appendEntry() { assert.fail("A status query must not add session entries"); },
  });
  const ctx = { ui: {
    addAutocompleteProvider(factory) { autocomplete.push(factory); },
    setWidget(key, value) { if (value === undefined) widgets.delete(key); else widgets.set(key, value); },
    setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
    notify(message, type) { notices.push({ message, type }); },
  } };
  assert.equal(existsSync(join(directory, "pi-station")), false, "loading the extension has no launch side effects");
  return { directory, command, ctx, widgets, statuses, notices, handlers, autocomplete };
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

test("status leaves a visible widget instead of relying on a replaceable notification", async (t) => {
  const { command, ctx, widgets, statuses, notices } = fixture(t);
  // A closed ephemeral listener provides a free port without launching Pi Station.
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.PI_STATION_PORT = String(server.address().port);
  await new Promise((resolve) => server.close(resolve));
  await command.handler("status", ctx);
  const report = widgets.get("pi-station");
  assert.ok(report.includes("CLI: not running"));
  assert.ok(report.includes("Web: not running"));
  assert.ok(report.includes("Desktop: not running"));
  assert.ok(report.some((line) => line.startsWith("Log: ")));
  assert.equal(statuses.size, 0, "only the progress indicator should be cleared");
  assert.deepEqual(notices, []);
  await command.handler("stop", ctx);
  assert.equal(widgets.has("pi-station"), false, "the next station command clears the old snapshot");
});

test("status failures remain visible after progress is cleared", async (t) => {
  const { command, ctx, widgets, statuses, notices } = fixture(t);
  await command.handler("status", ctx);
  assert.match(widgets.get("pi-station").join("\n"), /status failed[\s\S]*PI_STATION_PORT/);
  assert.equal(statuses.size, 0);
  assert.equal(notices.at(-1).type, "error");
});
