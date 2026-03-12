import type { ThreadItem } from "@openai/codex-sdk";

export function buildSpeechPrompt(text: string, steer?: string) {
  return [
    "Speak the following text naturally.",
    "Do not add, remove, or change facts.",
    steer ? `Style instruction: ${steer}` : "",
    `Text: ${text}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function summarizeCommandResult(item: Extract<ThreadItem, { type: "command_execution" }>) {
  const output = item.aggregated_output.trim();
  const snippet = output.length > 180 ? `${output.slice(0, 177)}...` : output;
  return snippet
    ? `${item.command} exited with ${item.exit_code ?? 0}: ${snippet}`
    : `${item.command} exited with ${item.exit_code ?? 0}.`;
}

export function summarizeFileChange(item: Extract<ThreadItem, { type: "file_change" }>) {
  return `${item.changes.length} file change${item.changes.length === 1 ? "" : "s"} ${item.status === "completed" ? "applied" : "failed"}.`;
}

export function summarizeMcpResult(item: Extract<ThreadItem, { type: "mcp_tool_call" }>) {
  if (item.status !== "completed") {
    return item.error?.message ?? `${item.tool} failed.`;
  }
  if (item.tool === "speak_to_user") {
    const spokenText =
      (item.result?.structured_content as { spokenText?: string } | undefined)?.spokenText?.trim() ?? "";
    return spokenText || "Spoke to the user.";
  }
  return `${item.server}:${item.tool} completed successfully.`;
}

export function describeAutoProgress(toolName: string, summary: string) {
  const normalized = summary.toLowerCase();
  if (normalized.includes("moodle") && normalized.includes("timetable")) {
    return "Ich rufe gerade deinen Moodle-Stundenplan ab und warte auf die Ausgabe.";
  }
  if (normalized.includes("skill.md") || normalized.includes("agents.md")) {
    return "Ich lese gerade die passenden Anleitungen und Skills fuer diesen Schritt.";
  }
  if (toolName === "codex_patch") {
    return "Ich schreibe gerade die benoetigten Aenderungen in die Dateien.";
  }
  if (toolName === "codex_command") {
    return "Ich fuehre gerade einen Befehl aus und warte auf das Ergebnis.";
  }
  return "Ich arbeite gerade am naechsten Schritt und gebe dir gleich das Ergebnis.";
}

export function resolvePlutoTextModel(audioModel: string) {
  const normalized = audioModel.replace(/^models\//, "");
  if (normalized.includes("native-audio") || normalized.includes("live")) {
    return "gemini-2.5-flash";
  }
  return normalized;
}

export function extractResponseText(response: { text?: string | null; candidates?: Array<{ content?: { parts?: Array<{ text?: string | null }> } }> }) {
  if (typeof response.text === "string" && response.text.trim().length > 0) {
    return response.text.trim();
  }

  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.text?.trim()) {
        return part.text.trim();
      }
    }
  }

  return "";
}
