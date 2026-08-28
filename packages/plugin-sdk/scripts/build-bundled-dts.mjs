// Generates the self-contained `.d.ts` bundles that `bb plugin new` ships into
// a scaffolded plugin's `types/` directory, so authors get real BbPluginApi /
// @get-bb/plugin-sdk/app types WITHOUT the (unpublished) @bb/* workspace packages
// on disk.
//
// rollup-plugin-dts flattens @get-bb/plugin-sdk's own contracts plus every @bb/*
// type it references (BbSdk, PromptInput, ThreadResponse, …) into the root
// file. Testing subpaths reuse that already-portable root declaration through
// the package's own public name instead of flattening the same contracts a
// second time. Genuine npm packages remain external imports and resolve from
// the consumer's own dependencies.
//
// The output, bundled-types/*.d.ts, is NOT committed. It is the package's
// published `types` surface and a build output of the turbo task
// `@get-bb/plugin-sdk#build:types`; @bb/templates reads it at scaffold-embed
// time by file path (no package edge, to avoid a dependency cycle), and the
// in-repo plugins typecheck against it. Unchanged files are not rewritten so
// mtimes stay stable for watchers.
import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";

import {
  BB_DTS_MAX_WORKERS,
  BB_DTS_REEXEC,
  BB_DTS_SLICE,
  decideIsolation,
  isInCgroupUnit,
  primaryCgroupPath,
  resolveWorkerConfiguration,
  runWorkerPool,
} from "./build-bundled-dts-support.mjs";
import { normalizeBundledDts } from "./normalize-bundled-dts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const pkgsDir = path.resolve(pkgRoot, "..");
// Server-contract modules whose real declarations are not portable into a
// flattened .d.ts, each redirected to a loose stub (the stub headers say why).
const STUBBED_MODULES = new Map([
  [
    path.join(pkgsDir, "server-contract/src/public-api.ts"),
    path.join(here, "public-api-stub.d.ts"),
  ],
  [
    path.join(pkgsDir, "server-contract/src/api-client.ts"),
    path.join(here, "api-client-stub.d.ts"),
  ],
]);
const outDir = path.join(pkgRoot, "bundled-types");
const outputs = {
  "bb-plugin-sdk.d.ts": path.join(pkgRoot, "src/index.ts"),
  "bb-plugin-sdk-app.d.ts": path.join(pkgRoot, "src/app.ts"),
  "bb-plugin-sdk-provider-bridge.d.ts": path.join(
    pkgRoot,
    "src/provider-bridge.ts",
  ),
  "bb-plugin-sdk-ai-services.d.ts": path.join(pkgRoot, "src/ai-services.ts"),
  "bb-plugin-sdk-provider-bridge-testing.d.ts": path.join(
    pkgRoot,
    "src/provider-bridge-testing.ts",
  ),
  "bb-plugin-sdk-provider-bridge-acp.d.ts": path.join(
    pkgRoot,
    "src/provider-bridge-acp.ts",
  ),
  "bb-plugin-sdk-host.d.ts": path.join(pkgRoot, "src/host.ts"),
  "bb-plugin-sdk-internal-composer-customization-validation.d.ts": path.join(
    pkgRoot,
    "src/internal/composer-customization-validation.ts",
  ),
  "bb-plugin-sdk-internal-composer-view.d.ts": path.join(
    pkgRoot,
    "src/internal/composer-view.ts",
  ),
  "bb-plugin-sdk-internal-file-navigation-validation.d.ts": path.join(
    pkgRoot,
    "src/internal/file-navigation-validation.ts",
  ),
  "bb-plugin-sdk-internal-host-policy.d.ts": path.join(
    pkgRoot,
    "src/internal/host-policy.ts",
  ),
  "bb-plugin-sdk-internal-plugin-app-collector.d.ts": path.join(
    pkgRoot,
    "src/internal/plugin-app-collector.ts",
  ),
  "bb-plugin-sdk-testing.d.ts": path.join(pkgRoot, "src/testing/index.ts"),
  "bb-plugin-sdk-testing-app.d.ts": path.join(pkgRoot, "src/testing/app.tsx"),
  "bb-plugin-sdk-testing-host.d.ts": path.join(pkgRoot, "src/testing/host.ts"),
};

