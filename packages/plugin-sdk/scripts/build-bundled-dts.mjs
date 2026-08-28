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
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
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
const DEFAULT_MAX_WORKERS = 1;
const HARD_MAX_WORKERS = 2;
const DTS_MAX_WORKERS_ENV = "BB_DTS_MAX_WORKERS";
const DTS_SLICE = "bb-dts.slice";
const BB_SERVICE = "bb-jsl.service";
const DTS_LOCK_TIMEOUT_SECONDS = 900;
const DTS_RUNTIME_MAX = "30min";

function resolveMaxWorkers() {
  const raw = process.env[DTS_MAX_WORKERS_ENV];
  if (raw === undefined || raw === "") return DEFAULT_MAX_WORKERS;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${DTS_MAX_WORKERS_ENV} must be a positive integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > HARD_MAX_WORKERS) {
    throw new Error(
      `${DTS_MAX_WORKERS_ENV} must be between 1 and ${HARD_MAX_WORKERS}`,
    );
  }
  return parsed;
}

function readSelfCgroup() {
  if (process.platform !== "linux") return "";
  try {
    return readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return "";
  }
}

function isInCgroupUnit(cgroup, unit) {
  return cgroup.split("\n").some((line) => {
    const cgroupPath = line.slice(line.lastIndexOf(":") + 1);
    return cgroupPath.split("/").includes(unit);
  });
}

function getDtsSliceState() {
  if (process.platform !== "linux") {
    return { available: false, loaded: false, detail: "not Linux" };
  }
  const result = spawnSync(
    "/usr/bin/systemctl",
    ["--user", "show", DTS_SLICE, "--property=LoadState", "--value"],
    { encoding: "utf8" },
  );
  return {
    available: result.status === 0,
    loaded: result.status === 0 && result.stdout.trim() === "loaded",
    detail:
      result.error?.message ??
      result.stderr?.trim() ??
      result.stdout?.trim() ??
      `systemctl exited ${result.status ?? "without a status"}`,
  };
}

function getDtsLockPath() {
  const runtimeDir =
    process.env.XDG_RUNTIME_DIR ??
    (typeof process.getuid === "function"
      ? `/run/user/${process.getuid()}`
      : null);
  if (!runtimeDir) {
    throw new Error(
      "Cannot determine the per-user runtime directory for the DTS build lock",
    );
  }
  return path.join(runtimeDir, "bb-dts-build.lock");
}

async function runInDtsScope(maxWorkers) {
  const scope = `bb-dts-${process.pid}-${Date.now()}.scope`;
  const childEnv = { ...process.env };
  // A legacy preload used this variable as a recursion guard. Do not carry a
  // caller-provided value into the authoritative cgroup-based implementation.
  delete childEnv.BB_DTS_ISOLATED;
  const child = spawn(
    "/usr/bin/flock",
    [
      "--exclusive",
      "--timeout",
      String(DTS_LOCK_TIMEOUT_SECONDS),
      "--conflict-exit-code",
      "75",
      getDtsLockPath(),
      "/usr/bin/systemd-run",
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      `--slice=${DTS_SLICE}`,
      `--unit=${scope}`,
      `--property=RuntimeMaxSec=${DTS_RUNTIME_MAX}`,
      "/usr/bin/env",
      `${DTS_MAX_WORKERS_ENV}=${maxWorkers}`,
      process.execPath,
      ...process.execArgv,
      ...process.argv.slice(1),
    ],
    { cwd: process.cwd(), env: childEnv, stdio: "inherit" },
  );

  let interruptedExitCode = null;
  const terminateScope = (exitCode) => {
    if (interruptedExitCode !== null) return;
    interruptedExitCode = exitCode;
    child.kill("SIGTERM");
    spawnSync("/usr/bin/systemctl", ["--user", "stop", scope], {
      stdio: "ignore",
    });
  };
  const onSighup = () => terminateScope(129);
  const onSigint = () => terminateScope(130);
  const onSigterm = () => terminateScope(143);
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
    throw new Error(
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
  const maxWorkers = resolveMaxWorkers();
  const cgroup = readSelfCgroup();
  const isolated = isInCgroupUnit(cgroup, DTS_SLICE);
  if (!isolated) {
    const sliceState = getDtsSliceState();
    if (sliceState.loaded) {
      await runInDtsScope(maxWorkers);
      return;
    }
    if (isInCgroupUnit(cgroup, BB_SERVICE)) {
      throw new Error(
        `Refusing to build bundled declarations inside ${BB_SERVICE}: ` +
          `${DTS_SLICE} is unavailable (${sliceState.detail})`,
      );
    }
  }

  const generated = {};
  const queue = Object.entries(outputs);
  const workers = Math.min(queue.length, availableParallelism(), maxWorkers);
  console.log(
    `[build-bundled-dts] workers=${workers} isolated=${isolated} pid=${process.pid}`,
  );
  const activeWorkers = new Set();
  try {
    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          const [fileName, entry] = next;
          generated[fileName] = await generateInWorker(entry, activeWorkers);
        }
      }),
    );
  } catch (error) {
    await Promise.allSettled(
      Array.from(activeWorkers, (worker) => worker.terminate()),
    );
    throw error;
  }
  // Keep the declared order so a diff of the outputs stays readable.
  writeOutputs(
    Object.fromEntries(
      Object.keys(outputs).map((fileName) => [fileName, generated[fileName]]),
    ),
  );
}

function generateInWorker(entry, activeWorkers) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { entry },
    });
    let result;
    let receivedResult = false;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    activeWorkers.add(worker);
    worker.once("message", (value) => {
      result = value;
      receivedResult = true;
    });
    worker.once("error", fail);
    worker.once("exit", (code) => {
      activeWorkers.delete(worker);
      if (code !== 0) {
        fail(new Error(`bundle worker exited with ${code}`));
      } else if (!receivedResult) {
        fail(new Error("bundle worker exited without returning a result"));
      } else if (!settled) {
        settled = true;
        resolve(result);
      }
    });
  });
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
