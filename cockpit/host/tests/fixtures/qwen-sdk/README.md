# Qwen Code through its SDK: recorded sessions

Recorded 2026-11-27 from Qwen Code 0.28.4 driven by `@qwen-code/sdk` 0.1.35 (stream-json over stdio), against a
scripted OpenAI-compatible mock endpoint (model `mock-model`, no real model). Paths are replaced by `/work/project`
and `/qwen`.

- `two-turns.jsonl`: the SDK messages of one session, one per line: a turn with a streamed text reply, then a turn
  with a streamed text, a `run_shell_command` call, its result and a closing text. `system/init` is cut down to the
  fields the runtime reads.
- `chat.jsonl`: the same session's chat file (`QWEN_HOME/projects/<project>/chats/<id>.jsonl`), plus a resumed turn
  that ran `touch made-by-agent.txt` after an approval.
- `thinking-then-text.jsonl`: a turn that thinks before it answers, written by hand in the shape Qwen Code 0.28.6's
  `StreamJsonOutputAdapter` emits it: a message holds one block type, so the switch from thinking to text finalises
  message A and starts message B under a new id, but `message_start` goes out only once per turn, so B's text is
  streamed without one and its assistant message names B.
