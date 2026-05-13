import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { loadEnvironmentConfig } from "../src/env.js";
import { OpenClawManager } from "../src/openclaw-manager.js";
import { buildHealthReport, collectConfigIssues } from "../src/service.js";
import { ManagedStateStore } from "../src/state-store.js";
import type { CommandResult } from "../src/cli-runner.js";
import type { EnvironmentConfig } from "../src/types.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class MockCliRunner {
  public readonly runCalls: Array<{ args: string[]; options?: { stdin?: string; allowFailure?: boolean } }> = [];
  public readonly runJsonCalls: string[][] = [];

  constructor(
    private readonly runJsonQueue: unknown[] = [],
    private readonly runResult: CommandResult = { stdout: "", stderr: "", exitCode: 0 }
  ) {}

  async run(args: string[], options?: { stdin?: string; allowFailure?: boolean }): Promise<CommandResult> {
    this.runCalls.push({ args, options });
    return this.runResult;
  }

  async runJson<T>(args: string[]): Promise<T> {
    this.runJsonCalls.push(args);
    if (this.runJsonQueue.length === 0) {
      throw new Error(`No mock JSON result queued for ${args.join(" ")}`);
    }

    return this.runJsonQueue.shift() as T;
  }
}

function createEnv(overrides: Partial<EnvironmentConfig> = {}): EnvironmentConfig {
  const baseRoot = path.join(tmpdir(), "agent-platform-management-console-oc-test");

  return {
    configFile: path.join(baseRoot, "config.json"),
    host: "0.0.0.0",
    port: 3000,
    gatewayRestartMode: "openclaw",
    openclawHome: path.join(baseRoot, "openclaw-home"),
    openclawStateDir: path.join(baseRoot, "openclaw-home", ".openclaw"),
    openclawConfigPath: path.join(baseRoot, "openclaw-home", ".openclaw", "openclaw.json"),
    openclawBin: "openclaw",
    doctorBin: "doctor",
    workspacesRoot: path.join(baseRoot, "workspaces"),
    ontologyRoot: path.join(baseRoot, "ontology"),
    ontologyS3Endpoint: "http://minio.internal:9000",
    ontologyS3Region: "us-east-1",
    ontologyS3AccessKeyId: "minio-access",
    ontologyS3SecretAccessKey: "minio-secret",
    ontologyS3ForcePathStyle: true,
    globalSkillsRoot: path.join(baseRoot, "openclaw-home", ".openclaw", "skills"),
    stateFile: path.join(baseRoot, "managed-agents.json"),
    mqttBrokerUrl: "mqtts://management-broker:8883",
    mqttUsername: "mgmt-user",
    mqttPassword: "mgmt-pass",
    mqttClientId: "oc-mgmt-test",
    mqttRequestTopic: "openclaw/management/request",
    mqttResponseTopic: "openclaw/management/response",
    managedMqttBrokerUrl: "mqtts://channel-broker:8883",
    managedMqttUsername: "channel-user",
    managedMqttPassword: "channel-pass",
    inboundTopicTemplate: "agents/channel/{agent-name}/inbound",
    outboundTopicTemplate: "agents/channel/{agent-name}/outbound",
    ...overrides
  };
}

test("loadEnvironmentConfig derives OpenClaw-owned paths from OPENCLAW_STATE_DIR", async (t) => {
  const previousEnv = { ...process.env };
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "agent-platform-management-console-oc-env-"));
  process.env.OPENCLAW_STATE_DIR = path.join(runtimeRoot, ".openclaw");
  process.env.OPENCLAW_HOME = runtimeRoot;
  process.env.OPENCLAW_CONFIG_PATH = path.join(runtimeRoot, ".openclaw", "custom-openclaw.json");
  process.env.OC_MANAGEMENT_CONFIG_FILE = path.join(PROJECT_ROOT, "config.example.json");
  process.env.AIOS_MQTT_BROKER = "mqtts://management-broker:8883";
  process.env.AIOS_MQTT_USERNAME = "mgmt-user";
  process.env.AIOS_MQTT_PASSWORD = "mgmt-pass";
  process.env.AIOS_MQTT_CHANNEL_BROKER = "mqtts://channel-broker:8883";
  process.env.AIOS_MQTT_CHANNEL_USERNAME = "channel-user";
  process.env.AIOS_MQTT_CHANNEL_PASSWORD = "channel-pass";
  process.env.AIOS_S3_ENDPOINT = "http://minio.internal:9000";
  process.env.AIOS_S3_REGION = "us-east-1";
  process.env.AIOS_S3_ACCESS_KEY_ID = "minio-access";
  process.env.AIOS_S3_SECRET_ACCESS_KEY = "minio-secret";

  try {
    const env = loadEnvironmentConfig();
    assert.equal(env.openclawStateDir, path.join(runtimeRoot, ".openclaw"));
    assert.equal(env.openclawConfigPath, path.join(runtimeRoot, ".openclaw", "custom-openclaw.json"));
    assert.equal(env.globalSkillsRoot, path.join(runtimeRoot, ".openclaw", "skills"));
  } finally {
    process.env = previousEnv;
  }
});

