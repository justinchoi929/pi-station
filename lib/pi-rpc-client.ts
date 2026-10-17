import type { ChildProcessWithoutNullStreams } from "node:child_process";
import spawn from "cross-spawn";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { delimiter, join, resolve } from "node:path";

export interface PiRpcRecord {
  type: string;
  id?: string;
  [key: string]: unknown;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

export function piExecutable(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.PI_STATION_PI?.trim() || "pi";
}

/** Keep the web server's environment out of pi and its project commands. */
export function piProcessEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const name of Object.keys(result)) {
    const key = name.toUpperCase();
    if (key === "NODE_ENV" || key === "PORT" || key === "PI_WEB_PASSWORD"
      || key.startsWith("NEXT_") || key.startsWith("ELECTRON_")) delete result[name];
  }
  // npm scripts prepend this project's .bin, which contains the file-adapter
  // SDK's pi shim. That shim must never shadow the user's installed CLI.
  const pathKey = Object.keys(result).find((name) => name.toUpperCase() === "PATH");
  if (pathKey) {
    const stationBin = resolve(join(process.cwd(), "node_modules", ".bin"));
    const comparable = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
    result[pathKey] = result[pathKey]?.split(delimiter).filter((entry) => entry && comparable(entry) !== comparable(stationBin)).join(delimiter);
  }
  return result;
}

export function readPiVersion(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolveVersion, reject) => {
    const child = spawn(piExecutable(environment), ["--version"], { env: piProcessEnvironment(environment), windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("pi version check timed out")); }, 10_000);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 64 * 1024) { child.kill("SIGKILL"); reject(new Error("pi version output is too large")); }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && output.trim()) resolveVersion(output.trim());
      else reject(new Error("pi version check failed"));
    });
  });
}

/** A single CLI process. Stdout is JSONL; stderr is bounded diagnostic text. */
export class PiRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(record: PiRpcRecord) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private diagnostics = "";
  private failure?: Error;
  private stopping = false;
  private stopPromise?: Promise<void>;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly closed: Promise<void>;

  constructor(options: { cwd: string; args?: string[]; environment?: NodeJS.ProcessEnv }) {
    const environment = options.environment ?? process.env;
    const executable = piExecutable(environment);
    this.child = spawn(executable, ["--mode", "rpc", ...options.args ?? []], {
      cwd: options.cwd,
      env: piProcessEnvironment(environment),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // No shell: executable paths and project paths may contain spaces.
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(this.decoder.write(chunk)));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.diagnostics = (this.diagnostics + chunk.toString("utf8")).slice(-8_192);
    });
    this.child.stdin.on("error", (error) => this.fail(new Error(`Could not write to pi: ${error.message}`)));
    this.child.once("error", (error: NodeJS.ErrnoException) => this.fail(new Error(error.code === "ENOENT"
      ? `Cannot find pi executable (${executable}). Install pi on PATH or set PI_STATION_PI to its executable path.`
      : `Could not start pi (${executable}): ${error.message}`)));
    this.closed = new Promise((resolve) => this.child.once("close", (code, signal) => {
      const detail = this.diagnostics.trim();
      this.fail(new Error(`pi exited (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`));
      resolve();
    }));
  }

  get alive(): boolean { return !this.failure && !this.stopping; }

  onEvent(listener: (record: PiRpcRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    if (this.failure) listener(this.failure);
    return () => this.closeListeners.delete(listener);
  }

  async request<T = unknown>(command: PiRpcRecord, timeoutMs = 30_000): Promise<T> {
    if (!this.alive) throw this.failure ?? new Error("pi is shutting down");
    const id = randomUUID();
    const result = new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = { resolve: (data) => resolve(data as T), reject };
      if (timeoutMs > 0) entry.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi command timed out: ${command.type}`));
      }, timeoutMs);
      this.pending.set(id, entry);
    });
    void this.write({ ...command, id }).catch((error: unknown) => {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error instanceof Error ? error : new Error(String(error)));
    });
    return result;
  }

  /** Extension replies do not produce an RPC response. */
  write(record: PiRpcRecord): Promise<void> {
    const operation = this.writeTail.then(() => new Promise<void>((resolve, reject) => {
      if (!this.alive) { reject(this.failure ?? new Error("pi is shutting down")); return; }
      this.child.stdin.write(`${JSON.stringify(record)}\n`, (error) => error ? reject(error) : resolve());
    }));
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    // Only LF separates records. U+2028/U+2029 are valid JSON string content.
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let record: PiRpcRecord;
      try {
        record = JSON.parse(line) as PiRpcRecord;
        if (!record || typeof record.type !== "string") throw new Error("Missing record type");
      } catch {
        this.fail(new Error("pi wrote an invalid JSONL record to stdout"));
        this.child.kill("SIGTERM");
        return;
      }
      if (record.type === "response") {
        const entry = record.id ? this.pending.get(record.id) : undefined;
        if (!entry) continue;
        this.pending.delete(record.id!);
        if (entry.timer) clearTimeout(entry.timer);
        if (record.success === false) entry.reject(new Error(String(record.error ?? "pi command failed")));
        else entry.resolve(record.data);
      } else {
        for (const listener of this.listeners) {
          try { listener(record); } catch (error) { console.error("[pi-station] RPC event listener failed:", error); }
        }
      }
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener(error);
  }

  shutdown(deadlineMs = 5_000): Promise<void> {
    return this.stopPromise ??= this.stop(deadlineMs);
  }

  private async stop(deadlineMs: number): Promise<void> {
    this.stopping = true;
    this.child.stdin.end();
    const terminate = setTimeout(() => this.child.kill("SIGTERM"), deadlineMs);
    const kill = setTimeout(() => this.child.kill("SIGKILL"), deadlineMs + 1_000);
    try { await this.closed; } finally { clearTimeout(terminate); clearTimeout(kill); }
  }

  destroy(): void {
    this.stopping = true;
    this.child.kill("SIGTERM");
  }
}