// Real npm packages the bundle imports from — kept external so they resolve
// from the scaffold's devDependencies rather than being inlined.
const EXTERNAL = [
  /^@get-bb\/plugin-sdk$/,
  /^node:/,
  /^@testing-library\/react($|\/)/,
  /^better-sqlite3/,
  /^hono($|\/)/,
  /^react($|\/|-)/,
  /^react-dom($|\/)/,
  /^zod($|\/)/,
];

/** Resolve any `@bb/<pkg>[/<sub>]` to its `source` export target on disk. */
function resolveBbSource(id) {
  const match = /^@bb\/([^/]+)(\/.*)?$/.exec(id);
  if (!match) return null;
  const pkgDir = path.join(pkgsDir, match[1]);
  const manifestPath = path.join(pkgDir, "package.json");
  if (!existsSync(manifestPath)) return null;
  const { exports } = JSON.parse(readFileSync(manifestPath, "utf8"));
  const key = match[2] ? "." + match[2] : ".";
  const entry = exports?.[key];
  const source =
    typeof entry === "string"
      ? entry
      : (entry?.source ?? entry?.types ?? entry?.default);
  return source ? path.join(pkgDir, source) : null;
}

const inlineWorkspace = {
  name: "inline-bb-workspace",
  resolveId(id, importer) {
    // Redirect server-contract's non-portable modules to their loose stubs,
    // whether imported by bare specifier or by a sibling's relative path.
    if (importer) {
      const asTs = path.resolve(
        path.dirname(importer),
        id.replace(/\.js$/, ".ts"),
      );
      const stub = STUBBED_MODULES.get(asTs);
      if (stub) return stub;
    }
    const stub = STUBBED_MODULES.get(id);
    if (stub) return stub;
    return resolveBbSource(id);
  },
};

async function bundle(input) {
  const build = await rollup({
    input,
    external: EXTERNAL,
    plugins: [inlineWorkspace, dts({ respectExternal: false })],
    onwarn(warning) {
      // Circular type references are fine in .d.ts output; surface everything
      // else so a genuinely broken bundle is visible.
      if (warning.code === "CIRCULAR_DEPENDENCY") return;
      console.warn(`[build-bundled-dts] ${warning.code}: ${warning.message}`);
    },
  });
  const { output } = await build.generate({ format: "es" });
  await build.close();
  return output[0].code;
}

const HEADER = [
  "// Portable type declarations for `@get-bb/plugin-sdk`. Unpublished BB",
  "// workspace contracts are flattened; public subpaths may reuse the",
  "// package root without requiring any other @bb/* package.",
  "//",
  "// Confused by the API, or need a symbol that isn't here? Clone the BB repo",
  "// and read the real source: https://github.com/get-bb/bb",
].join("\n");

function generateBundle(entry) {
  return bundle(entry).then((code) =>
    normalizeBundledDts(`${HEADER}\n\n${code}`),
  );
}

// Each bundle builds its own TypeScript program, which is CPU-bound and
// single-threaded inside rollup-plugin-dts; the six large entries take 2–7s
// apiece. They are independent, so this file re-runs itself as a worker per
// entry. The pool is deliberately bounded because each rollup-plugin-dts
// program can consume substantial memory independently of Turbo concurrency.
const DTS_LOCK_TIMEOUT_SECONDS = 900;
const DTS_RUNTIME_MAX = "30min";
const STANDARD_LINUX_COMMAND_DIRS = ["/usr/bin", "/bin"];

function readSelfCgroup() {
  if (process.platform !== "linux") return "";
  try {
    return readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return "";
  }
}

