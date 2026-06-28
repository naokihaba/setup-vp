# RFC: setup-vp GitLab CI/CD Remote Template

## Summary

This RFC proposes a GitLab CI/CD remote template for `voidzero-dev/setup-vp`.
The template lets GitLab users install Vite+, set up Node.js through
`vp env use`, configure registry auth, and optionally run `vp install` while
keeping the source of truth in this GitHub repository.

The template is published as a plain YAML file plus two runtime files:

```text
gitlab/setup-vp.yml
gitlab/bootstrap.sh
gitlab/setup-vp.mjs
```

GitLab users load it with `include:remote`:

```yaml
include:
  - remote: "https://raw.githubusercontent.com/voidzero-dev/setup-vp/v1/gitlab/setup-vp.yml"

test:
  extends: .setup-vp
  image: node:24
  script:
    - vp run test
```

## Motivation

`setup-vp` is currently a GitHub Action. Its TypeScript implementation depends
on the GitHub Actions runtime, including action inputs, path management, state,
outputs, and post-action cache behavior. GitLab CI/CD cannot execute that action
directly with equivalent semantics.

The goal is to provide a GitLab-native entry point without creating a separate
GitLab project or mirror. GitLab supports remote YAML includes, so a template
hosted from GitHub can be reused directly by GitLab pipelines.

Relevant GitLab documentation:

- https://docs.gitlab.com/ci/yaml/#includeremote
- https://docs.gitlab.com/ci/yaml/#includeinputs
- https://docs.gitlab.com/ci/yaml/#includeintegrity
- https://docs.gitlab.com/ci/caching/
- https://docs.gitlab.com/ci/migration/github_actions/

## Goals

1. Provide a GitLab CI/CD template from this GitHub repository only.
2. Support `include:remote` with `spec:inputs`.
3. Keep GitLab input names as close as possible to the GitHub Action inputs.
4. Install Vite+ from the official installer with retry and fallback URLs.
5. Support `node-version` and `node-version-file`.
6. Support the default `run-install: true` experience and advanced
   `run-install` entries with `cwd` and `args`.
7. Support private registry auth through `registry-url`, `scope`, and
   `NODE_AUTH_TOKEN`.
8. Support `sfw: true` for `vp install`.
9. Avoid requiring users to provide Node.js before setup starts.
10. Document where GitLab behavior cannot match GitHub Actions.

## Non-Goals

1. Do not create or require a GitLab project.
2. Do not publish a GitLab CI/CD component.
3. Do not use `include:component` for the initial design.
4. Do not run the GitHub Action bundle (`dist/index.mjs`) inside GitLab.
5. Do not implement GitHub Actions cache semantics inside the GitLab template.
6. Do not provide Windows runner support in the initial template.

## Design

### Distribution Model

The template is stored in this repository and referenced by raw GitHub URL.

```yaml
include:
  - remote: "https://raw.githubusercontent.com/voidzero-dev/setup-vp/v1/gitlab/setup-vp.yml"
```

Consumers should pin a tag or commit instead of `main`. GitLab 17.9+ users can
also use `include:integrity` when they want to pin the remote file hash.

```yaml
include:
  - remote: "https://raw.githubusercontent.com/voidzero-dev/setup-vp/v1.0.0/gitlab/setup-vp.yml"
    integrity: "sha256-..."
    inputs:
      node-version: "22"
```

`include:component` is intentionally not used. It is designed for GitLab CI/CD
components resolved from a GitLab component project, which conflicts with the
"GitHub repository only" constraint.

### Template Shape

`gitlab/setup-vp.yml` defines two YAML documents and intentionally stays thin:

1. `spec:inputs` for GitLab include inputs.
2. A hidden `.setup-vp` job that exports inputs, downloads `bootstrap.sh`, and
   executes it.

```yaml
spec:
  inputs:
    version:
      default: "latest"
    node-version:
      default: "lts"
    node-version-file:
      default: ""
    working-directory:
      default: "."
    run-install:
      default: "true"
    sfw:
      type: boolean
      default: false
    registry-url:
      default: ""
    scope:
      default: ""
    setup-ref:
      default: "v1"
---
.setup-vp:
  before_script:
    - |
      # export inputs, download bootstrap.sh, and execute it
```

### Bootstrap And Runtime

Implementation logic is split to keep shell small:

