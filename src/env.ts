import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";

import type { EnvironmentConfig } from "./types.js";

interface FileConfig {
  http?: {
    host?: string;
    port?: number;
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

  const managedBroker = readRequiredEnv("OC_MQTT_CHANNEL_BROKER");
  const managedUsername = readRequiredEnv("OC_MQTT_CHANNEL_USERNAME");
  const managedPassword = readRequiredEnv("OC_MQTT_CHANNEL_PASSWORD");

  return {
    configFile,
    host: fileConfig.http?.host?.trim() || "0.0.0.0",
    port: fileConfig.http?.port && Number.isInteger(fileConfig.http.port) ? fileConfig.http.port : 3000,
    openclawHome,
    openclawStateDir,
    openclawConfigPath,
    openclawBin: fileConfig.openclaw?.bin?.trim() || "openclaw",
    doctorBin: fileConfig.openclaw?.doctorBin?.trim() || "doctor",
    workspacesRoot: fileConfig.openclaw?.workspacesRoot?.trim() || "/var/platform_data/openclaw/workspaces",
    ontologyRoot: fileConfig.openclaw?.ontologyRoot?.trim() || "/var/platform_data/ontology",
    globalSkillsRoot: fileConfig.skills?.globalRoot?.trim()
      ? expandHome(fileConfig.skills.globalRoot.trim())
      : path.join(openclawStateDir, "skills"),
    stateFile: fileConfig.stateFile?.trim() || "/var/platform_data/openclaw-management/managed-agents.json",
    mqttBrokerUrl: readRequiredEnv("OC_MANAGEMENT_MQTT_BROKER", managedBroker),
    mqttUsername: readOptionalEnv("OC_MANAGEMENT_MQTT_USERNAME", managedUsername),
    mqttPassword: readOptionalEnv("OC_MANAGEMENT_MQTT_PASSWORD", managedPassword),
    mqttClientId: readOptionalEnv(
      "OC_MANAGEMENT_MQTT_CLIENT_ID",
      `agent-platform-management-console-oc-${hostname()}-${process.pid}`
    ) ?? `agent-platform-management-console-oc-${hostname()}-${process.pid}`,
    mqttRequestTopic: fileConfig.mqtt?.requestTopic?.trim() || "openclaw/management/request",
    mqttResponseTopic: fileConfig.mqtt?.responseTopic?.trim() || "openclaw/management/response",
    managedMqttBrokerUrl: managedBroker,
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
