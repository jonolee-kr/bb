import { describe, expect, it, vi } from "vitest";

import {
  BB_DTS_SLICE,
  BB_SERVICE,
  decideIsolation,
  isInCgroupUnit,
  parseMaxWorkers,
  resolveWorkerConfiguration,
  runWorkerPool,
} from "./build-bundled-dts-support.mjs";

const serviceCgroup = `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${BB_SERVICE}\n`;
const dtsCgroup = `0::/user.slice/user-1000.slice/user@1000.service/bb.slice/${BB_DTS_SLICE}/bb-dts-1.scope\n`;

describe("bundled DTS worker configuration", () => {
  it.each(["1", "2", "64"])("accepts %s workers", (value) => {
    expect(parseMaxWorkers(value, "test")).toBe(Number(value));
  });

  it.each(["", "0", "-1", "1.5", "many", "65"])(
    "rejects invalid worker value %s",
    (value) => {
      expect(() => parseMaxWorkers(value, "test")).toThrow(
        "must be an integer from 1 through 64",
      );
    },
  );

  it("defaults to two workers on a large host", () => {
    expect(
      resolveWorkerConfiguration({
        args: [],
        envValue: undefined,
        availableCpuCount: 16,
        outputCount: 15,
      }),
    ).toMatchObject({ effective: 2, requested: 2, source: "default" });
  });

  it("caps the effective workers by CPU and declaration counts", () => {
    expect(
      resolveWorkerConfiguration({
        args: ["--max-workers=64"],
        envValue: undefined,
        availableCpuCount: 16,
        outputCount: 3,
      }).effective,
    ).toBe(3);
    expect(
      resolveWorkerConfiguration({
        args: [],
        envValue: undefined,
        availableCpuCount: 1,
        outputCount: 15,
      }).effective,
    ).toBe(1);
  });

  it("uses the CLI option before the environment value", () => {
    expect(
      resolveWorkerConfiguration({
        args: ["--max-workers", "3"],
        envValue: "not-an-integer",
        availableCpuCount: 16,
        outputCount: 15,
      }),
    ).toMatchObject({ effective: 3, requested: 3, source: "--max-workers" });
  });

  it("rejects a missing CLI option value", () => {
    expect(() =>
      resolveWorkerConfiguration({
        args: ["--max-workers"],
        envValue: undefined,
        availableCpuCount: 16,
        outputCount: 15,
      }),
    ).toThrow("must be an integer from 1 through 64");
  });

  it("rejects an invalid worker value before a worker can start", () => {
    const createJob = vi.fn();
    expect(() =>
      resolveWorkerConfiguration({
        args: ["--max-workers=0"],
        envValue: undefined,
        availableCpuCount: 16,
        outputCount: 15,
      }),
    ).toThrow("must be an integer from 1 through 64");
    expect(createJob).not.toHaveBeenCalled();
  });
});

describe("bundled DTS worker failure", () => {
  it("terminates active siblings and preserves the first failure", async () => {
    const firstFailure = new Error("first worker failed");
    let rejectSibling;
    const terminateSibling = vi.fn(() => {
      rejectSibling(new Error("sibling terminated"));
      return Promise.resolve(1);
    });
    const createJob = vi.fn((entry) => {
      if (entry === "fail") {
        return {
          result: Promise.reject(firstFailure),
          terminate: vi.fn(),
        };
      }
      return {
        result: new Promise((_, reject) => {
          rejectSibling = reject;
        }),
        terminate: terminateSibling,
      };
    });

    await expect(
      runWorkerPool({
        entries: [
          ["first.d.ts", "fail"],
          ["second.d.ts", "wait"],
          ["third.d.ts", "must-not-start"],
        ],
        workerCount: 2,
        createJob,
      }),
    ).rejects.toBe(firstFailure);
    expect(terminateSibling).toHaveBeenCalledOnce();
    expect(createJob).toHaveBeenCalledTimes(2);
  });
});

describe("bundled DTS isolation policy", () => {
  it("reads the cgroup v2 path and recognizes exact units", () => {
    expect(isInCgroupUnit(dtsCgroup, BB_DTS_SLICE)).toBe(true);
    expect(isInCgroupUnit(serviceCgroup, BB_DTS_SLICE)).toBe(false);
  });

  it("prevents a second re-exec when the marker lacks live isolation", () => {
    expect(
      decideIsolation({
        platform: "linux",
        cgroup: serviceCgroup,
        reexecMarker: true,
        sliceLoaded: true,
        sliceDetail: "loaded",
      }),
    ).toMatchObject({ kind: "fail" });
  });

  it("runs after the marker and live cgroup both prove isolation", () => {
    expect(
      decideIsolation({
        platform: "linux",
        cgroup: dtsCgroup,
        reexecMarker: true,
        sliceLoaded: true,
        sliceDetail: "loaded",
      }),
    ).toMatchObject({ kind: "run", isolated: true });
  });

  it("fails closed inside the BB service when the slice is unavailable", () => {
    expect(
      decideIsolation({
        platform: "linux",
        cgroup: serviceCgroup,
        reexecMarker: false,
        sliceLoaded: false,
        sliceDetail: "not found",
      }),
    ).toMatchObject({ kind: "fail" });
  });

  it("uses bounded fallback outside the BB service", () => {
    expect(
      decideIsolation({
        platform: "linux",
        cgroup: "0::/user.slice/user-1000.slice/session-1.scope\n",
        reexecMarker: false,
        sliceLoaded: false,
        sliceDetail: "not found",
      }),
    ).toMatchObject({ kind: "run", isolated: false });
    expect(
      decideIsolation({
        platform: "darwin",
        cgroup: "",
        reexecMarker: false,
        sliceLoaded: false,
        sliceDetail: "not Linux",
      }),
    ).toMatchObject({ kind: "run", isolated: false });
  });

  it("requests re-exec when the slice is loaded", () => {
    expect(
      decideIsolation({
        platform: "linux",
        cgroup: serviceCgroup,
        reexecMarker: false,
        sliceLoaded: true,
        sliceDetail: "loaded",
      }),
    ).toEqual({ kind: "reexec" });
  });
});
