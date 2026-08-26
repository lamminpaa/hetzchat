import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ToolError } from "./types.js";

/**
 * R13: resolves `candidate` inside `root` and refuses anything that escapes.
 *
 * The lexical check catches `..` and absolute paths; the realpath check catches
 * symlinks that point outside, which the lexical check cannot see.
 */
export async function resolveWithinRoot(root: string, candidate: string): Promise<string> {
  const rootReal = await realpath(root).catch(() => resolve(root));
  const target = resolve(rootReal, candidate);

  assertInside(rootReal, target, candidate);

  // A path that does not exist yet cannot be a symlink out; the lexical check
  // above is the whole guarantee in that case.
  const targetReal = await realpath(target).catch(() => undefined);
  if (targetReal !== undefined) assertInside(rootReal, targetReal, candidate);

  return targetReal ?? target;
}

function assertInside(root: string, target: string, original: string): void {
  if (target === root) return;

  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep)[0] === "..") {
    throw new ToolError(
      `Refusing to touch ${original}: it resolves outside the working directory.`,
    );
  }
}