- `gitlab/setup-vp.yml` handles GitLab inputs and downloads `bootstrap.sh`.
- `gitlab/bootstrap.sh` installs Vite+, runs `vp env use <node-version>` to
  ensure the runtime starts with the requested bootstrap Node, downloads
  `setup-vp.mjs`, and runs it.
- `gitlab/setup-vp.mjs` handles maintainable logic: node-version-file parsing,
  registry auth, `sfw`, `run-install` parsing, install execution, and final
  version output.

This avoids requiring users to choose a Node image before using setup-vp.
Bootstrap installs Vite+ first and uses `vp env use <node-version>` to make
enough requested Node available to run `setup-vp.mjs`, even when the runner
image already contains an older `node` binary. When `node-version-file` later
resolves to a different version, the Node runtime runs `vp env use` again with
the final version.

Remote includes do not provide a portable way for the included YAML to discover
the exact Git ref used in the `include:remote` URL. For that reason the template
has a `setup-ref` input. The default points at `v1`, and users who need strict
reproducibility should pass the same tag or commit SHA as the template include.

```yaml
include:
  - remote: "https://raw.githubusercontent.com/voidzero-dev/setup-vp/v1.0.0/gitlab/setup-vp.yml"
    inputs:
      setup-ref: "v1.0.0"
```

### Execution Flow

The hidden job runs in `before_script` so that the user's `script` can assume
`vp` is available.

1. Export GitLab inputs into `SETUP_VP_*` environment variables.
2. Download and execute `bootstrap.sh` from `setup-ref`.
3. Install Vite+ from `https://viteplus.dev/install.sh`.
4. Fall back to the raw GitHub installer if the primary installer fails.
5. Add `~/.vite-plus/bin` to `PATH`.
6. Install bootstrap Node with `vp env use <node-version>` before starting the
   Node runtime.
7. Download and execute `setup-vp.mjs` from `setup-ref`.
8. Resolve `working-directory`.
9. Resolve `node-version-file` when provided.
10. Run `vp env use <resolved version>` when a Node.js version is available.
11. Configure temporary npm auth when `registry-url` is set.
12. Install or detect `sfw` when `sfw: true`.
13. Run `vp install` when `run-install` is enabled.
14. Print `vp --version`.

### Node.js Version Resolution

`node-version` defaults to `lts`, matching the GitHub Action experience.

```yaml
include:
  - remote: "https://raw.githubusercontent.com/voidzero-dev/setup-vp/v1/gitlab/setup-vp.yml"
    inputs:
      node-version: "lts"
```

`node-version-file` takes precedence when specified:

```yaml
include:
  - remote: "https://raw.githubusercontent.com/voidzero-dev/setup-vp/v1/gitlab/setup-vp.yml"
    inputs:
      node-version-file: ".node-version"
```

Supported files:

- `.nvmrc`
- `.node-version`
- `.tool-versions`
- `package.json`

For `package.json`, the Node runtime reads `devEngines.runtime` for a `node` entry
first, then falls back to `engines.node`, matching the GitHub Action logic.

There is one GitLab-specific caveat: because `spec:inputs` applies the
`node-version` default before the shell sees it, the template cannot distinguish
"the user omitted `node-version`" from "the user explicitly set `node-version:
lts`". The chosen behavior is simple: if `node-version-file` is set, the file
wins; otherwise `node-version` wins.

### Run Install

The default matches GitHub Actions:

```yaml
run-install: "true"
```

The GitLab template also supports multiple install entries:

```yaml
include:
  - remote: "https://raw.githubusercontent.com/voidzero-dev/setup-vp/v1/gitlab/setup-vp.yml"
    inputs:
      run-install: |
        - cwd: ./packages/app
          args: ['--frozen-lockfile']
        - cwd: ./packages/lib

test:
  extends: .setup-vp
  image: node:24
  script:
    - vp run test
```

This is intentionally modeled after the GitHub Action's structured
`run-install` input rather than adding a separate `install-args` input. Keeping
one input avoids diverging user experience between GitHub and GitLab.

### Socket Firewall Free

`sfw: true` wraps install commands as `sfw vp install ...`.

```yaml
include:
  - remote: "https://raw.githubusercontent.com/voidzero-dev/setup-vp/v1/gitlab/setup-vp.yml"
    inputs:
      sfw: true
      run-install: "true"
