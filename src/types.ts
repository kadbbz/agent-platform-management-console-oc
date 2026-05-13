export interface ServiceOptions {
  host?: string;
  port?: number;
}

export interface ServiceInfo {
  name: string;
  version: string;
  host: string;
  port: number;
}

export interface EnvironmentConfig {
  configFile: string;
  host: string;
  port: number;
  openclawHome: string;
  openclawStateDir: string;
  openclawConfigPath: string;
  openclawBin: string;
  doctorBin: string;
  workspacesRoot: string;
  ontologyRoot: string;
  globalSkillsRoot: string;
  stateFile: string;
  mqttBrokerUrl: string;
  mqttUsername?: string;
  mqttPassword?: string;
  mqttClientId: string;
  mqttRequestTopic: string;
  mqttResponseTopic: string;
  managedMqttBrokerUrl: string;
  managedMqttUsername: string;
  managedMqttPassword: string;
  inboundTopicTemplate: string;
  outboundTopicTemplate: string;
}

export interface ManagementRequest {
  requestId?: string;
  action: string;
  params?: Record<string, unknown>;
  replyTo?: string;
}

export interface ManagementResponse {
  requestId: string;
  action: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  timestamp: string;
}

export interface ManagedAgentRecord {
  id: string;
  accountId: string;
  workspace: string;
  inboundTopic: string;
  outboundTopic: string;
  enabled: boolean;
  updatedAt: string;
}

export interface ManagedState {
  version: 1;
  agents: ManagedAgentRecord[];
}

export interface AgentCreateParams {
  agentId: string;
  accountId?: string;
  workspace?: string;
  inboundTopic?: string;
  outboundTopic?: string;
  restart?: boolean;
  model?: string | {
    primary: string;
    fallbacks?: string[];
  };
  agentsMd?: string;
}

export interface AgentMutationParams {
  agentId: string;
  restart?: boolean;
}

export interface AgentModelSetParams {
  agentId: string;
  model: string | {
    primary: string;
    fallbacks?: string[];
  };
}

export interface AgentDocsUpdateParams {
  agentId: string;
  content: string;
}

export interface OntologyCreateParams {
  name: string;
  zipBase64?: string;
  zipFile?: string;
  replace?: boolean;
}

export interface OntologyDeleteParams {
  name: string;
}

export interface LogsQueryParams {
  limit?: number;
}

export interface GlobalSkillsInstallParams {
  slug: string;
  version?: string;
  force?: boolean;
}

export interface GlobalSkillsUpdateParams {
  slug?: string;
  all?: boolean;
  force?: boolean;
}

export interface GlobalSkillsDeleteParams {
  slug: string;
}

export interface DiagnosticsRunParams {
  deep?: boolean;
  repair?: boolean;
}

export interface GatewayRestartParams {
  safe?: boolean;
  skipDeferral?: boolean;
  force?: boolean;
}
