import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveWithinRoot } from "../../src/tools/paths.js";
import { BUILTIN_TOOLS, listFilesTool, readFileTool, runShellTool } from "../../src/tools/builtin.js";
import { ToolRunner, denyAll, type Approver } from "../../src/tools/runner.js";
import { ToolError, truncateResult, MAX_TOOL_RESULT_CHARS } from "../../src/tools/types.js";

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "hetzchat-tools-"));
  root = join(base, "workspace");
  outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(root, "inside.txt"), "inside content\n", "utf8");
  await writeFile(join(outside, "secret.txt"), "secret content\n", "utf8");
});

afterEach(async () => {
  await rm(resolve(root, ".."), { recursive: true, force: true });
});

const approver = (answer: boolean): Approver => ({
  interactive: true,
  confirm: async () => answer,
});

function makeRunner(options: { approver?: Approver; allowed?: string[] } = {}) {
  const activity: string[] = [];
  const runner = new ToolRunner({
    tools: BUILTIN_TOOLS,
    root,
    allowed: new Set(options.allowed ?? []),
    onActivity: (message) => activity.push(message),
  });
  runner.approver = options.approver ?? denyAll;
  return { runner, activity };
}

const call = (name: string, args: unknown) => ({
  id: `call_${name}`,
  name,
  arguments: JSON.stringify(args),
});

describe("R13 file tools cannot escape the working root", () => {
  it("allows a path inside the root", async () => {
    await expect(resolveWithinRoot(root, "inside.txt")).resolves.toContain("inside.txt");
    await expect(resolveWithinRoot(root, "./inside.txt")).resolves.toContain("inside.txt");
  });

  it("refuses a path that climbs out with ..", async () => {
    await expect(resolveWithinRoot(root, "../outside/secret.txt")).rejects.toThrow(ToolError);
    await expect(resolveWithinRoot(root, "../../etc/passwd")).rejects.toThrow(
      /outside the working directory/,
    );
  });

  it("refuses an absolute path outside the root", async () => {
    await expect(resolveWithinRoot(root, "/etc/passwd")).rejects.toThrow(ToolError);
    await expect(resolveWithinRoot(root, join(outside, "secret.txt"))).rejects.toThrow(ToolError);
  });

  it("refuses a symlink that points out of the root", async () => {
    await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));

    await expect(resolveWithinRoot(root, "escape.txt")).rejects.toThrow(
      /outside the working directory/,
    );
  });

  it("refuses a path that reaches outside through a symlinked directory", async () => {
    await symlink(outside, join(root, "elsewhere"));

    await expect(resolveWithinRoot(root, "elsewhere/secret.txt")).rejects.toThrow(ToolError);
  });

  it("stops read_file and list_files at the boundary, not just the resolver", async () => {
    const { runner } = makeRunner();

    const read = await runner.execute(call("read_file", { path: "../outside/secret.txt" }));
    expect(read.ok).toBe(false);
    expect(read.content).not.toContain("secret content");

    const list = await runner.execute(call("list_files", { path: "../outside" }));
    expect(list.ok).toBe(false);
    expect(list.content).not.toContain("secret.txt");
  });

  it("still reads a file that is genuinely inside", async () => {
    const { runner } = makeRunner();

    const result = await runner.execute(call("read_file", { path: "inside.txt" }));

    expect(result.ok).toBe(true);
    expect(result.content).toBe("inside content\n");
  });
});

