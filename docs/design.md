# agent-platform-management-console-oc Design

## Goal

Build a long-running TypeScript service, installed on the same server as an OpenClaw gateway, that listens on a dedicated MQTT management topic and replaces shell-based management entrypoints such as:

- `agents`
- `logs`
- `restart`

The legacy deployment may keep `doctor`, but the management plane is moved into this service.

## Constraints

### Configuration split

The service uses:

- environment variables for MQTT connection credentials
- a JSON config file for stable service behavior and paths
- OpenClaw's own `OPENCLAW_*` environment variables for OpenClaw-owned directories

Reason:

- broker URLs, usernames, and passwords are deployment secrets
- topics, binary paths, roots, and state-file locations are stable defaults
- this keeps the runtime surface smaller and less error-prone
- OpenClaw-owned shared paths must follow the active OpenClaw runtime layout instead of a hard-coded directory

### Official OpenClaw surfaces

The service must use official OpenClaw control surfaces rather than directly editing `openclaw.json`:

- `openclaw agents ...`
- `openclaw channels ...`
- `openclaw config get/set/unset/validate`
- `openclaw gateway ...`
- `openclaw logs`
- `openclaw models status`
- `openclaw doctor`

Relevant docs:

- CLI index: `https://docs.openclaw.ai/cli`
- Agents: `https://docs.openclaw.ai/cli/agents`
- Channels: `https://docs.openclaw.ai/cli/channels`
- Config: `https://docs.openclaw.ai/cli/config`
- Logs: `https://docs.openclaw.ai/cli/logs`
- Doctor: `https://docs.openclaw.ai/cli/doctor`
- Gateway: `https://docs.openclaw.ai/cli/gateway`
- Hooks: `https://docs.openclaw.ai/automation/hooks`
- Agent config: `https://docs.openclaw.ai/gateway/config-agents`

### MQTT channel plugin

The target deployment uses `@kadbbz/mqtt-channel` as an OpenClaw channel plugin.

Confirmed from the plugin manifest for `@kadbbz/mqtt-channel@2.3.1`:

- `channels["mqtt-channel"].accounts.<id>.enabled` is a legal config field.
- Account config includes `brokerUrl`, `username`, `password`, `topics.inbound`, `topics.outbound`, `qos`, `disableBlockStreaming`.

This matters because `enable/disable` can be implemented as a first-class account switch instead of delete/recreate.

### Hooks

Hooks are not used as the primary control plane.

Reason:

- Hooks are event-driven inside the gateway.
- This project is a management control plane driven from MQTT requests.
- The service needs deterministic administrative operations, not lifecycle callbacks.

Hooks remain a future extension point for:

- workspace bootstrap enrichment
- managed `AGENTS.md` composition during `agent:bootstrap`
- audit logging

## Architecture

### Runtime components

1. MQTT listener
2. sequential command executor
3. OpenClaw CLI adapter
4. managed state store
5. operation handlers
6. lightweight HTTP health server

### Why sequential execution

OpenClaw config writes, channel account mutations, agent binding changes, and gateway restarts should not race each other. The service therefore processes management requests one at a time.

### Managed state

The service keeps a local state file for the resources it owns:

```json
{
  "version": 1,
  "agents": [
    {
      "id": "lowcode",
      "accountId": "lowcode",
      "workspace": "/var/platform_data/openclaw/workspaces/lowcode",
      "inboundTopic": "agents/channel/lowcode/inbound",
      "outboundTopic": "agents/channel/lowcode/outbound",
      "enabled": true,
      "updatedAt": "2026-05-13T13:00:00.000Z"
    }
  ]
}
```

This state is not a replacement for OpenClaw config. It exists to track which agents/accounts were created by this service and which topic/account pair belongs to each managed agent.

## Config model

Example:

```json
{
  "http": {
    "host": "0.0.0.0",
    "port": 3000
  },
  "gateway": {
    "restartMode": "openclaw"
  },
  "openclaw": {
    "bin": "openclaw",
    "doctorBin": "doctor",
    "workspacesRoot": "/var/platform_data/openclaw/workspaces",
    "ontologyRoot": "/var/platform_data/ontology"
  },
  "mqtt": {
    "requestTopic": "openclaw/management/request",
    "responseTopic": "openclaw/management/response",
    "inboundTopicTemplate": "agents/channel/{agent-name}/inbound",
    "outboundTopicTemplate": "agents/channel/{agent-name}/outbound"
  },
  "skills": {
    "globalRoot": ""
  },
  "stateFile": "/var/platform_data/openclaw-management/managed-agents.json"
}
```