function resolveExecutable(command) {
  // Provider shells can replace PATH. Search it first, then the standard Linux
  // directories. Verify every result instead of trusting fixed /usr/bin paths.
  const directories = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    ...STANDARD_LINUX_COMMAND_DIRS,
  ].filter(Boolean);
  for (const directory of new Set(directories)) {
    const candidate = path.join(directory, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue to the next candidate.
    }
  }
  throw new Error(
    `Required DTS isolation command "${command}" is not executable. ` +
      `Checked PATH and ${STANDARD_LINUX_COMMAND_DIRS.join(", ")}.`,
  );
}

function getDtsSliceState() {
  if (process.platform !== "linux") {
    return {
      loaded: false,
      detail: "not Linux",
      systemctlPath: null,
    };
  }
  let systemctlPath;
  try {
    systemctlPath = resolveExecutable("systemctl");
  } catch (error) {
    return {
      loaded: false,
      detail: error instanceof Error ? error.message : String(error),
      systemctlPath: null,
    };
  }
  const result = spawnSync(
    systemctlPath,
    ["--user", "show", BB_DTS_SLICE, "--property=LoadState", "--value"],
    { encoding: "utf8" },
  );
  return {
    loaded: result.status === 0 && result.stdout.trim() === "loaded",
    detail:
      result.error?.message ||
      result.stderr?.trim() ||
      result.stdout?.trim() ||
      `systemctl exited ${result.status ?? "without a status"}`,
    systemctlPath,
  };
}

