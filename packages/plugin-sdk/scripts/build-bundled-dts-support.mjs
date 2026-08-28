export const BB_DTS_MAX_WORKERS = "BB_DTS_MAX_WORKERS";
export const BB_DTS_REEXEC = "BB_DTS_REEXEC";
export const BB_DTS_SLICE = "bb-dts.slice";
export const BB_SERVICE = "bb-jsl.service";
export const DEFAULT_MAX_WORKERS = 2;
export const MAX_WORKERS_LIMIT = 64;

export function parseMaxWorkers(value, source) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new Error(
      `${source} must be an integer from 1 through ${MAX_WORKERS_LIMIT}`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_WORKERS_LIMIT) {
    throw new Error(
      `${source} must be an integer from 1 through ${MAX_WORKERS_LIMIT}`,
    );
  }
  return parsed;
}

function readCliMaxWorkers(args) {
  let specified = false;
  let value;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    let candidate;
    if (argument === "--max-workers") {
      index += 1;
      candidate = args[index];
    } else if (argument.startsWith("--max-workers=")) {
      candidate = argument.slice("--max-workers=".length);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (specified) {
      throw new Error("--max-workers can only be specified once");
    }
    specified = true;
    value = candidate;
  }
  return { specified, value };
}

export function resolveWorkerConfiguration({
  args,
  envValue,
  availableCpuCount,
  outputCount,
}) {
  if (!Number.isInteger(availableCpuCount) || availableCpuCount < 1) {
    throw new Error("availableCpuCount must be a positive integer");
  }
  if (!Number.isInteger(outputCount) || outputCount < 1) {
    throw new Error("outputCount must be a positive integer");
  }

  const cli = readCliMaxWorkers(args);
  const source = cli.specified ? "--max-workers" : BB_DTS_MAX_WORKERS;
  const requested = cli.specified
    ? parseMaxWorkers(cli.value, source)
    : envValue === undefined
      ? DEFAULT_MAX_WORKERS
      : parseMaxWorkers(envValue, source);
  return {
    effective: Math.min(requested, availableCpuCount, outputCount),
    requested,
    source: !cli.specified && envValue === undefined ? "default" : source,
  };
}

export function readCgroupPaths(cgroup) {
  return cgroup
    .split("\n")
    .map((line) => {
      const firstColon = line.indexOf(":");
      const secondColon = line.indexOf(":", firstColon + 1);
      return secondColon === -1 ? "" : line.slice(secondColon + 1).trim();
    })
    .filter(Boolean);
}

export function primaryCgroupPath(cgroup) {
  const paths = readCgroupPaths(cgroup);
  return paths.find((cgroupPath) => cgroupPath.startsWith("/")) ?? "";
}

export function isInCgroupUnit(cgroup, unit) {
  return readCgroupPaths(cgroup).some((cgroupPath) =>
    cgroupPath.split("/").includes(unit),
  );
}

export function decideIsolation({
  platform,
  cgroup,
  reexecMarker,
  sliceLoaded,
  sliceDetail,
}) {
  const cgroupPath = primaryCgroupPath(cgroup);
  const isolated = isInCgroupUnit(cgroup, BB_DTS_SLICE);
  if (reexecMarker && !isolated) {
    return {
      kind: "fail",
      message:
        `${BB_DTS_REEXEC}=1 but the live cgroup path ` +
        `${cgroupPath || "is unavailable"} does not contain ${BB_DTS_SLICE}. ` +
        "Refusing a second re-exec.",
    };
  }
  if (isolated) {
    return { cgroupPath, isolated: true, kind: "run" };
  }
  if (platform !== "linux") {
    return {
      cgroupPath,
      isolated: false,
      kind: "run",
      warning: `resource isolation is inactive on ${platform}`,
    };
  }
  if (sliceLoaded) {
    return { kind: "reexec" };
  }
  if (isInCgroupUnit(cgroup, BB_SERVICE)) {
    return {
      kind: "fail",
      message:
        `Refusing to build bundled declarations inside ${BB_SERVICE}. ` +
        `${BB_DTS_SLICE} is unavailable (${sliceDetail}).`,
    };
  }
  return {
    cgroupPath,
    isolated: false,
    kind: "run",
    warning:
      `resource isolation is inactive because ${BB_DTS_SLICE} is unavailable ` +
      `(${sliceDetail})`,
  };
}

export async function runWorkerPool({ entries, workerCount, createJob }) {
  const queue = [...entries];
  const activeJobs = new Set();
  const generated = {};
  let failed = false;
  let firstFailure;

  const terminateSiblings = async (failedJob) => {
    const siblings = [...activeJobs].filter((job) => job !== failedJob);
    await Promise.allSettled(
      siblings.map((job) => Promise.resolve().then(() => job.terminate())),
    );
  };

  const runQueue = async () => {
    while (!failed) {
      const next = queue.shift();
      if (!next) return;
      const [fileName, entry] = next;
      let job;
      try {
        job = createJob(entry);
        activeJobs.add(job);
        const content = await job.result;
        if (!failed) generated[fileName] = content;
      } catch (error) {
        if (!failed) {
          failed = true;
          firstFailure = error;
          queue.length = 0;
          await terminateSiblings(job);
        }
      } finally {
        if (job) activeJobs.delete(job);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(workerCount, queue.length) }, runQueue),
  );
  if (failed) throw firstFailure;
  return generated;
}
