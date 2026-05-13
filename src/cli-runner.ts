import { spawn } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class CommandError extends Error {
  constructor(
    message: string,
    public readonly command: string[],
    public readonly result: CommandResult
  ) {
    super(message);
  }
}

export class CliRunner {
  constructor(private readonly bin: string) {}

  async run(args: string[], options: { stdin?: string; allowFailure?: boolean } = {}): Promise<CommandResult> {
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(this.bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        const result: CommandResult = {
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code ?? 0
        };

        if (result.exitCode !== 0 && !options.allowFailure) {
          reject(new CommandError(
            `Command failed: ${[this.bin, ...args].join(" ")}`,
            [this.bin, ...args],
            result
          ));
          return;
        }

        resolve(result);
      });

      if (options.stdin) {
        child.stdin.write(options.stdin);
      }
      child.stdin.end();
    });
  }

  async runJson<T>(args: string[], options: { stdin?: string; allowFailure?: boolean } = {}): Promise<T> {
    const result = await this.run(args, options);
    if (!result.stdout) {
      throw new Error(`Expected JSON output from ${[this.bin, ...args].join(" ")}`);
    }

    return JSON.parse(result.stdout) as T;
  }
}
