import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';

const tempDirs: string[] = [];
const repoRoot = resolve(import.meta.dirname, '..');

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('setup.sh', () => {
  it('runs npm install, npm run build, then cli setup with forwarded args', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'ohb-setup-script-'));
    tempDirs.push(tempRoot);

    const fakeBin = join(tempRoot, 'bin');
    const logFile = join(tempRoot, 'calls.log');
    await writeFile(logFile, '', 'utf8');
    await writeFile(
      join(tempRoot, 'npm-script.sh'),
      '#!/bin/sh\n' +
      'printf "npm:%s:%s\\n" "$PWD" "$*" >> "$TEST_LOG"\n',
      'utf8',
    );
    await writeFile(
      join(tempRoot, 'node-script.sh'),
      '#!/bin/sh\n' +
      'printf "node:%s:%s\\n" "$PWD" "$*" >> "$TEST_LOG"\n',
      'utf8',
    );
    await mkdirAll(fakeBin);
    await writeFile(join(fakeBin, 'npm'), '#!/bin/sh\nexec "' + join(tempRoot, 'npm-script.sh') + '" "$@"\n', 'utf8');
    await writeFile(join(fakeBin, 'node'), '#!/bin/sh\nexec "' + join(tempRoot, 'node-script.sh') + '" "$@"\n', 'utf8');
    await chmod(join(tempRoot, 'npm-script.sh'), 0o755);
    await chmod(join(tempRoot, 'node-script.sh'), 0o755);
    await chmod(join(fakeBin, 'npm'), 0o755);
    await chmod(join(fakeBin, 'node'), 0o755);

    await execFilePromise('bash', ['setup.sh', '--workspace-root', '/tmp/custom-workspace'], {
      cwd: repoRoot,
      env: {
        ...globalThis.process.env,
        PATH: `${fakeBin}:${globalThis.process.env.PATH ?? ''}`,
        TEST_LOG: logFile,
      },
    });

    const log = await readFile(logFile, 'utf8');
    expect(log).toContain(`npm:${repoRoot}:install`);
    expect(log).toContain(`npm:${repoRoot}:run build`);
    expect(log).toContain(`node:${repoRoot}:dist/cli.js setup --workspace-root /tmp/custom-workspace`);
  });
});

async function mkdirAll(path: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path, { recursive: true });
}

function execFilePromise(
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string | undefined>;
  },
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, opts, (error) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise();
    });
  });
}
