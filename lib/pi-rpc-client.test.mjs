import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { PiRpcClient, piExecutable, piProcessEnvironment, readPiVersion } = await createJiti(import.meta.url).import("./pi-rpc-client.ts");

async function client(t, source) {
  const root = await mkdtemp(join(tmpdir(), "station-rpc-"));
  const executable = join(root, "pi fixture");
  await writeFile(executable, `#!${process.execPath}\n${source}`);
  await chmod(executable, 0o700);
  const rpc = new PiRpcClient({ cwd: root, environment: { ...process.env, PI_STATION_PI: executable } });
  t.after(async () => { await rpc.shutdown(50); await rm(root, { recursive: true, force: true }); });
  return rpc;
}

const readCommands = `let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\\n')) !== -1) {
    const command = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    handle(command);
  }
});
process.stdin.on('end', () => process.exit(0));
`;

test("resolves the executable from PATH by default and accepts an exact override", () => {
  assert.equal(piExecutable({}), "pi");
  assert.equal(piExecutable({ PI_STATION_PI: " /a path/pi " }), "/a path/pi");
  const env = piProcessEnvironment({ PATH: "/bin", NODE_ENV: "production", PORT: "3000", NEXT_SECRET: "secret", PI_WEB_PASSWORD: "secret", OPENAI_API_KEY: "provider", PI_CODING_AGENT_DIR: "/agent" });
  assert.deepEqual(env, { PATH: "/bin", OPENAI_API_KEY: "provider", PI_CODING_AGENT_DIR: "/agent" });
  assert.equal(piProcessEnvironment({ PATH: [join(process.cwd(), "node_modules/.bin"), "/user/bin", "/bin"].join(delimiter) }).PATH, ["/user/bin", "/bin"].join(delimiter));
});

test("correlates out-of-order responses and reads split UTF-8 and Unicode separators", async (t) => {
  const rpc = await client(t, `${readCommands}
function handle(command) {
  const bytes = Buffer.from(JSON.stringify({id:command.id,type:'response',success:true,data:command.value})+'\\r\\n');
  setTimeout(() => { process.stdout.write(bytes.subarray(0, 13)); setTimeout(()=>process.stdout.write(bytes.subarray(13)), 1); }, command.delay);
}`);
  const results = await Promise.all([
    rpc.request({ type: "echo", value: "中文\u2028A\u2029B", delay: 40 }),
    rpc.request({ type: "echo", value: "second", delay: 0 }),
  ]);
  assert.deepEqual(results, ["中文\u2028A\u2029B", "second"]);
});

test("npm's local SDK shim cannot shadow the external pi executable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "station-external-pi-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "pi");
  await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write('external-fixture\\n');`);
  await chmod(executable, 0o700);
  const environment = { ...process.env, PATH: [join(process.cwd(), "node_modules/.bin"), root, process.env.PATH].join(delimiter) };
  delete environment.PI_STATION_PI;
  assert.equal(await readPiVersion(environment), "external-fixture");
});

test("forwards events separately from command failures and applies request deadlines", async (t) => {
  const rpc = await client(t, `${readCommands}
function handle(command) {
  if (command.type === 'hang') return;
  process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n');
  process.stdout.write(JSON.stringify({id:command.id,type:'response',success:false,error:'fixture rejection'})+'\\n');
}`);
  const events = [];
  rpc.onEvent((event) => events.push(event.type));
  await assert.rejects(rpc.request({ type: "fail" }), /fixture rejection/);
  assert.deepEqual(events, ["agent_start"]);
  await assert.rejects(rpc.request({ type: "hang" }, 25), /timed out: hang/);
});

test("a missing executable and an unexpected exit reject pending requests", async (t) => {
  const missing = new PiRpcClient({ cwd: tmpdir(), environment: { ...process.env, PI_STATION_PI: join(tmpdir(), "station-no-such-pi-executable") } });
  await assert.rejects(missing.request({ type: "get_state" }), /Cannot find pi executable/);
  await missing.shutdown(50);
  const rpc = await client(t, `${readCommands}\nfunction handle() { process.stderr.write('fixture crashed'); process.exit(7); }`);
  await assert.rejects(rpc.request({ type: "get_state" }), /pi exited \(7\): fixture crashed/);
});

test("shutdown closes stdin and escalates if the CLI ignores graceful shutdown", async (t) => {
  const rpc = await client(t, `process.on('SIGTERM', () => {}); process.stdin.resume(); setInterval(()=>{},1000);`);
  const started = Date.now();
  await rpc.shutdown(25);
  assert.equal(rpc.alive, false);
  assert.ok(Date.now() - started < 3_000);
});
