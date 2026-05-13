import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { OntologyManager } from "../src/ontology-manager.js";
import type { EnvironmentConfig } from "../src/types.js";

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

test("OntologyManager creates, lists, and deletes ontologies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oc-mgmt-ontology-"));
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip();
  zip.addFile("schema.json", Buffer.from("{\"name\":\"crm\"}", "utf8"));
  const manager = new OntologyManager(
    createEnv({
      ontologyRoot: path.join(root, "ontology")
    }),
    {
      objectStore: {
        async getObject(bucket: string, objectKey: string): Promise<Buffer> {
          assert.equal(bucket, "ontology-bucket");
          assert.equal(objectKey, "crm/crm.zip");
          return zip.toBuffer();
        }
      }
    }
  );

  const created = await manager.createOntology({
    name: "crm",
    bucket: "ontology-bucket",
    objectKey: "crm/crm.zip"
  });

  assert.equal(created.path, path.join(root, "ontology", "crm"));
  assert.equal(
    await readFile(path.join(root, "ontology", "crm", "schema.json"), "utf8"),
    "{\"name\":\"crm\"}"
  );

  await mkdir(path.join(root, "ontology", "zeta"), { recursive: true });
  const listed = await manager.listOntologies();
  assert.deepEqual(listed.items, ["crm", "zeta"]);

  const deleted = await manager.deleteOntology({ name: "crm" });
  assert.equal(deleted.path, path.join(root, "ontology", "crm"));

  const afterDelete = await manager.listOntologies();
  assert.deepEqual(afterDelete.items, ["zeta"]);
});
