// Pi Station desktop: a window onto the Pi Station web server. It attaches to a server
// already listening on the port (started with `npm run web` in a terminal, say) or starts
// one and keeps it running while the window is closed, until Quit. Browsers can use the
// same server at the same address meanwhile.
import { app, BrowserWindow, dialog, Menu, nativeImage, nativeTheme, shell, Tray } from "electron";
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

app.setName("Pi Station");

const PORT = process.env.PI_STATION_PORT || "30141";
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SERVER_START_TIMEOUT_MS = 90_000;
const SERVER_STOP_TIMEOUT_MS = 8_000;

let mainWindow = null;
// Held so the menu bar icon is not garbage collected; nothing reads it.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let tray = null;
let server = null; // the server child process, when this app started it
let quitting = false;

// Unpackaged, the server runs from this checkout. The packaged app holds only this
// folder: it runs the server from the checkout it was built from (desktop/dist.mjs
// records it). The server starts the pi executable from the login shell's PATH.
function stationRoot() {
  if (process.env.PI_STATION_HOME) return process.env.PI_STATION_HOME;
  if (!app.isPackaged) return dirname(dirname(fileURLToPath(import.meta.url)));
  return JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")).piStationHome;
}

// An app opened from Finder gets launchd's minimal PATH. The server and the commands
// pi runs need what a terminal has: take the login shell's environment.
function loginShellEnv() {
  const marker = "__PI_STATION_ENV__";
  try {
    const output = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", `printf '\\0${marker}\\0'; env -0`], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const entries = output.split(`\0${marker}\0`)[1].split("\0").filter(Boolean).map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    });
    return Object.fromEntries(entries);
  } catch {
    return { ...process.env };
  }
}

async function isServerUp() {
  try {
    const response = await fetch(`${ORIGIN}/manifest.webmanifest`, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

function startServer() {
  const root = stationRoot();
  const env = loginShellEnv();
  for (const name of Object.keys(env)) if (name.startsWith("ELECTRON_")) delete env[name];
  const log = createWriteStream(join(app.getPath("logs"), "server.log"), { flags: "a" });
  const child = spawn("node", [join(root, "bin/pi-web.js"), "--no-open", "--port", PORT], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on("exit", () => {
    if (server === child) server = null;
  });
  return child;
}

async function waitForServer(child) {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isServerUp()) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`The server exited (${child.exitCode ?? child.signalCode}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The server did not answer within ${SERVER_START_TIMEOUT_MS / 1000}s.`);
}

async function ensureServer() {
  if (await isServerUp()) return;
  server = startServer();
  await waitForServer(server);
}

function stopServer() {
  const child = server;
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, SERVER_STOP_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function isOwnUrl(url) {
  return url === ORIGIN || url.startsWith(`${ORIGIN}/`);
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: "Pi Station",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 12 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#262624" : "#faf9f5",
    show: false,
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.once("ready-to-show", () => window.show());
  // Links leave for the default browser; Pi Station's own pages open in a window of their own.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isOwnUrl(url)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isOwnUrl(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  // Closing hides the window; the server keeps running for browsers until Quit.
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  void window.loadURL(ORIGIN);
  return window;
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  else mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const icon = nativeImage.createFromPath(join(stationRoot(), "public/icons/icon-192.png")).resize({ width: 18, height: 18 });
  const instance = new Tray(icon);
  instance.setToolTip(`Pi Station - ${ORIGIN}`);
  instance.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Pi Station", click: showWindow },
    { label: "Open in Browser", click: () => void shell.openExternal(ORIGIN) },
    { type: "separator" },
    { label: "Quit Pi Station", click: () => app.quit() },
  ]));
  return instance;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);

  app.on("before-quit", (event) => {
    quitting = true;
    if (!server) return;
    event.preventDefault();
    void stopServer().then(() => app.quit());
  });

  app.whenReady().then(async () => {
    tray = createTray();
    try {
      await ensureServer();
    } catch (error) {
      dialog.showErrorBox(
        "Pi Station could not start its server",
        `${error instanceof Error ? error.message : String(error)}\n\nSee ${join(app.getPath("logs"), "server.log")}`,
      );
      app.quit();
      return;
    }
    showWindow();
    if (process.env.PI_STATION_CAPTURE) {
      // A screenshot of the window once it settles, for checking the layout without a person.
      setTimeout(async () => {
        const image = await mainWindow.webContents.capturePage();
        writeFileSync(process.env.PI_STATION_CAPTURE, image.toPNG());
        app.quit();
      }, Number(process.env.PI_STATION_CAPTURE_DELAY_MS || 8_000));
    }
  });
}
