import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { cleanEnvironment, findNode, probeStation, stationPaths, terminateChild } from "./station-common.mjs";
import { prepareElectron, prepareRuntime } from "./station-runtime.mjs";

const require = createRequire(import.meta.url);
const { openInBrowser } = require("./browser-opener.js");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function stopChild(child, timeout = 8_000) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => { terminateChild(child, "SIGKILL"); resolve(); }, timeout);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    terminateChild(child);
  });
}

export async function createStationService({ paths, token, environment = process.env,
  prepare = prepareRuntime, electron = prepareElectron, probe = probeStation,
  open = openInBrowser, launch = spawn, node = findNode(environment) }) {
  let web = null;
  let desktop = null;
  let runtime = null;
  let stopping = false;
  let tail = Promise.resolve();
  const children = new Set();
  const controller = new AbortController();
  const own = (command, args, options) => {
    const child = launch(command, args, options);
    children.add(child);
    child.once("close", () => children.delete(child));
    // Spawn errors must never become uncaught events in the background worker.
    child.on("error", (error) => console.error("[pi-station] Child process:", error.message));
    return child;
  };
  const alive = (child) => child && child.pid && child.exitCode === null && child.signalCode === null;
  const status = () => ({ url: paths.url, webOwned: alive(web) === true, desktop: alive(desktop) === true, stopping });

  async function ensureWeb() {
    const existing = await probe(paths.url, environment);
    if (existing === "station") return;
    if (existing !== "absent") throw new Error(`Port ${paths.port} is occupied or inaccessible; choose PI_STATION_PORT`);
    runtime ??= await prepare(paths.directory, node, environment, undefined, controller.signal);
    if (stopping) throw new Error("Pi Station is stopping");
    // Another instance may have started a server while this one was building.
    const afterBuild = await probe(paths.url, environment);
    if (afterBuild === "station") return;
    if (afterBuild !== "absent") throw new Error(`Port ${paths.port} is occupied`);
    web = own(node.path, [join(runtime, "bin/pi-web.js"), "--no-open", "--port", String(paths.port)], {
      cwd: runtime, env: cleanEnvironment(environment), stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
    });
    const deadline = Date.now() + 90_000;
    while (!stopping && Date.now() < deadline) {
      if (await probe(paths.url, environment) === "station") return;
      if (!alive(web)) throw new Error("Pi Station Web server exited; see the service log");
      await delay(300);
    }
    await stopChild(web);
    throw new Error("Pi Station Web server did not become ready");
  }

  async function execute(command) {
    if (stopping) throw new Error("Pi Station is stopping");
    if (!["web", "desktop"].includes(command)) throw new Error("Unknown Pi Station command");
    if (command === "desktop" && process.platform !== "darwin") throw new Error("Pi Station desktop currently supports macOS; use /station web on this platform");
    await ensureWeb();
    if (command === "web") {
      if (!["1", "true", "yes", "on"].includes(environment.PI_WEB_NO_OPEN?.trim().toLowerCase())) open(paths.url);
    }
    else {
      // A second Electron invocation activates the existing single-instance window.
      runtime ??= await prepare(paths.directory, node, environment, undefined, controller.signal);
      const binary = await electron(paths.directory, environment, controller.signal);
      if (stopping) throw new Error("Pi Station is stopping");
      const child = own(binary, [runtime], { cwd: runtime, env: {
        ...cleanEnvironment(environment), PI_STATION_HOME: runtime, PI_STATION_PORT: String(paths.port),
      }, stdio: ["ignore", "inherit", "inherit"] });
      if (!alive(desktop)) desktop = child;
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    }
    return status();
  }

  const server = createServer(async (request, response) => {
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(request.headers.authorization || "");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      response.writeHead(403).end(JSON.stringify({ error: "Forbidden" }));
      return;
    }
    let body = "";
    try {
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1024) throw new Error("Request is too large");
      }
      const { command } = JSON.parse(body);
      let result;
      if (command === "status") result = status();
      else if (command === "stop") {
        response.writeHead(200).end(JSON.stringify({ ...status(), stopped: true }));
        void shutdown();
        return;
      } else {
        const operation = tail.then(() => execute(command));
        tail = operation.catch(() => {});
        result = await operation;
      }
      response.writeHead(200).end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400).end(JSON.stringify({ error: error.message }));
    }
  });
  server.requestTimeout = 0;
  let shutdownPromise;
  function shutdown() {
    return shutdownPromise ??= (async () => {
      stopping = true;
      controller.abort();
      // Keep answering status until preparation and all owned processes finish.
      // Clients must not report Stop complete while the Web port is still alive.
      await Promise.all([tail, ...[...children].map((child) => stopChild(child))]);
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
      try {
        if (JSON.parse(readFileSync(paths.record, "utf8")).token === token) unlinkSync(paths.record);
      } catch { /* Already removed. */ }
    })();
  }
  mkdirSync(paths.directory, { recursive: true });
  if (process.platform !== "win32" && existsSync(paths.socket)) unlinkSync(paths.socket);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socket, resolve);
  });
  if (process.platform !== "win32") chmodSync(paths.socket, 0o600);
  const temporary = paths.record + `.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
  renameSync(temporary, paths.record);
  return { shutdown, status };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.PI_STATION_SERVICE_TOKEN;
  if (!token) throw new Error("Pi Station service must be started by its plugin");
  const service = await createStationService({ paths: stationPaths(), token });
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
    void service.shutdown().then(() => process.exit(0));
  });
}
