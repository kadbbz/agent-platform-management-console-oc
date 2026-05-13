import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";

import type { EnvironmentConfig } from "./types.js";

interface FileConfig {
  http?: {
    host?: string;
    port?: number;
  };
  gateway?: {
    restartMode?: string;
  };
  openclaw?: {
    bin?: string;
    doctorBin?: string;
    workspacesRoot?: string;
    ontologyRoot?: string;
  };
  mqtt?: {
    requestTopic?: string;
    responseTopic?: string;
    inboundTopicTemplate?: string;
    outboundTopicTemplate?: string;
  };
  skills?: {
    globalRoot?: string;
  };
  stateFile?: string;
}

function readRequiredEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

function readOptionalEnv(name: string, fallback?: string): string | undefined {
  const value = process.env[name] ?? fallback;
  if (!value || value.trim().length === 0) {
    return undefined;
  }

  return value.trim();
}

function readConfigFile(filePath: string): FileConfig {
  const content = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(content) as FileConfig;
  return parsed ?? {};
}

function ensureTopicTemplate(name: string, value: string): string {
  if (!value.includes("{agent-name}")) {
    throw new Error(`${name} must contain {agent-name}`);
  }

  return value;
}

function ensureBrokerUrl(name: string, value: string): string {
  try {
    const url = new URL(value);
    if (!url.protocol || !url.hostname) {
      throw new Error("missing protocol or hostname");
    }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} must be a valid MQTT broker URL: ${reason}`);
  }

  return value;
}

function ensureOptionalUrl(name: string, value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    if (!url.protocol || !url.hostname) {
      throw new Error("missing protocol or hostname");
    }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} must be a valid URL: ${reason}`);
  }

  return value;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }

  throw new Error(`${name} must be one of true,false,1,0,yes,no`);
}

function resolveGatewayRestartMode(value?: string): "openclaw" | "none" | "container" {
  const normalized = value?.trim();
  if (!normalized || normalized === "openclaw") {
    return "openclaw";
  }
  if (normalized === "none") {
    return "none";
  }
  if (normalized === "container") {
    return "container";
  }

  throw new Error(`gateway.restartMode must be "openclaw", "none", or "container", received ${normalized}`);
}

export function renderTopic(template: string, agentId: string): string {
  return template.replaceAll("{agent-name}", agentId);
}

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }

  return value;
}

function resolveOpenClawHome(): string {
  const explicit = readOptionalEnv("OPENCLAW_HOME");
  if (explicit) {
    return expandHome(explicit);
  }

  return process.env.HOME ? expandHome(process.env.HOME) : homedir();
}

function resolveOpenClawStateDir(openclawHome: string): string {
  const explicit = readOptionalEnv("OPENCLAW_STATE_DIR");
  if (explicit) {
    return expandHome(explicit);
  }

  return path.join(openclawHome, ".openclaw");
}

function resolveOpenClawConfigPath(openclawStateDir: string): string {
  const explicit = readOptionalEnv("OPENCLAW_CONFIG_PATH");
  if (explicit) {
    return expandHome(explicit);
  }

  return path.join(openclawStateDir, "openclaw.json");
}

export function loadEnvironmentConfig(): EnvironmentConfig {
  const configFile = readOptionalEnv(
    "OC_MANAGEMENT_CONFIG_FILE",
    path.join(process.cwd(), "config.example.json")
  ) ?? path.join(process.cwd(), "config.example.json");
  const fileConfig = readConfigFile(configFile);
  const openclawHome = resolveOpenClawHome();
  const openclawStateDir = resolveOpenClawStateDir(openclawHome);
  const openclawConfigPath = resolveOpenClawConfigPath(openclawStateDir);

  const managedBroker = readRequiredEnv("AIOS_MQTT_CHANNEL_BROKER");
  const managedUsername = readRequiredEnv("AIOS_MQTT_CHANNEL_USERNAME");
  const managedPassword = readRequiredEnv("AIOS_MQTT_CHANNEL_PASSWORD");

  return {
    configFile,
    host: fileConfig.http?.host?.trim() || "0.0.0.0",
    port: fileConfig.http?.port && Number.isInteger(fileConfig.http.port) ? fileConfig.http.port : 3000,
    gatewayRestartMode: resolveGatewayRestartMode(fileConfig.gateway?.restartMode),
    openclawHome,
    openclawStateDir,
    openclawConfigPath,
    openclawBin: fileConfig.openclaw?.bin?.trim() || "openclaw",
    doctorBin: fileConfig.openclaw?.doctorBin?.trim() || "doctor",
    workspacesRoot: fileConfig.openclaw?.workspacesRoot?.trim() || "/var/platform_data/openclaw/workspaces",
    ontologyRoot: fileConfig.openclaw?.ontologyRoot?.trim() || "/var/platform_data/ontology",
    ontologyS3Endpoint: ensureOptionalUrl("AIOS_S3_ENDPOINT", readOptionalEnv("AIOS_S3_ENDPOINT")),
    ontologyS3Region: readOptionalEnv("AIOS_S3_REGION", "us-east-1") ?? "us-east-1",
    ontologyS3AccessKeyId: readOptionalEnv("AIOS_S3_ACCESS_KEY_ID"),
    ontologyS3SecretAccessKey: readOptionalEnv("AIOS_S3_SECRET_ACCESS_KEY"),
    ontologyS3ForcePathStyle: readBooleanEnv("AIOS_S3_FORCE_PATH_STYLE", true),
    globalSkillsRoot: fileConfig.skills?.globalRoot?.trim()
      ? expandHome(fileConfig.skills.globalRoot.trim())
      : path.join(openclawStateDir, "skills"),
    stateFile: fileConfig.stateFile?.trim() || "/var/platform_data/openclaw-management/managed-agents.json",
    mqttBrokerUrl: ensureBrokerUrl(
      "AIOS_MQTT_BROKER",
      readRequiredEnv("AIOS_MQTT_BROKER", managedBroker)
    ),
    mqttUsername: readOptionalEnv("AIOS_MQTT_USERNAME", managedUsername),
    mqttPassword: readOptionalEnv("AIOS_MQTT_PASSWORD", managedPassword),
    mqttClientId: readOptionalEnv(
      "AIOS_MQTT_CLIENT_ID",
      `agent-platform-management-console-oc-${hostname()}-${process.pid}`
    ) ?? `agent-platform-management-console-oc-${hostname()}-${process.pid}`,
    mqttRequestTopic: fileConfig.mqtt?.requestTopic?.trim() || "openclaw/management/request",
    mqttResponseTopic: fileConfig.mqtt?.responseTopic?.trim() || "openclaw/management/response",
    managedMqttBrokerUrl: ensureBrokerUrl("AIOS_MQTT_CHANNEL_BROKER", managedBroker),
    managedMqttUsername: managedUsername,
    managedMqttPassword: managedPassword,
    inboundTopicTemplate: ensureTopicTemplate(
      "mqtt.inboundTopicTemplate",
      fileConfig.mqtt?.inboundTopicTemplate?.trim() || "agents/channel/{agent-name}/inbound"
    ),
    outboundTopicTemplate: ensureTopicTemplate(
      "mqtt.outboundTopicTemplate",
      fileConfig.mqtt?.outboundTopicTemplate?.trim() || "agents/channel/{agent-name}/outbound"
    )
  };
}