```

If `sfw` is already on `PATH`, the template reuses it. Otherwise it downloads a
pinned `sfw-free` release for Linux or macOS when a matching binary exists. If
the runner architecture is unsupported, the template logs a warning and falls
back to plain `vp install`.

## Public API

| Input               | Default  | Description                                                                   |
| ------------------- | -------- | ----------------------------------------------------------------------------- |
| `version`           | `latest` | Version of Vite+ to install.                                                  |
| `node-version`      | `lts`    | Node.js version to install via `vp env use`.                                  |
| `node-version-file` |          | Path to `.nvmrc`, `.node-version`, `.tool-versions`, or `package.json`.       |
| `working-directory` | `.`      | Project directory used for relative paths and default `vp install` execution. |
| `run-install`       | `true`   | Run `vp install`; accepts boolean or YAML object/array with `cwd` and `args`. |
| `sfw`               | `false`  | Wrap `vp install` with Socket Firewall Free.                                  |
| `registry-url`      |          | Optional registry URL to write to a temporary `.npmrc`.                       |
| `scope`             |          | Optional scope for authenticating against scoped registries.                  |
| `setup-ref`         | `v1`     | Ref used to download `bootstrap.sh` and `setup-vp.mjs`.                       |

## GitHub Action Parity

| Capability              | GitHub Action | GitLab template | Notes                                        |
| ----------------------- | ------------- | --------------- | -------------------------------------------- |
| Install Vite+           | Yes           | Yes             | GitLab uses shell in `before_script`.        |
| `node-version`          | Yes           | Yes             | Default is `lts` in both.                    |
| `node-version-file`     | Yes           | Yes             | Includes `package.json`.                     |
| `working-directory`     | Yes           | Yes             | Used for relative paths and default install. |
| `run-install`           | Yes           | Yes             | Structured `cwd` and `args` are supported.   |
| `registry-url`          | Yes           | Yes             | GitLab requires `NODE_AUTH_TOKEN` variable.  |
| `scope`                 | Yes           | Yes             | Same input name.                             |
| `sfw`                   | Yes           | Yes             | GitLab supports Unix-like runners only.      |
| `cache`                 | Yes           | No              | GitLab cache is job-level YAML behavior.     |
| `cache-dependency-path` | Yes           | No              | See cache section below.                     |

## Cache Design

The GitLab template does not expose `cache` or `cache-dependency-path` inputs.
This is an intentional difference.

The GitHub Action restores cache during the action's main phase and saves cache
during the action's post phase. GitLab cache is configured as a job keyword and
is restored by the runner before `before_script` starts. A remote template
running shell commands inside `before_script` cannot compute dynamic cache paths
and then ask GitLab to restore those paths for the same job.

GitLab users should configure `cache:` on their jobs directly:

```yaml
test:
  extends: .setup-vp
  image: node:24
  cache:
    key:
      files:
        - pnpm-lock.yaml
    paths:
      - .pnpm-store/
  script:
    - vp run test
```

Follow-up cache work should happen separately after deciding whether Vite+ should
support a stable project-local package manager cache directory for GitLab.

## Security

Remote includes execute as CI configuration, so examples should recommend
pinning:

- Prefer `v1`, an immutable version tag such as `v1.0.0`, or a commit SHA.
- Avoid `main` in production pipelines.
- Use `include:integrity` where available for stricter remote file validation.
- Pin `setup-ref` to the same immutable tag or commit SHA when strict
  reproducibility is required. `include:integrity` validates the included YAML,
  not the bootstrap or Node runtime downloaded by that YAML.

The template downloads installers and optional `sfw` binaries at runtime. The
downloaded `sfw` version is pinned in the template for reproducibility. Users
who need stronger supply-chain guarantees can install a SHA-pinned `sfw` binary
before extending `.setup-vp`; the template will reuse `sfw` from `PATH`.

## Rollout

1. Add `gitlab/setup-vp.yml`.
2. Add `gitlab/bootstrap.sh`.
3. Add `gitlab/setup-vp.mjs`.
4. Add this RFC under `rfcs/`.
5. Document GitLab usage in `README.md`.
6. Validate YAML parsing and shell/Node syntax locally.
7. Validate the remote include through GitLab CI Lint before release.
8. Release under `v1` and an immutable semver tag.
