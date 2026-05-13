import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import type {
  EnvironmentConfig,
  OntologyCreateParams,
  OntologyDeleteParams
} from "./types.js";

function validateOntologyName(name: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid ontology name: ${name}`);
  }
}

interface OntologyObjectStore {
  getObject(bucket: string, objectKey: string): Promise<Buffer>;
}

function requireOntologyS3Config(env: EnvironmentConfig): {
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
} {
  if (!env.ontologyS3AccessKeyId) {
    throw new Error("Missing required environment variable: AIOS_S3_ACCESS_KEY_ID");
  }
  if (!env.ontologyS3SecretAccessKey) {
    throw new Error("Missing required environment variable: AIOS_S3_SECRET_ACCESS_KEY");
  }

  return {
    endpoint: env.ontologyS3Endpoint,
    region: env.ontologyS3Region,
    accessKeyId: env.ontologyS3AccessKeyId,
    secretAccessKey: env.ontologyS3SecretAccessKey,
    forcePathStyle: env.ontologyS3ForcePathStyle
  };
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) {
    throw new Error("S3 object body is empty");
  }

  if (
    typeof body === "object"
    && "transformToByteArray" in body
    && typeof body.transformToByteArray === "function"
  ) {
    return Buffer.from(await body.transformToByteArray());
  }

  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  throw new Error("Unsupported S3 object body type");
}

function createS3ObjectStore(env: EnvironmentConfig): OntologyObjectStore {
  const config = requireOntologyS3Config(env);
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });

  return {
    async getObject(bucket: string, objectKey: string): Promise<Buffer> {
      const response = await client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: objectKey
      }));
      return await bodyToBuffer(response.Body);
    }
  };
}

export class OntologyManager {
  private objectStore?: OntologyObjectStore;

  constructor(
    private readonly env: EnvironmentConfig,
    dependencies?: {
      objectStore?: OntologyObjectStore;
    }
  ) {
    this.objectStore = dependencies?.objectStore;
  }

  async listOntologies(): Promise<{ items: string[] }> {
    await mkdir(this.env.ontologyRoot, { recursive: true });
    const { readdir } = await import("node:fs/promises");
    const items = await readdir(this.env.ontologyRoot, { withFileTypes: true });
    return {
      items: items.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    };
  }

  async createOntology(params: OntologyCreateParams): Promise<{ path: string }> {
    validateOntologyName(params.name);
    if (!params.bucket || params.bucket.trim().length === 0) {
      throw new Error("ontology.create requires bucket");
    }
    if (!params.objectKey || params.objectKey.trim().length === 0) {
      throw new Error("ontology.create requires objectKey");
    }

    const targetDir = path.join(this.env.ontologyRoot, params.name);
    if (params.replace) {
      await rm(targetDir, { recursive: true, force: true });
    }

    const AdmZip = (await import("adm-zip")).default;
    const zipPayload = await this.getObjectStore().getObject(params.bucket, params.objectKey);
    const zip = new AdmZip(zipPayload);

    await mkdir(targetDir, { recursive: true });

    for (const entry of zip.getEntries()) {
      const normalized = path.normalize(entry.entryName).replace(/^(\.\.(\/|\\|$))+/, "");
      const destination = path.join(targetDir, normalized);
      const relative = path.relative(targetDir, destination);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Zip entry escapes ontology root: ${entry.entryName}`);
      }

      if (entry.isDirectory) {
        await mkdir(destination, { recursive: true });
        continue;
      }

      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, entry.getData());
    }

    return { path: targetDir };
  }

  async deleteOntology(params: OntologyDeleteParams): Promise<{ path: string }> {
    validateOntologyName(params.name);
    const targetDir = path.join(this.env.ontologyRoot, params.name);
    await rm(targetDir, { recursive: true, force: true });
    return { path: targetDir };
  }

  private getObjectStore(): OntologyObjectStore {
    if (!this.objectStore) {
      this.objectStore = createS3ObjectStore(this.env);
    }

    return this.objectStore;
  }
}
