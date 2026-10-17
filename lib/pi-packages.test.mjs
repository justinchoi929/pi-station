import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");
const packageLock = require("../package-lock.json");

// pi's packages depend on each other with `^` ranges, and an install of the
// published pi-web resolves them afresh: package-lock.json is not published.
// So every pi package in the tree is a direct dependency at the exact version
// locked here, which npm reuses for the SDK's own ranges. pi-web 0.12.0 pinned
// only four of them, and installs after pi 1.2.0 came out paired
// pi-coding-agent 1.1.0 with pi-codemode 1.2.0, which it cannot load.
// These packages adapt session files and settings only. The agent runtime is
// the independent CLI on PATH, never a sibling source checkout.
const PI_SCOPE = "@earendil-works/";

test("file-format adapters are pinned registry packages, independent of a pi checkout", () => {
  const nameOf = (path) => path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  const locked = Object.entries(packageLock.packages).filter(([path]) => nameOf(path).startsWith(PI_SCOPE));
  assert.ok(locked.length > 0, "the lockfile holds pi packages");
  for (const [path, entry] of locked) {
    const name = nameOf(path);
    assert.equal(path, `node_modules/${name}`, `${path}: a second copy of ${name}`);
    assert.match(entry.resolved, /^https:/, `${name} must come from the registry`);
    assert.equal(packageJson.dependencies[name], entry.version, `${name} must be pinned at ${entry.version}`);
  }
  for (const [name, version] of Object.entries(packageJson.dependencies)) {
    if (!name.startsWith(PI_SCOPE)) continue;
    assert.equal(packageLock.packages[`node_modules/${name}`]?.version, version, `${name} is declared but not locked at ${version}`);
  }
  assert.equal(packageJson.scripts["sync-pi"], undefined);
  assert.doesNotMatch(JSON.stringify(packageLock), /file:\.\.\/pi\//);
});
