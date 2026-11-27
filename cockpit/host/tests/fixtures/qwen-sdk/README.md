# Qwen Code through its SDK: recorded sessions

Recorded 2026-11-27 from Qwen Code 0.28.4 driven by `@qwen-code/sdk` 0.1.35 (stream-json over stdio), against a
scripted OpenAI-compatible mock endpoint (model `mock-model`, no real model). Paths are replaced by `/work/project`
and `/qwen`.

- `two-turns.jsonl`: the SDK messages of one session, one per line: a turn with a streamed text reply, then a turn
  with a streamed text, a `run_shell_command` call, its result and a closing text. `system/init` is cut down to the
  fields the runtime reads.
- `chat.jsonl`: the same session's chat file (`QWEN_HOME/projects/<project>/chats/<id>.jsonl`), plus a resumed turn
  that ran `touch made-by-agent.txt` after an approval.
