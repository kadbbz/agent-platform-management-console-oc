# agent-platform-management-console-oc

面向 OpenClaw gateway 的 MQTT 管理服务。

这个服务部署在 OpenClaw gateway 所在机器或容器中，通过管理主题接收 JSON 请求，替代直接执行 `agents`、`logs`、`restart` 等壳命令。实现上只使用 OpenClaw 官方 CLI 和配置写入接口，不直接改写 `openclaw.json`。

当前使用的 OpenClaw 控制面包括：

- `openclaw agents ...`
- `openclaw channels ...`
- `openclaw config get/set/unset/validate`
- `openclaw gateway ...`
- `openclaw logs`
- `openclaw models status`
- `openclaw doctor`

## 安装

```bash
npm install agent-platform-management-console-oc
```

## 运行

1. 基于 `config.example.json` 准备一份实际配置文件。
2. 通过环境变量提供 MQTT 连接信息。
3. 如果需要创建 ontology，再通过环境变量提供 MinIO/S3 连接信息。
4. 如果 OpenClaw 使用了自定义运行目录，同时导出一致的 `OPENCLAW_HOME`、`OPENCLAW_STATE_DIR` 或 `OPENCLAW_CONFIG_PATH`。

示例：

```bash
OC_MANAGEMENT_CONFIG_FILE="/etc/agent-platform-management-console-oc/config.json" \
AIOS_MQTT_BROKER="mqtts://broker.example.com:8883" \
AIOS_MQTT_USERNAME="user" \
AIOS_MQTT_PASSWORD="pass" \
AIOS_MQTT_CHANNEL_BROKER="mqtts://broker.example.com:8883" \
AIOS_MQTT_CHANNEL_USERNAME="user" \
AIOS_MQTT_CHANNEL_PASSWORD="pass" \
AIOS_S3_ENDPOINT="http://minio.example.com:9000" \
AIOS_S3_REGION="us-east-1" \
AIOS_S3_ACCESS_KEY_ID="minio-access" \
AIOS_S3_SECRET_ACCESS_KEY="minio-secret" \
agent-platform-management-console-oc
```

## Docker 重启模式

`gateway.restartMode` 支持三种模式：

- `openclaw`：执行 `openclaw gateway restart --safe --json`
- `none`：跳过重启
- `container`：在响应发送完成后，对容器内 PID 1 发送 `SIGTERM`，交给 Docker 的 restart policy 重启容器

如果你的部署要求“在容器内触发整容器重启”，应配置为 `container`，并确保容器本身配置了 `--restart` 或编排层等价策略。

## HTTP 健康检查

服务只暴露一个 HTTP 接口：

- `GET /health`

默认监听地址为 `0.0.0.0:3000`。

返回规则：

- 配置合法，且管理面 MQTT 已连接并成功订阅 request topic 时返回 `200`
- 其他情况返回 `503`

返回内容会包含：

- 配置校验结果
- 管理面 MQTT 连接和订阅状态
- `mqtt-channel` 相关配置摘要

## MQTT 协议

默认主题：

- 请求主题：`openclaw/management/request`
- 响应主题：`openclaw/management/response`

请求消息示例：

```json
{
  "requestId": "req-001",
  "action": "agent.create",
  "replyTo": "openclaw/management/reply",
  "params": {
    "agentId": "lowcode",
    "workspace": "/var/platform_data/openclaw/workspaces/lowcode"
  }
}
```

响应消息示例：

```json
{
  "requestId": "req-001",
  "action": "agent.create",
  "ok": true,
  "result": {
    "id": "lowcode"
  },
  "timestamp": "2026-05-13T13:00:00.000Z"
}
```

## 支持的动作

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

## 重启语义

只有 `gateway.restart` 会触发重启。

以下动作都不会自动重启 gateway，即使请求里带了旧版本遗留的 `restart` 字段，也会被忽略：

- `agent.create`
- `agent.enable`
- `agent.disable`
- `agent.delete`
- `agent.model.set`
- `agent.docs.update`
- `skills.global.*`
- `ontology.*`
- `logs.query`
- `diagnostics.run`

如果你在变更配置后需要重启，请单独再发一条 `gateway.restart`。

`agent.list` 的整理结果 `items` 里会包含以下字段：

- `name`
- `workspaces`
- `inbound-topic`
- `outbound-topic`

## 配置说明

敏感信息和连接参数通过环境变量提供：

- `OC_MANAGEMENT_CONFIG_FILE`
- `AIOS_MQTT_BROKER`
- `AIOS_MQTT_USERNAME`
- `AIOS_MQTT_PASSWORD`
- `AIOS_MQTT_CLIENT_ID`
- `AIOS_MQTT_CHANNEL_BROKER`
- `AIOS_MQTT_CHANNEL_USERNAME`
- `AIOS_MQTT_CHANNEL_PASSWORD`
- `OPENCLAW_HOME`
- `OPENCLAW_STATE_DIR`
- `OPENCLAW_CONFIG_PATH`
- `AIOS_S3_ENDPOINT`
- `AIOS_S3_REGION`
- `AIOS_S3_ACCESS_KEY_ID`
- `AIOS_S3_SECRET_ACCESS_KEY`
- `AIOS_S3_FORCE_PATH_STYLE`

稳定配置通过 JSON 文件提供：

- HTTP 监听地址和端口
- gateway 重启模式
- `openclaw` 和 `doctor` 可执行文件路径
- workspace 根目录
- ontology 根目录
- ontology 对象存储连接信息来自环境变量
- 全局共享 skills 根目录
- 管理 request/response topic
- agent MQTT topic 模板
- 本地 state 文件路径

当 `skills.globalRoot` 为空时，服务会按 OpenClaw 的运行时目录推导共享技能目录：

- 如果设置了 `OPENCLAW_STATE_DIR`，使用 `OPENCLAW_STATE_DIR/skills`
- 否则使用 `<OPENCLAW_HOME 或 HOME>/.openclaw/skills`

`ontology.create` 不再直接接收 zip 内容或本地 zip 路径，而是接收：

- `bucket`
- `objectKey`

服务会使用环境变量中的 MinIO/S3 连接信息下载该对象，并将 zip 解压到 ontology 目录。

## 参考文档

每个管理动作的请求示例见 [reference.md](/Users/ningwei/VSCodeProjects/agent-platform-management-console-oc/reference.md:1)。

设计说明见 [docs/design.md](/Users/ningwei/VSCodeProjects/agent-platform-management-console-oc/docs/design.md:1)。

## 开发

```bash
npm install
npm run check
npm run build
npm test
```
