import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { CliRunner } from "./cli-runner.js";
import { renderTopic } from "./env.js";
import { ManagedStateStore } from "./state-store.js";
import type {
  AgentCreateParams,
  AgentDocsUpdateParams,
  AgentModelSetParams,
  AgentMutationParams,
  DiagnosticsRunParams,
  EnvironmentConfig,
  GlobalSkillsDeleteParams,
  GlobalSkillsInstallParams,
  GlobalSkillsUpdateParams,
  GatewayRestartParams,
  LogsQueryParams,
  ManagedAgentRecord
} from "./types.js";

const require = createRequire(import.meta.url);

function validateAgentId(agentId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) {
    throw new Error(`Invalid agent id: ${agentId}`);
  }

  if (agentId === "main" || agentId === "cli") {
    throw new Error(`Reserved agent id is not allowed: ${agentId}`);
  }
}

function normalizeModelConfig(model: AgentModelSetParams["model"]): { primary: string; fallbacks?: string[] } {
  if (typeof model === "string") {
    return { primary: model };
  }

  return {
    primary: model.primary,
    fallbacks: model.fallbacks ?? []
  };
}

function quoteConfigKey(key: string): string {
  return `["${key.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"]`;
}

function mqttAccountPath(accountId: string): string {
  return `channels${quoteConfigKey("mqtt-channel")}.accounts${quoteConfigKey(accountId)}`;
}

