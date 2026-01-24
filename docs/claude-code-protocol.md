# Claude Code SDK Protocol

miriad-code implements a subset of the Claude Code SDK protocol for compatibility
with orchestration platforms like miriad.systems.

## Transport

- **Format**: Newline-delimited JSON (NDJSON) over stdin/stdout
- **Direction**: Bidirectional
- **Process**: Stays alive between turns, accepts ongoing user messages

## Input Messages (stdin)

### User Message

```json
{"type":"user","message":{"role":"user","content":"Hello"},"session_id":"default"}
```

With content blocks:
```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]},"session_id":"default"}
```

Fields:
- `type`: Always `"user"`
- `message.role`: Always `"user"`
- `message.content`: String or array of content blocks
- `session_id`: Optional session identifier

### Control Request

```json
{"type":"control","action":"interrupt"}
{"type":"control","action":"status"}
```

Actions:
- `interrupt`: Cancel the current turn (if running)
- `status`: Get server status (running, session_id, queued_messages)

## Out-of-Turn Message Delivery

Messages received while a turn is running are **injected into the current turn** at the next opportunity (before the next model call). This allows users to provide corrections or additional context mid-turn.

When a message is queued, the server responds with:
```json
{"type":"system","subtype":"queued","session_id":"sess_2","position":1}
```

When queued messages are injected, the server notifies:
```json
{"type":"system","subtype":"injected","message_count":2,"content_length":150}
```

Multiple queued messages are concatenated with double line breaks (`\n\n`) and injected as a single user message. The agent sees this as additional context and can adjust its behavior accordingly.

## Output Messages (stdout)

### Assistant Message

```json
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello!"}],"model":"claude-opus-4-5-20251101"}}
```

With tool use:
```json
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"call_123","name":"read","input":{"filePath":"/tmp/test.txt"}}],"model":"claude-opus-4-5-20251101"}}
```

### Result Message

Sent when a turn completes:

```json
{"type":"result","subtype":"success","duration_ms":1234,"is_error":false,"num_turns":3,"session_id":"default","result":"Done!","usage":{"input_tokens":100,"output_tokens":50}}
```

Fields:
- `subtype`: `"success"`, `"error"`, or `"cancelled"`
- `duration_ms`: Total turn duration in milliseconds
- `is_error`: Boolean indicating error state
- `num_turns`: Number of tool use cycles
- `session_id`: Session identifier
- `result`: Final text response (optional)
- `usage`: Token usage (optional)

### System Message

For metadata and events:

```json
{"type":"system","subtype":"tool_result","tool_result":{"type":"tool_result","tool_use_id":"call_123","content":"file contents"}}
{"type":"system","subtype":"error","message":"Something went wrong"}
{"type":"system","subtype":"consolidation","entries_created":2,"entries_updated":1}
```

## Content Blocks

### Text Block
```json
{"type":"text","text":"Hello world"}
```

### Tool Use Block
```json
{"type":"tool_use","id":"call_123","name":"read","input":{"filePath":"/tmp/test.txt"}}
```

### Tool Result Block
```json
{"type":"tool_result","tool_use_id":"call_123","content":"file contents","is_error":false}
```

## Example Session

```
→ {"type":"user","message":{"role":"user","content":"Read /tmp/test.txt"},"session_id":"sess_1"}
← {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll read that file for you."},{"type":"tool_use","id":"call_1","name":"read","input":{"filePath":"/tmp/test.txt"}}],"model":"claude-opus-4-5-20251101"}}
← {"type":"system","subtype":"tool_result","tool_result":{"type":"tool_result","tool_use_id":"call_1","content":"Hello from test file!"}}
← {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The file contains: Hello from test file!"}],"model":"claude-opus-4-5-20251101"}}
← {"type":"result","subtype":"success","duration_ms":2500,"is_error":false,"num_turns":1,"session_id":"sess_1","result":"The file contains: Hello from test file!","usage":{"input_tokens":150,"output_tokens":30}}
→ {"type":"user","message":{"role":"user","content":"Thanks!"},"session_id":"sess_1"}
← {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"You're welcome!"}],"model":"claude-opus-4-5-20251101"}}
← {"type":"result","subtype":"success","duration_ms":800,"is_error":false,"num_turns":0,"session_id":"sess_1","result":"You're welcome!","usage":{"input_tokens":50,"output_tokens":10}}
```

## Differences from Claude Code SDK

### Implemented
- ✅ User messages with string or content block array
- ✅ Assistant messages with text and tool_use blocks
- ✅ Result messages with usage stats
- ✅ System messages for tool results and errors
- ✅ Process stays alive between turns
- ✅ Out-of-turn message delivery (queued messages)
- ✅ Interrupt control request

### Not Implemented (Yet)
- ❌ Thinking blocks (extended reasoning)
- ❌ Stream events (partial message updates)
- ❌ Full control protocol (permission callbacks, hooks)

## Usage

Start the server:
```bash
miriad-code --stdio --db ./agent.db
```

Send messages via stdin, receive responses via stdout.