function getDtsLockPath() {
  const runtimeDir =
    process.env.XDG_RUNTIME_DIR ||
    (typeof process.getuid === "function"
      ? `/run/user/${process.getuid()}`
      : null);
  if (!runtimeDir) {
    throw new Error(
      "Cannot determine the per-user runtime directory for the DTS build lock",
    );
  }
  try {
    accessSync(runtimeDir, fsConstants.W_OK | fsConstants.X_OK);
  } catch (error) {
    throw new Error(
      `Cannot write the DTS build lock in ${runtimeDir}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return path.join(runtimeDir, "bb-dts-build.lock");
}

async function runInDtsScope(maxWorkers, systemctlPath) {
  const scope = `bb-dts-${process.pid}-${Date.now()}.scope`;
  const flockPath = resolveExecutable("flock");
  const systemdRunPath = resolveExecutable("systemd-run");
  const childEnv = { ...process.env };
  // A legacy preload used this variable as a recursion guard. Do not carry a
  // caller-provided value into the authoritative cgroup-based implementation.
  delete childEnv.BB_DTS_ISOLATED;
  const child = spawn(
    flockPath,
    [
      "--exclusive",
      "--no-fork",
      "--timeout",
      String(DTS_LOCK_TIMEOUT_SECONDS),
      "--conflict-exit-code",
      "75",
      getDtsLockPath(),
      systemdRunPath,
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "--same-dir",
      `--slice=${BB_DTS_SLICE}`,
      `--unit=${scope}`,
      `--property=RuntimeMaxSec=${DTS_RUNTIME_MAX}`,
      `--setenv=${BB_DTS_REEXEC}=1`,
      `--setenv=${BB_DTS_MAX_WORKERS}=${maxWorkers}`,
      process.execPath,
      ...process.execArgv,
      ...process.argv.slice(1),
    ],
    { cwd: process.cwd(), env: childEnv, stdio: "inherit" },
  );

  let interruptedExitCode = null;
  const terminateScope = (signal, exitCode) => {
    if (interruptedExitCode !== null) return;
    interruptedExitCode = exitCode;
    child.kill(signal);
    spawnSync(
      systemctlPath,
      ["--user", "kill", `--signal=${signal}`, "--kill-who=all", scope],
      { stdio: "ignore" },
    );
    spawnSync(systemctlPath, ["--user", "stop", scope], {
      stdio: "ignore",
    });
  };
  const onSighup = () => terminateScope("SIGHUP", 129);
  const onSigint = () => terminateScope("SIGINT", 130);
  const onSigterm = () => terminateScope("SIGTERM", 143);
  process.once("SIGHUP", onSighup);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    process.off("SIGHUP", onSighup);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }

  if (interruptedExitCode !== null) {
    process.exitCode = interruptedExitCode;
    return;
  }
  if (result.code === null) {
    throw new Error(
      `DTS scope ${scope} terminated without an exit status (${result.signal ?? "unknown signal"})`,
    );
  }
  if (result.code === 75) {
    console.error(
      `Timed out after ${DTS_LOCK_TIMEOUT_SECONDS}s waiting for another bundled-DTS build`,
    );
  }
  if (result.code !== 0) {
    console.error(
      `[build-bundled-dts] isolated scope ${scope} failed with exit ${result.code}`,
    );
  }
  process.exitCode = result.code;
}

if (!isMainThread) {
  parentPort.postMessage(await generateBundle(workerData.entry));
} else {
  await main();
}

async function main() {
  const workerConfiguration = resolveWorkerConfiguration({
    args: process.argv.slice(2),
    envValue: process.env[BB_DTS_MAX_WORKERS],
    availableCpuCount: availableParallelism(),
    outputCount: Object.keys(outputs).length,
  });
  const cgroup = readSelfCgroup();
  const alreadyIsolated = isInCgroupUnit(cgroup, BB_DTS_SLICE);
  const reexecMarker = process.env[BB_DTS_REEXEC] === "1";
  const sliceState =
    process.platform === "linux" && !alreadyIsolated && !reexecMarker
      ? getDtsSliceState()
      : { loaded: false, detail: "not checked", systemctlPath: null };
  const isolation = decideIsolation({
    platform: process.platform,
    cgroup,
    reexecMarker,
    sliceLoaded: sliceState.loaded,
    sliceDetail: sliceState.detail,
  });
  if (isolation.kind === "fail") throw new Error(isolation.message);
  if (isolation.kind === "reexec") {
    if (!sliceState.systemctlPath) {
      throw new Error(`Cannot enter ${BB_DTS_SLICE}: systemctl is unavailable`);
    }
    await runInDtsScope(
      workerConfiguration.requested,
      sliceState.systemctlPath,
    );
    return;
  }
  if (isolation.warning) {
    console.warn(`[build-bundled-dts] warning: ${isolation.warning}`);
  }

  const cgroupPath = isolation.cgroupPath || primaryCgroupPath(cgroup);
  console.log(
    `[build-bundled-dts] workers=${workerConfiguration.effective} ` +
      `pid=${process.pid} isolation=${isolation.isolated ? "active" : "inactive"} ` +
      `cgroup=${cgroupPath || "unavailable"}`,
  );
  const generated = await runWorkerPool({
    entries: Object.entries(outputs),
    workerCount: workerConfiguration.effective,
    createJob: createWorkerJob,
  });
  // Keep the declared order so a diff of the outputs stays readable.
  writeOutputs(
    Object.fromEntries(
      Object.keys(outputs).map((fileName) => [fileName, generated[fileName]]),
    ),
  );
}

function createWorkerJob(entry) {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { entry },
  });
  const result = new Promise((resolve, reject) => {
    let received = false;
    let content;
    worker.once("message", (message) => {
      received = true;
      content = message;
    });
    worker.once("messageerror", reject);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`bundle worker exited with ${code}`));
      } else if (!received) {
        reject(new Error("bundle worker exited without a declaration result"));
      } else {
        resolve(content);
      }
    });
  });
  return { result, terminate: () => worker.terminate() };
}

function writeOutputs(generated) {
  mkdirSync(outDir, { recursive: true });

  for (const [fileName, content] of Object.entries(generated)) {
    const target = path.join(outDir, fileName);
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (current === content) {
      console.log(`Unchanged ${path.relative(pkgRoot, target)}`);
    } else {
      writeAtomically(target, content);
      console.log(`Wrote ${path.relative(pkgRoot, target)}`);
    }
  }
}

/**
 * Temp sibling + rename, so a concurrent reader (another turbo process, tsc
 * in an editor) never sees a truncated declaration file.
 */
function writeAtomically(target, content) {
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
