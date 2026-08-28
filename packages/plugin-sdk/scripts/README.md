# Bundled declaration build isolation

`build-bundled-dts.mjs` generates the 15 portable declaration bundles for
`@get-bb/plugin-sdk`. Each bundle creates a TypeScript program and can use
substantial memory.

## Selected design

The build uses two resource controls.

1. The internal worker pool limits concurrent declaration programs. The safe
   default is two workers.
2. On supported Linux hosts, the entrypoint re-executes through `systemd-run`
   in `bb-dts.slice`.

The internal limit is the primary control. The slice supplies aggregate memory,
CPU, task, swap, and runtime limits as defense in depth.

The package scripts pass `--max-workers=1` explicitly. This production setting
keeps one declaration program below the managed slice's memory high threshold.
A direct caller can use
`--max-workers N` or `BB_DTS_MAX_WORKERS=N`, where `N` is from 1 through 64.
The CLI option has precedence. The effective count cannot exceed the available
CPU count or the declaration output count.

## Isolation policy

The launcher reads `/proc/self/cgroup` and uses `BB_DTS_REEXEC=1` only as a
recursion marker. A marked process must also have `bb-dts.slice` in its live
cgroup path. Otherwise, the build fails without a second re-exec.

The launcher applies these platform rules.

- A Linux process with a loaded `bb-dts.slice` enters a unique transient scope.
- A Linux process inside `bb-jsl.service` fails when the slice is unavailable.
- A Linux process outside `bb-jsl.service` uses the bounded fallback when the
  slice is unavailable. It prints an isolation warning.
- A non-Linux process uses the bounded fallback and prints an isolation warning.
- A configured scope or command failure returns a nonzero status. The launcher
  does not start an unrestricted second copy.

The launcher serializes builds with `bb-dts-build.lock`. It uses
`XDG_RUNTIME_DIR`, or `/run/user/<uid>` when that variable is absent. The lock
wait is 15 minutes. Each transient scope has a 30-minute runtime limit.

The launcher does not trust fixed executable paths. It resolves `systemctl`,
`systemd-run`, and `flock` from `PATH`, `/usr/bin`, or `/bin`. It verifies that
each selected file is executable. `systemd-run --setenv` passes the marker, so
the launcher does not require `/usr/bin/env`.

The managed host configures `bb-dts.slice` with `PartOf=bb-jsl.service`.
Stopping the BB service therefore stops active DTS scopes. The slice currently
has a 3 GiB memory maximum and configures a one-core CPU quota. Those limits
belong to the host unit and are not worker-count inputs. The host must delegate
the cgroup v2 `cpu` controller for the configured CPU quota to reach the kernel.

## Alternatives

An internal limit alone is portable and prevents CPU-count fan-out. It cannot
move memory accounting outside the main BB service, so it is insufficient on
the managed host.

Direct self-isolation preserves the existing package entrypoint and does not
depend on `NODE_OPTIONS`, shell aliases, or provider environment inheritance.
This change selects that approach with the internal limit.

A provider job slice could contain arbitrary builds. The current runtime
expects each provider bridge as a direct piped child and owns its process
group. ACP agents are bridge descendants, while PTY terminals are separate
session leaders. A transparent `systemd-run` wrapper would change child
identity, pipe ownership, process-group cancellation, and PTY behavior. BB does
not currently provide that wrapper. A broader resource domain needs a separate
host-daemon design with provider IPC, terminal, cancellation, and descendant
ownership tests.

## Operational verification

Remove `NODE_OPTIONS` during verification. The startup line reports the
effective worker count, PID, isolation state, and live cgroup path.

```bash
env -u NODE_OPTIONS pnpm run build:types
systemctl --user show bb-jsl.service \
  -p MemoryCurrent -p MemoryHigh -p MemoryMax -p TasksCurrent
systemctl --user show bb-dts.slice \
  -p ControlGroup -p MemoryCurrent -p MemoryHigh -p MemoryMax -p TasksCurrent \
  -p CPUQuotaPerSecUSec
ps -o pid,ppid,rss,pcpu,nlwp,args -C node
cat /proc/<dts-pid>/cgroup
cat /sys/fs/cgroup/<bb-dts-control-group>/memory.max
cat /sys/fs/cgroup/<bb-dts-control-group>/cpu.max
```

The live DTS PID must have `bb-dts.slice` in its cgroup path. Unit properties
or environment variables alone do not prove isolation. A missing `cpu.max`
means the user manager cannot enforce the configured CPU quota.
