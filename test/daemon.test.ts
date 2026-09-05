import { describe, expect, it } from 'vitest';
import { buildLinuxServiceUnit, buildPeerSymlinkExecStartPre } from '../src/cli/daemon.js';

describe('buildLinuxServiceUnit', () => {
  it('includes ExecStartPre when provided', () => {
    const unit = buildLinuxServiceUnit({
      nodePath: '/usr/bin/node',
      cliPath: '/opt/piscord/dist/cli/index.js',
      configPath: '/home/u/.config/pi-discord-gateway/config.env',
      homeDir: '/home/u',
      execStartPre: "ExecStartPre=/bin/sh -c 'true'",
    });

    expect(unit).toContain("ExecStartPre=/bin/sh -c 'true'");
    expect(unit.indexOf('ExecStartPre=')).toBeLessThan(unit.indexOf('ExecStart='));
    expect(unit).toContain('ExecStart=/usr/bin/node /opt/piscord/dist/cli/index.js start');
    expect(unit).toContain('Environment=PIDG_CONFIG=/home/u/.config/pi-discord-gateway/config.env');
  });

  it('omits ExecStartPre when not provided', () => {
    const unit = buildLinuxServiceUnit({
      nodePath: '/usr/bin/node',
      cliPath: '/opt/piscord/dist/cli/index.js',
      configPath: '/cfg',
      homeDir: '/home/u',
    });

    expect(unit).not.toContain('ExecStartPre');
  });
});

describe('buildPeerSymlinkExecStartPre', () => {
  const cliPath = '/root/.pi/agent/npm/node_modules/piscord/dist/cli/index.js';
  const globalRoot = '/usr/local/lib/node_modules';

  it('returns undefined on npm-global installs (linkDir == peerDir would rm -rf the real package)', () => {
    const globalCliPath = `${globalRoot}/piscord/dist/cli/index.js`;
    const existing = new Set([
      `${globalRoot}/@earendil-works/pi-coding-agent`,
      `${globalRoot}/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai`,
    ]);
    const line = buildPeerSymlinkExecStartPre(globalCliPath, {
      globalRoot,
      fsExists: (path) => existing.has(path),
    });
    expect(line).toBeUndefined();
  });

  it('links both peers when both exist in the global root, replacing real dirs safely', () => {
    const existing = new Set([
      `${globalRoot}/@earendil-works/pi-coding-agent`,
      `${globalRoot}/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai`,
    ]);

    const line = buildPeerSymlinkExecStartPre(cliPath, {
      globalRoot,
      fsExists: (path) => existing.has(path),
    });

    expect(line).toBeDefined();
    expect(line).toContain('mkdir -p "/root/.pi/agent/npm/node_modules/@earendil-works"');
    // rm -rf first: ln -sfn alone would NEST the symlink inside a real dir.
    expect(line).toContain(
      `rm -rf "/root/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent" && ln -sfn "${globalRoot}/@earendil-works/pi-coding-agent" "/root/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent"`,
    );
    expect(line).toContain(
      `rm -rf "/root/.pi/agent/npm/node_modules/@earendil-works/pi-ai" && ln -sfn "${globalRoot}/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai" "/root/.pi/agent/npm/node_modules/@earendil-works/pi-ai"`,
    );
  });

  it('links only pi-coding-agent when pi-ai is not resolvable', () => {
    const existing = new Set([`${globalRoot}/@earendil-works/pi-coding-agent`]);

    const line = buildPeerSymlinkExecStartPre(cliPath, {
      globalRoot,
      fsExists: (path) => existing.has(path),
    });

    expect(line).toBeDefined();
    expect(line).toContain('pi-coding-agent');
    expect(line).not.toContain('pi-ai');
  });

  it('returns undefined for non-node_modules installs or missing global peers', () => {
    expect(
      buildPeerSymlinkExecStartPre('/opt/piscord/dist/cli/index.js', {
        globalRoot,
        fsExists: () => true,
      }),
    ).toBeUndefined();

    expect(
      buildPeerSymlinkExecStartPre(cliPath, {
        globalRoot,
        fsExists: () => false,
      }),
    ).toBeUndefined();
  });
});
