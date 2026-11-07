# Gemini 3.x thinking configuration and why `thinkingBudget: 0` returns 400 INVALID_ARGUMENT

Scope: Gemini API / Vertex AI (Gemini Enterprise Agent Platform) and the `@google/genai` JS SDK 2.32.0, as of November 2026. Note: ai.google.dev/gemini-api/docs/* URLs now 301-redirect to aistudio.google.com/docs/*. Several of those AI Studio pages now document the Interactions API (`client.interactions.create`, snake_case `generation_config.thinking_level`), not `generateContent`. The SDK facts below come from the locally installed package at `D:/ragaven project/ai-checkout/node_modules/@google/genai/dist/genai.d.ts` (version 2.32.0).

## Q1. thinkingLevel vs thinkingBudget: which models accept which, and can thinking be fully disabled on Gemini 3?

### Takeaway
Gemini 3 and later models are controlled by a discrete `thinkingLevel` (MINIMAL/LOW/MEDIUM/HIGH, depending on the model). The integer `thinkingBudget` belongs to Gemini 2.5 and earlier. There, `0` turned thinking off on 2.5 Flash and Flash-Lite but not on 2.5 Pro. No official source documents a way to turn thinking fully off on a Gemini 3 model. The lowest setting is `MINIMAL`, and only some models support it. `gemini-3.5-flash-lite` already defaults to `MINIMAL`.

### Cited Findings
- "Gemini 3 models use the `thinking_level` parameter." It also says "Don't use the `thinking_level` parameter with Gemini 2.5 and earlier models." — [Vertex AI: Thinking](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thinking)
- On Gemini 2.5 only, `thinking_budget` 0 turns thinking off on Flash and Flash-Lite. Thinking cannot be turned off on 2.5 Pro. — [Vertex AI: Thinking](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thinking)
- Applies to 2.5 only: setting `thinking_budget=0` on 2.5 Pro returns a 400 INVALID_ARGUMENT "does not support setting thinking_budget to 0". — [Google AI Developers Forum, via search result](https://discuss.ai.google.dev/t/gemini-2-5-flash-problems-while-trying-to-deactivate-thinking/96648)
- On Gemini 3 and later the lowest level is `MINIMAL`, which uses the fewest thinking tokens. Gemini 4 does not support it. It still requires thought signatures in multi-turn conversations. Thinking is on by default in supported models, though a response may contain no thought parts. — [Vertex AI: Thinking](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thinking)
- AI Studio thinking page: "Gemini models engage in dynamic thinking by default." Thinking is controlled through `thinking_level`. The only model whose default is "Off" is `gemini-2.5-flash-lite`. The page gives no way to turn thinking off on Gemini 3. — [AI Studio: Thinking](https://aistudio.google.com/docs/thinking)
- Supported levels and defaults per model (Vertex table, Gemini 3+):

  | Model | Levels | Default |
  |---|---|---|
  | Gemini 4 Argon | LOW, MEDIUM, HIGH | MEDIUM |
  | Gemini 3.8 Flash | LOW, MEDIUM, HIGH | MEDIUM |
  | Gemini 3.7 Flash | LOW, MEDIUM, HIGH | MEDIUM |
  | Gemini 3.6 Flash | MINIMAL, LOW, MEDIUM, HIGH | MEDIUM |
  | Gemini 3.5 Flash | MINIMAL, LOW, MEDIUM, HIGH | MEDIUM |
  | Gemini 3.5 Flash-Lite | MINIMAL, LOW, MEDIUM, HIGH | MINIMAL |
  | Gemini 3.1 Flash-Lite | MINIMAL, LOW, MEDIUM, HIGH | MINIMAL |
  | Gemini 3.1 Pro (preview) | LOW, MEDIUM, HIGH | HIGH |
  | Gemini 3 Flash (preview) | MINIMAL, LOW, MEDIUM, HIGH | HIGH |
  | Gemini 3.1 Flash Image / 3.1 Flash-Lite Image | MINIMAL, HIGH | MINIMAL |
  | Gemini 3 Pro Image | HIGH | HIGH |

  — [Vertex AI: Thinking](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thinking)
- The AI Studio table agrees for `gemini-3.5-flash-lite` (default "On (minimal)", levels minimal/low/medium/high). It lists `gemini-3-pro-preview` as low/high only, and 2.5 models as low/medium/high. — [AI Studio: Thinking](https://aistudio.google.com/docs/thinking)
- Pattern across both tables: Pro and the newest Flash models (3.8, Gemini 4) do not accept MINIMAL. 3.x Flash-Lite and 3.5/3.6 Flash do. — [Vertex AI: Thinking](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thinking); [AI Studio: Thinking](https://aistudio.google.com/docs/thinking)
- The 3.5 Flash-Lite model card lists levels `MINIMAL, LOW, MEDIUM, HIGH` and says "3.5 Flash-Lite defaults to minimal thinking, which optimizes for speed and cost efficiency." — [Vertex: Gemini 3.5 Flash-Lite](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash-lite). A third-party search summary claimed Flash-Lite lists only minimal/medium/high. The official page does not support that claim.

### Inferences
- Asking for "thinking off" on `gemini-3.5-flash-lite` has no equivalent. Omitting `thinkingConfig` already gives the lowest documented level (MINIMAL), so the app's working no-config call is effectively the "least thinking" configuration.
- `thinkingBudget: 0` was a Gemini 2.5 idiom. Code ported from 2.5 Flash or Flash-Lite will break on 3.x.

### Gaps
- No official page states the token-count behaviour of MINIMAL on 3.5 Flash-Lite, for example whether it can produce zero thought tokens.

## Q2. Is `thinkingBudget: 0` explicitly rejected on Gemini 3, or are the two parameters mutually exclusive? Documented error behaviour

### Takeaway
Both statements are true. Google documents `thinkingBudget` as deprecated or unsupported on Gemini 3+ models. Sending it can cause errors: intermittent on Gemini 3, outright on Gemini 4. Sending both `thinkingBudget` and `thinkingLevel` returns a 400 error. For this app, the root cause is the presence of `thinkingBudget` in a request to a Gemini 3.x model, and the fix is to remove it. The documented error text is a generic 400 INVALID_ARGUMENT, which matches what the app observed.

### Cited Findings
- "The `thinking_budget` parameter is deprecated for Gemini 3 and later models." Using it with Gemini 4 fails outright, and using it with Gemini 3 can cause intermittent errors. — [Vertex AI: Thinking](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thinking)
- "Specifying both `thinking_level` and `thinking_budget` in the same request returns an error." The page also advises: "Remove `thinking_budget` from your requests when using Gemini 3 and later models to avoid these errors." — [Vertex AI: Thinking](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thinking)
- "The raw numeric `thinking_budget` parameter is no longer supported across all Gemini 3 models." On sending both: "Using both in a request will return a `400` error." Migration step: "Replace `thinking_budget` with `thinking_level`." — [Vertex: Developer's guide to Gemini 3.5 Flash](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-5-flash)
- The Gemini 3.6 migration guide likewise says to "Replace `thinking_budget` with `thinking_level`". It does not say whether `thinking_budget` is still accepted. — [AI Studio: What's new in Gemini 3.6](https://aistudio.google.com/docs/whats-new-gemini-3.6)
- The 3.5 Flash-Lite model card does not mention `thinking_budget` at all. — [Vertex: Gemini 3.5 Flash-Lite](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash-lite)
- The SDK does not validate this client-side. The 2.32.0 `ThinkingConfig` type still exposes `thinkingBudget?: number`, with the doc comment "0 is DISABLED. -1 is AUTOMATIC. The default values and allowed ranges are model dependent." That is why the request reaches the server and fails with HTTP 400. — local `node_modules/@google/genai/dist/genai.d.ts` (v2.32.0), lines ~16189-16198; the same type is in [googleapis/js-genai src/types.ts](https://github.com/googleapis/js-genai/blob/main/src/types.ts)
- Third-party libraries also treat the two as mutually exclusive. A Go library commit says this follows Google's API, and the community Elixir validator maps Gemini 3 to `thinking_level`. — [fantasy-mirror commit](https://git.secluded.site/fantasy-mirror/commit/bd6d47d799127fd9138dc83ca6f19685bb67391d); [GeminiEx ThinkingConfig validation](https://hexdocs.pm/gemini_ex/Gemini.Validation.ThinkingConfig.html)

### Inferences
- The sources differ on severity. The Vertex thinking page says "deprecated" and "intermittent errors" on Gemini 3. The 3.5 Flash guide says "no longer supported across all Gemini 3 models". The app's deterministic 400 on 3.5 Flash-Lite fits the stricter wording. Possibly 0 in particular is rejected because 3.x has no "off" state, but no official page says "budget 0 is rejected" in those words.
- The generic message "Request contains an invalid argument." does not name the bad field. That fits server-side rejection of the deprecated field or of the out-of-range value 0.

### Gaps
- No js-genai GitHub issue was found that reports exactly `thinkingBudget: 0` + Gemini 3.x Flash-Lite → 400. The js-genai CHANGELOG is not shipped in the npm package and was not reviewed.
- No official statement was found on whether a non-zero `thinkingBudget` alone (no `thinkingLevel`) is silently mapped to a level on 3.5 Flash-Lite or is also rejected.

## Q3. Exact JS SDK syntax for setting the thinking level

### Takeaway
In `@google/genai` 2.32.0 `generateContent`, use `config.thinkingConfig.thinkingLevel` with the exported `ThinkingLevel` enum. Its values are the uppercase strings `"MINIMAL" | "LOW" | "MEDIUM" | "HIGH"`, plus `"THINKING_LEVEL_UNSPECIFIED"`. Do not set `thinkingBudget`. The Interactions API uses a different shape: a snake_case `generation_config.thinking_level` with lowercase strings.

### Cited Findings
- SDK 2.32.0 type definitions (verbatim members):
  ```ts
  export declare interface ThinkingConfig {
      includeThoughts?: boolean;
      thinkingBudget?: number;      // "0 is DISABLED. -1 is AUTOMATIC. ... model dependent."
      thinkingLevel?: ThinkingLevel;
  }
  export declare enum ThinkingLevel {
      THINKING_LEVEL_UNSPECIFIED = "THINKING_LEVEL_UNSPECIFIED",
      MINIMAL = "MINIMAL", LOW = "LOW", MEDIUM = "MEDIUM", HIGH = "HIGH"
  }
  ```
  — local `node_modules/@google/genai/dist/genai.d.ts` (v2.32.0); [googleapis/js-genai src/types.ts](https://github.com/googleapis/js-genai/blob/main/src/types.ts)
- The Python equivalent on Vertex is `types.ThinkingConfig(thinking_level=...)` with MINIMAL/LOW/MEDIUM/HIGH. The Vertex page's only Node example is for 2.5 (`thinkingConfig: { thinkingBudget: 1024 }`). — [Vertex AI: Thinking](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thinking)
- AI Studio JS example (Interactions API, not generateContent):
  ```js
  await client.interactions.create({ model: "gemini-3.8-flash", input: "...",
    generation_config: { thinking_level: "low" } });
  ```
  — [AI Studio: Thinking](https://aistudio.google.com/docs/thinking)

### Inferences
- Recommended generateContent form for this app (built from the SDK types above):
  ```js
  import { GoogleGenAI, ThinkingLevel } from "@google/genai";
  const res = await ai.models.generateContent({
    model: "gemini-3.5-flash-lite",
    contents,
    config: {
      tools: [{ functionDeclarations }],
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }, // or omit for default MINIMAL
    },
  });
  ```
  Plain JS can pass the string `"LOW"` directly, since the enum values are strings.

### Gaps
- No official Node/JS `generateContent` example using `thinkingLevel` was found on ai.google.dev or Vertex. The syntax above is derived from the SDK's type definitions. It was not run live.

## Q4. Recommended config for a low-latency function-calling chat assistant on Gemini 3 Flash / Flash-Lite, and temperature guidance

### Takeaway
On 3.5 Flash-Lite, the default MINIMAL level gives the lowest latency. Google warns that MINIMAL "can cause premature tool termination on multi-step tasks" and recommends LOW for light reasoning, or MEDIUM/HIGH for agents that call APIs. A checkout assistant that uses tools should therefore use `LOW`, or `MEDIUM` if tool chains are multi-step. Google's guidance on temperature has changed from 2025's "keep it at 1.0": it now says to remove temperature, topP and topK on Gemini 3.x. On 3.5 Flash-Lite custom values are ignored, and future generations will return 400 for them. Frequency and presence penalties already return an error. Thought signatures and strict functionCall/functionResponse `id` matching are required.

### Cited Findings
- 3.5 Flash-Lite card: use `MINIMAL` for latency-sensitive classification and extraction, `LOW` for high-throughput tasks that need light reasoning, and for subagents that call external APIs, "set the thinking level to medium or high." It also says "Using the minimal thinking level can cause premature tool termination on multi-step tasks." Function calling is supported. A request whose last `contents` entry has `"role": "model"` returns an error. — [Vertex: Gemini 3.5 Flash-Lite](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash-lite)
- The 3.6 guide repeats this for 3.5 Flash-Lite: leave `thinking_level` at `"minimal"` for extraction and routing, and use `"medium"` or `"high"` for autonomous subagents "to prevent premature tool termination." — [AI Studio: What's new in Gemini 3.6](https://aistudio.google.com/docs/whats-new-gemini-3.6)
- Sampling on 3.5 Flash-Lite: the defaults are temperature 1.0, topP 0.95, topK 64. "Custom values for parameters like temperature, top-K, and top-P aren't supported", and such values are ignored. "Setting a custom value for these parameters will throw an error" applies to frequency and presence penalties. — [Vertex: Gemini 3.5 Flash-Lite](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash-lite)
- 3.5 Flash guide: "The model manages its own sampling for optimal results. Remove these parameters from all requests." The parameters "won't throw an error, the model will ignore them entirely." For determinism, use a system instruction with explicit rules. — [Vertex: Developer's guide to Gemini 3.5 Flash](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-5-flash)
- The 3.6 guide calls `temperature`, `top_p` and `top_k` deprecated: "In future model generations, supplying these parameters returns an HTTP 400 error." It also says "Remove these parameters from all requests." — [AI Studio: What's new in Gemini 3.6](https://aistudio.google.com/docs/whats-new-gemini-3.6)
- Function calling rules: "Every `FunctionResponse` must include the `id` from the corresponding `FunctionCall`." The guide also says to "Return exactly one `FunctionResponse` for each `FunctionCall` received". Mismatches "cause the model to return empty responses with `finish_reason: STOP` in most cases." Thoughts from previous turns are preserved by default, so history should include full context (thoughts, calls, responses) or omit it entirely. — [Vertex: Developer's guide to Gemini 3.5 Flash](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-5-flash)
- Thought signatures: "If a required thought signature is not returned when using Gemini 3 models, the model will return a `400` error." Signatures must be returned "even when using `MINIMAL` thinking levels". The Gen AI SDKs handle them automatically when you use chat history or append the model's full response to history. With REST or trimmed or edited history, you must preserve them yourself. — [Vertex: Thought signatures](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures)
- To cut latency, lower `thinking_level` (`low`/`medium`) instead of setting a small `max_output_tokens`, which is a hard cutoff. — [AI Studio: Thinking](https://aistudio.google.com/docs/thinking)

### Inferences
- Suggested config for the checkout assistant: `thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }`. Drop `temperature`, `topP` and `topK`, and never send frequency or presence penalties. Append the model's full `Content`, including `thoughtSignature` parts, to history before sending `functionResponse` parts with matching `id` and `name`. If the app hand-builds `contents`, missing signatures are a second possible source of 400s on tool turns. That is separate from the thinkingBudget bug.
- If the app currently sets a custom temperature, remove it. It is ignored today on 3.5 Flash-Lite and is slated to become a 400 in future generations.

### Gaps
- No published latency numbers comparing MINIMAL and LOW on 3.5 Flash-Lite.

## Q5. Does "gemini-3.5-flash-lite" exist? Current Gemini 3.x model IDs (Nov 2026)

### Takeaway
Yes. `gemini-3.5-flash-lite` is a real, stable model ID: "The fastest, lowest-cost model in the 3.5 family". The model name was not the cause of the 400. Gemini 2.5 Flash and 2.5 Pro are deprecated and will auto-route to 3.x models on December 1, 2026.

### Cited Findings
- Model ID `gemini-3.5-flash-lite` is listed on the Vertex model card. — [Vertex: Gemini 3.5 Flash-Lite](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash-lite)
- It is described as "The fastest, lowest-cost model in the 3.5 family". — [AI Studio: What's new in Gemini 3.6](https://aistudio.google.com/docs/whats-new-gemini-3.6)
- AI Studio models page (Nov 2026):
  - Stable: `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gemini-3.5-transcribe`.
  - New: `gemini-3.8-flash`, `gemini-3.8-live`, `gemini-3.8-live-extended-thinking`, `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts`.
  - Preview: `gemini-3-flash-preview`, `gemini-3.1-pro-preview`, among others.
  - Flagship: `gemini-4-argon`.
  - Shut down: `gemini-3-pro-preview`, `gemini-3.1-flash-lite-preview`, `gemini-2.0-flash`, `gemini-2.0-flash-lite`.
  - `gemini-2.5-flash` and `gemini-2.5-pro` are deprecated, and on Dec 1, 2026 their requests route to `gemini-3.5-flash-lite` and `gemini-3.8-flash` respectively. `gemini-2.5-flash-lite` is served "until further notice".

  — [AI Studio: Models](https://aistudio.google.com/docs/models)
- The 3.6 page says Gemini 3.6 Flash is now previous-generation, and "For our newest Flash model, see [Gemini 3.8 Flash]." — [AI Studio: What's new in Gemini 3.6](https://aistudio.google.com/docs/whats-new-gemini-3.6)

### Inferences
- Because 2.5 Flash requests will auto-route to `gemini-3.5-flash-lite` on Dec 1, 2026, any legacy 2.5 code that still sends `thinkingBudget: 0` may start hitting this same 400 after the cutover. That is a reason to remove `thinkingBudget` everywhere.

### Gaps
- No GA date for `gemini-3.5-flash-lite` was found on the pages reviewed.
- Gemini 3.5 Flash and 3.7 Flash appear in the Vertex thinking table but not in the AI Studio stable list. Their exact Gemini API IDs and status were not confirmed.
