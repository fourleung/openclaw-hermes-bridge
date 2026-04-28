#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setupOpenClawExtension, type SetupOpenClawExtensionOptions } from './setup.js';

interface RunCliDeps {
  setupOpenClawExtension: (opts: SetupOpenClawExtensionOptions) => Promise<{
    extensionDir: string;
    packageRef: string;
  }>;
  packageVersion: string;
  cwd: string;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

export async function runCli(argv: string[], deps: RunCliDeps): Promise<number> {
  const [command, ...rest] = argv;

  if (command !== 'setup') {
    deps.stderr.write(usage());
    return 1;
  }

  const parsed = parseSetupArgs(rest);
  if ('error' in parsed) {
    deps.stderr.write(`${parsed.error}\n\n${usage()}`);
    return 1;
  }

  const result = await deps.setupOpenClawExtension({
    packageVersion: deps.packageVersion,
    workspaceRoot: parsed.workspaceRoot,
    packageRef: parsed.packageRef,
    packageRoot: undefined,
  });

  deps.stdout.write(
    `Installed Hermes Bridge extension at ${result.extensionDir}\n` +
    `Package ref: ${result.packageRef}\n`,
  );
  return 0;
}

function parseSetupArgs(args: string[]): {
  workspaceRoot?: string;
  packageRef?: string;
} | { error: string } {
  let workspaceRoot: string | undefined;
  let packageRef: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--workspace-root') {
      workspaceRoot = args[i + 1];
      i += 1;
      if (!workspaceRoot) return { error: 'Missing value for --workspace-root' };
      continue;
    }
    if (arg === '--package-ref') {
      packageRef = args[i + 1];
      i += 1;
      if (!packageRef) return { error: 'Missing value for --package-ref' };
      continue;
    }
    return { error: `Unknown option: ${arg}` };
  }

  return { workspaceRoot, packageRef };
}

function usage(): string {
  return [
    'Usage: openclaw-hermes-bridge setup [--workspace-root <path>] [--package-ref <ref>]',
    '',
    'setup installs or updates the OpenClaw extension wiring for this package.',
  ].join('\n');
}

async function readPackageVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(new globalThis.URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  return packageJson.version;
}

const isMain = globalThis.process.argv[1]
  ? pathToFileURL(globalThis.process.argv[1]).href === import.meta.url
  : false;

if (isMain) {
  const packageVersion = await readPackageVersion();
  const exitCode = await runCli(globalThis.process.argv.slice(2), {
    setupOpenClawExtension,
    packageVersion,
    cwd: globalThis.process.cwd(),
    stdout: globalThis.process.stdout,
    stderr: globalThis.process.stderr,
  });
  globalThis.process.exitCode = exitCode;
}
