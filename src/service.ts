import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { connect, type IClientOptions, type MqttClient } from "mqtt";

import { CliRunner } from "./cli-runner.js";
import { loadEnvironmentConfig } from "./env.js";
import { OpenClawManager } from "./openclaw-manager.js";
import { OntologyManager } from "./ontology-manager.js";
import { ManagedStateStore } from "./state-store.js";
import type {
  AgentCreateParams,
  AgentDocsUpdateParams,
  AgentModelSetParams,
  AgentMutationParams,
  DiagnosticsRunParams,
  GlobalSkillsDeleteParams,
  GlobalSkillsInstallParams,
  GlobalSkillsUpdateParams,
  GatewayRestartParams,
  LogsQueryParams,
  ManagementRequest,
  ManagementResponse,
  OntologyCreateParams,
  OntologyDeleteParams,
  ServiceInfo,
  ServiceOptions
} from "./types.js";

const SERVICE_NAME = "agent-platform-management-console-oc";
const SERVICE_VERSION = "0.1.0";

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

interface MqttRuntimeState {
  connected: boolean;
  subscribed: boolean;
  lastConnectedAt?: string;
  lastSubscribedAt?: string;
  lastDisconnectedAt?: string;
  lastError?: string;
  lastErrorAt?: string;
}

interface PendingContainerRestart {
  reason: string;
  requestedAt: string;
}

export function collectConfigIssues(env: ReturnType<typeof loadEnvironmentConfig>): string[] {
  const issues: string[] = [];

  if (!Number.isInteger(env.port) || env.port < 1 || env.port > 65535) {
    issues.push(`http.port must be an integer between 1 and 65535, received ${env.port}`);
  }
  if (env.mqttRequestTopic === env.mqttResponseTopic) {
    issues.push("mqtt.requestTopic and mqtt.responseTopic must be different");
  }
  if (env.inboundTopicTemplate === env.outboundTopicTemplate) {
    issues.push("mqtt.inboundTopicTemplate and mqtt.outboundTopicTemplate must be different");
  }

  return issues;
}

export function buildHealthReport(
  env: ReturnType<typeof loadEnvironmentConfig>,
  mqttState: MqttRuntimeState,
  configIssues: string[]
) {
  const configOk = configIssues.length === 0;
  const managementMqttOk = mqttState.connected && mqttState.subscribed;
  const ok = configOk && managementMqttOk;

  return {
    status: ok ? "ok" : "error",
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    checks: {
      config: {
        ok: configOk,
        issues: configIssues,
        configFile: env.configFile,
        openclawConfigPath: env.openclawConfigPath,
        gatewayRestartMode: env.gatewayRestartMode
      },
      managementMqtt: {
        ok: managementMqttOk,
        connected: mqttState.connected,
        subscribed: mqttState.subscribed,
        brokerUrl: env.mqttBrokerUrl,
        clientId: env.mqttClientId,
        requestTopic: env.mqttRequestTopic,
        responseTopic: env.mqttResponseTopic,
        lastConnectedAt: mqttState.lastConnectedAt,
        lastSubscribedAt: mqttState.lastSubscribedAt,
        lastDisconnectedAt: mqttState.lastDisconnectedAt,
        lastError: mqttState.lastError,
        lastErrorAt: mqttState.lastErrorAt
      },
      managedMqttChannel: {
        ok: true,
        brokerUrl: env.managedMqttBrokerUrl,
        hasUsername: env.managedMqttUsername.trim().length > 0,
        inboundTopicTemplate: env.inboundTopicTemplate,
        outboundTopicTemplate: env.outboundTopicTemplate
      }
    }
  };
}