test("loadEnvironmentConfig rejects invalid MQTT broker URLs", () => {
  const previousEnv = { ...process.env };
  process.env.OPENCLAW_STATE_DIR = path.join(PROJECT_ROOT, ".tmp", "runtime");
  process.env.OPENCLAW_HOME = path.join(PROJECT_ROOT, ".tmp", "runtime-home");
  process.env.OPENCLAW_CONFIG_PATH = path.join(PROJECT_ROOT, ".tmp", "runtime", "openclaw.json");
  process.env.OC_MANAGEMENT_CONFIG_FILE = path.join(PROJECT_ROOT, "config.example.json");
  process.env.AIOS_MQTT_BROKER = "not-a-url";
  process.env.AIOS_MQTT_USERNAME = "mgmt-user";
  process.env.AIOS_MQTT_PASSWORD = "mgmt-pass";
  process.env.AIOS_MQTT_CHANNEL_BROKER = "mqtts://channel-broker:8883";
  process.env.AIOS_MQTT_CHANNEL_USERNAME = "channel-user";
  process.env.AIOS_MQTT_CHANNEL_PASSWORD = "channel-pass";
  process.env.AIOS_S3_ENDPOINT = "http://minio.internal:9000";
  process.env.AIOS_S3_REGION = "us-east-1";
  process.env.AIOS_S3_ACCESS_KEY_ID = "minio-access";
  process.env.AIOS_S3_SECRET_ACCESS_KEY = "minio-secret";

  try {
    assert.throws(() => loadEnvironmentConfig(), /AIOS_MQTT_BROKER must be a valid MQTT broker URL/);
  } finally {
    process.env = previousEnv;
  }
});

test("loadEnvironmentConfig accepts gateway restart mode none", async () => {
  const previousEnv = { ...process.env };
  const tempRoot = await mkdtemp(path.join(tmpdir(), "oc-mgmt-gateway-none-"));
  const configPath = path.join(tempRoot, "config.json");
  await writeFile(configPath, JSON.stringify({
    http: {
      host: "0.0.0.0",
      port: 3000
    },
    gateway: {
      restartMode: "none"
    },
    openclaw: {
      bin: "openclaw",
      doctorBin: "doctor",
      workspacesRoot: "/var/platform_data/openclaw/workspaces",
      ontologyRoot: "/var/platform_data/ontology"
    },
    mqtt: {
      requestTopic: "openclaw/management/request",
      responseTopic: "openclaw/management/response",
      inboundTopicTemplate: "agents/channel/{agent-name}/inbound",
      outboundTopicTemplate: "agents/channel/{agent-name}/outbound"
    },
    skills: {
      globalRoot: ""
    },
    stateFile: "/var/platform_data/openclaw-management/managed-agents.json"
  }), "utf8");

  process.env.OPENCLAW_STATE_DIR = path.join(tempRoot, "runtime");
  process.env.OPENCLAW_HOME = path.join(tempRoot, "runtime-home");
  process.env.OPENCLAW_CONFIG_PATH = path.join(tempRoot, "runtime", "openclaw.json");
  process.env.OC_MANAGEMENT_CONFIG_FILE = configPath;
  process.env.AIOS_MQTT_BROKER = "mqtts://management-broker:8883";
  process.env.AIOS_MQTT_USERNAME = "mgmt-user";
  process.env.AIOS_MQTT_PASSWORD = "mgmt-pass";
  process.env.AIOS_MQTT_CHANNEL_BROKER = "mqtts://channel-broker:8883";
  process.env.AIOS_MQTT_CHANNEL_USERNAME = "channel-user";
  process.env.AIOS_MQTT_CHANNEL_PASSWORD = "channel-pass";
  process.env.AIOS_S3_ENDPOINT = "http://minio.internal:9000";
  process.env.AIOS_S3_REGION = "us-east-1";
  process.env.AIOS_S3_ACCESS_KEY_ID = "minio-access";
  process.env.AIOS_S3_SECRET_ACCESS_KEY = "minio-secret";

  try {
    assert.equal(loadEnvironmentConfig().gatewayRestartMode, "none");
  } finally {
    process.env = previousEnv;
  }
});

