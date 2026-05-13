# agent-platform-management-console-oc 参考

## 说明

所有管理命令都通过 MQTT JSON 消息发送到管理请求主题。

基础包结构：

```json
{
  "requestId": "req-001",
  "action": "service.ping",
  "replyTo": "openclaw/management/reply",
  "params": {}
}
```

重启规则必须明确区分：

- 只有 `gateway.restart` 会触发重启
- 其他动作都不会自动重启
- 如果需要在配置变更后重启，请单独发送一条 `gateway.restart`

## 服务

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

## Agent 管理

### `agent.list`

说明：返回结果中的 `items` 会额外整理出以下字段：

- `name`
- `workspaces`
- `inbound-topic`
- `outbound-topic`

```json
{
  "requestId": "req-agent-list-001",
  "action": "agent.list",
  "params": {}
}
```

### `agent.create`

说明：创建 agent、写入 `mqtt-channel` 账号配置、绑定 agent；不会自动重启 gateway。

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
    "agentsMd": "# Lowcode Agent\n\n共享运行说明。"
  }
}
```

### `agent.enable`

说明：只启用账号和绑定；不会自动重启 gateway。

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

说明：只禁用账号；不会自动重启 gateway。

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

说明：解绑、删除账号、删除 agent；不会自动重启 gateway。

```json
{
  "requestId": "req-agent-delete-001",
  "action": "agent.delete",
  "params": {
    "agentId": "lowcode"
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

说明：只更新模型配置；不会自动重启 gateway。

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

说明：只写入工作区 `AGENTS.md`；不会自动重启 gateway。

```json
{
  "requestId": "req-agent-docs-001",
  "action": "agent.docs.update",
  "params": {
    "agentId": "lowcode",
    "content": "# AGENTS\n\n更新后的说明。"
  }
}
```

## 全局 Skills

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

更新单个 skill：

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

更新所有全局 skill：

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

说明：请求里只传 `bucket` 和 `objectKey`。服务会用环境变量中的 MinIO/S3 连接信息下载 zip 并解压；不会自动重启 gateway。

```json
{
  "requestId": "req-ontology-create-001",
  "action": "ontology.create",
  "params": {
    "name": "crm-ontology",
    "bucket": "ontology-artifacts",
    "objectKey": "crm/crm-ontology.zip",
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

## 日志

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

## 诊断

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

说明：这是唯一会触发重启的动作。具体行为由 `gateway.restartMode` 决定：

- `openclaw`：执行 `openclaw gateway restart`
- `none`：跳过重启
- `container`：向 PID 1 发送 `SIGTERM`，依赖 Docker restart policy 重启容器

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
