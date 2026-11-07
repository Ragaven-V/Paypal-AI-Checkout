# Multi-turn function calling history rules for Gemini 3.x via @google/genai JS SDK chats

Note on sources: as of Nov 2026, `ai.google.dev/gemini-api/docs/*` URLs 301-redirect to `aistudio.google.com/docs/*`, and the default pages now describe the **Interactions API** (`client.interactions.create`, `previous_interaction_id`, `function_result` steps). The generateContent / chats variants are served with `?generate-content=true`. SDK code below was checked against `googleapis/js-genai` `src/chats.ts` (main) **and** the locally installed `node_modules/@google/genai` (version 2.32.0, `dist/node/index.mjs`). The two match.

## 1. Thought signatures: what they are, whether they're mandatory, the errors, and whether the SDK preserves them

### Takeaway
On Gemini 3 (and Gemini 4) you must return thought signatures for function calling. Validation covers the "current turn" only, and a missing signature returns HTTP 400 "...is missing a `thought_signature`". The JS chat object keeps signatures automatically, in streaming too, because it stores the raw response `Content` parts. Code that rebuilds history by hand (for example from `chunk.functionCalls`) or regroups parts loses or misplaces them.

### Cited Findings
- Signatures are encrypted records of the model's reasoning, used to keep reasoning context across multi-step interactions. The general rule is to return every signature you receive, exactly as sent, in the next turn's history. — [Thought signatures (generateContent)](https://aistudio.google.com/docs/thought-signatures?generate-content=true)
- Gemini 4 and Gemini 3: "you must pass back thought signatures during function calling, otherwise you will get a validation error". This also applies to Gemini 3 Flash at `minimal` thinking level. — [Thought signatures](https://aistudio.google.com/docs/thought-signatures?generate-content=true)
- **Gemini 2.5 differs**: it puts the signature in the first part, and returning it is optional. — [Thought signatures](https://aistudio.google.com/docs/thought-signatures?generate-content=true)
- Strict validation applies only to the current turn, not earlier turns. The current turn starts at the most recent user message with standard content (for example text), not a `functionResponse`. Every model function-call step after that message belongs to the current turn, and the first `functionCall` part of each step must carry its signature or the request fails with 400. — [Thought signatures](https://aistudio.google.com/docs/thought-signatures?generate-content=true)
- Documented Gemini 3 error wording: "Function call `<Function Call>` in the `<index of contents array>` content block is missing a `thought_signature`." — [Thought signatures](https://aistudio.google.com/docs/thought-signatures?generate-content=true)
- Real-world forms of that error, seen on Vertex AI with `@google/genai` 1.38: "Unable to submit request because function call `get_detailed_results` in the 4. content block is missing a `thought_signature`." — [Google AI forum thread, Jan 2026](https://discuss.ai.google.dev/t/gemini-3-flash-preview-inconsistent-thought-signature-generation-in-parallel-function-calls-causes-400-errors-and-potential-silent-data-loss/118936); [js-genai #1275](https://github.com/googleapis/js-genai/issues/1275)
- Sequential (multi-step) calls: each step's function call has its own signature, and all of them must be passed back. In the docs' example, both the flight-check and the taxi-booking signatures are required. — [Thought signatures](https://aistudio.google.com/docs/thought-signatures?generate-content=true)
- Text (non-function-call) responses: the final part may carry a signature. Returning it is recommended but not enforced, so leaving it out causes no error, though quality may drop. — [Thought signatures](https://aistudio.google.com/docs/thought-signatures?generate-content=true)
- Image-generation models (for example `gemini-3-pro-image-preview`) also enforce signatures on text and image parts. Error texts seen: "Text part is missing a thought_signature in content position 1, part position 1." and "Image part is missing a thought_signature in content position 6, part position 2." — [js-genai #1116](https://github.com/googleapis/js-genai/issues/1116)
- The official SDKs handle signatures automatically when you use standard chat history or append the full model response object. Manual handling is needed for REST or when you extract history parts yourself. — [Thought signatures](https://aistudio.google.com/docs/thought-signatures?generate-content=true); [Vertex AI thought signatures](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures)
- Vertex docs name the usual failure causes: custom middleware that keeps only `name`/`args` of a `functionCall` and drops the sibling `thoughtSignature`, or streaming chunks reassembled without the signature. — [Vertex AI thought signatures](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures) (as summarized by search; page not fetched in full)
- Don't merge a signed `Part` with an unsigned one, and don't combine two signed `Part`s. Return each signature inside its original `Part`. — [Function calling (generateContent)](https://aistudio.google.com/docs/function-calling?generate-content=true)
- Dummy signatures for injected or migrated history (for example a trace from a model without signatures, or function-call parts you built yourself): set `thoughtSignature` to `"context_engineering_is_the_way_to_go"` or `"skip_thought_signature_validator"` to skip validation. The docs strongly discourage injecting function-call parts that the API did not generate. — [Thought signatures](https://aistudio.google.com/docs/thought-signatures?generate-content=true). One user confirmed `"skip_thought_signature_validator"` bypassed the check in March 2026. — [js-genai #1116](https://github.com/googleapis/js-genai/issues/1116)
- **SDK source, how the chat stores history**: `sendMessage` records `response.candidates[0].content` as-is. `processStreamResponse` pushes each valid chunk's `candidates[0].content` by reference, with no filtering and no merging, and never inspects `thoughtSignature`. Signatures are therefore kept, but a streamed model turn is stored as **several consecutive `role:'model'` Content entries, one per chunk**. — [js-genai src/chats.ts](https://github.com/googleapis/js-genai/blob/main/src/chats.ts); confirmed in the installed v2.32.0 `dist/node/index.mjs`
- `Chats.create` deep-copies `params.history` with `structuredClone`, and `getHistory()` returns a `structuredClone`. If you slice `getHistory()` and pass the slice as `history`, every part field, `thoughtSignature` included, survives. — [js-genai src/chats.ts](https://github.com/googleapis/js-genai/blob/main/src/chats.ts)
- Streaming, generateContent: without a function call, the signature may arrive in a part with empty text, so read the stream until `finish_reason` arrives. — [Thought signatures](https://aistudio.google.com/docs/thought-signatures?generate-content=true)

### Inferences
- Because the app goes through `chat.sendMessage`/`sendMessageStream` and re-creates chats from `getHistory()` slices, signatures should survive. A missing-signature 400 is most likely caused by (a) a slice that removes the model functionCall step(s) of the current turn while keeping later steps, (b) hand-built `functionCall` parts, or (c) the chunk-splitting and grouping issue covered in section 3, not by the SDK stripping fields.
- Re-creating a chat with the same model and passing the history unchanged needs no dummy signatures. They are only needed if the app synthesizes `functionCall` model turns, or moves history from a 2.5 model or another provider.

### Gaps
- Nothing found says whether the backend accepts a streamed model turn stored as several consecutive `model` Content entries (one per chunk) when one of them holds a signed `functionCall`. No official doc covers this. See the inference in section 3.
- I did not re-fetch the Vertex page in full to quote its wording verbatim.

## 2. Turn-ordering rules: functionCall followed by functionResponse, history starting with a functionResponse, and the resulting errors

### Takeaway
A model turn with `functionCall` part(s) must be followed directly by one user turn holding the matching `functionResponse` part(s), all calls before all responses. Interleaving returns 400. The documented errors are 400 INVALID_ARGUMENT with messages such as "Please ensure that function response turn comes immediately after a function call turn". No official doc says whether a history may start with a `functionResponse`, and the SDK does not check.

### Cited Findings
- generateContent docs: the model turn with the function call comes first, then a `user`-role turn with `functionResponse: { name, response, id }`. "Always include the exact `id` from the `function_call`". The JS chat sample reads `response.functionCalls` (`fn.name, fn.args, fn.id`). — [Function calling (generateContent)](https://aistudio.google.com/docs/function-calling?generate-content=true)
- The docs' examples wrap results as `response: { result: ... }`. No mandatory `{output}`/`{error}` schema is documented, so `{ output }` is just a convention. — [Function calling (generateContent)](https://aistudio.google.com/docs/function-calling?generate-content=true)
- FAQ: parallel calls must be sent as FC1(with signature), FC2, then FR1, FR2. Interleaving them (FC1, FR1, FC2, FR2) returns a 400 error. — [Thought signatures](https://aistudio.google.com/docs/thought-signatures?generate-content=true)
- Error seen when one response was sent for two calls, or responses were sent as separate turns: "Please ensure that function response turn comes immediately after a function call turn... the number of function response parts should be equal to number of function call parts of the function call turn." The maintainer's fix was to send all responses together in one turn with several parts. (Nov 2024, pre-Gemini 3) — [firebase-ios-sdk #14022](https://github.com/firebase/firebase-ios-sdk/issues/14022)
- Related error: "Please ensure that function call turns come immediately after a user turn or after a function response turn." The community attributed it to two consecutive user turns or a non-alternating history, and said a conversation must start with a user turn. These are community claims with no Google staff reply. (Oct 2024 – Feb 2025, pre-Gemini 3) — [Google AI forum](https://discuss.ai.google.dev/t/about-the-gemini-api-400-please-ensure-that-function-call-turns-come-immediately-after-a-user-turn-or-after-a-function-response-turn-error/46213)
- SDK validation: `validateHistory` only throws `Role must be user or model, but got ${role}.` Its JSDoc claims it throws "if the history does not start with a user turn", but the code does **not** check that. A history that starts with a `model` turn or with a user `functionResponse` turn is accepted client-side and sent to the API. — [js-genai src/chats.ts](https://github.com/googleapis/js-genai/blob/main/src/chats.ts)
- Under the Gemini 3 signature rules, a `functionResponse` user turn does **not** start a new "current turn". Only a user message with standard content does. — [Thought signatures](https://aistudio.google.com/docs/thought-signatures?generate-content=true)

### Inferences
- If a trim slice starts at a user `functionResponse` turn (its `functionCall` model turn was cut off), the server sees an orphan response. That probably fails with the "function response turn comes immediately after a function call turn" 400. If the next model `functionCall` step is still in the current turn, the signature check may also fire. Safe rule: start a slice only at a user turn whose parts are text (no `functionResponse`).
- A slice that ends right after a model `functionCall` turn, with the next message being new user text instead of the `functionResponse`, breaks the call→response pairing and should be avoided.
- The ordering error texts above come from 2024-era models (1.5/2.0). Gemini 3 may word them differently. Treat them as indicative.

### Gaps
- No official Gemini 3 doc states the full ordering contract (first turn must be user, no orphan functionResponse), or the exact current error strings for those cases.
- Whether `role: 'function'` is still accepted is unclear. Current docs use `user`, and the SDK's `validateHistory` rejects any role other than `user`/`model` in chat history.

## 3. Parallel function calls: one turn, order, matching ids

### Takeaway
Send every `functionResponse` for a parallel batch in **one** user Content with several parts, with the same count as the calls and each echoing its call's `id`. Keep all the parallel `functionCall` parts together in one model Content, unmodified: only the first part carries the signature. Order: matching by `id` is the safe approach, since the docs contradict themselves on whether order matters.

### Cited Findings
- In a parallel response, only the first `functionCall` part has a `thought_signature`. Later parts do not. — [Thought signatures](https://aistudio.google.com/docs/thought-signatures?generate-content=true)
- Each response is matched to its call by `id`. On ordering, one section says "you don't need to return the `function_result` objects in the same order that the `function_call` objects were received", and another says to "include the responses in the same order as they were requested". — [Function calling (generateContent)](https://aistudio.google.com/docs/function-calling?generate-content=true)
- Number of response parts must equal number of call parts, sent in one turn. — [firebase-ios-sdk #14022](https://github.com/firebase/firebase-ios-sdk/issues/14022)
- js-genai #1275 (Jan–Apr 2026, `gemini-3-flash-preview`, SDK 1.38): first reported as the model "inconsistently" signing parallel calls, causing 400 "...function call `analyze_data` in the 6. content block is missing a `thought_signature`". On Apr 24, 2026 the reporter **retracted** this. The behaviour matches the spec, and the 400s came from client code that stored each parallel call as a **separate model message**, so the API treated each one as a new step needing its own signature. Fix: group the parallel calls into one Content with several parts, and likewise the responses. The issue was still open, labelled p2 bug. — [js-genai #1275](https://github.com/googleapis/js-genai/issues/1275); [forum thread](https://discuss.ai.google.dev/t/gemini-3-flash-preview-inconsistent-thought-signature-generation-in-parallel-function-calls-causes-400-errors-and-potential-silent-data-loss/118936)
- The SDK streaming path stores each chunk's content as a separate `model` Content entry (see section 1). — [js-genai src/chats.ts](https://github.com/googleapis/js-genai/blob/main/src/chats.ts)

### Inferences
- **Risk for this app**: if Gemini 3 streams parallel `functionCall` parts across **several chunks**, `sendMessageStream` history would hold them as separate consecutive `model` Contents. That is the shape #1275 identified as causing "missing a `thought_signature`" 400s, and it would happen without any user code fault. I found no confirmation of whether the backend merges consecutive same-role contents. If 400s show up only on streamed parallel calls, a mitigation is to rebuild history yourself with consecutive `model` Contents' parts concatenated into one Content (parts unchanged, signatures in place), or to use non-streaming `sendMessage` for tool turns.
- Collecting `chunk.functionCalls` across chunks is fine for *executing* tools. Execute all of them, then send one `sendMessage({ message: [fr1, fr2, ...] })` with all responses and ids. Don't send one `sendMessage` per call.

### Gaps
- Whether Gemini 3 actually splits parallel function calls across stream chunks is undocumented.
- Whether the API tolerates consecutive `model` Contents is not documented.

## 4. Safe history truncation, what getHistory(true) drops, and history state after a failed sendMessage

### Takeaway
`getHistory(true)` drops invalid model runs (empty or missing parts, or parts with no keys) **together with the user turn before them**. It does not check function-call pairing or signatures. A rejected `sendMessage` leaves history untouched, because nothing is recorded. Streaming failures, or breaking out of the stream early, also record nothing, or an empty model placeholder that curation then removes. Truncate only at user-text turn boundaries.

### Cited Findings
- Only the comprehensive history is stored. `getHistory(false)` (the default) returns it, `getHistory(true)` derives curated history with `extractCuratedHistory`, and both return deep clones. Requests are always built from `getHistory(true).concat(input)`. — [js-genai src/chats.ts](https://github.com/googleapis/js-genai/blob/main/src/chats.ts); installed v2.32.0
- `isValidContent` is false when `parts` is undefined or empty, or any part is undefined or `{}`. It does not look at role, `finishReason` or `thoughtSignature`. `extractCuratedHistory` keeps every user turn. For each run of consecutive model turns, if any is invalid, it drops the run **and pops the preceding user turn** ("Remove the last user input when model content is invalid"). — [js-genai src/chats.ts](https://github.com/googleapis/js-genai/blob/main/src/chats.ts)
- `recordHistory` pushes an empty `{role:'model', parts:[]}` placeholder when the model output is empty or lacks a role, "so that the history is always alternating". — [js-genai src/chats.ts](https://github.com/googleapis/js-genai/blob/main/src/chats.ts)
- `sendMessage` failure: if `generateContent` rejects, `recordHistory` is never called, so neither the user input nor any model output is added. `sendPromise` is reset to `Promise.resolve()`, so later calls aren't blocked, and the error reaches the caller. — [js-genai src/chats.ts](https://github.com/googleapis/js-genai/blob/main/src/chats.ts); installed v2.32.0
- `sendMessageStream`: `sendPromise` resolves once the stream is *created*, not consumed. History is written only after the async generator is fully iterated: `recordHistory(inputContent, isValid && finished ? outputContent : [])`. If any chunk is invalid or no `finishReason` arrives, the model side becomes the empty placeholder, which curation later drops along with the user input. If iteration throws, nothing is recorded. A second send started before the first stream is fully consumed reads stale history. — [js-genai src/chats.ts](https://github.com/googleapis/js-genai/blob/main/src/chats.ts); installed v2.32.0
- `params.config` on `sendMessage` *replaces* the chat config rather than merging with it. — [js-genai src/chats.ts](https://github.com/googleapis/js-genai/blob/main/src/chats.ts)

### Inferences
- **Function-response trap**: if the tool-result `sendMessage({message:[functionResponse...]})` returns an empty or invalid model turn (for example a blocked or empty candidate), curation pops the *functionResponse user turn*. The previous model `functionCall` turn is then left dangling, and the next user text produces an ordering 400. This could explain errors that seem to follow "bad" turns. Discarding the chat after an error, as the app does, avoids carrying this forward. Rebuilding from `getHistory(true)` would also carry the dangling call.
- Safe truncation recipe: take `getHistory(true)` (not the comprehensive default, which can contain empty placeholders), find indices of `role==='user'` entries whose parts contain no `functionResponse`, and slice starting at one of those. Never keep a model `functionCall` turn without its following `functionResponse` turn. Keep every part of each Content unchanged.
- Breaking out of `for await` early (for example right after seeing `functionCalls`) prevents `recordHistory` from running. That turn is then missing from history and the next `functionResponse` message becomes an orphan. Always drain the stream until it ends.
- When re-creating a chat from a slice, pass the same model. Signatures are model-specific, and validation applies to the current turn.

### Gaps
- No official doc describes how much history may be dropped from *before* the current turn. The docs only say earlier turns aren't signature-validated, which suggests trimming whole earlier exchanges is safe.

## 5. Reading text vs function calls from streaming chunks without the non-text-parts warning

### Takeaway
`chunk.text` is a getter that warns on every chunk containing any non-text field (for example `functionCall`). To avoid the warning, read `chunk.candidates?.[0]?.content?.parts` directly, or check `chunk.functionCalls` first and read `.text` only when there are none.

### Cited Findings
- `GenerateContentResponse.text` (installed v2.32.0) iterates parts. Any field other than `text`, `thought` or `thoughtSignature` is added to `nonTextParts`, and if any are found it calls `console.warn(\`there are non-text parts ${nonTextParts} in the response, returning concatenation of all text parts. Please refer to the non text parts for a full response from model.\`)`. Thought parts (`thought: true`) are skipped. `thoughtSignature` alone does not trigger the warning. It returns `undefined` if no part has a string `text`. — local `node_modules/@google/genai/dist/node/index.mjs` lines ~2685–2718 (v2.32.0); same getter in [js-genai src/types.ts](https://github.com/googleapis/js-genai/blob/main/src/types.ts)
- `GenerateContentResponse.functionCalls` returns `parts.filter(p => p.functionCall).map(p => p.functionCall)` from the first candidate, or `undefined` if there are none. It returns only the `FunctionCall` objects (`name`, `args`, `id`) and **not** the enclosing Part or its `thoughtSignature`. — local `dist/node/index.mjs` ~line 2800 (v2.32.0)
- The streaming signature may arrive in an empty-text part. Read until `finish_reason`. — [Thought signatures](https://aistudio.google.com/docs/thought-signatures?generate-content=true)

### Inferences
- Recommended pattern per chunk: `for (const part of chunk.candidates?.[0]?.content?.parts ?? []) { if (part.thought) continue; if (part.functionCall) calls.push(part.functionCall); else if (typeof part.text === 'string') emit(part.text); }`. This avoids the warning and treats signature-only empty-text parts as harmless.
- Because `functionCalls` drops the Part wrapper, never rebuild a model `functionCall` turn from `chunk.functionCalls`. Rely on the chat's stored history, or copy whole `content.parts`.
- The warning itself is harmless. It means `.text` was called on a chunk carrying a `functionCall`.

### Gaps
- None material. The warning logic was verified in the installed SDK source.
