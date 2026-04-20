import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

type Platform = ReturnType<typeof inferPlatform>;

const EXTENSION_ID = 'hermes_bridge';
const TYPEBOX_VERSION = '^0.32.15';

export interface SetupOpenClawExtensionOptions {
  workspaceRoot?: string;
  packageVersion: string;
  packageRef?: string;
  packageRoot?: string;
  platform?: Platform;
  runCommand?: (command: string, args: string[], opts: { cwd: string }) => Promise<void>;
}

export interface SetupOpenClawExtensionResult {
  workspaceRoot: string;
  extensionDir: string;
  packageRef: string;
}

export async function setupOpenClawExtension(
  opts: SetupOpenClawExtensionOptions,
): Promise<SetupOpenClawExtensionResult> {
  const workspaceRoot = opts.workspaceRoot ?? join(homedir(), '.openclaw', 'workspace');
  const extensionDir = join(workspaceRoot, '.openclaw', 'extensions', EXTENSION_ID);
  const packageRef = opts.packageRef ?? inferPackageRef(opts.packageRoot) ?? `^${opts.packageVersion}`;
  const runCommand = opts.runCommand ?? runCommandDefault;

  await mkdir(extensionDir, { recursive: true });

  await writeFile(
    join(extensionDir, 'package.json'),
    JSON.stringify(buildPackageJson(packageRef), null, 2) + '\n',
    'utf8',
  );
  await writeFile(
    join(extensionDir, 'openclaw.plugin.json'),
    JSON.stringify(buildPluginManifest(), null, 2) + '\n',
    'utf8',
  );
  await writeFile(join(extensionDir, 'index.ts'), buildIndexSource(), 'utf8');

  await runCommand(resolveNpmCommand(opts.platform), ['install'], { cwd: extensionDir });

  return { workspaceRoot, extensionDir, packageRef };
}

function inferPackageRef(packageRoot?: string): string | undefined {
  if (!packageRoot) return undefined;
  return `file:${packageRoot}`;
}

function buildPackageJson(packageRef: string): object {
  return {
    name: '@openclaw/plugin-hermes-bridge',
    version: '1.0.0',
    type: 'module',
    dependencies: {
      'openclaw-hermes-bridge': packageRef,
      '@sinclair/typebox': TYPEBOX_VERSION,
    },
    openclaw: {
      extensions: ['index.ts'],
      configSchema: {
        jsonSchema: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', default: true },
          },
        },
      },
    },
  };
}

function buildPluginManifest(): object {
  return {
    id: EXTENSION_ID,
    name: 'Hermes Bridge',
    description: 'Delegates subtasks to Hermes via ACP.',
    version: '1.0.0',
    configSchema: {
      jsonSchema: {
        type: 'object',
        properties: {
          enabled: {
            type: 'boolean',
            default: true,
          },
        },
      },
    },
  };
}

function buildIndexSource(): string {
  return `import { createBridge } from "openclaw-hermes-bridge";
import { Type } from "@sinclair/typebox";

export const id = "hermes_bridge";
export const name = "Hermes Bridge";
export const description = "Delegates subtasks to Hermes via ACP.";

let sharedBridge: any = null;

export function register(api: any) {
  const config = api.pluginConfig || {};

  api.registerTool((ctx: any) => {
    if (config.enabled === false) return null;

    const HERMES_SESSION_BOOT_TIMEOUT_MS = 60_000;
    const HERMES_DEFAULT_TIMEOUT_MS = 300_000;

    const HermesSchema = Type.Object({
      prompt: Type.String({
        description: "Detailed task description for the Hermes agent.",
      }),
      task_id: Type.Optional(Type.String({
        description: "Tracking ID for this subtask.",
      })),
    });

    const HERMES_OUTPUT_SCHEMA: any = {
      type: "object",
      required: ["answer"],
      properties: {
        answer: { type: "string" },
      },
      additionalProperties: true,
    };

    if (!sharedBridge) {
      api.logger.info("Initializing Hermes Bridge singleton...");
      sharedBridge = createBridge({
        sessionBootTimeoutMs: HERMES_SESSION_BOOT_TIMEOUT_MS,
        defaultTimeoutMs: HERMES_DEFAULT_TIMEOUT_MS,
      });

      api.on("gateway_stop", async () => {
        api.logger.info("Shutting down Hermes Bridge...");
        if (sharedBridge) {
          await sharedBridge.shutdown();
          sharedBridge = null;
        }
      });
    }

    const workflowId = ctx.sessionKey?.trim() || "openclaw-default";

    return {
      name: "call_hermes",
      description: "Ask Hermes to handle a subtask. High performance reasoning.",
      parameters: HermesSchema,
      execute: async (_toolCallId: string, args: any) => {
        const { prompt, task_id } = args;

        try {
          const envelope = await sharedBridge.delegate(workflowId, {
            prompt,
            outputSchema: HERMES_OUTPUT_SCHEMA,
          });

          if (envelope.status === "ok" && envelope.output) {
            return {
              content: JSON.stringify({
                answer: envelope.output.answer,
                task_id,
                session_id: envelope.meta.sessionId,
                attempt: envelope.meta.attempt,
                duration_ms: envelope.meta.durationMs,
              }),
            };
          }

          return {
            content: JSON.stringify({
              error: \`hermes_\${envelope.status}\`,
              message: envelope.error?.message || \`Status: \${envelope.status}\`,
              raw_text: envelope.rawText.slice(0, 1000),
            }),
          };
        } catch (err: any) {
          return {
            content: JSON.stringify({
              error: "bridge_exception",
              message: err.message,
            }),
          };
        }
      },
    };
  });
}
`;
}

async function runCommandDefault(
  command: string,
  args: string[],
  opts: { cwd: string },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code ?? 'null'}`));
    });
  });
}

export function resolveNpmCommand(platform: Platform = inferPlatform()): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function inferPlatform() {
  return globalThis.process.platform;
}
