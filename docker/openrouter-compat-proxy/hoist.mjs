// Pure request rewrite for the OpenRouter compat proxy. Kept separate from
// server.mjs so it can be unit-tested without binding a port (importing the server
// module starts it listening).

/** Text blocks of one message's content, whatever shape it arrived in. */
function textBlocks(content) {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => ({ type: 'text', text: b.text }));
}

/** Move every `role:"system"` entry out of `messages` and append it to the
 *  top-level `system` field, preserving order.
 *
 *  WHY: the claude binary appends a trailing `role:"system"` message (the Agent
 *  tool's agent-type listing) on top of the top-level `system` field. OpenRouter
 *  passes Anthropic models through natively so they are unaffected, but every other
 *  vendor needs an Anthropic -> OpenAI translation in which that message keeps its
 *  position, and vLLM-style backends reject it:
 *    400 "System message must be at the beginning."
 *  Measured on qwen/qwen3.8-27b across all three of its upstreams.
 *
 *  Returns the raw bytes UNCHANGED when the body is not parseable JSON, has no
 *  `messages` array, contains no system message, or would be left with no messages
 *  at all — forward as-is rather than inventing a request. */
export function hoistSystemMessages(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return rawBody;
  }
  if (!body || !Array.isArray(body.messages)) return rawBody;

  const kept = [];
  const moved = [];
  for (const message of body.messages) {
    if (message && message.role === 'system') {
      moved.push(...textBlocks(message.content));
      continue;
    }
    kept.push(message);
  }
  if (moved.length === 0) return rawBody;
  // Dropping every message would leave an invalid request; leave it alone and let
  // upstream answer for itself.
  if (kept.length === 0) return rawBody;

  const existing =
    typeof body.system === 'string'
      ? textBlocks(body.system)
      : Array.isArray(body.system)
        ? body.system
        : [];

  body.system = [...existing, ...moved];
  body.messages = kept;
  return Buffer.from(JSON.stringify(body));
}
