import { stationCommand } from "../bin/station-client.mjs";

const commands = ["web", "desktop", "stop", "status"];

function stationAutocomplete(current) {
  return {
    triggerCharacters: current.triggerCharacters,
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      const text = lines[0]?.slice(0, cursorCol) ?? "";
      if (!suggestions || lines.length !== 1 || cursorLine !== 0 || !text.startsWith("/station ")
        || lines[0].slice(cursorCol).trim() || suggestions.prefix !== text.slice("/station ".length)
        || suggestions.items.some((item) => !commands.includes(item.value))) return suggestions;
      // Whole-command suggestions submit on Enter; Tab still only completes.
      return {
        ...suggestions, prefix: text,
        items: suggestions.items.map((item) => ({ ...item, value: `station ${item.value}` })),
      };
    },
    applyCompletion: (...args) => current.applyCompletion(...args),
    shouldTriggerFileCompletion: (...args) => current.shouldTriggerFileCompletion?.(...args) ?? true,
  };
}

function statusLines(result) {
  const web = result.webStatus === "station"
    ? `${result.url} (${result.webOwned ? "plugin-managed" : "independently started"})`
    : result.webStatus === "absent" ? "not running" : "port occupied or inaccessible";
  return [
    "Pi Station status",
    `CLI: ${result.stopping ? "stopping" : result.running ? "running" : "not running"}`,
    `Web: ${web}`,
    `Desktop: ${result.desktop ? "running" : "not running"}`,
    `Log: ${result.log}`,
  ];
}

export default function stationExtension(pi) {
  // Loading extensions also happens during model discovery. Start nothing here.
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.addAutocompleteProvider(stationAutocomplete);
  });
  pi.registerCommand("station", {
    description: "Open Pi Station Web/desktop, or stop its background service",
    getArgumentCompletions: (prefix) => commands.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const command = args.trim() || "web";
      if (!commands.includes(command)) {
        ctx.ui.notify("Usage: /station [web|desktop|stop|status]", "info");
        return;
      }
      ctx.ui.setWidget("pi-station", undefined);
      ctx.ui.setStatus("pi-station", `Pi Station: ${command}…`);
      if (["web", "desktop"].includes(command)) ctx.ui.notify("Opening Pi Station. The first launch prepares its runtime and may take several minutes.", "info");
      try {
        const result = await stationCommand(command);
        if (command === "status") {
          // Keep the report beside the editor instead of a replaceable chat notice.
          ctx.ui.setWidget("pi-station", statusLines(result));
          return;
        }
        const message = command === "stop"
          ? result.stopped ? "Pi Station stopped. Any independently started Web server remains running." : "No plugin-managed Pi Station service is running."
          : result.running ? `Pi Station: ${result.url}\nLog: ${result.log}` : "No plugin-managed Pi Station service is running.";
        ctx.ui.notify(message, "info");
      } catch (error) {
        if (command === "status") ctx.ui.setWidget("pi-station", ["Pi Station status failed", String(error.message)]);
        ctx.ui.notify(`Pi Station: ${error.message}`, "error");
      } finally { ctx.ui.setStatus("pi-station", undefined); }
    },
  });
}
