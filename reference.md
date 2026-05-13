# agent-platform-management-console-oc Reference

## Overview

All commands are sent as MQTT JSON payloads to the management request topic.

Base envelope:

```json
{
  "requestId": "req-001",
  "action": "service.ping",
  "replyTo": "openclaw/management/reply",
  "params": {}
}
```

## Service

### `service.ping`

```json
{
  "requestId": "req-ping-001",
  "action": "service.ping",
  "params": {}
}
```

### `service.status`

```json
{
  "requestId": "req-status-001",
  "action": "service.status",
  "params": {}
}
```

## Agent Management

### `agent.list`

```json
{
  "requestId": "req-agent-list-001",
  "action": "agent.list",
  "params": {}
}
```

### `agent.create`

```json
{
  "requestId": "req-agent-create-001",
  "action": "agent.create",
  "params": {
    "agentId": "lowcode",
    "workspace": "/var/platform_data/openclaw/workspaces/lowcode",
    "model": {
      "primary": "corp-openai/qwen3.5-plus",
      "fallbacks": [
        "openai/gpt-5.4-mini"
      ]
    },
    "agentsMd": "# Lowcode Agent\n\nShared operating instructions.",
    "restart": true
  }
}
```

### `agent.enable`

```json
{
  "requestId": "req-agent-enable-001",
  "action": "agent.enable",
  "params": {
    "agentId": "lowcode"
  }
}
```

### `agent.disable`

```json
{
  "requestId": "req-agent-disable-001",
  "action": "agent.disable",
  "params": {
    "agentId": "lowcode"
  }
}
```

### `agent.delete`

```json
{
  "requestId": "req-agent-delete-001",
  "action": "agent.delete",
  "params": {
    "agentId": "lowcode",
    "restart": true
  }
}
```

### `agent.usage`

```json
{
  "requestId": "req-agent-usage-001",
  "action": "agent.usage",
  "params": {
    "agentId": "lowcode"
  }
}
```

### `agent.model.set`

```json
{
  "requestId": "req-agent-model-001",
  "action": "agent.model.set",
  "params": {
    "agentId": "lowcode",
    "model": {
      "primary": "openai/gpt-5.5",
      "fallbacks": [
        "openai/gpt-5.4-mini"
      ]
    }
  }
}
```

### `agent.docs.update`

```json
{
  "requestId": "req-agent-docs-001",
  "action": "agent.docs.update",
  "params": {
    "agentId": "lowcode",
    "content": "# AGENTS\n\nUpdated instructions."
  }
}
```

## Global Skills

### `skills.global.list`

```json
{
  "requestId": "req-skills-list-001",
  "action": "skills.global.list",
  "params": {}
}
```

### `skills.global.install`

```json
{
  "requestId": "req-skills-install-001",
  "action": "skills.global.install",
  "params": {
    "slug": "calendar-helper",
    "version": "1.2.3",
    "force": false
  }
}
```

### `skills.global.update`

Update one skill:

```json
{
  "requestId": "req-skills-update-001",
  "action": "skills.global.update",
  "params": {
    "slug": "calendar-helper",
    "force": false
  }
}
```

Update all global skills:

```json
{
  "requestId": "req-skills-update-all-001",
  "action": "skills.global.update",
  "params": {
    "all": true
  }
}
```

### `skills.global.delete`

```json
{
  "requestId": "req-skills-delete-001",
  "action": "skills.global.delete",
  "params": {
    "slug": "calendar-helper"
  }
}
```

## Ontology

### `ontology.list`

```json
{
  "requestId": "req-ontology-list-001",
  "action": "ontology.list",
  "params": {}
}
```

### `ontology.create`

```json
{
  "requestId": "req-ontology-create-001",
  "action": "ontology.create",
  "params": {
    "name": "crm-ontology",
    "zipFile": "/var/platform_data/uploads/crm-ontology.zip",
    "replace": true
  }
}
```

### `ontology.delete`

```json
{
  "requestId": "req-ontology-delete-001",
  "action": "ontology.delete",
  "params": {
    "name": "crm-ontology"
  }
}
```

## Logs

### `logs.query`

```json
{
  "requestId": "req-logs-query-001",
  "action": "logs.query",
  "params": {
    "limit": 200
  }
}
```

## Diagnostics

### `diagnostics.run`

```json
{
  "requestId": "req-diagnostics-001",
  "action": "diagnostics.run",
  "params": {
    "deep": true,
    "repair": false
  }
}
```

## Gateway

### `gateway.status`

```json
{
  "requestId": "req-gateway-status-001",
  "action": "gateway.status",
  "params": {}
}
```

### `gateway.restart`

```json
{
  "requestId": "req-gateway-restart-001",
  "action": "gateway.restart",
  "params": {
    "safe": true,
    "skipDeferral": false,
    "force": false
  }
}
```
