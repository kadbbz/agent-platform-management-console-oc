import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ManagedAgentRecord, ManagedState } from "./types.js";

const DEFAULT_STATE: ManagedState = {
  version: 1,
  agents: []
};

export class ManagedStateStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<ManagedState> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as Partial<ManagedState>;
      return {
        version: 1,
        agents: Array.isArray(parsed.agents) ? parsed.agents : []
      };
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return DEFAULT_STATE;
      }

      throw error;
    }
  }

  async write(state: ManagedState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async listAgents(): Promise<ManagedAgentRecord[]> {
    const state = await this.read();
    return [...state.agents].sort((left, right) => left.id.localeCompare(right.id));
  }

  async getAgent(agentId: string): Promise<ManagedAgentRecord | undefined> {
    const state = await this.read();
    return state.agents.find((agent) => agent.id === agentId);
  }

  async upsertAgent(agent: ManagedAgentRecord): Promise<void> {
    const state = await this.read();
    const nextAgents = state.agents.filter((entry) => entry.id !== agent.id);
    nextAgents.push(agent);
    await this.write({
      version: 1,
      agents: nextAgents.sort((left, right) => left.id.localeCompare(right.id))
    });
  }

  async removeAgent(agentId: string): Promise<void> {
    const state = await this.read();
    await this.write({
      version: 1,
      agents: state.agents.filter((agent) => agent.id !== agentId)
    });
  }
}