test("health report fails when MQTT is disconnected or topics collide", () => {
  const env = createEnv({
    mqttRequestTopic: "openclaw/management/shared",
    mqttResponseTopic: "openclaw/management/shared"
  });

  const configIssues = collectConfigIssues(env);
  const health = buildHealthReport(env, {
    connected: false,
    subscribed: false,
    lastError: "MQTT error: connection refused",
    lastErrorAt: "2026-05-13T00:00:00.000Z"
  }, configIssues);

  assert.equal(health.status, "error");
  assert.equal(health.checks.config.ok, false);
  assert.equal(health.checks.managementMqtt.ok, false);
  assert.match(health.checks.config.issues[0] ?? "", /requestTopic and mqtt.responseTopic must be different/);
});

test("restartGateway skips CLI restart when restart mode is none", async () => {
  const cli = new MockCliRunner();
  const doctor = new MockCliRunner();
  const stateStore = new ManagedStateStore(path.join(tmpdir(), "oc-mgmt-restart-none.json"));
  const manager = new OpenClawManager(
    cli as never,
    doctor as never,
    createEnv({ gatewayRestartMode: "none" }),
    stateStore
  );

  const result = await manager.restartGateway({ safe: true });

  assert.deepEqual(result, {
    skipped: true,
    mode: "none",
    reason: "Gateway restart is disabled by configuration"
  });
  assert.equal(cli.runJsonCalls.length, 0);
  assert.equal(cli.runCalls.length, 0);
});

test("restartGateway schedules container restart when restart mode is container", async () => {
  const cli = new MockCliRunner();
  const doctor = new MockCliRunner();
  const stateStore = new ManagedStateStore(path.join(tmpdir(), "oc-mgmt-restart-container.json"));
  let scheduledReason: string | undefined;
  const manager = new OpenClawManager(
    cli as never,
    doctor as never,
    createEnv({ gatewayRestartMode: "container" }),
    stateStore,
    {
      scheduleContainerRestart: (reason: string) => {
        scheduledReason = reason;
      }
    }
  );

  const result = await manager.restartGateway({ safe: true });

  assert.deepEqual(result, {
    scheduled: true,
    mode: "container",
    targetPid: 1,
    signal: "SIGTERM",
    reason: "Container restart scheduled"
  });
  assert.equal(scheduledReason, "gateway.restart");
  assert.equal(cli.runJsonCalls.length, 0);
  assert.equal(cli.runCalls.length, 0);
});

test("listAgents returns requested display fields without security level", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oc-mgmt-agent-list-"));
  const stateStore = new ManagedStateStore(path.join(root, "managed-state.json"));
  await stateStore.upsertAgent({
    id: "lowcode",
    accountId: "lowcode",
    workspace: "/var/platform_data/openclaw/workspaces/lowcode",
    inboundTopic: "agents/channel/lowcode/inbound",
    outboundTopic: "agents/channel/lowcode/outbound",
    enabled: true,
    updatedAt: "2026-05-13T00:00:00.000Z"
  });

  const cli = new MockCliRunner([[
    {
      id: "lowcode",
      name: "Lowcode Agent",
      workspace: "/ignored/from/config"
    }
  ]]);
  const doctor = new MockCliRunner();
  const manager = new OpenClawManager(
    cli as never,
    doctor as never,
    createEnv(),
    stateStore
  );

  const result = await manager.listAgents() as {
    items: Array<Record<string, unknown>>;
  };

  assert.deepEqual(result.items, [{
    agentId: "lowcode",
    name: "Lowcode Agent",
    workspace: "/var/platform_data/openclaw/workspaces/lowcode",
    workspaces: "/var/platform_data/openclaw/workspaces/lowcode",
    inboundTopic: "agents/channel/lowcode/inbound",
    "inbound-topic": "agents/channel/lowcode/inbound",
    outboundTopic: "agents/channel/lowcode/outbound",
    "outbound-topic": "agents/channel/lowcode/outbound"
  }]);
  assert.equal("securityLevel" in result.items[0]!, false);
  assert.equal("security-level" in result.items[0]!, false);
});

