import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverAndLoadExtensions } from "@mariozechner/pi-coding-agent";

const expectedCommands = ["diff"];
const expectedHandlers = [];

const cwd = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), "pi-diff-pack-smoke-"));

try {
  const packDir = join(tempDir, "pack");
  const extractDir = join(tempDir, "extract");
  mkdirSync(packDir);
  mkdirSync(extractDir);

  const packOutput = run("npm", [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    packDir,
  ]);
  const [{ filename, name, version }] = JSON.parse(packOutput);
  const tarballPath = join(packDir, filename);
  if (!existsSync(tarballPath)) {
    throw new Error(`npm pack did not create ${tarballPath}`);
  }

  run("tar", ["-xzf", tarballPath, "-C", extractDir]);
  const packageRoot = join(extractDir, "package");
  if (!existsSync(join(packageRoot, "package.json"))) {
    throw new Error("Packed tarball did not contain package/package.json");
  }

  const result = await discoverAndLoadExtensions(
    [packageRoot],
    cwd,
    join(tempDir, "agent"),
  );
  if (result.errors.length > 0) {
    throw new Error(
      result.errors.map(({ path, error }) => `${path}: ${error}`).join("\n"),
    );
  }
  if (result.extensions.length === 0) {
    throw new Error("Packed tarball did not load any pi extensions");
  }

  const commands = new Set(
    result.extensions.flatMap((extension) => [...extension.commands.keys()]),
  );
  const handlers = new Set(
    result.extensions.flatMap((extension) => [...extension.handlers.keys()]),
  );

  assertContains(commands, expectedCommands, "command");
  assertContains(handlers, expectedHandlers, "handler");

  console.log(`Verified ${name}@${version} loads from packed tarball.`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with code ${result.status}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function assertContains(actual, expected, label) {
  for (const value of expected) {
    if (!actual.has(value)) {
      throw new Error(`Packed extension did not register ${label}: ${value}`);
    }
  }
}
