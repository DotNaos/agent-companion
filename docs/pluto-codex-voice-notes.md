# Pluto Codex Voice Notes

Status: working notes and target architecture as of 2026-03-12.

This document captures the current direction for Pluto so the plan and implementation context do not get lost mid-iteration.

## Core Direction

- Codex should be the only assistant brain for Pluto.
- Use the official Codex SDK, not a Gemini-native reasoning loop, to run the assistant on the local machine.
- Default Codex model: `gpt-5.4`.
- Gemini remains in the stack only for speech input and speech output when audio is enabled.
- When audio is off, Pluto should not call Gemini at all. Text chat should go straight to Codex and the UI should render Codex output directly.

## SDK vs MCP

The intended runtime split is:

- Codex SDK for embedding and thread control.
- MCP for custom tools that Codex can call.

That means the answer to "codex mcp or codex sdk?" is: use the Codex SDK as the main integration, and still expose local capabilities to Codex through MCP where structured tools are needed.

For Pluto, the main custom tool is a Gemini speech bridge:

- `speak_to_user({ text, mode, steer?, kind })`

This is not the assistant brain. It is a Codex-callable local tool used only to deliver spoken output.

## Intended User Experience

### Audio off

- User chats directly with Codex.
- No Gemini reasoning.
- No Gemini speech calls.
- The desktop UI should be explicit that the assistant is Codex.

### Audio on

- User still talks to the same Codex thread.
- Spoken input is transcribed and committed as a normal user turn into Codex.
- Codex decides what to do, uses tools, edits files, runs commands, and produces the actual answer.
- User-facing spoken output must go through the Gemini speech bridge tool.
- Visible Codex text remains available as fallback/debug output if speech fails.

## Gemini Speech Bridge

Codex needs a single structured tool for spoken delivery:

- `text: string`
- `mode: "plain" | "summarize"`
- `steer?: string`
- `kind: "final" | "progress"`

Expected behavior:

- `plain`: Gemini should speak the submitted text as-is.
- `summarize`: Gemini may shorten for speech, but must preserve actions, blockers, risks, and commitments.
- `steer`: optional style instruction from Codex for tone or brevity.
- `kind="progress"`: only for meaningful progress updates, not every internal step.

Expected result shape:

- `spokenText`
- `deliveryId`
- `audioAvailable`
- optional failure details

If Gemini delivery fails, the Codex response must still complete in the UI. Spoken output is optional delivery, not the source of truth.

## Voice Input Model

V1 should be text-turn-based internally:

- open mic UX
- partial transcripts in the UI
- final transcript committed into the Codex thread
- spoken playback after Codex answers
- interruption support

This is duplex at the UX layer, not model-native speech-to-speech reasoning.

If the user interrupts while Gemini is speaking:

- stop playback immediately
- keep the Codex thread alive
- start the next user turn from the new transcript

## Skills and Memory

Pluto should not maintain a separate long-term skills system when Codex already has one.

Source of truth for skills:

- repo `AGENTS.md`
- project `.codex/config.toml`
- user `~/.codex/config.toml`
- installed skill folders with `SKILL.md`

This matters for cases like Moodle CLI: the goal is for Codex to see the skill directly and use it naturally, instead of Pluto re-implementing a second skill runtime.

Pluto-side state should stay lightweight and focused on:

- session metadata
- audio state
- UI/session routing

## Chat SDK

`https://chat-sdk.dev/docs` may be useful later for richer chat surfaces, but it is not the core requirement for this Pluto runtime change.

Current decision:

- do not block Pluto's Codex/Gemini architecture on Chat SDK
- revisit it later if the desktop chat surface needs better UI primitives

## Target Architecture Sketch

```text
User types or speaks
        |
        v
desktop companion / local runner
        |
        +--> Gemini live session for STT only when audio is on
        |
        v
Codex SDK thread
  - same thread for typed and spoken turns
  - runs tools / commands / edits
  - owns the actual assistant reasoning
        |
        +--> local MCP tool: speak_to_user(...)
                  |
                  v
              Gemini speech delivery
```

## Current WIP Implementation Notes

The current branch already moved in this direction:

- `apps/local-runner/src/codex-session-manager.ts`
  - wraps `@openai/codex-sdk`
  - manages thread start/resume and audio-aware configuration
- `apps/local-runner/src/pluto-codex-mcp.ts`
  - exposes the local `speak_to_user` MCP tool for a Pluto session
- `apps/local-runner/src/pluto-voice-session-runtime.ts`
  - reworked toward Codex-first turns
  - uses Gemini for transcription and spoken delivery instead of reasoning
- `apps/local-runner/src/pluto.ts`
  - updated runtime wiring
- `apps/local-runner/src/control-server.ts`
  - includes the session-scoped Codex MCP endpoint
- `apps/local-runner/src/env.ts`
  - includes `PLUTO_CODEX_MODEL` and `PLUTO_CODEX_WORKING_DIRECTORY`
- `apps/desktop-companion/src/renderer/components/PlutoVoiceSessionConsole.stream.ts`
  - updated labels so assistant output is presented as Codex

## Known Open Items

- two local-runner tests were still failing the last time this direction was touched because the persisted voice-session history contained more stream events than the older Gemini-native tests expected
- `apps/local-runner/src/state.ts` is still above the repo hard LOC limit and needs refactoring before this work should be considered finished
- `packages/shared/src/schemas.ts` is sitting close to the hard LOC limit and should be watched during further changes

## Practical Next Step

When resuming this work:

1. stabilize the failing Pluto voice-session history tests
2. refactor oversized files, especially `apps/local-runner/src/state.ts`
3. finish the Codex-first text/audio routing so audio-off is fully Codex-only
4. keep Gemini scoped to STT/TTS plus the `speak_to_user` delivery path
