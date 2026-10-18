import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStationService } from "../bin/station-service.mjs";
import { probeStation, serviceRequest, stationPaths } from "../bin/station-common.mjs";
import { stationCommand } from "../bin/station-client.mjs";

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "station-service-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const paths = stationPaths({ PI_CODING_AGENT_DIR: directory, PI_STATION_PORT: String(port) });
  const runtime = join(directory, "runtime with spaces");
  mkdirSync(join(runtime, "bin"), { recursive: true });
  writeFileSync(join(runtime, "bin/pi-web.js"), `const http = require("node:http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const server = http.createServer((req, res) => res.end(JSON.stringify({application:"pi-station"}))).listen(port,"127.0.0.1");
process.on("SIGTERM", () => { server.closeAllConnections(); server.close(); });\n`);
  return { directory, paths, runtime, token: "test-secret", node: { path: process.execPath, version: process.versions.node } };
}

test("control socket rejects unauthenticated commands; concurrent opens own only one Web child and stop it", async (t) => {
  const options = await fixture(t);
  let builds = 0;
  let opens = 0;
  const service = await createStationService({ ...options, environment: {},
    prepare: async () => { builds++; return options.runtime; }, open: () => opens++,
  });
  t.after(() => service.shutdown());
  await assert.rejects(serviceRequest(options.paths, "wrong-token", "web"), /Forbidden/);
  assert.equal(builds, 0);
  const results = await Promise.all([1, 2].map(() => serviceRequest(options.paths, options.token, "web", 15_000)));
  assert.equal(builds, 1);
  assert.equal(opens, 2);
  assert.ok(results.every((result) => result.webOwned));
  assert.equal(await probeStation(options.paths.url, {}), "station");
  await serviceRequest(options.paths, options.token, "stop");
  await service.shutdown();
  assert.equal(await probeStation(options.paths.url, {}), "absent");
  assert.equal(existsSync(options.paths.record), false);
});

test("reuse of an independently started service does not build or terminate it", async (t) => {
  const options = await fixture(t);
  const external = createServer((_req, res) => res.end(JSON.stringify({ application: "pi-station" })));
  await new Promise((resolve) => external.listen(options.paths.port, "127.0.0.1", resolve));
  t.after(() => { external.closeAllConnections(); external.close(); });
  const service = await createStationService({ ...options, environment: { PI_WEB_NO_OPEN: "1" },
    prepare: async () => { assert.fail("An existing Web service needs no build"); },
    open: () => assert.fail("PI_WEB_NO_OPEN suppresses browser opening"),
  });
  t.after(() => service.shutdown());
  const result = await serviceRequest(options.paths, options.token, "web");
  assert.equal(result.webOwned, false);
  await service.shutdown();
  assert.equal(await probeStation(options.paths.url, {}), "station");
});

test("an unrelated listener cannot be mistaken for Pi Station", async (t) => {
  const options = await fixture(t);
  const external = createServer((_req, res) => res.end("unrelated application"));
  await new Promise((resolve) => external.listen(options.paths.port, "127.0.0.1", resolve));
  t.after(() => { external.closeAllConnections(); external.close(); });
  const service = await createStationService({ ...options, environment: {},
    prepare: async () => assert.fail("Must not build when the port belongs to another app"),
  });
  t.after(() => service.shutdown());
  await assert.rejects(serviceRequest(options.paths, options.token, "web"), /occupied/);
});

test("Web probes bypass the host's global fetch proxy and preserve local authentication", async (t) => {
  const options = await fixture(t);
  t.mock.method(globalThis, "fetch", () => assert.fail("A loopback probe must bypass the host's fetch dispatcher"));
  let authorization;
  const external = createServer((req, res) => {
    authorization = req.headers.authorization;
    res.end(JSON.stringify({ application: "pi-station" }));
  });
  await new Promise((resolve) => external.listen(options.paths.port, "127.0.0.1", resolve));
  t.after(() => { external.closeAllConnections(); external.close(); });
  assert.equal(await probeStation(options.paths.url, { PI_WEB_PASSWORD: "test-password" }), "station");
  assert.equal(authorization, `Basic ${Buffer.from("pi:test-password").toString("base64")}`);
});

