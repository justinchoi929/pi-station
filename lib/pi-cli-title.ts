import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PiCliSession } from "./pi-cli-session";
import { PiRpcClient } from "./pi-rpc-client";
import { buildTitleTranscript, parseGeneratedSessionTitle, type GeneratedSessionTitle } from "./session-title";

/** Generate a name in an ephemeral CLI session, leaving the source conversation intact. */
export async function generateCliSessionTitle(source: PiCliSession): Promise<GeneratedSessionTitle> {
  const { messages } = await source.send({ type: "get_messages" }) as { messages: AgentMessage[] };
  const transcript = buildTitleTranscript(messages);
  if (!transcript.trim()) throw new Error("The session has no usable text to name");
  const state = await source.send({ type: "get_state" }) as { model?: { provider: string; id: string } };
  if (!state.model) throw new Error("No model is selected for title generation");
  const client = new PiRpcClient({
    cwd: source.cwd,
    args: ["--no-session", "--no-tools", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes",
      "--provider", state.model.provider, "--model", state.model.id, "--thinking", "off",
      "--system-prompt", "You name chat sessions. Return only a concise title in the user's primary language, without quotes or explanation."],
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Session title generation timed out")), 90_000);
      client.onEvent((event) => { if (event.type === "agent_settled") resolve(); });
      client.onClose(reject);
    });
    // Observe completion before submitting: a fast provider can settle before its acknowledgement.
    const submitted = client.request({ type: "prompt", message: `Name this conversation in at most 80 characters:\n\n${transcript}` }, 90_000);
    await Promise.all([submitted, completed]);
    const { messages: replies } = await client.request<{ messages: Array<{ role: string; stopReason?: string; errorMessage?: string }> }>({ type: "get_messages" });
    const last = replies.findLast((message) => message.role === "assistant");
    if (last?.stopReason === "error" || last?.stopReason === "aborted") throw new Error(last.errorMessage || "Title generation failed");
    const { text } = await client.request<{ text: string }>({ type: "get_last_assistant_text" });
    if (typeof text !== "string" || !text.trim()) throw new Error("The model did not return a session title");
    return { title: parseGeneratedSessionTitle(text) };
  } finally {
    if (timeout) clearTimeout(timeout);
    await client.shutdown();
  }
}
