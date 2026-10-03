# GitHub Copilot (CLI and VS Code)

GitHub Copilot can send its model calls through Control Tower: Copilot CLI and VS Code's chat both let you add your own model provider, and Control Tower is one. Every request is then attributed to a key (or, on [laptops](laptops.md), to the person signed in), counted in the Ledger, drawn on the Airspace and subject to your gates. Both also take Control Tower's `/mcp` endpoint as an MCP server, so the tools you've registered come with the same gates.

What goes through Control Tower is the model you add. Copilot's own GitHub-hosted models, and inline code completions in VS Code, still go to GitHub: see [What stays with GitHub](#what-stays-with-github).

> Rolling Copilot CLI out to a whole company? [Laptops](laptops.md) sets it up with Jamf, Intune, Kandji or Group Policy, each person signed in as themselves (Enterprise).

## Quick reference

| | Copilot CLI | VS Code (Copilot Chat) |
|---|---|---|
| Where | environment variables (`COPILOT_PROVIDER_*`) | **Manage Language Models → Add Models → Custom Endpoint** (`chatLanguageModels.json`) |
| Address | `http://<control-tower>:4000` (Messages API) or `…/v1` (Chat Completions) | `http://<control-tower>:4000/v1/messages` or `…/v1/chat/completions`, per model |
| Key | `COPILOT_PROVIDER_API_KEY=ct_sk_…`, or a command that prints it (`COPILOT_PROVIDER_API_KEY_COMMAND`) | the provider's API key |
| Model | `COPILOT_MODEL`: any model name Control Tower serves | each model's `id`: any model name Control Tower serves |
| MCP | `~/.copilot/mcp-config.json` | `mcp.json` (your user folder, or `.vscode/mcp.json`) |
| GitHub account | Not needed (`COPILOT_OFFLINE=true` talks to Control Tower only) | Not needed for these models |

## Step 1: Create a key

In the console, open **Keys → Create key**. Name it (`copilot`, or one per developer such as `copilot-dana`), set its **Team**, and click **Create**. The key is shown once.

## Copilot CLI

Install it if you haven't: `npm install -g @github/copilot` (version 1.0.84 or later).

### Models

Point Copilot CLI's model provider at Control Tower, in the shell that starts it (or your shell's profile):

```bash
export COPILOT_PROVIDER_TYPE=anthropic
export COPILOT_PROVIDER_BASE_URL=http://localhost:4000
export COPILOT_PROVIDER_API_KEY=ct_sk_…
export COPILOT_MODEL=claude-sonnet-4-5
export COPILOT_OFFLINE=true   # only Control Tower: no GitHub sign-in, no telemetry
```

`COPILOT_MODEL` can be any model Control Tower serves, Claude or not: Control Tower translates the Messages API for other providers. The Messages API (`COPILOT_PROVIDER_TYPE=anthropic`) is the one to choose: a request a gate holds is told in Copilot's reply as it waits (see [What a person sees](#what-a-person-sees)). To use Chat Completions instead, set `COPILOT_PROVIDER_TYPE=openai` and `COPILOT_PROVIDER_BASE_URL=http://localhost:4000/v1`.

Rather than keep the key in a variable, Copilot CLI can run a command that prints it, each time it needs one: `COPILOT_PROVIDER_API_KEY_COMMAND=/path/to/a/script`. That's how the [Laptops](laptops.md) rollout gives it each person's short-lived token from ct-auth.

Check it:

```bash
copilot -p "Which gateway are you going through?"
```

The request is in **Flights**, as a `messages` call (or `chat`) under the key, and the app is shown as GitHub Copilot CLI.

### Tools (MCP)

Add Control Tower to `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "controltower": {
      "type": "http",
      "url": "http://localhost:4000/mcp",
      "headers": { "Authorization": "Bearer ct_sk_…" },
      "tools": ["*"]
    }
  }
}
```

Copilot names them `controltower-<server>__<tool>`. A key sees only the tools it may use; to add one tool server only, use its own endpoint, `http://localhost:4000/mcp/<slug>`.

## VS Code (GitHub Copilot Chat)

VS Code's chat (GitHub Copilot Chat, built into VS Code) takes models from your own provider through its **Custom Endpoint** provider, without a GitHub account or Copilot plan. The first time someone opens the chat, VS Code asks them to set it up; after that, the chat works with the models you add.

### Models

Open the chat's model picker, then **Manage Language Models → Add Models → Custom Endpoint**, name the group `Control Tower`, give it the key, and choose the API type. VS Code opens `chatLanguageModels.json`, in your user folder, where each model has its address:

```json
[
  {
    "name": "Control Tower",
    "vendor": "customendpoint",
    "apiKey": "${input:controltowerKey}",
    "apiType": "messages",
    "models": [
      {
        "id": "claude-sonnet-4-5",
        "name": "Claude Sonnet 4.5 (Control Tower)",
        "url": "http://localhost:4000/v1/messages",
        "toolCalling": true,
        "vision": false,
        "maxInputTokens": 200000,
        "maxOutputTokens": 8000
      }
    ]
  }
]
```

