import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import lockfile from "proper-lockfile";
import spawn from "cross-spawn";
import { cleanEnvironment, packageRoot, terminateChild } from "./station-common.mjs";

export const runtimeSources = ["app", "components", "hooks", "lib", "public", "bin", "desktop",
  "next.config.ts", "tsconfig.json", "postcss.config.mjs", "tailwind.config.ts", "proxy.ts",
  "instrumentation.ts", "instrumentation-node.ts"];
const electronVersion = "44.8.0";

function includeSource(path) {
  return !path.endsWith(".test.mjs") && !path.endsWith(".test.ts") && !path.endsWith(".test.tsx");
}

export function runtimeDigest(root = packageRoot) {
  const hash = createHash("sha256");
  function visit(path) {
    const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = join(path, entry.name);
      if (!includeSource(file)) continue;
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) hash.update(relative(root, file)).update("\0").update(readFileSync(file)).update("\0");
      else throw new Error(`Unsupported runtime source: ${relative(root, file)}`);
    }
  }
  for (const name of runtimeSources) {
    const path = join(root, name);
    if (existsSync(path) && !name.includes(".")) visit(path);
    else hash.update(name).update("\0").update(readFileSync(path)).update("\0");
  }
  for (const name of ["package.json", "package-lock.json"]) hash.update(readFileSync(join(root, "runtime", name)));
  return hash.digest("hex").slice(0, 20);
}

function run(command, args, cwd, environment, signal, timeout = 15 * 60_000) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(command, args, { cwd, env: cleanEnvironment(environment), stdio: "inherit", windowsHide: true });
    let killTimer;
    let failure;
    const terminate = () => {
      failure ??= new Error(signal?.aborted ? "Pi Station preparation cancelled" : "Pi Station preparation timed out");
      try { terminateChild(child); } catch (error) { console.error(error.message); }
      killTimer ??= setTimeout(() => { try { terminateChild(child, "SIGKILL"); } catch (error) { console.error(error.message); } }, 8_000);
    };
    const timer = setTimeout(terminate, timeout);
    signal?.addEventListener("abort", terminate, { once: true });
    const clear = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", terminate); };
    child.once("error", (error) => {
      failure ??= error;
      if (!child.pid) { clear(); reject(error); }
    });
    child.once("exit", (code, signal) => {
      clear();
      if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(new Error(`${command} ${args[0]} failed (${signal || code}); see the Pi Station service log`));
    });
  });
}

async function withLock(directory, action, signal) {
  mkdirSync(directory, { recursive: true });
  const deadline = Date.now() + 10 * 60_000;
  let release;
  while (!release) {
    signal?.throwIfAborted();
    try { release = await lockfile.lock(directory); }
    catch (error) {
      if (error.code !== "ELOCKED" || Date.now() > deadline) throw error;
      await wait(1000, undefined, { signal });
    }
  }
  try { signal?.throwIfAborted(); return await action(); } finally { await release(); }
}

export async function prepareRuntime(directory, node, environment = process.env, root = packageRoot, signal) {
  const digest = runtimeDigest(root);
  const target = join(directory, "runtimes", `${digest}-${process.platform}-${process.arch}-${node.version}`);
  return withLock(target, async () => {
    const ready = join(target, ".station-ready");
    if (existsSync(ready) && readFileSync(ready, "utf8") === digest && existsSync(join(target, ".next", "BUILD_ID"))) return target;
    console.log("[pi-station] Preparing Web runtime:", target);
    for (const name of runtimeSources) cpSync(join(root, name), join(target, name), { recursive: true, filter: includeSource });
    for (const name of ["package.json", "package-lock.json"]) cpSync(join(root, "runtime", name), join(target, name));
    await run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], target, environment, signal);
    await run(node.path, [join(target, "node_modules/next/dist/bin/next"), "build", "--webpack"], target, { ...environment, NEXT_TELEMETRY_DISABLED: "1" }, signal);
    writeFileSync(ready, digest);
    return target;
  }, signal);
}

export async function prepareElectron(directory, environment = process.env, signal) {
  const target = join(directory, "desktop", `${electronVersion}-${process.platform}-${process.arch}`);
  return withLock(target, async () => {
    const require = createRequire(join(target, "package.json"));
    function executable() {
      try {
        if (require("electron/package.json").version !== electronVersion) return null;
        const path = require("electron");
        return existsSync(path) ? path : null;
      } catch { return null; }
    }
    if (executable()) return executable();
    console.log("[pi-station] Installing Electron", electronVersion);
    writeFileSync(join(target, "package.json"), JSON.stringify({ name: "pi-station-desktop-runtime", private: true, dependencies: { electron: electronVersion } }));
    await run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], target, environment, signal);
    const path = executable();
    if (!path) throw new Error("Electron binary is missing; check whether npm install scripts are disabled");
    return path;
  }, signal);
}
