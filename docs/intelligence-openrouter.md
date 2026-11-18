# Intelligence Core — OpenRouter Configuration

OpenRouter (`https://openrouter.ai/`) is the **only** production AI gateway in Phase 1.

The Decision Engine never talks to OpenAI, Anthropic, or Google APIs directly. Model selection is configuration-only.

## 1. Create an OpenRouter account

1. Open [https://openrouter.ai/](https://openrouter.ai/)
2. Create an account
3. Generate an API key from the OpenRouter dashboard
4. Review available models at [https://openrouter.ai/models](https://openrouter.ai/models)

Official docs:

- [https://openrouter.ai/docs](https://openrouter.ai/docs)
- [https://openrouter.ai/developers](https://openrouter.ai/developers)

## 2. Configure `.env`

Copy placeholders from `.env.example` and set:

```env
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=your_key_here
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=provider/model-name
OPENROUTER_FALLBACK_MODELS=
OPENROUTER_APP_NAME=Instagram Automation Agent
OPENROUTER_APP_URL=
AI_REQUEST_TIMEOUT_MS=60000
AI_MAX_TOOL_ITERATIONS=8
AI_MAX_RETRIES=2
```

Rules:

- Never commit `.env`
- Never hardcode API keys
- `OPENROUTER_MODEL` is required for real AI operations and must use `provider/model-name`
- The app does **not** invent a default model ID
- Fallback models are optional and comma-separated

## 3. Select a model

Examples of valid model ID shapes (illustrative only):

```text
openai/some-model
anthropic/some-model
google/some-model
```

Change models by editing `OPENROUTER_MODEL` (and optional `OPENROUTER_FALLBACK_MODELS`). No Decision Engine code changes are required.

## 4. Test the connection

```bash
npm run agent -- ai status
npm run agent -- ai test
npm run agent -- ai models
npm run agent -- ai usage
```

- `ai status` never prints secrets
- `ai test` performs a real minimal OpenRouter request
- Do not claim connectivity works until `ai test` succeeds

For deterministic local tests without network:

```bash
npm run agent -- --mock execute "Analyze recent Story performance"
```

Mock output is never treated as real AI output.

## 5. Tool Calling

The model may request application tools. The application owns execution.

Flow:

1. Send instruction + context + tool definitions to OpenRouter
2. Inspect returned tool calls
3. Validate tool name/arguments
4. Enforce permissions
5. Execute only registered tools
6. Return results to the model
7. Stop on final JSON decision or iteration/timeout limits

The model cannot access the database, browser, filesystem, or Instagram account directly.

## 6. Usage and cost tracking

When OpenRouter returns usage fields, the system records:

- requested model
- actual model
- prompt / completion / total tokens
- request duration
- status / error category
- cost only when reliably present

Missing values are stored as `null`. They are never invented.

## 7. Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `AI_CONFIG_MISSING_KEY` | `OPENROUTER_API_KEY` unset |
| `AI_CONFIG_MISSING_MODEL` | `OPENROUTER_MODEL` unset |
| `AI_CONFIG_INVALID_MODEL` | model not in `provider/model-name` form |
| `OPENROUTER_AUTH` | invalid API key |
| `OPENROUTER_CREDITS` | insufficient OpenRouter credits |
| `OPENROUTER_MODEL_NOT_FOUND` | unavailable/unsupported model ID |
| `OPENROUTER_SECURITY_POLICY` | Cloudflare edge/network block (often IPv6 path); not proof the key is invalid |
| `OPENROUTER_RATE_LIMIT` | temporary rate limit; retries may apply |
| `AI_INVALID_OUTPUT` | malformed decision JSON; not persisted as success |

### Cloudflare `Access denied by security policy`

If `curl`/`Node` receive HTTP 403 with body:

```json
{ "success": false, "error": "Access denied by security policy." }
```

and `server: cloudflare`, the request was blocked before OpenRouter API auth.

On dual-stack hosts, compare:

```bash
curl -4 -sS -o /dev/null -w '%{http_code} %{header_json}\n' https://openrouter.ai/api/v1/models
curl -6 -sS -o /dev/null -w '%{http_code}\n' https://openrouter.ai/api/v1/models
```

This project prefers IPv4 DNS results when constructing the OpenRouter client (`dns.setDefaultResultOrder('ipv4first')`) because some IPv6 edges return the security-policy 403 while IPv4 succeeds.

Do not treat that 403 as an automatic API-key failure.