Secrets stay in env:

- `AIOS_MQTT_BROKER`
- `AIOS_MQTT_USERNAME`
- `AIOS_MQTT_PASSWORD`
- `AIOS_MQTT_CHANNEL_BROKER`
- `AIOS_MQTT_CHANNEL_USERNAME`
- `AIOS_MQTT_CHANNEL_PASSWORD`
- `OPENCLAW_HOME`
- `OPENCLAW_STATE_DIR`
- `OPENCLAW_CONFIG_PATH`

When `skills.globalRoot` is empty, the service derives the shared skill root from OpenClaw env vars:

- `OPENCLAW_STATE_DIR/skills`, or
- `<OPENCLAW_HOME or HOME>/.openclaw/skills`

## Request protocol

### Transport

- inbound MQTT topic: configurable, default `openclaw/management/request`
- outbound MQTT topic: configurable, default `openclaw/management/response`

### Request envelope

```json
{
  "requestId": "req-001",
  "action": "agent.create",
  "replyTo": "openclaw/management/reply",
  "params": {}
}
```

### Response envelope

```json
{
  "requestId": "req-001",
  "action": "agent.create",
  "ok": true,
  "result": {},
  "timestamp": "2026-05-13T13:00:00.000Z"
}
```

## Operation mapping

### Agent management

`agent.create`

1. validate id
2. `openclaw agents add ... --non-interactive`
3. `openclaw config set channels["mqtt-channel"].accounts["<accountId>"] ... --strict-json`
4. `openclaw agents bind --agent <id> --bind mqtt-channel:<accountId>`
5. optionally set `agents.list[index].model`
6. optionally write workspace `AGENTS.md`
7. optionally restart gateway

`agent.enable`

1. `openclaw config set channels["mqtt-channel"].accounts["<accountId>"].enabled true --strict-json`
2. ensure binding exists

`agent.disable`

1. `openclaw config set channels["mqtt-channel"].accounts["<accountId>"].enabled false --strict-json`

`agent.delete`

1. `openclaw agents unbind --agent <id> --bind mqtt-channel:<accountId>`
2. `openclaw config unset channels["mqtt-channel"].accounts["<accountId>"]`
3. `openclaw agents delete <id> --force`
4. optionally restart gateway

`agent.usage`

- `openclaw models status --agent <id> --json`

`agent.model.set`

- `openclaw config set agents.list[index].model ... --strict-json`

`agent.docs.update`

- write `<workspace>/AGENTS.md`

### Ontology management

`ontology.create`

- accept a zip payload
- extract safely under the ontology root into a named directory
- reject path traversal entries

`ontology.delete`

- remove one ontology directory

### Logs

`logs.query`

- `openclaw logs --limit <n> --plain --no-color`

### Global skills management

Global skills mean shared managed skills visible to every agent through the
OpenClaw shared skill root.

Official semantics used here:

- shared managed/local skills: `~/.openclaw/skills`
- extra shared roots: `skills.load.extraDirs`
- per-workspace installs are intentionally excluded from this global scope

Implementation:

- list: inspect the configured shared skill root and ClawHub lock/origin metadata
- install: `clawhub install <slug> --workdir <parent> --dir <basename>`
- update: `clawhub update <slug>|--all --workdir <parent> --dir <basename>`
- delete: `clawhub uninstall <slug> --workdir <parent> --dir <basename> --no-input --yes`

### Diagnostics

`diagnostics.run`

- prefer retained `doctor` command when present for legacy compatibility
- otherwise fallback to `openclaw doctor`

### Gateway restart

`gateway.restart`

- default to `openclaw gateway restart --safe --json`
- allow `skipDeferral` and `force`
- allow disabling restart entirely with `gateway.restartMode = "none"` for containerized deployments where the gateway process is not restartable through the CLI
- allow container restart with `gateway.restartMode = "container"` by signaling PID 1 and relying on Docker restart policy

## Restart policy

Only the explicit `gateway.restart` action triggers a restart.

- `agent.create`, `agent.delete`, `agent.enable`, `agent.disable`
- `agent.model.set`, `agent.docs.update`
- `skills.global.*`
- `ontology.*`
- `logs.query`
- `diagnostics.run`

All of the actions above only change configuration or query state. They do not restart the gateway automatically.

## Non-goals for v1

- direct plugin development
- hook-pack authoring
- concurrent request execution
- streaming log follow over MQTT
- generalized arbitrary config editing

## Development approach

1. implement the service and CLI adapter
2. cover state and handler behavior with local tests
3. validate build and request routing locally with a fake CLI
