import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import spawn from "cross-spawn";

const require = createRequire(import.meta.url);
const { getAgentDir } = require("./run-records.js");
const { isNodeVersionSupported } = require("./node-version.js");
export const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function stationPaths(environment = process.env) {
  const port = Number(environment.PI_STATION_PORT || 30141);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PI_STATION_PORT must be between 1 and 65535");
  const directory = resolve(getAgentDir(environment), "pi-station");
  const key = createHash("sha256").update(directory).digest("hex").slice(0, 16);
  return {
    directory, port, url: `http://127.0.0.1:${port}`,
    record: join(directory, `service-${port}.json`),
    log: join(directory, `service-${port}.log`),
    socket: process.platform === "win32" ? `\\\\.\\pipe\\pi-station-${key}-${port}` : join(tmpdir(), `pi-station-${key}-${port}.sock`),
  };
}

export function readServiceRecord(paths) {
  try { return JSON.parse(readFileSync(paths.record, "utf8")); } catch { return null; }
}

export function cleanEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) =>
    name !== "NODE_ENV" && name !== "PI_STATION_SERVICE_TOKEN" && !name.startsWith("ELECTRON_")));
}

export function terminateChild(child, signal = "SIGTERM") {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32") { child.kill(signal); return; }
  // Windows signals terminate only the launcher, leaving Next/npm children alive.
  const result = spawn.sync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, encoding: "utf8", timeout: 10_000 });
  if (result.error) throw result.error;
  if (result.status !== 0 && child.exitCode === null) throw new Error(`Could not stop Pi Station child process ${child.pid}`);
}

// pi may itself be a standalone binary. Always locate a real Node runtime.
export function findNode(environment = process.env) {
  const result = spawn.sync("node", ["-p", "JSON.stringify({path:process.execPath,version:process.versions.node})"], {
    env: cleanEnvironment(environment), encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error("Pi Station requires Node.js 22.19.0 or newer on PATH");
  const node = JSON.parse(result.stdout.trim());
  if (!isNodeVersionSupported(node.version)) throw new Error(`Pi Station requires Node.js 22.19.0 or newer (found ${node.version})`);
  return node;
}

export function serviceRequest(paths, token, command, timeout = 2_000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ command });
    const req = request({ socketPath: paths.socket, path: "/", method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body),
    } }, (response) => {
      let output = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        output += chunk;
        if (output.length > 64 * 1024) req.destroy(new Error("Pi Station control response is too large"));
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const data = JSON.parse(output);
          if (response.statusCode !== 200) throw new Error(data.error || "Pi Station control request failed");
          resolve(data);
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("Pi Station command timed out")), timeout);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end(body);
  });
}

export async function probeStation(url, environment = process.env) {
  try {
    const headers = environment.PI_WEB_PASSWORD
      ? { authorization: `Basic ${Buffer.from(`pi:${environment.PI_WEB_PASSWORD}`).toString("base64")}` } : {};
    const response = await fetch(`${url}/api/station`, { headers, signal: AbortSignal.timeout(2_000), redirect: "error" });
    if (response.status === 404) { await response.body?.cancel(); return "other"; }
    if (!response.ok) { await response.body?.cancel(); return "other"; }
    const data = await response.json();
    return data.application === "pi-station" ? "station" : "other";
  } catch (error) {
    return error.cause?.code === "ECONNREFUSED" ? "absent" : "other";
  }
}