test("createAgent issues the expected openclaw commands", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oc-mgmt-agent-create-"));
  const stateStore = new ManagedStateStore(path.join(root, "managed-state.json"));
  const cli = new MockCliRunner([
    [],
    [{ id: "lowcode" }]
  ]);
  const doctor = new MockCliRunner();

  const manager = new OpenClawManager(
    cli as never,
    doctor as never,
    createEnv({
      workspacesRoot: path.join(root, "workspaces")
    }),
    stateStore
  );

  await manager.createAgent({
    agentId: "lowcode",
    model: {
      primary: "openai/gpt-5.5",
      fallbacks: ["openai/gpt-5.4-mini"]
    },
    agentsMd: "# AGENTS\n"
  });

  assert.deepEqual(cli.runJsonCalls, [
    ["config", "get", "agents.list", "--json"],
    ["config", "get", "agents.list", "--json"]
  ]);

  assert.deepEqual(cli.runCalls.map((call) => call.args), [
    ["config", "set", "plugins.entries[\"mqtt-channel\"].enabled", "true", "--strict-json"],
    ["config", "set", "session.dmScope", "\"per-channel-peer\"", "--strict-json"],
    ["agents", "add", "lowcode", "--workspace", path.join(root, "workspaces", "lowcode"), "--non-interactive", "--json"],
    ["config", "set", "agents.list[0].model", "{\"primary\":\"openai/gpt-5.5\",\"fallbacks\":[\"openai/gpt-5.4-mini\"]}", "--strict-json"],
    ["config", "set", "channels[\"mqtt-channel\"].accounts[\"lowcode\"]", "{\"enabled\":true,\"brokerUrl\":\"mqtts://channel-broker:8883\",\"username\":\"channel-user\",\"password\":\"channel-pass\",\"topics\":{\"inbound\":\"agents/channel/lowcode/inbound\",\"outbound\":\"agents/channel/lowcode/outbound\"},\"qos\":1,\"disableBlockStreaming\":false}", "--strict-json"],
    ["agents", "bind", "--agent", "lowcode", "--bind", "mqtt-channel:lowcode", "--json"]
  ]);
});

test("deleteAgent issues the expected openclaw commands", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oc-mgmt-agent-delete-"));
  const stateStore = new ManagedStateStore(path.join(root, "managed-state.json"));
  await stateStore.upsertAgent({
    id: "lowcode",
    accountId: "lowcode",
    workspace: "/var/platform_data/openclaw/workspaces/lowcode",
    inboundTopic: "agents/channel/lowcode/inbound",
    outboundTopic: "agents/channel/lowcode/outbound",
    enabled: true,
    updatedAt: "2026-05-13T00:00:00.000Z"
  });

  const cli = new MockCliRunner();
  const doctor = new MockCliRunner();
  const manager = new OpenClawManager(
    cli as never,
    doctor as never,
    createEnv(),
    stateStore
  );

  await manager.deleteAgent({ agentId: "lowcode", restart: true });

  assert.deepEqual(cli.runJsonCalls, []);

  assert.deepEqual(cli.runCalls.map((call) => call.args), [
    ["agents", "unbind", "--agent", "lowcode", "--bind", "mqtt-channel:lowcode", "--json"],
    ["config", "unset", "channels[\"mqtt-channel\"].accounts[\"lowcode\"]"],
    ["agents", "delete", "lowcode", "--force", "--json"]
  ]);
});

test("global skills commands issue the expected clawhub invocations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oc-mgmt-skills-"));
  const stateStore = new ManagedStateStore(path.join(root, "managed-state.json"));
  const cli = new MockCliRunner();
  const doctor = new MockCliRunner();
  const clawhub = new MockCliRunner();

  const manager = new OpenClawManager(
    cli as never,
    doctor as never,
    createEnv({
      globalSkillsRoot: "/srv/runtime/.openclaw/skills"
    }),
    stateStore,
    {
      clawhubCli: clawhub as never,
      clawhubBin: "/mock/bin/clawhub.js"
    }
  );

  await manager.installGlobalSkill({ slug: "calendar-helper", version: "1.2.3", force: true });
  await manager.updateGlobalSkill({ slug: "calendar-helper", force: true });
  await manager.updateGlobalSkill({ all: true });
  await manager.deleteGlobalSkill({ slug: "calendar-helper" });

  assert.deepEqual(clawhub.runCalls.map((call) => call.args), [
    ["/mock/bin/clawhub.js", "install", "calendar-helper", "--workdir", "/srv/runtime/.openclaw", "--dir", "skills", "--no-input", "--version", "1.2.3", "--force"],
    ["/mock/bin/clawhub.js", "update", "calendar-helper", "--workdir", "/srv/runtime/.openclaw", "--dir", "skills", "--no-input", "--force"],
    ["/mock/bin/clawhub.js", "update", "--all", "--workdir", "/srv/runtime/.openclaw", "--dir", "skills", "--no-input"],
    ["/mock/bin/clawhub.js", "uninstall", "calendar-helper", "--workdir", "/srv/runtime/.openclaw", "--dir", "skills", "--no-input", "--yes"]
  ]);
});
