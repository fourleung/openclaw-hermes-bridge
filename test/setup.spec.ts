import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveNpmCommand, setupOpenClawExtension } from '../src/setup.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('setupOpenClawExtension', () => {
  it('writes a managed OpenClaw extension and installs dependencies', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'ohb-setup-'));
    tempDirs.push(workspaceRoot);

    const runCommand = vi.fn(async () => {});

    const result = await setupOpenClawExtension({
      workspaceRoot,
      packageVersion: '0.1.0',
      runCommand,
    });

    expect(result.extensionDir).toBe(join(
      workspaceRoot,
      '.openclaw',
      'extensions',
      'hermes_bridge',
    ));

    const packageJson = JSON.parse(
      await readFile(join(result.extensionDir, 'package.json'), 'utf8'),
    ) as {
      dependencies: Record<string, string>;
      openclaw: { extensions: string[] };
    };
    expect(packageJson.dependencies['openclaw-hermes-bridge']).toBe('^0.1.0');
    expect(packageJson.dependencies['@sinclair/typebox']).toBe('^0.32.15');
    expect(packageJson.openclaw.extensions).toEqual(['index.ts']);

    const pluginJson = JSON.parse(
      await readFile(join(result.extensionDir, 'openclaw.plugin.json'), 'utf8'),
    ) as { id: string; name: string };
    expect(pluginJson.id).toBe('hermes_bridge');
    expect(pluginJson.name).toBe('Hermes Bridge');

    const indexSource = await readFile(join(result.extensionDir, 'index.ts'), 'utf8');
    expect(indexSource).toContain('import { createBridge } from "openclaw-hermes-bridge";');
    expect(indexSource).toContain('name: "call_hermes"');

    expect(runCommand).toHaveBeenCalledWith('npm', ['install'], {
      cwd: result.extensionDir,
    });
  });

  it('respects packageRef overrides and preserves unrelated files on rerun', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'ohb-setup-'));
    tempDirs.push(workspaceRoot);

    const runCommand = vi.fn(async () => {});

    const first = await setupOpenClawExtension({
      workspaceRoot,
      packageVersion: '0.1.0',
      packageRef: 'file:/tmp/openclaw-hermes-bridge',
      runCommand,
    });

    await writeFile(join(first.extensionDir, 'keep.txt'), 'keep me', 'utf8');

    await setupOpenClawExtension({
      workspaceRoot,
      packageVersion: '0.1.0',
      packageRef: 'file:/tmp/openclaw-hermes-bridge',
      runCommand,
    });

    const packageJson = JSON.parse(
      await readFile(join(first.extensionDir, 'package.json'), 'utf8'),
    ) as {
      dependencies: Record<string, string>;
    };
    expect(packageJson.dependencies['openclaw-hermes-bridge']).toBe('file:/tmp/openclaw-hermes-bridge');
    expect(await readFile(join(first.extensionDir, 'keep.txt'), 'utf8')).toBe('keep me');
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it('infers a local file dependency when packageRoot is provided', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'ohb-setup-'));
    const packageRoot = await mkdtemp(join(tmpdir(), 'ohb-package-'));
    tempDirs.push(workspaceRoot, packageRoot);

    const runCommand = vi.fn(async () => {});

    const result = await setupOpenClawExtension({
      workspaceRoot,
      packageRoot,
      packageVersion: '0.1.0',
      runCommand,
    });

    const packageJson = JSON.parse(
      await readFile(join(result.extensionDir, 'package.json'), 'utf8'),
    ) as {
      dependencies: Record<string, string>;
    };

    expect(packageJson.dependencies['openclaw-hermes-bridge']).toBe(`file:${packageRoot}`);
    expect(result.packageRef).toBe(`file:${packageRoot}`);
  });
});

describe('resolveNpmCommand', () => {
  it('uses npm.cmd on Windows', () => {
    expect(resolveNpmCommand('win32')).toBe('npm.cmd');
  });

  it('uses npm on non-Windows platforms', () => {
    expect(resolveNpmCommand('darwin')).toBe('npm');
    expect(resolveNpmCommand('linux')).toBe('npm');
  });
});
