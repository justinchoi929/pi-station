import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { PiCliSession } = await createJiti(import.meta.url).import("./pi-cli-session.ts");
const available = spawnSync(process.env.PI_STATION_PI || "pi", ["--version"], { timeout: 10_000 }).status === 0;

function nextEvent(session, type) {
  let stop;
  let timer;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => { stop(); reject(new Error(`Waiting for ${type}`)); }, 15_000);
    stop = session.onEvent((event) => { if (event.type === type) { clearTimeout(timer); stop(); resolve(event); } });
  });
}

test("PATH pi runs prompts, streams, restores history, navigates and answers extension dialogs", { skip: !available, timeout: 40_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "station-cli-integration-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(cwd);
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta, reason = null) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
    chunk({ role: "assistant", content: "来自 CLI 的回复\u2028" });
    if (body.includes("slow-fixture")) {
      const timer = setTimeout(() => res.end("data: [DONE]\n\n"), 10_000);
      res.once("close", () => clearTimeout(timer));
      return;
    }
    chunk({ content: "完成" });
    chunk({}, "stop");
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
    api: "openai-completions", apiKey: "fixture-key", baseUrl: `http://127.0.0.1:${port}/v1`,
    models: [{ id: "fixture", name: "Fixture", reasoning: false, contextWindow: 100000, maxTokens: 1000 }],
  } } }));
  await writeFile(join(agentDir, "extensions", "dialog.ts"), `export default function(pi) { pi.registerCommand('station-ask', {handler:async (_args,ctx)=>{ const answer=await ctx.ui.input('Test dialog'); ctx.ui.notify(answer); }}); }`);
  const environment = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  const options = { cwd, environment, initialModel: { provider: "fixture", modelId: "fixture" }, toolNames: ["read"], idleTimeoutMs: 0 };
  let session;
  let reopened;
  t.after(async () => { await session?.shutdown(); await reopened?.shutdown(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  session = await PiCliSession.create(options);
  await assert.rejects(session.send({ type: "new_session" }), /Unsupported command/);
  const events = [];
  session.onEvent((event) => events.push(event));
  const settled = nextEvent(session, "agent_settled");
  await session.send({ type: "prompt", message: "只回复一句话" });
  await settled;
  assert.equal((await session.send({ type: "get_last_assistant_text" })).text, "来自 CLI 的回复\u2028完成");
  assert.ok(events.some((event) => event.type === "message_update"));
  assert.ok(events.some((event) => event.type === "prompt_done"));
  assert.equal(requests.length, 1);
  const path = session.sessionFile;
  assert.ok((await readFile(path, "utf8")).includes("只回复一句话"));
  const id = session.sessionId;
  await session.send({ type: "set_tools", toolNames: ["read", "grep"] });
  await session.send({ type: "reload" });
  assert.deepEqual((await session.send({ type: "get_tools" })).filter((tool) => tool.active).map((tool) => tool.name), ["read", "grep"]);
  assert.ok(!(await session.send({ type: "get_commands" })).commands.some((command) => command.name === "__pi_station"));

  const dialog = nextEvent(session, "extension_ui_request");
  const asking = session.send({ type: "prompt", message: "/station-ask" });
  const request = await dialog;
  assert.equal(request.method, "input");
  assert.equal(session.isAwaitingInput(), true);
  await session.send({ type: "extension_ui_response", id: request.id, value: "已回答" });
  await asking;
  assert.equal(session.isAwaitingInput(), false);
  assert.equal(requests.length, 1, "extension commands and bridge operations never call the model");
  const { entries } = await session.send({ type: "get_entries" });
  const user = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
  const assistant = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
  const forked = await session.send({ type: "fork_branch", entryId: assistant.id });
  assert.equal(forked.cancelled, false);
  assert.notEqual(forked.newSessionId, id);
  assert.equal(session.sessionId, id, "copying a branch never replaces the source CLI's identity");
  await session.send({ type: "navigate_tree", targetId: user.id });
  const branch = session.inner.sessionManager.getBranch();
  assert.ok(!branch.some((entry) => entry.id === user.id), "navigating to a user prompt branches before that prompt");
  assert.ok(!branch.some((entry) => entry.type === "message" && entry.message.role === "assistant"));
  await session.shutdown();
  reopened = await PiCliSession.create({ cwd, environment, sessionFile: path, idleTimeoutMs: 0 });
  assert.equal(reopened.sessionId, id);
  assert.deepEqual((await reopened.send({ type: "get_tools" })).filter((tool) => tool.active).map((tool) => tool.name), ["read", "grep"]);
  const streaming = nextEvent(reopened, "message_update");
  await reopened.send({ type: "prompt", message: "slow-fixture" });
  await streaming;
  const stopped = nextEvent(reopened, "prompt_done");
  await reopened.send({ type: "abort" });
  assert.equal((await stopped).aborted, true);
  assert.equal(reopened.isRunning(), false);
});
