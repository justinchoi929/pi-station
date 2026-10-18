import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import lockfile from "proper-lockfile";
import { cleanEnvironment, findNode, packageRoot, probeStation, readServiceRecord, serviceRequest, stationPaths } from "./station-common.mjs";

export async function stationCommand(command, environment = process.env) {
  if (!["web", "desktop", "stop", "status"].includes(command)) throw new Error("Use /station web, desktop, stop or status");
  const paths = stationPaths(environment);
  mkdirSync(paths.directory, { recursive: true });
  const release = await lockfile.lock(paths.directory, { lockfilePath: paths.record + ".lock", retries: { retries: 20, minTimeout: 200, maxTimeout: 500 } });
  let record;
  try {
    record = readServiceRecord(paths);
    if (record) {
      try { await serviceRequest(paths, record.token, "status"); }
      catch (error) {
        // Never signal a PID from a stale file: it may now belong to another app.
        if (!["ECONNREFUSED", "ENOENT"].includes(error.code)) throw error;
        record = null;
      }
    }
    if (!record && ["stop", "status"].includes(command)) return {
      running: false, log: paths.log,
      ...(command === "status" ? { webStatus: await probeStation(paths.url, environment), url: paths.url } : {}),
    };
    if (!record) {
      const node = findNode(environment);
      const token = randomBytes(32).toString("hex");
      const log = openSync(paths.log, "a", 0o600);
      const child = spawn(node.path, [join(packageRoot, "bin/station-service.mjs")], {
        cwd: packageRoot, env: { ...cleanEnvironment(environment), PI_CODING_AGENT_DIR: dirname(paths.directory), PI_STATION_SERVICE_TOKEN: token },
        detached: true, stdio: ["ignore", log, log], windowsHide: true,
      });
      let failure;
      child.once("error", (error) => { failure = error; });
      closeSync(log);
      child.unref();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        try {
          await serviceRequest(paths, token, "status");
          record = { token };
          break;
        } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
      }
      if (!record) throw new Error(`Pi Station service did not start. See ${paths.log}`);
    }
  } finally { await release(); }
  let result;
  try { result = await serviceRequest(paths, record.token, command, 20 * 60_000); }
  catch (error) { throw new Error(`${error.message}\nLog: ${paths.log}`, { cause: error }); }
  if (command === "stop") {
    // The response acknowledges shutdown; wait for the control socket to close.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try { await serviceRequest(paths, record.token, "status"); }
      catch { return { ...result, running: false, log: paths.log }; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Pi Station is still stopping. See ${paths.log}`);
  }
  return { ...result, running: true, log: paths.log,
    ...(command === "status" ? { webStatus: await probeStation(paths.url, environment) } : {}),
  };
}
