# Provisioning the Windows GitLab runner

Windows verification is required (`docs/m0-decisions.md`, decision 5). The job definition
(`windows-gate` in `.gitlab-ci.yml`) is written and maintained; it runs as soon as a runner
carrying the configured tag is registered.

## Why Windows is not optional

A Linux-only gate structurally cannot see the defects this project has already hit on Windows:

| Defect class | Why Linux cannot catch it |
| --- | --- |
| CRLF rewriting of frozen bytes | Git's `core.autocrlf` rewrites LF to CRLF on Windows checkout, which invalidates the Prompt A checksum. `.gitattributes` marks the file `-text`; only a Windows checkout proves it held. |
| File locking during browser teardown | Windows refuses to delete a directory an exiting process still holds. A per-run temp directory raced with the exiting browser here; POSIX unlink semantics hide the whole class. |
| Path separators and drive letters | A path assumption that works on `/tmp` can fail on `C:\Users\...` with spaces in the name. This repository lives under such a path. |
| Chromium launch flakiness | The launch failure that produced 4 spurious infrastructure failures per 100 runs was observed on Windows (ADR-0025). |

## Requirements

| Item | Minimum |
| --- | --- |
| OS | Windows 10 22H2 / Windows 11 / Server 2022 |
| Shell | PowerShell 7+ (`pwsh`), not Windows PowerShell 5.1 |
| Node | 24 LTS |
| Git | 2.40+ |
| Disk | 10 GB free (Chromium, npm cache, artifacts) |
| RAM | 8 GB (the gate runs 100 sequential browser contexts) |

## Steps

### 1. Install the runner

```powershell
New-Item -ItemType Directory -Force -Path C:\GitLab-Runner
Invoke-WebRequest -Uri "https://gitlab-runner-downloads.s3.amazonaws.com/latest/binaries/gitlab-runner-windows-amd64.exe" -OutFile C:\GitLab-Runner\gitlab-runner.exe
```

### 2. Register it

Take the registration token from **Settings → CI/CD → Runners** in the project. Do not commit it
and do not paste it into a shared channel.

```powershell
cd C:\GitLab-Runner
.\gitlab-runner.exe register `
  --non-interactive `
  --url "https://hackathon.infoedge.com/" `
  --token "<PROJECT_RUNNER_TOKEN>" `
  --executor "shell" `
  --shell "pwsh" `
  --description "reproagent-windows" `
  --tag-list "windows,reproagent"
```

`--executor shell` is deliberate. The gate launches real Chromium processes; a Windows container
executor adds image-size and GPU-sandbox problems with no benefit for a single-tenant runner.

### 3. Install it as a service

```powershell
.\gitlab-runner.exe install --user "DOMAIN\runner-account" --password "<PASSWORD>"
.\gitlab-runner.exe start
```

Use a dedicated low-privilege local account. It needs: read/write on its own build directory, and
permission to launch processes. It must not be an administrator — the agent never requires
elevation, and a CI account that can elevate turns any dependency compromise into host
compromise.

### 4. Install the toolchain for that account

The `shell` executor runs as the service account, so the toolchain must exist for that account,
not for your interactive session.

```powershell
node --version    # expect v24.x
git --version
pwsh --version
```

### 5. Enable the job

Two project CI/CD variables:

| Variable | Value | Notes |
| --- | --- | --- |
| `WINDOWS_RUNNER_TAG` | `windows` | Must match a tag from `--tag-list` |
| `RUN_WINDOWS_GATE` | `true` | Gates the job; without it the job never runs |

`windows-gate` is opt-in by variable so that, with no Windows runner registered, the job does not
sit pending forever and block every pipeline. Once the runner exists, set `RUN_WINDOWS_GATE=true`
and it becomes a required part of the gate.

### 6. Verify

```powershell
cd C:\path\to\repo
npm ci
npm run build
npx playwright install chromium chromium-headless-shell
pwsh -File scripts/verify.ps1 -Gate
```

Expect `All stages passed.` and, inside it, the reliability gate passing **twice** with
`runs=100`, zero retries and zero infrastructure failures. Then push a commit and confirm
`windows-gate` runs green in the pipeline.

## Troubleshooting

**Job stays pending.** No runner carries `WINDOWS_RUNNER_TAG`. Check the tag matches exactly, and
that the runner shows online in the project's runner list.

**`pwsh` not recognised.** The runner was registered with `--shell powershell` (5.1) instead of
`pwsh`. Re-register, or edit `shell = "pwsh"` in `C:\GitLab-Runner\config.toml` and restart.

**Prompt A checksum fails on Windows only.** `.gitattributes` is not being honoured. Confirm it is
committed and that the runner's Git is 2.40+, then re-clone: a working copy checked out before
`.gitattributes` existed keeps its CRLF line endings.

**Chromium fails to launch as the service account.** The browser was installed for a different
user. `PLAYWRIGHT_BROWSERS_PATH` in `.gitlab-ci.yml` puts it inside the project directory; ensure
the service account can write there.

**Long-path errors.** Enable long paths:

```powershell
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1
git config --system core.longpaths true
```

**The gate is slower than the 60-minute Linux timeout.** `windows-gate` allows 90 minutes. If it
still exceeds that, record the measured numbers and renegotiate the budget in writing in the
`docs/FREEZE-M0.md` amendment log — never by quietly editing the assertion.
