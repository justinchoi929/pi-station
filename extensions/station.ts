import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { stationCommand } from "../bin/station-client.mjs";

const commands = ["web", "desktop", "stop", "status"];
const statusEntryType = "pi-station:status";

function stationAutocomplete(current: AutocompleteProvider): AutocompleteProvider {
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

function statusLines(result: Awaited<ReturnType<typeof stationCommand>>) {
  const web = result.webStatus === "station"
    ? `${result.url} (${result.webOwned ? "plugin-managed" : "independently started"})`
    : result.webStatus === "absent" ? "not running" : "port occupied or inaccessible";
  return [
    "Pi Station status",
    `Web: ${web}`,
    `Desktop: ${result.desktop ? "running" : "not running"}`,
    `Log: ${result.log}`,
  ];
}

export default function stationExtension(pi: ExtensionAPI) {
  // Loading extensions also happens during model discovery. Start nothing here.
  pi.registerEntryRenderer<{ text?: string; level?: string }>(statusEntryType, (entry, _options, theme) => {
    const text = entry.data?.text;
    if (typeof text !== "string") return;
    return new Text(entry.data?.level === "error" ? theme.fg("error", text) : text, 1, 0);
  });
  const replyToStatus = (ctx: ExtensionContext, text: string, level: "info" | "error" = "info") => {
    if (ctx.mode === "tui") {
      // Custom entries are transcript items, excluded from model context by pi.
      pi.appendEntry(statusEntryType, { text, level });
    } else ctx.ui.notify(text, level);
  };
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
      // Clear the fixed status panel left by older versions.
      ctx.ui.setWidget("pi-station", undefined);
      ctx.ui.setStatus("pi-station", `Pi Station: ${command}…`);
      if (["web", "desktop"].includes(command)) ctx.ui.notify("Opening Pi Station. The first launch prepares its runtime and may take several minutes.", "info");
      try {
        const result = await stationCommand(command);
        if (command === "status") {
          replyToStatus(ctx, statusLines(result).join("\n"));
          return;
        }
        const message = command === "stop"
          ? result.stopped ? "Pi Station stopped. Any independently started Web server remains running." : "No plugin-managed Pi Station service is running."
          : result.running ? `Pi Station: ${result.url}\nLog: ${result.log}` : "No plugin-managed Pi Station service is running.";
        ctx.ui.notify(message, "info");
      } catch (error) {
        const message = `Pi Station: ${error instanceof Error ? error.message : String(error)}`;
        if (command === "status") replyToStatus(ctx, message, "error");
        else ctx.ui.notify(message, "error");
      } finally { ctx.ui.setStatus("pi-station", undefined); }
    },
  });
}