function resolveBundledClawhubBin(): string {
  const packageJsonPath = require.resolve("clawhub/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const packageJson = require(packageJsonPath) as { bin?: string | Record<string, string> };
  const binEntry = typeof packageJson.bin === "string"
    ? packageJson.bin
    : packageJson.bin?.clawhub ?? packageJson.bin?.clawdhub;

  if (!binEntry) {
    throw new Error("Unable to resolve clawhub bin entry");
  }

  return path.join(packageDir, binEntry);
}

export class OpenClawManager {
  private readonly clawhubCli: CliRunner;
  private readonly clawhubBin: string;
  private readonly scheduleContainerRestart?: (reason: string) => void;

  constructor(
    private readonly cli: CliRunner,
    private readonly doctorCli: CliRunner,
    private readonly env: EnvironmentConfig,
    private readonly stateStore: ManagedStateStore,
    dependencies?: {
      clawhubCli?: CliRunner;
      clawhubBin?: string;
      scheduleContainerRestart?: (reason: string) => void;
    }
  ) {
    this.clawhubCli = dependencies?.clawhubCli ?? new CliRunner(process.execPath);
    this.clawhubBin = dependencies?.clawhubBin ?? resolveBundledClawhubBin();
    this.scheduleContainerRestart = dependencies?.scheduleContainerRestart;
  }

  async listAgents(): Promise<unknown> {
    const managedAgents = await this.stateStore.listAgents();
    const configuredAgents = await this.safeJson<Array<{
      id?: string;
      name?: string;
      workspace?: string;
      sandbox?: { mode?: string };
      tools?: { exec?: { security?: string; ask?: string } };
      bindings?: Array<{ bind?: string }>;
    }>>(["agents", "list", "--json", "--bindings"]);
    const byId = new Map(managedAgents.map((agent) => [agent.id, agent]));
    const items = configuredAgents.map((agent) => {
      const managed = agent.id ? byId.get(agent.id) : undefined;
      return {
        agentId: agent.id ?? "",
        name: agent.name ?? agent.id ?? "",
        workspace: managed?.workspace ?? agent.workspace ?? "",
        workspaces: managed?.workspace ?? agent.workspace ?? "",
        inboundTopic: managed?.inboundTopic,
        "inbound-topic": managed?.inboundTopic,
        outboundTopic: managed?.outboundTopic,
        "outbound-topic": managed?.outboundTopic
      };
    });
    return {
      managedAgents,
      configuredAgents,
      items
    };
  }

  async createAgent(params: AgentCreateParams): Promise<ManagedAgentRecord> {
    validateAgentId(params.agentId);

    const existing = await this.stateStore.getAgent(params.agentId);
    if (existing) {
      throw new Error(`Managed agent already exists: ${params.agentId}`);
    }

    if (await this.agentExists(params.agentId)) {
      throw new Error(`OpenClaw agent already exists: ${params.agentId}`);
    }

    const workspace = params.workspace ?? path.join(this.env.workspacesRoot, params.agentId);
    const accountId = params.accountId ?? params.agentId;
    const inboundTopic = params.inboundTopic ?? renderTopic(this.env.inboundTopicTemplate, params.agentId);
    const outboundTopic = params.outboundTopic ?? renderTopic(this.env.outboundTopicTemplate, params.agentId);

    await this.ensureManagedTopologyBase();
    await mkdir(workspace, { recursive: true });

    await this.cli.run([
      "agents",
      "add",
      params.agentId,
      "--workspace",
      workspace,
      "--non-interactive",
      "--json"
    ]);

    if (params.model) {
      await this.setAgentModel({
        agentId: params.agentId,
        model: params.model
      });
    }

    await this.configureMqttAccount({
      accountId,
      brokerUrl: this.env.managedMqttBrokerUrl,
      username: this.env.managedMqttUsername,
      password: this.env.managedMqttPassword,
      inboundTopic,
      outboundTopic,
      enabled: true
    });

    await this.cli.run([
      "agents",
      "bind",
      "--agent",
      params.agentId,
      "--bind",
      `mqtt-channel:${accountId}`,
      "--json"
    ], { allowFailure: true });

    if (params.agentsMd) {
      await this.writeAgentsMarkdown(workspace, params.agentsMd);
    }

    const record: ManagedAgentRecord = {
      id: params.agentId,
      accountId,
      workspace,
      inboundTopic,
      outboundTopic,
      enabled: true,
      updatedAt: new Date().toISOString()
    };

    await this.stateStore.upsertAgent(record);

    return record;
  }

  async enableAgent(params: AgentMutationParams): Promise<ManagedAgentRecord> {
    const record = await this.requireManagedAgent(params.agentId);
    await this.cli.run([
      "config",
      "set",
      `${mqttAccountPath(record.accountId)}.enabled`,
      "true",
      "--strict-json"
    ]);
    await this.cli.run([
      "agents",
      "bind",
      "--agent",
      record.id,
      "--bind",
      `mqtt-channel:${record.accountId}`,
      "--json"
    ], { allowFailure: true });

    const updated: ManagedAgentRecord = {
      ...record,
      enabled: true,
      updatedAt: new Date().toISOString()
    };
    await this.stateStore.upsertAgent(updated);
    return updated;
  }

  async disableAgent(params: AgentMutationParams): Promise<ManagedAgentRecord> {
    const record = await this.requireManagedAgent(params.agentId);
    await this.cli.run([
      "config",
      "set",
      `${mqttAccountPath(record.accountId)}.enabled`,
      "false",
      "--strict-json"
    ]);

    const updated: ManagedAgentRecord = {
      ...record,
      enabled: false,
      updatedAt: new Date().toISOString()
    };
    await this.stateStore.upsertAgent(updated);
    return updated;
  }

  async deleteAgent(params: AgentMutationParams): Promise<{ agentId: string; accountId: string }> {
    const record = await this.requireManagedAgent(params.agentId);

    await this.cli.run([
      "agents",
      "unbind",
      "--agent",
      record.id,
      "--bind",
      `mqtt-channel:${record.accountId}`,
      "--json"
    ], { allowFailure: true });

    await this.cli.run([
      "config",
      "unset",
      mqttAccountPath(record.accountId)
    ], { allowFailure: true });

    await this.cli.run([
      "agents",
      "delete",
      record.id,
      "--force",
      "--json"
    ]);

    await this.stateStore.removeAgent(record.id);

    return {
      agentId: record.id,
      accountId: record.accountId
    };
  }

  async queryUsage(params: { agentId: string }): Promise<unknown> {
    return await this.safeJson<unknown>([
      "models",
      "status",
      "--agent",
      params.agentId,
      "--json"
    ]);
  }

  async setAgentModel(params: AgentModelSetParams): Promise<unknown> {
    const index = await this.requireAgentConfigIndex(params.agentId);
    const model = normalizeModelConfig(params.model);

    await this.cli.run([
      "config",
      "set",
      `agents.list[${index}].model`,
      JSON.stringify(model),
      "--strict-json"
    ]);

    return {
      agentId: params.agentId,
      model
    };
  }

  async updateAgentDocs(params: AgentDocsUpdateParams): Promise<{ path: string }> {
    const record = await this.requireManagedAgent(params.agentId);
    const targetPath = await this.writeAgentsMarkdown(record.workspace, params.content);
    return { path: targetPath };
  }

  async queryLogs(params: LogsQueryParams = {}): Promise<{ output: string }> {
    const limit = Number.isInteger(params.limit) && (params.limit ?? 0) > 0 ? params.limit! : 200;
    const result = await this.cli.run([
      "logs",
      "--limit",
      String(limit),
      "--plain",
      "--no-color"
    ]);

    return { output: result.stdout };
  }

  async listGlobalSkills(): Promise<{
    root: string;
    items: Array<{
      slug: string;
      path: string;
      origin?: unknown;
      pinned?: boolean;
      pinReason?: string;
    }>;
  }> {
    const root = this.env.globalSkillsRoot;
    const workdir = path.dirname(root);
    const lockPath = path.join(workdir, ".clawhub", "lock.json");

    await mkdir(root, { recursive: true });

    let lockData: Record<string, { pinned?: boolean; pin?: { reason?: string } }> = {};
    try {
      const lockRaw = await readFile(lockPath, "utf8");
      const parsed = JSON.parse(lockRaw) as { skills?: Record<string, { pinned?: boolean; pin?: { reason?: string } }> };
      lockData = parsed.skills ?? {};
    } catch {}

    const entries = await readdir(root, { withFileTypes: true });
    const items = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map(async (entry) => {
        const skillPath = path.join(root, entry.name);
        const originPath = path.join(skillPath, ".clawhub", "origin.json");
        let origin: unknown;
        try {
          origin = JSON.parse(await readFile(originPath, "utf8"));
        } catch {}

        const lockEntry = lockData[entry.name];
        return {
          slug: entry.name,
          path: skillPath,
          origin,
          pinned: lockEntry?.pinned ?? false,
          pinReason: lockEntry?.pin?.reason
        };
      }));

    return {
      root,
      items: items.sort((left, right) => left.slug.localeCompare(right.slug))
    };
  }

  async installGlobalSkill(params: GlobalSkillsInstallParams): Promise<unknown> {
    const args = [
      this.clawhubBin,
      "install",
      params.slug,
      "--workdir",
      path.dirname(this.env.globalSkillsRoot),
      "--dir",
      path.basename(this.env.globalSkillsRoot),
      "--no-input"
    ];

    if (params.version) {
      args.push("--version", params.version);
    }
    if (params.force) {
      args.push("--force");
    }

    const result = await this.clawhubCli.run(args);
    return {
      root: this.env.globalSkillsRoot,
      output: [result.stdout, result.stderr].filter(Boolean).join("\n")
    };
  }

  async updateGlobalSkill(params: GlobalSkillsUpdateParams = {}): Promise<unknown> {
    const args = [
      this.clawhubBin,
      "update",
      "--workdir",
      path.dirname(this.env.globalSkillsRoot),
      "--dir",
      path.basename(this.env.globalSkillsRoot),
      "--no-input"
    ];

    if (params.all || !params.slug) {
      args.splice(2, 0, "--all");
    } else {
      args.splice(2, 0, params.slug);
    }
    if (params.force) {
      args.push("--force");
    }

    const result = await this.clawhubCli.run(args);
    return {
      root: this.env.globalSkillsRoot,
      output: [result.stdout, result.stderr].filter(Boolean).join("\n")
    };
  }

  async deleteGlobalSkill(params: GlobalSkillsDeleteParams): Promise<unknown> {
    const result = await this.clawhubCli.run([
      this.clawhubBin,
      "uninstall",
      params.slug,
      "--workdir",
      path.dirname(this.env.globalSkillsRoot),
      "--dir",
      path.basename(this.env.globalSkillsRoot),
      "--no-input",
      "--yes"
    ]);

    return {
      root: this.env.globalSkillsRoot,
      output: [result.stdout, result.stderr].filter(Boolean).join("\n")
    };
  }

  async runDiagnostics(params: DiagnosticsRunParams = {}): Promise<{ output: string; backend: string }> {
    const doctorArgs: string[] = [];
    if (params.deep) {
      doctorArgs.push("--deep");
    }
    if (params.repair) {
      doctorArgs.push("--repair", "--non-interactive");
    }

    try {
      const doctorResult = await this.doctorCli.run(doctorArgs, { allowFailure: false });
      return {
        output: [doctorResult.stdout, doctorResult.stderr].filter(Boolean).join("\n"),
        backend: "doctor"
      };
    } catch {
      const args = ["doctor", ...doctorArgs];
      const result = await this.cli.run(args);
      return {
        output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
        backend: "openclaw"
      };
    }
  }

  async gatewayStatus(): Promise<unknown> {
    return await this.safeJson<unknown>(["gateway", "status", "--json"]);
  }

  async restartGateway(params: GatewayRestartParams = {}): Promise<unknown> {
    if (this.env.gatewayRestartMode === "none") {
      return {
        skipped: true,
        mode: this.env.gatewayRestartMode,
        reason: "Gateway restart is disabled by configuration"
      };
    }
    if (this.env.gatewayRestartMode === "container") {
      this.scheduleContainerRestart?.("gateway.restart");
      return {
        scheduled: true,
        mode: this.env.gatewayRestartMode,
        targetPid: 1,
        signal: "SIGTERM",
        reason: "Container restart scheduled"
      };
    }

    const args = ["gateway", "restart"];
    if (params.safe ?? (!params.force)) {
      args.push("--safe");
    }
    if (params.skipDeferral) {
      args.push("--skip-deferral");
    }
    if (params.force) {
      args.push("--force");
    }
    args.push("--json");
    return await this.safeJson<unknown>(args);
  }

  private async ensureManagedTopologyBase(): Promise<void> {
    await this.cli.run([
      "config",
      "set",
      `plugins.entries${quoteConfigKey("mqtt-channel")}.enabled`,
      "true",
      "--strict-json"
    ]);
    await this.cli.run([
      "config",
      "set",
      "session.dmScope",
      "\"per-channel-peer\"",
      "--strict-json"
    ]);
  }

  private async configureMqttAccount(config: {
    accountId: string;
    brokerUrl: string;
    username: string;
    password: string;
    inboundTopic: string;
    outboundTopic: string;
    enabled: boolean;
  }): Promise<void> {
    const payload = {
      enabled: config.enabled,
      brokerUrl: config.brokerUrl,
      username: config.username,
      password: config.password,
      topics: {
        inbound: config.inboundTopic,
        outbound: config.outboundTopic
      },
      qos: 1,
      disableBlockStreaming: false
    };

    await this.cli.run([
      "config",
      "set",
      mqttAccountPath(config.accountId),
      JSON.stringify(payload),
      "--strict-json"
    ]);
  }

  private async requireManagedAgent(agentId: string): Promise<ManagedAgentRecord> {
    const record = await this.stateStore.getAgent(agentId);
    if (!record) {
      throw new Error(`Managed agent not found: ${agentId}`);
    }

    return record;
  }

  private async agentExists(agentId: string): Promise<boolean> {
    const index = await this.findAgentConfigIndex(agentId);
    return index >= 0;
  }

  private async findAgentConfigIndex(agentId: string): Promise<number> {
    const agents = await this.safeJson<Array<{ id?: string }>>(["config", "get", "agents.list", "--json"]);
    return agents.findIndex((agent) => agent.id === agentId);
  }

  private async requireAgentConfigIndex(agentId: string): Promise<number> {
    const index = await this.findAgentConfigIndex(agentId);
    if (index < 0) {
      throw new Error(`Agent config not found: ${agentId}`);
    }

    return index;
  }

  private async safeJson<T>(args: string[]): Promise<T> {
    return await this.cli.runJson<T>(args);
  }

  private async writeAgentsMarkdown(workspace: string, content: string): Promise<string> {
    const targetPath = path.join(workspace, "AGENTS.md");
    await mkdir(workspace, { recursive: true });
    const normalized = content.endsWith("\n") ? content : `${content}\n`;
    await writeFile(targetPath, normalized, "utf8");
    return targetPath;
  }
}
