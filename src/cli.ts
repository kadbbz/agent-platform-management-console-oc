#!/usr/bin/env node

import { createManagementConsoleService } from "./service.js";

async function main(): Promise<void> {
  const service = createManagementConsoleService();
  const info = await service.start();

  process.stdout.write(
    `agent-platform-management-console-oc listening on http://${info.host}:${info.port}\n`
  );

  const shutdown = async () => {
    await service.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