class TaskQueue {
  private tail = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

export function createManagementConsoleService(_options: ServiceOptions = {}) {
  const env = loadEnvironmentConfig();
  const configIssues = collectConfigIssues(env);
  const stateStore = new ManagedStateStore(env.stateFile);
  const cli = new CliRunner(env.openclawBin);
  const doctorCli = new CliRunner(env.doctorBin);
  let pendingContainerRestart: PendingContainerRestart | undefined;
  const manager = new OpenClawManager(cli, doctorCli, env, stateStore, {
    scheduleContainerRestart: (reason: string) => {
      pendingContainerRestart = {
        reason,
        requestedAt: new Date().toISOString()
      };
    }
  });
  const ontologyManager = new OntologyManager(env);
  const info: ServiceInfo = {
    name: SERVICE_NAME,
    version: SERVICE_VERSION,
    host: env.host,
    port: env.port
  };

  let mqttClient: MqttClient | undefined;
  const mqttState: MqttRuntimeState = {
    connected: false,
    subscribed: false
  };
  const queue = new TaskQueue();

  function markMqttError(message: string): void {
    mqttState.lastError = message;
    mqttState.lastErrorAt = new Date().toISOString();
  }

  function takePendingContainerRestart(): PendingContainerRestart | undefined {
    const pending = pendingContainerRestart;
    pendingContainerRestart = undefined;
    return pending;
  }

  function executeContainerRestart(restart: PendingContainerRestart): void {
    const signal: NodeJS.Signals = "SIGTERM";
    process.stderr.write(
      `Scheduling container restart via PID 1 ${signal} (${restart.reason}, requested at ${restart.requestedAt})\n`
    );
    setImmediate(() => {
      try {
        process.kill(1, signal);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Failed to trigger container restart: ${message}\n`);
      }
    });
  }

  async function buildHealth() {
    return buildHealthReport(env, mqttState, configIssues);
  }

  async function buildStatus() {
    return {
      service: info.name,
      version: info.version,
      mqtt: {
        connected: mqttState.connected,
        subscribed: mqttState.subscribed,
        brokerUrl: env.mqttBrokerUrl,
        requestTopic: env.mqttRequestTopic,
        responseTopic: env.mqttResponseTopic,
        clientId: env.mqttClientId,
        lastConnectedAt: mqttState.lastConnectedAt,
        lastSubscribedAt: mqttState.lastSubscribedAt,
        lastDisconnectedAt: mqttState.lastDisconnectedAt,
        lastError: mqttState.lastError,
        lastErrorAt: mqttState.lastErrorAt
      },
      config: {
        valid: configIssues.length === 0,
        issues: configIssues
      },
      configFile: env.configFile,
      gatewayRestartMode: env.gatewayRestartMode,
      openclawHome: env.openclawHome,
      openclawStateDir: env.openclawStateDir,
      openclawConfigPath: env.openclawConfigPath,
      globalSkillsRoot: env.globalSkillsRoot,
      health: await buildHealth(),
      managedAgents: await stateStore.listAgents()
    };
  }

  async function handleAction(request: ManagementRequest): Promise<unknown> {
    const params = (request.params ?? {}) as unknown;

    switch (request.action) {
      case "service.ping":
        return { pong: true };
      case "service.status":
        return await buildStatus();
      case "agent.list":
        return await manager.listAgents();
      case "agent.create":
        return await manager.createAgent(params as AgentCreateParams);
      case "agent.enable":
        return await manager.enableAgent(params as AgentMutationParams);
      case "agent.disable":
        return await manager.disableAgent(params as AgentMutationParams);
      case "agent.delete":
        return await manager.deleteAgent(params as AgentMutationParams);
      case "agent.usage":
        return await manager.queryUsage(params as { agentId: string });
      case "agent.model.set":
        return await manager.setAgentModel(params as AgentModelSetParams);
      case "agent.docs.update":
        return await manager.updateAgentDocs(params as AgentDocsUpdateParams);
      case "skills.global.list":
        return await manager.listGlobalSkills();
      case "skills.global.install":
        return await manager.installGlobalSkill(params as GlobalSkillsInstallParams);
      case "skills.global.update":
        return await manager.updateGlobalSkill(params as GlobalSkillsUpdateParams);
      case "skills.global.delete":
        return await manager.deleteGlobalSkill(params as GlobalSkillsDeleteParams);
      case "ontology.list":
        return await ontologyManager.listOntologies();
      case "ontology.create":
        return await ontologyManager.createOntology(params as OntologyCreateParams);
      case "ontology.delete":
        return await ontologyManager.deleteOntology(params as OntologyDeleteParams);
      case "logs.query":
        return await manager.queryLogs(params as LogsQueryParams);
      case "diagnostics.run":
        return await manager.runDiagnostics(params as DiagnosticsRunParams);
      case "gateway.status":
        return await manager.gatewayStatus();
      case "gateway.restart":
        return await manager.restartGateway(params as GatewayRestartParams);
      default:
        throw new Error(`Unsupported action: ${request.action}`);
    }
  }

  function buildResponse(
    request: ManagementRequest,
    response: Pick<ManagementResponse, "ok" | "result" | "error">
  ): ManagementResponse {
    return {
      requestId: request.requestId ?? randomUUID(),
      action: request.action,
      ok: response.ok,
      result: response.result,
      error: response.error,
      timestamp: new Date().toISOString()
    };
  }

  async function publishResponse(request: ManagementRequest, payload: ManagementResponse): Promise<void> {
    const replyTo = request.replyTo ?? env.mqttResponseTopic;
    if (!mqttClient) {
      throw new Error("MQTT client is not initialized");
    }

    await new Promise<void>((resolve, reject) => {
      mqttClient!.publish(replyTo, JSON.stringify(payload), { qos: 1 }, (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  async function handleMqttMessage(message: Buffer): Promise<void> {
    let request: ManagementRequest;
    try {
      request = JSON.parse(message.toString("utf8")) as ManagementRequest;
      if (!request.action || typeof request.action !== "string") {
        throw new Error("Invalid request.action");
      }
    } catch (error: unknown) {
      const fallbackRequest: ManagementRequest = {
        requestId: randomUUID(),
        action: "unknown"
      };
      const payload = buildResponse(fallbackRequest, {
        ok: false,
        error: {
          code: "bad_request",
          message: error instanceof Error ? error.message : String(error)
        }
      });
      await publishResponse(fallbackRequest, payload).catch(() => undefined);
      return;
    }

    const payload = await queue.enqueue(async () => {
      try {
        const result = await handleAction(request);
        return buildResponse(request, { ok: true, result });
      } catch (error: unknown) {
        return buildResponse(request, {
          ok: false,
          error: {
            code: "command_failed",
            message: error instanceof Error ? error.message : String(error)
          }
        });
      }
    });

    let publishError: unknown;
    try {
      await publishResponse(request, payload);
    } catch (error: unknown) {
      publishError = error;
    }

    const pendingRestart = takePendingContainerRestart();
    if (pendingRestart) {
      executeContainerRestart(pendingRestart);
    }

    if (publishError) {
      throw publishError;
    }
  }

  function routeHttp(request: IncomingMessage, response: ServerResponse): void {
    void (async () => {
      if (request.method === "GET" && request.url === "/health") {
        const health = await buildHealth();
        sendJson(response, health.status === "ok" ? 200 : 503, health);
        return;
      }

      sendJson(response, 404, { error: "Not Found" });
    })().catch((error: unknown) => {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  const server = createServer(routeHttp);

  return {
    info,
    server,
    async start(): Promise<ServiceInfo> {
      const mqttOptions: IClientOptions = {
        clientId: env.mqttClientId,
        username: env.mqttUsername,
        password: env.mqttPassword,
        reconnectPeriod: 2000,
        clean: true
      };

      mqttClient = connect(env.mqttBrokerUrl, mqttOptions);
      mqttClient.on("connect", () => {
        mqttState.connected = true;
        mqttState.subscribed = false;
        mqttState.lastConnectedAt = new Date().toISOString();
        mqttClient?.subscribe(env.mqttRequestTopic, { qos: 1 }, (error: Error | null) => {
          if (error) {
            const message = `Failed to subscribe to ${env.mqttRequestTopic}: ${error.message}`;
            markMqttError(message);
            process.stderr.write(`${message}\n`);
            return;
          }

          mqttState.subscribed = true;
          mqttState.lastSubscribedAt = new Date().toISOString();
        });
      });
      mqttClient.on("reconnect", () => {
        mqttState.connected = false;
        mqttState.subscribed = false;
      });
      mqttClient.on("close", () => {
        mqttState.connected = false;
        mqttState.subscribed = false;
        mqttState.lastDisconnectedAt = new Date().toISOString();
      });
      mqttClient.on("error", (error: Error) => {
        const message = `MQTT error: ${error.message}`;
        markMqttError(message);
        process.stderr.write(`${message}\n`);
      });
      mqttClient.on("message", (_topic: string, message: Buffer) => {
        void handleMqttMessage(message).catch((error: unknown) => {
          process.stderr.write(`Failed to handle MQTT message: ${String(error)}\n`);
        });
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(env.port, env.host, () => {
          server.off("error", reject);
          resolve();
        });
      });

      return info;
    },
    async stop(): Promise<void> {
      if (mqttClient) {
        await new Promise<void>((resolve) => {
          mqttClient?.end(false, {}, () => resolve());
        });
      }

      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        });
      }
    }
  };
}
