# Explicit context caching (cachedContent) in the Gemini API with @google/genai and Gemini 3.x

Notes as of 2026-11-07. Note: `ai.google.dev/gemini-api/docs/*` now returns a 301 redirect to `aistudio.google.com/docs/*`, and `cloud.google.com/vertex-ai/...` redirects to `docs.cloud.google.com/vertex-ai/...`. The current docs list newer model names (Gemini 3.1 Pro Preview, 3.5/3.6/3.7/3.8 Flash, 3.1/3.5 Flash-Lite, Gemini 4 Argon). Older snapshots mention `gemini-3-flash-preview` and `gemini-3-pro-preview`.

## 1. Can a generateContent/chat request that sets cachedContent also send systemInstruction, tools or toolConfig?

### Takeaway
No. The API rejects the request with `400 INVALID_ARGUMENT`: "CachedContent can not be used with GenerateContent request setting system_instruction, tools or tool_config." System instruction, tools and tool config have to be baked into the cache at `caches.create` time and left out of the request. In an app that passed `systemInstruction` and `tools` alongside `cachedContent`, every cached call would fail like this.

### Cited Findings
- Exact error text, reported by users on 2024-10-03 and 2025-01-09 (the second with status "InvalidArgument: 400"): "CachedContent can not be used with GenerateContent request setting system_instruction, tools or tool_config." The first report also quotes the server's hint: "Proposed fix: move those values to CachedContent from GenerateContent request." — [Google AI forum: Structured output support with cached content](https://discuss.ai.google.dev/t/structured-output-support-with-cached-content/41525)
- Forum reply (Siddharth_Naik, 2025-11-10; whether he is Google staff is unverified): "CachedContent cannot be used with a GenerateContent request that also sets system_instruction, tools, or tool_config." Those settings must live in the cache. To vary `allowedFunctionNames` per request, the workaround is one cache per set of allowed functions. The original poster also saw that a per-request `toolConfig` overrides the cached config and loses access to function calls. — [Google AI forum: Different configTool on every API request](https://discuss.ai.google.dev/t/different-configtool-on-every-api-request/107329)
- Vertex AI docs: if you set system instructions, tool config or tools when creating the cache, don't set `system_instructions`, `tool_config` or `tools` again on the request. — [Vertex AI: Use a context cache](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-use)
- `CreateCachedContentConfig` accepts `system_instruction`, `contents`, `tools` and `tool_config`. It does not accept `response_schema` or `response_mime_type`, which have to stay on the request (or be turned into a forced function declaration). — [Google AI forum: support caching response_schema in CreateCachedContentConfig](https://discuss.ai.google.dev/t/support-caching-response-schema-structured-output-config-in-createcachedcontentconfig/183271)
- The official JS example creates the cache with `config: { contents, systemInstruction }` and then calls `generateContent({ model, contents, config: { cachedContent: cache.name } })` without repeating the system instruction. — [Gemini API caching docs (generateContent)](https://aistudio.google.com/docs/caching?generate-content=true)
- Cache creation also needs at least one user-role entry in `contents`. Passing a system-role Content fails with "Content with system role is not supported." — [Google Cloud community: Vertex AI caching only system prompt](https://discuss.google.dev/t/vertex-ai-caching-only-system-prompt/170079)

### Inferences
- The fix is to put `tools` (and `toolConfig`, if used) inside `caches.create` config, which the app already does, and remove `systemInstruction`, `tools` and `toolConfig` from the `chats.create` / `sendMessage` config whenever `cachedContent` is set. Otherwise drop caching and send them normally.
- The error lists only system_instruction, tools and tool_config. Other generation settings (temperature, `thinkingConfig`, `responseMimeType`/`responseSchema`, safety settings) appear to be allowed on the request alongside `cachedContent`. That fits the response_schema thread, but I found no doc listing every allowed field.
- The `chats` helper in js-genai passes its `config` into each underlying generateContent call, so the same rule applies to `ai.chats.create({ config: { cachedContent, ... } })`. This is inferred from the SDK design, not confirmed in a doc.

### Gaps
- No official Gemini API (AI Studio) doc page states the error string. It comes from user reports of the API response, and the Vertex doc states the rule.
- No js-genai GitHub issue about this error turned up. A search of the repo's issues for "cachedContent" returned only #845 (CachedContentUsageMetadata not exported), #444 (YouTube caching, empty usageMetadata) and #339 (cache worked on Gemini 1.5 but not 2.0). — [js-genai issues search](https://github.com/googleapis/js-genai/issues?q=is%3Aissue+cachedContent)

## 2. Minimum token counts for explicit caching on Gemini 3.x, and the error below the minimum

### Takeaway
The current docs give 4,096 tokens for Gemini 3.x models on the Gemini API. Vertex AI gives 4,096 for most Gemini 3, with 6,144 for several models (implicit caching only). Older snapshots listed 1,024 for `gemini-3-flash-preview`. A ~1-2k-token catalog is below every documented Gemini 3 minimum, so `caches.create` should fail with `400 INVALID_ARGUMENT: Cached content is too small. total_token_count=N, min_total_token_count=M`. The `min_total_token_count` in the error is the number the API actually enforces.

### Cited Findings
- Current Gemini API caching page, minimum input token table: Gemini 4 Argon 4,096; Gemini 3.8 Flash 4,096; Gemini 3.6 Flash 4,096; Gemini 3.1 Pro Preview 4,096; Gemini 2.5 Flash 2,048; Gemini 2.5 Pro 2,048. The same page says "The minimum input token count varies by model. The maximum matches each model's limit." — [Gemini API caching docs](https://aistudio.google.com/docs/caching?generate-content=true)
- An earlier indexed version of the ai.google.dev caching page listed Gemini 3 Flash Preview at 1,024 and Gemini 3 Pro Preview at 4,096. This comes from a search snippet of a cached page, so it is lower confidence. — [ai.google.dev caching (older snapshot)](https://ai.google.dev/gemini-api/docs/caching.md)
- Vertex AI: minimum cache size is 4,096 tokens for Gemini 3 (with exceptions) and Gemini 4. Gemini 3.0 Flash Preview, 3.1 Pro Preview, 3.7 Flash and 3.8 Flash are 6,144 tokens "for implicit caching only". The Gemini 2 family is 2,048. — [Vertex AI context caching overview](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview)
- Error format examples: "400 INVALID_ARGUMENT: Cached content is too small." with "total_token_count=1006, min_total_token_count=1024" on gemini-2.5-flash, and "total_token_count=2010, min_total_token_count=2048" on gemini-2.5-flash-lite (google-genai 2.17.0, post dated 2026-08-19). The author reports the enforced minimums differ from the docs, which said 2,048 for 2.5 Flash and did not list Flash-Lite. — [Google AI forum: docs list wrong minimum token count](https://discuss.ai.google.dev/t/context-caching-docs-list-wrong-minimum-token-count-for-gemini-2-5-flash-flash-lite-missing-entirely/178942)
- Another example: "Cached content is too small. total_token_count=781, min_total_token_count=1024". The same post cites June 2026 docs listing 4,096 for Gemini 3.5 Flash and 3.1 Pro Preview, and warns that the figures differ across Google surfaces and releases. — [MemX blog, 2026-04-30 (updated June 2026)](https://memx.app/blog/gemini-caching-trap-prompts-under-1024-tokens/)
- Historical: older models enforced min_total_token_count=32768 (Gemini 1.5 era). — [Google AI forum: Cached content is too small. total_token_count=1](https://discuss.ai.google.dev/t/cached-content-is-too-small-total-token-count-1/76733)

### Inferences
- Explicit caching of a ~1-2k-token catalog is very likely rejected on any Gemini 3.x model. If the app catches the create error and falls back to no cache, the fallback path is the one that actually runs. Check the app's logs for "Cached content is too small".
- Documented minimums have drifted from enforced ones (at least for 2.5). Read `min_total_token_count` from the error, or count tokens with `ai.models.countTokens`, rather than hard-coding a number.

### Gaps
- No doc lists explicit-cache minimums specifically for Gemini 3.x Flash-Lite (3.1/3.5 Flash-Lite).
- The current AI Studio table may be labelled as the implicit-caching minimum, and it is unclear whether the same numbers apply to explicit caching. Vertex separates the 6,144 figure as implicit-only.

## 3. Implicit caching on Gemini 3, and whether explicit caching is worth it for a small prompt

### Takeaway
Implicit (automatic prefix) caching is on by default for Gemini 2.5 and newer, with no setup and no storage cost. Hits are discounted but not guaranteed and need a shared prefix above the same ~4k-token minimum on Gemini 3.x. With a 1-2k-token catalog, neither caching mode is likely to apply, and the savings would be negligible anyway. The simplest correct design is to drop explicit caching and send `systemInstruction` and `tools` on each request.

### Cited Findings
- "Implicit caching is enabled by default for all Gemini 2.5 and newer models". Savings pass through automatically on hits, with no configuration, and are not guaranteed. To improve hit rates, put large, common content at the start of the prompt and send requests with similar prefixes close together. Hits show in `usage_metadata` (cached token count). — [Gemini API caching docs](https://aistudio.google.com/docs/caching)
- Implicit caching does not apply to requests that use an explicit cache, and extra input tokens sent with an explicit cache are billed at the standard rate. — [Gemini API caching docs (generateContent)](https://aistudio.google.com/docs/caching?generate-content=true)
- On Gemini 4 (Argon and newer), multi-turn and agent loops cache the full previous request only if the new request adds at least 2,050 tokens. Explicit caching is not supported for Gemini 4 Argon and later, and the Interactions API supports only implicit caching. Explicit caching is for Gemini 3 and 2.5 models via generateContent. — [Gemini API caching docs](https://aistudio.google.com/docs/caching)
- Vertex: implicit caching is on by default for all projects and gives a 90% discount on cached tokens, with no storage cost. A cached prefix "expires no later than 24 hours after it's created", and most entries are evicted earlier. Explicit caching gives a guaranteed discount: 90% on Gemini 2.5 and later, 75% on 2.0. — [Vertex AI context caching overview](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview)
- Pricing examples, Standard tier, per 1M tokens: Gemini 3.8 Flash and 3.6 Flash input $0.75, cached $0.075, storage $0.50/hour (until 2026-12-31; doubling from 2027-01-01). Gemini 3 Flash Preview input $0.50, cached $0.05, storage $1.00/hour. Gemini 3.5 Flash-Lite input $0.30, cached $0.03, storage $1.00/hour. Gemini 3.1 Flash-Lite input $0.25, cached $0.025, storage $1.00/hour. Gemini 3.1 Pro Preview input $2.00, cached $0.20 (≤200k), storage $4.50/hour. — [Gemini API pricing](https://aistudio.google.com/docs/pricing)

### Inferences
- Rough break-even for 2k tokens on 3.8 Flash: storage is 2k × $0.50/1M ≈ $0.001/hour, and each cached request saves 2k × ($0.75 − $0.075)/1M ≈ $0.00135. A cache would pay for itself at about one request per hour, but the minimum-token rule makes it impossible at this size, and the absolute savings are fractions of a cent.
- To benefit from implicit caching later, if the catalog grows past ~4k tokens, keep the system instruction, tools and catalog as an identical, stable prefix on every request and put the per-user or variable content last.

### Gaps
- No doc confirms whether tool declarations count toward the implicit-cache prefix on Gemini 3 (likely, since they are part of the prompt, but unconfirmed).

## 4. TTL / expireTime, expired caches, updates and storage cost

### Takeaway
The default TTL is 1 hour, with no maximum (Vertex sets a 1-minute minimum). `caches.update` can change only `ttl` or `expireTime`. After expiry the cache is deleted and requests that reference it fail (users see 403/404). Caches may also disappear before their TTL, so code should catch the error, recreate the cache and retry. Storage is billed per token-hour for the whole TTL.

### Cited Findings
- "If not set, the TTL defaults to 1 hour." Storage is billed by TTL, and "There are no minimum or maximum bounds on the TTL." `caches.update` can change `ttl` or `expire_time`, and updating anything else is not supported. JS: `ai.caches.update({ name: cache.name, config: { ttl: '7200s' } })`. Python accepts a timezone-aware datetime or ISO string for `expire_time`. Content can't be read back, only metadata (`name`, `model`, `display_name`, `usage_metadata`, `create_time`, `update_time`, `expire_time`). — [Gemini API caching docs (generateContent)](https://aistudio.google.com/docs/caching?generate-content=true)
- Vertex: "The default `expireTime` is 60 minutes after the `createTime`." "After a cache expires, it's marked for deletion and you shouldn't assume that it can be used or updated". To keep using it, recreate it. — [Vertex AI: Use a context cache](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-use)
- Vertex: explicit TTL minimum is 1 minute and "There isn't a maximum cache duration." Creating a cache bills the input tokens at the standard input price, and explicit caching adds storage costs based on how long caches are kept. — [Vertex AI context caching overview](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview)
- Requests against a gone cache are reported as HTTP 403 or 404. One client library maps both to a "cache expired" error. — [rig-core cached_content.rs](https://docs.rs/rig-core/0.44.0/src/rig_core/client/cached_content.rs.html)
- A third-party blog reports NOT_FOUND (404) errors before the TTL ends, especially after idle periods, and recommends catch-and-recreate. This is not an official claim. — [Workalizer blog](https://workalizer.com/insights/gemini/gemini-api-context-caching-why-your-ttl-isnt-a-guarantee-and-how-to-prevent-404-errors)
- Cached tokens count toward the standard GenerateContent rate limits, and there are no special caching rate limits. — [Gemini API caching docs (generateContent)](https://aistudio.google.com/docs/caching?generate-content=true)

### Inferences
- With `ttl: '1800s'` and a long-running Node server, chats created more than 30 minutes after startup (or ongoing chats past that point) will reference an expired cache and fail unless the app refreshes it. It can call `caches.update` periodically, or recreate the cache on a 403/404 and rebuild the chat.

### Gaps
- No official doc gives the exact error body for a request against an expired cache. The 403/404 codes come from third-party sources.

## 5. Must the cache's model exactly match the request model?

### Takeaway
Yes. A cache is created for one model (stored in its `model` field as `models/<id>`), and requests must use that same model. A mismatch returns 400 INVALID_ARGUMENT, according to third-party sources. Official docs only say that the cache records the model it was created with.

### Cited Findings
- Vertex: the cache's `model` is "The resource name for the model used to create the cache". The cache name includes the region, and requests must use the full resource name. — [Vertex AI: Use a context cache](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-use)
- The cache metadata exposes `model`. — [Gemini API caching docs (generateContent)](https://aistudio.google.com/docs/caching?generate-content=true)
- Client-library evidence: rig-core says a cache is tied to one model and normalizes the name to `models/gemini-...` for matching. The gemini-review-action release notes say it added model validation for caching "to prevent INVALID_ARGUMENT 400 errors when switching Gemini models". The Erlang ADK returns a `context_cache_model_mismatch` error. — [rig-core gemini cached_content.rs](https://docs.rs/rig-core/0.44.0/src/rig_core/providers/gemini/cached_content.rs.html); [gemini-review-action v1.3.5](https://github.com/derailed-dash/gemini-review-action/releases/tag/v1.3.5); [erlang_adk source](https://hex.pm/packages/erlang_adk/0.7.0/files/src/models/gemini/adk_context_cache_gemini.erl)

### Inferences
- Use the same model id string in `caches.create` and in `chats.create` / `generateContent`. Aliases that resolve differently (a `-latest` alias versus a pinned version, or a preview versus a GA id) should be treated as different models. Recreate the cache when the configured model changes.

### Gaps
- I found no official doc that quotes the exact error message for a model mismatch.
