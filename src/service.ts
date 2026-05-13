import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { connect, type IClientOptions, type MqttClient } from "mqtt";

import { CliRunner } from "./cli-runner.js";
import { loadEnvironmentConfig } from "./env.js";
import { OpenClawManager } from "./openclaw-manager.js";
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
  const stateStore = new ManagedStateStore(env.stateFile);
  const cli = new CliRunner(env.openclawBin);
  const doctorCli = new CliRunner(env.doctorBin);
  const manager = new OpenClawManager(cli, doctorCli, env, stateStore);
  const info: ServiceInfo = {
    name: SERVICE_NAME,
    version: SERVICE_VERSION,
    host: env.host,
    port: env.port
  };

  let mqttClient: MqttClient | undefined;
  let mqttConnected = false;
  const queue = new TaskQueue();

  async function buildStatus() {
    return {
      service: info.name,
      version: info.version,
      mqtt: {
        connected: mqttConnected,
        brokerUrl: env.mqttBrokerUrl,
        requestTopic: env.mqttRequestTopic,
        responseTopic: env.mqttResponseTopic
      },
      configFile: env.configFile,
      openclawHome: env.openclawHome,
      openclawStateDir: env.openclawStateDir,
      openclawConfigPath: env.openclawConfigPath,
      globalSkillsRoot: env.globalSkillsRoot,
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
        return await manager.listOntologies();
      case "ontology.create":
        return await manager.createOntology(params as OntologyCreateParams);
      case "ontology.delete":
        return await manager.deleteOntology(params as OntologyDeleteParams);
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

    await publishResponse(request, payload);
  }

  function routeHttp(request: IncomingMessage, response: ServerResponse): void {
    void (async () => {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (request.method === "GET" && request.url === "/ready") {
        sendJson(response, mqttConnected ? 200 : 503, { ready: mqttConnected });
        return;
      }

      if (request.method === "GET" && request.url === "/state") {
        sendJson(response, 200, await buildStatus());
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
        mqttConnected = true;
        mqttClient?.subscribe(env.mqttRequestTopic, { qos: 1 }, (error: Error | null) => {
          if (error) {
            process.stderr.write(`Failed to subscribe to ${env.mqttRequestTopic}: ${error.message}\n`);
          }
        });
      });
      mqttClient.on("reconnect", () => {
        mqttConnected = false;
      });
      mqttClient.on("close", () => {
        mqttConnected = false;
      });
      mqttClient.on("error", (error: Error) => {
        process.stderr.write(`MQTT error: ${error.message}\n`);
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
