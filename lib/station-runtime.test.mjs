import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import lockfile from "proper-lockfile";
import { runtimeDigest, runtimeSources, prepareRuntime } from "../bin/station-runtime.mjs";

function sourceFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "station-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "source");
  mkdirSync(root);
  for (const name of runtimeSources) {
    if (name.includes(".")) writeFileSync(join(root, name), "fixture");
    else { mkdirSync(join(root, name)); writeFileSync(join(root, name, "index.js"), "fixture"); }
  }
  mkdirSync(join(root, "runtime"));
  for (const name of ["package.json", "package-lock.json"]) writeFileSync(join(root, "runtime", name), "{}");
  return { directory, root };
}

test("runtime updates invalidate cached builds while unrelated docs and test edits do not", (t) => {
  const { root } = sourceFixture(t);
  const before = runtimeDigest(root);
  writeFileSync(join(root, "README.md"), "new docs");
  writeFileSync(join(root, "lib/new.test.mjs"), "new tests");
  assert.equal(runtimeDigest(root), before);
  writeFileSync(join(root, "app/index.js"), "updated UI");
  assert.notEqual(runtimeDigest(root), before);
});

test("Stop aborts waiting for another runtime build without installing dependencies", async (t) => {
  const { root, directory } = sourceFixture(t);
  const node = { path: process.execPath, version: process.versions.node };
  const target = join(directory, "runtimes", `${runtimeDigest(root)}-${process.platform}-${process.arch}-${node.version}`);
  mkdirSync(target, { recursive: true });
  const release = await lockfile.lock(target);
  t.after(async () => release());
  const controller = new AbortController();
  const preparing = prepareRuntime(directory, node, {}, root, controller.signal);
  const rejected = assert.rejects(preparing, { name: "AbortError" });
  setTimeout(() => controller.abort(), 30);
  await rejected;
  assert.equal(existsSync(join(target, "node_modules")), false);
  assert.equal(existsSync(join(target, ".station-ready")), false);
});
