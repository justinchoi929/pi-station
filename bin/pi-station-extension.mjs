// Loaded by the user's pi CLI. Uses only its public extension API; no SDK imports.
// Replies travel through the standard RPC notify record and never enter history.
export const BRIDGE_COMMAND = "__pi_station";
export const BRIDGE_PREFIX = "pi-station:rpc:";
const CODING_TOOLS = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);

export default function stationExtension(pi) {
  let toolSelection;

  function applySelection() {
    if (!toolSelection) return;
    const all = pi.getAllTools();
    const allowed = new Set(all.filter((tool) => tool.exposure !== "hidden").map((tool) => tool.name));
    const carry = pi.getActiveTools().filter((name) => !CODING_TOOLS.has(name));
    pi.setActiveTools([...new Set([...toolSelection, ...carry])].filter((name) => allowed.has(name)));
  }

  pi.on("session_start", (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const pin = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === "pi-web:tool-selection");
    toolSelection = pin?.data?.cleared ? undefined : pin?.data?.tools;
    applySelection();
  });
  pi.on("session_tree", applySelection);
  pi.on("tool_call", (event) => {
    if (!toolSelection || toolSelection.some((name) => ["bash", "powershell", "write", "edit"].includes(name))) return;
    if (!event.toolName.startsWith("mcp__")) return;
    const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
    if (tool?.annotations?.readOnlyHint !== true) return { block: true, reason: "MCP tool is not marked read-only" };
  });

  pi.registerCommand(BRIDGE_COMMAND, {
    description: "Pi Station client transport",
    handler: async (args, ctx) => {
      let request;
      const ui = ctx.ui;
      try {
        request = JSON.parse(args);
        let data;
        switch (request.operation) {
          case "models":
            data = {
              models: ctx.scopedModels.length ? ctx.scopedModels.map((item) => item.model) : ctx.modelRegistry.getAvailable().sort((a, b) => a.provider.localeCompare(b.provider)),
              thinkingLevelPins: Object.fromEntries(ctx.scopedModels.filter((item) => item.thinkingLevel).map((item) => [`${item.model.provider}/${item.model.id}`, item.thinkingLevel])),
              defaultModel: ctx.model,
              defaultThinkingLevel: pi.getThinkingLevel(),
              savedDefaultThinkingLevel: pi.getSettings().defaultThinkingLevel ?? null,
              modelError: ctx.modelRegistry.getError(),
            };
            break;
          case "inspect": {
            const active = new Set(pi.getActiveTools());
            data = {
              contextUsage: ctx.getContextUsage() ?? null,
              systemPrompt: ctx.getSystemPrompt(),
              tools: pi.getAllTools().filter((tool) => tool.exposure !== "hidden").map((tool) => ({ ...tool, active: active.has(tool.name) })),
              settings: pi.getSettings(),
            };
            break;
          }
          case "set_tools":
            if (!ctx.isIdle()) throw new Error("Cannot change tools while the session is running");
            toolSelection = request.tools;
            pi.appendEntry("pi-web:tool-selection", { version: 1, tools: toolSelection });
            applySelection();
            data = null;
            break;
          case "navigate_tree":
            if (!ctx.isIdle()) throw new Error("Cannot navigate while the session is running");
            {
            const target = ctx.sessionManager.getEntry(request.targetId);
            const content = target?.type === "message" && target.message.role === "user" ? target.message.content : undefined;
            const editorText = typeof content === "string" ? content : Array.isArray(content)
              ? content.filter((block) => block.type === "text").map((block) => block.text).join("\n") : undefined;
            data = await ctx.navigateTree(request.targetId, { summarize: request.summarize === true });
            if (editorText !== undefined) data = { ...data, editorText };
            applySelection();
            }
            break;
          case "reload":
            if (!ctx.isIdle()) throw new Error("Wait for the current response to finish before reloading.");
            await ctx.reload();
            data = null;
            break;
          default:
            throw new Error(`Unsupported station operation: ${request.operation}`);
        }
        ui.notify(BRIDGE_PREFIX + JSON.stringify({ id: request.id, success: true, data }));
      } catch (error) {
        ui.notify(BRIDGE_PREFIX + JSON.stringify({ id: request?.id, success: false, error: error instanceof Error ? error.message : String(error) }));
      }
    },
  });
}
