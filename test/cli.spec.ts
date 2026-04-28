import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';

describe('runCli', () => {
  it('runs setup against the default package version', async () => {
    const setupOpenClawExtension = vi.fn(async () => ({
      extensionDir: '/tmp/workspace/.openclaw/extensions/hermes_bridge',
      packageRef: '^0.1.0',
    }));
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    const code = await runCli(['setup'], {
      setupOpenClawExtension,
      packageVersion: '0.1.0',
      cwd: '/tmp/no-infer',
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    expect(setupOpenClawExtension).toHaveBeenCalledWith({
      packageVersion: '0.1.0',
      workspaceRoot: undefined,
      packageRef: undefined,
      packageRoot: undefined,
    });
    expect(stdout.write).toHaveBeenCalled();
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('passes through workspace-root and package-ref options', async () => {
    const setupOpenClawExtension = vi.fn(async () => ({
      extensionDir: '/tmp/custom/.openclaw/extensions/hermes_bridge',
      packageRef: 'file:/tmp/pkg',
    }));

    const code = await runCli([
      'setup',
      '--workspace-root',
      '/tmp/custom',
      '--package-ref',
      'file:/tmp/pkg',
    ], {
      setupOpenClawExtension,
      packageVersion: '0.1.0',
      cwd: '/tmp/no-infer',
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    });

    expect(code).toBe(0);
    expect(setupOpenClawExtension).toHaveBeenCalledWith({
      packageVersion: '0.1.0',
      workspaceRoot: '/tmp/custom',
      packageRef: 'file:/tmp/pkg',
      packageRoot: undefined,
    });
  });

  it('does not infer a local source-directory package ref from cwd', async () => {
    const setupOpenClawExtension = vi.fn(async () => ({
      extensionDir: '/tmp/custom/.openclaw/extensions/hermes_bridge',
      packageRef: '^0.1.0',
    }));

    const code = await runCli(['setup'], {
      setupOpenClawExtension,
      packageVersion: '0.1.0',
      cwd: '/Users/example/openclaw-hermes-bridge',
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    });

    expect(code).toBe(0);
    expect(setupOpenClawExtension).toHaveBeenCalledWith({
      packageVersion: '0.1.0',
      workspaceRoot: undefined,
      packageRef: undefined,
      packageRoot: undefined,
    });
  });

  it('returns 1 for unknown commands', async () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    const code = await runCli(['wat'], {
      setupOpenClawExtension: vi.fn(),
      packageVersion: '0.1.0',
      cwd: '/tmp/no-infer',
      stdout,
      stderr,
    });

    expect(code).toBe(1);
    expect(stderr.write).toHaveBeenCalled();
    expect(stdout.write).not.toHaveBeenCalled();
  });
});
