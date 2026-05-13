# agent-platform-management-console-oc

MQTT-driven management service for OpenClaw gateways.

This service is designed to run on the same server as an OpenClaw gateway and replace shell-based management entrypoints such as `agents`, `logs`, and `restart`. The original deployment may keep `doctor`, but the management plane moves to this service.

The implementation uses official OpenClaw CLI/config writers instead of editing `openclaw.json` directly:

- `openclaw agents ...`
- `openclaw channels ...`
- `openclaw config get/set/unset/validate`
- `openclaw gateway ...`
- `openclaw logs`
- `openclaw models status`
- `openclaw doctor`

## Install

```bash
npm install agent-platform-management-console-oc
```

## Run

1. Create a config file from `config.example.json`.
2. Provide MQTT connection values with environment variables.
3. If OpenClaw uses a custom runtime home, export the same `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, or `OPENCLAW_CONFIG_PATH` values for this service.

```bash
OC_MANAGEMENT_CONFIG_FILE="/etc/agent-platform-management-console-oc/config.json" \
OC_MANAGEMENT_MQTT_BROKER="mqtts://broker.example.com:8883" \
OC_MANAGEMENT_MQTT_USERNAME="user" \
OC_MANAGEMENT_MQTT_PASSWORD="pass" \
OC_MQTT_CHANNEL_BROKER="mqtts://broker.example.com:8883" \
OC_MQTT_CHANNEL_USERNAME="user" \
OC_MQTT_CHANNEL_PASSWORD="pass" \
agent-platform-management-console-oc
```

Optional HTTP health server:

- `GET /health`
- `GET /ready`
- `GET /state`

Default listen address is `0.0.0.0:3000`.

## MQTT protocol

Default topics:

- request: `openclaw/management/request`
- response: `openclaw/management/response`

Request payload:

```json
{
  "requestId": "req-001",
  "action": "agent.create",
  "replyTo": "openclaw/management/reply",
  "params": {
    "agentId": "lowcode",
    "workspace": "/var/platform_data/openclaw/workspaces/lowcode",
    "restart": true
  }
}
```

Response payload:

```json
{
  "requestId": "req-001",
  "action": "agent.create",
  "ok": true,
  "result": {
    "agentId": "lowcode"
  },
  "timestamp": "2026-05-13T13:00:00.000Z"
}
```

## Supported actions

- `service.ping`
- `service.status`
- `agent.list`
- `agent.create`
- `agent.enable`
- `agent.disable`
- `agent.delete`
- `agent.usage`
- `agent.model.set`
- `agent.docs.update`
- `skills.global.list`
- `skills.global.install`
- `skills.global.update`
- `skills.global.delete`
- `ontology.list`
- `ontology.create`
- `ontology.delete`
- `logs.query`
- `diagnostics.run`
- `gateway.status`
- `gateway.restart`

## Configuration

Secrets and connection values live in environment variables:

- `OC_MANAGEMENT_CONFIG_FILE`
- `OC_MANAGEMENT_MQTT_BROKER`
- `OC_MANAGEMENT_MQTT_USERNAME`
- `OC_MANAGEMENT_MQTT_PASSWORD`
- `OC_MANAGEMENT_MQTT_CLIENT_ID`
- `OC_MQTT_CHANNEL_BROKER`
- `OC_MQTT_CHANNEL_USERNAME`
- `OC_MQTT_CHANNEL_PASSWORD`
- `OPENCLAW_HOME`
- `OPENCLAW_STATE_DIR`
- `OPENCLAW_CONFIG_PATH`

Stable service behavior lives in JSON config:

- HTTP host and port
- `openclaw` and `doctor` binary paths
- workspace root
- ontology root
- global shared skills root
- request and response topics
- managed agent topic templates
- local state file path

If `skills.globalRoot` is empty, the service derives the shared skill path from OpenClaw's env layout:

- `OPENCLAW_STATE_DIR/skills`, when `OPENCLAW_STATE_DIR` is set
- otherwise `<OPENCLAW_HOME or HOME>/.openclaw/skills`

## Design

See [docs/design.md](/Users/ningwei/VSCodeProjects/openclaw-management-console/docs/design.md:1).

## Reference

See [reference.md](/Users/ningwei/VSCodeProjects/openclaw-management-console/reference.md:1) for one example request per management action.

## Development

```bash
npm install
npm run check
npm run build
npm test
```
