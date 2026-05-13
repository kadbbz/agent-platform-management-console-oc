import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { ManagedStateStore } from "../src/state-store.js";

test("ManagedStateStore upserts and removes agents", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oc-mgmt-state-"));
  const store = new ManagedStateStore(path.join(root, "managed-agents.json"));

  await store.upsertAgent({
    id: "lowcode",
    accountId: "lowcode",
    workspace: "/tmp/lowcode",
    inboundTopic: "agents/channel/lowcode/inbound",
    outboundTopic: "agents/channel/lowcode/outbound",
    enabled: true,
    updatedAt: "2026-05-13T00:00:00.000Z"
  });

  const agentsAfterInsert = await store.listAgents();
  assert.equal(agentsAfterInsert.length, 1);
  assert.equal(agentsAfterInsert[0]?.id, "lowcode");

  await store.removeAgent("lowcode");
  const agentsAfterDelete = await store.listAgents();
  assert.equal(agentsAfterDelete.length, 0);
});
