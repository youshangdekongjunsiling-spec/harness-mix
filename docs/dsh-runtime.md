# Dedicated DSH runtime

The locally installed DSH 0.1.2-rc.1 failed immediately after announcing its Web Remote URL: `user patch-layer watching requires the Cordis HMR service`. Enabling that service then failed with `hmr.registerConfig is not a function`. Its caret-ranged DSH dependencies and older HMR package did not form a working runtime on this installation.

The dedicated runtime manifest and lockfile in `config/dsh-runtime/` pin the tested official DSH 0.2.0-rc.2 dependency tree. This release uses `@deepseek-ai/dsh-hmr` and exact DSH component versions. It does not change Harness Mix's Claude runtime or user authentication settings.

Install independently from the repository root:

```powershell
npm ci --prefix config/dsh-runtime --ignore-scripts --no-audit --no-fund
$env:HARNESS_MIX_DSH_ROOT = (Resolve-Path config/dsh-runtime).Path
```

Set the same environment variable in the external Harness Mix launcher before starting or restarting it. The runtime root must contain this manifest's `dsh` npm script and its installed `node_modules`. Keep `--no-update` when running a locally patched Harness Mix fork. Do not launch a restart from inside an active Codex task.

For the repaired local installation, the runtime is in the installation directory's `dsh-runtime` folder; Start, Restart and Check launchers now select that folder. The previous runtime is retained.

Validation uses the existing DshWebHost adapter to start Web Remote, complete authentication, read `session/modelCatalog`, and release the child process. No model message or test conversation is needed. Restart the existing Harness Mix Host to pick up the changed launcher environment; a successful isolated smoke does not mean an already-running Host has switched runtime.