test("status probes independently started Web servers without creating a worker", async (t) => {
  const options = await fixture(t);
  const environment = { ...process.env, PI_CODING_AGENT_DIR: options.directory, PI_STATION_PORT: String(options.paths.port) };
  let application = "pi-station";
  const external = createServer((_req, res) => res.end(JSON.stringify({ application })));
  await new Promise((resolve) => external.listen(options.paths.port, "127.0.0.1", resolve));
  t.after(() => { external.closeAllConnections(); external.close(); });
  const running = await stationCommand("status", environment);
  assert.equal(running.running, false);
  assert.equal(running.webStatus, "station");
  assert.equal(running.url, options.paths.url);
  application = "unrelated";
  assert.equal((await stationCommand("status", environment)).webStatus, "other");
  external.closeAllConnections();
  await new Promise((resolve) => external.close(resolve));
  assert.equal((await stationCommand("status", environment)).webStatus, "absent");
  assert.equal(existsSync(options.paths.record), false, "status must never launch a worker");
});

test("status reports a stopped Web server even while its control worker remains running", async (t) => {
  const options = await fixture(t);
  const environment = { ...process.env, PI_CODING_AGENT_DIR: options.directory, PI_STATION_PORT: String(options.paths.port), PI_WEB_NO_OPEN: "1" };
  const external = createServer((_req, res) => res.end(JSON.stringify({ application: "pi-station" })));
  await new Promise((resolve) => external.listen(options.paths.port, "127.0.0.1", resolve));
  t.after(() => { external.closeAllConnections(); external.close(); });
  const service = await createStationService({ ...options, environment, prepare: async () => assert.fail("Status must never prepare a runtime") });
  t.after(() => service.shutdown());
  await stationCommand("web", environment);
  assert.equal((await stationCommand("status", environment)).webStatus, "station");
  external.closeAllConnections();
  await new Promise((resolve) => external.close(resolve));
  const stopped = await stationCommand("status", environment);
  assert.equal(stopped.running, true);
  assert.equal(stopped.webStatus, "absent");
  assert.equal(stopped.webOwned, false);
  assert.equal(stopped.desktop, false);
});

test("stop cancels a first-launch preparation without launching a server afterward", async (t) => {
  const options = await fixture(t);
  let entered;
  const preparing = new Promise((resolve) => { entered = resolve; });
  const service = await createStationService({ ...options, environment: {},
    prepare: async (_directory, _node, _environment, _root, signal) => {
      entered();
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }));
    },
    launch: () => assert.fail("Cancelled preparation cannot start a server"),
  });
  t.after(() => service.shutdown());
  const opening = serviceRequest(options.paths, options.token, "web", 15_000);
  const rejected = assert.rejects(opening);
  await preparing;
  await service.shutdown();
  await rejected;
  assert.equal(await probeStation(options.paths.url, {}), "absent");
});

test("independent plugin clients share one detached worker and preserve a reused Web server", async (t) => {
  const options = await fixture(t);
  const environment = { ...process.env, PI_CODING_AGENT_DIR: options.directory,
    PI_STATION_PORT: String(options.paths.port), PI_WEB_NO_OPEN: "1" };
  const external = createServer((_req, res) => res.end(JSON.stringify({ application: "pi-station" })));
  await new Promise((resolve) => external.listen(options.paths.port, "127.0.0.1", resolve));
  t.after(async () => {
    await stationCommand("stop", environment);
    external.closeAllConnections();
    external.close();
  });
  const results = await Promise.all([stationCommand("web", environment), stationCommand("web", environment)]);
  assert.ok(results.every((result) => result.running && !result.webOwned));
  assert.equal((await stationCommand("status", environment)).running, true);
  assert.equal((await stationCommand("stop", environment)).stopped, true);
  assert.equal((await stationCommand("status", environment)).running, false);
  assert.equal(await probeStation(options.paths.url, {}), "station");
});

test("the control service stays reachable until a slow Web shutdown finishes", async (t) => {
  const options = await fixture(t);
  writeFileSync(join(options.runtime, "bin/pi-web.js"), `const http = require("node:http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const server = http.createServer((req, res) => res.end(JSON.stringify({application:"pi-station"}))).listen(port,"127.0.0.1");
process.on("SIGTERM", () => setTimeout(() => { server.closeAllConnections(); server.close(); }, 200));\n`);
  const service = await createStationService({ ...options, environment: { PI_WEB_NO_OPEN: "1" }, prepare: async () => options.runtime });
  t.after(() => service.shutdown());
  await serviceRequest(options.paths, options.token, "web", 15_000);
  await serviceRequest(options.paths, options.token, "stop");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { await serviceRequest(options.paths, options.token, "status"); }
    catch { break; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await probeStation(options.paths.url, {}), "absent");
});
