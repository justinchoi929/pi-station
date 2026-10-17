import { stationCommand } from "../bin/station-client.mjs";

const commands = ["web", "desktop", "stop", "status"];

export default function stationExtension(pi) {
  // Loading extensions also happens during model discovery. Start nothing here.
  pi.registerCommand("station", {
    description: "Open Pi Station Web/desktop, or stop its background service",
    getArgumentCompletions: (prefix) => commands.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const command = args.trim() || "web";
      if (!commands.includes(command)) {
        ctx.ui.notify("Usage: /station [web|desktop|stop|status]", "info");
        return;
      }
      ctx.ui.setStatus("pi-station", `Pi Station: ${command}…`);
      if (["web", "desktop"].includes(command)) ctx.ui.notify("Opening Pi Station. The first launch prepares its runtime and may take several minutes.", "info");
      try {
        const result = await stationCommand(command);
        const message = command === "stop"
          ? result.stopped ? "Pi Station stopped. Any independently started Web server remains running." : "No plugin-managed Pi Station service is running."
          : result.running ? `Pi Station: ${result.url}\nLog: ${result.log}` : "No plugin-managed Pi Station service is running.";
        ctx.ui.notify(message, "info");
      } catch (error) {
        ctx.ui.notify(`Pi Station: ${error.message}`, "error");
      } finally { ctx.ui.setStatus("pi-station", undefined); }
    },
  });
}