describe("R11 every tool run is authorised", () => {
  it("runs a read-only tool without asking anyone", async () => {
    const { runner } = makeRunner({ approver: denyAll });

    expect(readFileTool.readOnly).toBe(true);
    expect(listFilesTool.readOnly).toBe(true);

    const result = await runner.execute(call("read_file", { path: "inside.txt" }));
    expect(result.ok).toBe(true);
  });

  it("refuses a side-effecting tool when there is nobody to ask", async () => {
    const { runner } = makeRunner({ approver: denyAll });

    expect(runShellTool.readOnly).toBe(false);
    const result = await runner.execute(call("run_shell", { command: "echo pwned" }));

    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/no terminal to ask|--allow-tool/);
    expect(result.content, "the command ran anyway").not.toContain("exit code");
  });

  it("refuses when the user says no", async () => {
    const { runner } = makeRunner({ approver: approver(false) });

    const result = await runner.execute(call("run_shell", { command: "echo pwned" }));

    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/Refused by the user/);
    expect(result.content, "the command ran anyway").not.toContain("exit code");
  });

  it("runs when the user says yes", async () => {
    const { runner } = makeRunner({ approver: approver(true) });

    const result = await runner.execute(call("run_shell", { command: "echo approved" }));

    expect(result.ok).toBe(true);
    expect(result.content).toContain("approved");
  });

  it("runs without asking when the tool was pre-authorised by name", async () => {
    const { runner } = makeRunner({ approver: denyAll, allowed: ["run_shell"] });

    const result = await runner.execute(call("run_shell", { command: "echo allowlisted" }));

    expect(result.ok).toBe(true);
    expect(result.content).toContain("allowlisted");
  });

  it("pre-authorising one tool does not authorise another", async () => {
    const { runner } = makeRunner({ approver: denyAll, allowed: ["fetch_url"] });

    const result = await runner.execute(call("run_shell", { command: "echo nope" }));

    expect(result.ok).toBe(false);
    expect(result.content, "the command ran anyway").not.toContain("exit code");
  });

  it("shows the user what the call would do before asking", async () => {
    const seen: string[] = [];
    const { runner } = makeRunner({
      approver: {
        interactive: true,
        confirm: async (summary) => {
          seen.push(summary);
          return false;
        },
      },
    });

    await runner.execute(call("run_shell", { command: "rm -rf /tmp/example" }));

    expect(seen[0]).toContain("rm -rf /tmp/example");
  });
});

describe("tool failures come back as results, not exceptions", () => {
  it("names an unknown tool and lists the real ones", async () => {
    const { runner } = makeRunner();

    const result = await runner.execute(call("delete_everything", {}));

    expect(result.ok).toBe(false);
    expect(result.content).toContain("delete_everything");
    expect(result.content).toContain("read_file");
  });

  it("reports arguments that are not valid JSON", async () => {
    const { runner } = makeRunner();

    const result = await runner.execute({ id: "1", name: "read_file", arguments: "{oops" });

    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/not valid JSON/);
  });

  it("reports a missing required argument", async () => {
    const { runner } = makeRunner();

    const result = await runner.execute(call("read_file", {}));

    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/Missing required argument "path"/);
  });

  it("reports a file that is not there", async () => {
    const { runner } = makeRunner();

    const result = await runner.execute(call("read_file", { path: "nope.txt" }));

    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/No such file/);
  });

  it("returns a non-zero shell exit as a result the model can read", async () => {
    const { runner } = makeRunner({ approver: approver(true) });

    const result = await runner.execute(call("run_shell", { command: "exit 3" }));

    expect(result.ok).toBe(true);
    expect(result.content).toContain("exit code 3");
  });
});

describe("tool results are bounded", () => {
  it("truncates a result and says by how much", () => {
    const long = "x".repeat(MAX_TOOL_RESULT_CHARS + 500);

    const truncated = truncateResult(long);

    expect(truncated.length).toBeLessThan(long.length);
    expect(truncated).toContain("500 more characters");
  });

  it("leaves a short result alone", () => {
    expect(truncateResult("short")).toBe("short");
  });
});

describe("tool specifications", () => {
  it("describes every tool in the shape the API expects", () => {
    const { runner } = makeRunner();

    for (const spec of runner.specifications()) {
      expect(spec["type"]).toBe("function");
      const fn = spec["function"] as Record<string, unknown>;
      expect(typeof fn["name"]).toBe("string");
      expect(typeof fn["description"]).toBe("string");
      expect((fn["parameters"] as Record<string, unknown>)["type"]).toBe("object");
    }
  });

  it("marks exactly the tools that only read as read-only", () => {
    const readOnly = BUILTIN_TOOLS.filter((tool) => tool.readOnly).map((tool) => tool.name);

    expect(readOnly.sort()).toEqual(["list_files", "read_file"]);
  });
});
