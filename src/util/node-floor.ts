/** Minimum Node.js version the gateway supports.
 *
 * Source of truth: the `engines` field of the pi peer packages
 * (@earendil-works/pi-ai and @earendil-works/pi-coding-agent both require
 * >=22.19.0). Keep in sync with `engines.node` in package.json — npm does not
 * enforce `engines` unless `engine-strict` is set, which is why the runtime
 * check exists. */
export const MIN_NODE_VERSION = '22.19.0';

/** True when `version` (default: the running Node) satisfies the floor.
 * Compares major.minor — the floor does not pin a patch level. */
export function nodeVersionMeetsFloor(version: string = process.versions.node): boolean {
  const [floorMajor, floorMinor] = MIN_NODE_VERSION.split('.').map(Number);
  const [major, minor] = version.split('.').map(Number);
  return major > floorMajor || (major === floorMajor && minor >= floorMinor);
}