For a model on Chat Completions, use `"apiType": "chat-completions"` and `"url": "http://localhost:4000/v1/chat/completions"`. Any model name Control Tower serves works in either; the Messages API is the one on which a held request is told in the chat as it waits.

The key you enter is kept in VS Code's secret storage. To put the file in place for someone (from a setup script, say), give each model the key in `requestHeaders` instead: `"requestHeaders": { "Authorization": "Bearer ct_sk_…" }`.

### Tools (MCP)

Add Control Tower to `mcp.json` (**MCP: Open User Configuration**, or `.vscode/mcp.json` in a project):

```json
{
  "servers": {
    "controltower": {
      "type": "http",
      "url": "http://localhost:4000/mcp",
      "headers": { "Authorization": "Bearer ${input:controltowerKey}" }
    }
  },
  "inputs": [{ "id": "controltowerKey", "type": "promptString", "description": "Control Tower key", "password": true }]
}
```

### For a company

- **Your own models.** For Copilot Business and Enterprise, the **Bring Your Own Language Model Key in VS Code** policy (in your GitHub organization's Copilot policies) must be on for people to add Control Tower's models.
- **A key each.** VS Code has no setting that runs a command for its key, so each person uses a key of their own (one per person in **Keys**, with its owner set), and you revoke it there when they leave.
- **Only your MCP servers.** VS Code's policies (Group Policy, Intune, a macOS profile) control MCP: **ChatAllowedMcpServers** (`chat.mcp.allowedServers`) to allow only Control Tower's endpoint, **ChatDeniedMcpServers**, and **ChatMCP** (`chat.mcp.access`: `all`, `registry` or `none`).

## What a person sees

Control Tower recognises Copilot CLI and VS Code's chat, and treats them as a person's apps, as it does Claude and Codex:

- **Held for approval**, on the Messages API: the reply starts at once with *⏳ Control Tower: waiting for approval (gate "…")*, stays open while an approver decides, then says *✓ approved by …* and the answer follows. In Copilot CLI and in VS Code's chat alike.
- **Blocked or denied**: a short message saying which gate and why (*Control Tower blocked this message: it contains AWS access key*). Without it, Copilot CLI showed a refusal as "Authentication failed with provider".

Flights show the app as GitHub Copilot CLI or VS Code.

See [What a person sees](airspace.md#what-a-person-sees).

## What stays with GitHub

- **Copilot's own models.** In VS Code, a person can still choose a GitHub-hosted model in the picker, if their plan has one; those calls go to GitHub, not through Control Tower. To keep everyone on Control Tower's models, turn the GitHub-hosted models off in your Copilot policies, or give Copilot CLI `COPILOT_OFFLINE=true` (the Laptops rollout does with **Lock down**).
- **Inline suggestions and other GitHub features** (code completions, semantic search, `/delegate`) use GitHub's service and a GitHub account.
- **Copilot's cloud agent** runs on GitHub, not on the laptop; give it Control Tower's MCP endpoint in the repository's Copilot settings if it should use your tools.

## Tested with

Both are run for real against Control Tower each week:

- **Copilot CLI 1.0.91**, installed by the Laptops rollout on Windows and macOS: signed in with ct-auth, no GitHub account, its answers through Control Tower, recorded as the person. With a key, it lists Control Tower's MCP tools.
- **VS Code 1.140 with its built-in Copilot Chat 0.68**, on Linux: Custom Endpoint models on both APIs, a refusal in words, and a held request approved while it waits. VS Code's MCP connection to Control Tower isn't covered by that run yet (unattended, VS Code doesn't start the servers in `mcp.json`); it uses the same MCP endpoint Claude Code, Codex and Copilot CLI are tested with.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Authentication failed with provider … (HTTP 401)` | The key isn't set, or was revoked | Check `COPILOT_PROVIDER_API_KEY` (or the command in `COPILOT_PROVIDER_API_KEY_COMMAND` prints a key) |
| `404 model_not_found` | `COPILOT_MODEL` isn't a model Control Tower serves | Use a name from **Models** |
| Requests don't appear in Flights | Copilot is using a GitHub-hosted model | Set `COPILOT_PROVIDER_BASE_URL` (CLI), or pick the Control Tower model in VS Code's picker |
| No Control Tower tools in Copilot CLI | `mcp-config.json` not found, or the key may not use the tools | Check the file is in `~/.copilot` (or `$COPILOT_HOME`), and the key's allowed tools |

## Next steps

- [Laptops](laptops.md): Copilot CLI for everyone, signed in as themselves
- [Keys, budgets & rate limits](keys.md): a budget per developer
- [Airspace, gates & approvals](airspace.md): approval before Copilot runs a destructive tool
