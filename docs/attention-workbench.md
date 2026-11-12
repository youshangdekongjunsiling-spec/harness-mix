# Attention Workbench staged launch

This worktree contains the staged Attention Workbench implementation. `Start-Attention-Workbench.cmd` launches the worktree `scripts/launch-codex.cjs --no-update --restart` while preserving the existing trial environment:

- Claude command: `C:\Users\yuanh\Documents\家用\99-工具\harness-mix\claude-runtime\node_modules\@anthropic-ai\claude-code\bin\claude.exe`
- PATH prefix: `C:\Users\yuanh\Documents\家用\99-工具\harness-mix\bin`
- DeepSeek root: `C:\Users\yuanh\Documents\家用\99-工具\harness-mix\dsh-runtime`
- Data directory: `%LOCALAPPDATA%\Harness Mix\trial-data`
- Automatic updates: disabled

The launcher visibly warns that Codex Desktop will restart. Save active work first. Rollback is reversible: close the staged run and launch the unchanged `C:\Users\yuanh\Documents\家用\99-工具\harness-mix\Start-Harness-Mix-Previous.cmd`.

The workbench reads native `thread/list`, bounded native `thread/read` execution-location metadata, and verified native item/status/turn notifications, then combines it with the Harness Mix Host attention snapshot. Native status is read-only. The feature does not merge, rebase, push, or mutate repositories. Managed snapshot requests send only selected cwd paths to Host. Native history is paginated (bounded pages); completed history is seeded as an initial baseline so old completions do not flood the first view. Native and managed timestamps are normalized separately.

Cards can open a direct native thread deep-link. The UI treats arrival as confirmed only after the target thread is observed in the visible native route or composer identity; a requested navigation alone is not confirmation.

## Usage

Launch the staged build, then choose the **对话工作台** icon in the far-left navigation, immediately below **站点 / Sites** (or **代码审查 / Code Review** if Sites is unavailable). Project tabs keep independent notifications and view selection. A card opens its chat; the same persistent sidebar icon then offers **返回工作台**. Switching projects does not acknowledge notifications. Only confirmed chat navigation acknowledges that chat's retained events.

Each repository has a commit topology view with children above parents. Shared commits have one node with all branch labels. The overview folds only unannotated linear ancestry and labels each condensed edge with its verified omitted-commit count; forks, merges, roots, boundaries and conversation pins remain visible. The graph uses one vertical scroll surface in a large window. Each node leads with a concise source commit subject; hovering or keyboard focus reveals the full subject, refs and hash. Select a commit to inspect its associated chats in a compact side panel, or use the branch locator to scroll to its tip. Branch labels open the associated chat list, and **全部对话** opens the whole project list. Narrow panels use a branch selector and compact list. Current worktree positions and recorded native commits retain distinct labels. Unverified locations stay outside the graph. "已入主线" means verified local Git ancestry, and does not assert a GitHub PR merge or squash-merge result.

## Scope and limits

Only local active (unarchived) native/managed chats are included. The native history window is bounded to 500 chats; Git reads are bounded to 16 repositories, 1024 commits per repository, and 32 worktree status checks per repository. Missing metadata, stale/failed sources, and truncated data remain visible as warnings or unknown associations. The extension polls chat metadata every 30 seconds in the background; while open it refreshes every 10 seconds and may read Git. Native notifications also trigger refresh. Native chat contents and execution requests are not sent to the Harness Mix Host; only local cwd paths are passed to its attention endpoint.

## Verified before activation

- `npm run check`: 297 JavaScript files passed.
- `npm run test:core-all`: passed.
- `npm run typecheck:native-ui`: passed.
- Snapshot test with real temporary Git repositories/worktrees: passed; refs/HEAD/status unchanged before/after.
- Attention renderer tests: 21 passed, including native lifecycle, event ordering, state, graph positioning, and navigation acknowledgement.
- `npm run test:native-protocol` and `npm run test:native-compatibility`: passed.
- `npm run test:native-ui`: 701 passed / 1 existing failure. The same `renderer-agent-picker.test.ts:159` assertion fails in the untouched source checkout; it concerns the original Codex handoff picker and was not changed for Attention Workbench.
- `npm run build:native:ui`: renderer/controller bundles built. Three staged native executables match the installed files byte for byte.
- Generated-fixture Electron smoke: project badges, read isolation, successful/failed navigation, return, branch/list pagination, historical commit handling, Escape/disposal passed. At 1024x736 the graph dialog is 992x568 with no scrolling; 360px/320px layouts have no horizontal overflow.

UI evidence lives in `output/attention-smoke/` and the local workbench task evidence folder. CamoFox fresh-tab creation timed out and the Codex in-app browser was unavailable; screenshots come from the implementation running in an isolated hidden Electron test window with fixture data.

## Initial activation history

The old installed package remains untouched for rollback. At initial delivery, Desktop activation had not occurred; the launcher correction and subsequent activation are recorded below. The launcher restarts Codex; running Harness Mix collaboration jobs become resumable interrupted jobs. Confirm a suitable restart time before activating. After restart, verify real chat navigation and notifications, then use another Harness followed by a new and resumed official Codex chat to check native route parity. Fixture/unit tests do not establish that live Desktop parity.

## Launcher correction (2026-10-22)

A restart through the desktop shortcuts was observed to use the old installed package: its launcher, controller and Host processes all ran from `harness-mix/node_modules/@harness-mix/cli`. The staged attention bundle was not active. The original delivery had not updated these normal launch entries.

The existing desktop **Harness Mix** and **重启 Harness Mix** shortcuts keep their names and now reach the staged worktree through their corrected CMD targets. **Check-Harness-Mix.cmd** also checks that worktree. Original wrappers are preserved beside them as `*-Previous.cmd`; those launch the unchanged old package. The dedicated `Start-Attention-Workbench.cmd` now includes `--restart`, preventing the launcher's existing-host early exit when explicitly activating the workbench.

These wrapper changes take effect on the next explicit restart; they do not reload the currently running old controller. The launcher expressly rejects restart from inside a Codex task to protect active work, so activation must be initiated externally through **重启 Harness Mix**. After the user restarted, the launcher, controller and Host process paths were verified to use `harness-mix-attention`. A real sidebar mount bug remained; see the correction below. Full native execution parity remains a separate pending validation.


## Persistent sidebar correction (2026-10-22)

The new worktree was active after the user restarted, but the entry had been inserted into a retained, hidden workspace header. That header also inherited `pointer-events:none`. The original click handler itself opened the dialog successfully. `installAttentionTrigger` now mounts the same real button immediately below the visible `builtin:sites` destination, with `builtin:pull-requests` as fallback. It rechecks visible anchors after sidebar remounts and visibility changes, adopts native button styling, explicitly enables pointer events, and preserves the click listener and return state. The icon uses an isolated `::after`; native `::before` is reserved for its hover layer and has zero opacity at rest.

A helper-only migration was applied to the existing live trigger without replacing the renderer binding or restarting Host/Desktop. Source and native UI bundles are updated for subsequent launches. Verified in the actual running Desktop: one 36x36 entry at x8/y369, directly below Sites; real pointer click opens the dialog; clicking the Harness Mix maintenance card opens that native chat; the sidebar return icon reopens the same project; navigating back to the original chat retains the entry. No new message/turn was submitted during navigation checks.

Validation for this correction: syntax check 297 files; core suite passed; full native UI typecheck passed; Attention suite 26 tests passed plus the real Git snapshot test; UI build passed. Live evidence is in `C:/Users/yuanh/Desktop/codex-kb-workbench/tasks/attention-implementation-20261022/live-sidebar-roundtrip.json` and `live-sidebar-final.json`. Full cross-harness execution parity is not established by these sidebar checks.

## Actual execution directory tracking (2026-10-22)

The initial cwd is insufficient to locate a chat's actual development repository. `C:/Users/yuanh/Documents/家用` has its own unrelated one-commit repository; the work for this task runs in the nested `99-工具/harness-mix-attention` worktree of Harness Mix. Native `thread/read` returns structured `commandExecution.cwd` values, and native `item/started` / `item/completed` notifications supply subsequent execution locations. The UI records only thread/item identifiers, a validated local absolute cwd, source and observation time. Commands, output, native execution requests and history remain on the stock native route and never go to Host.

While open, history inspection is bounded to eight chats per refresh and two concurrent reads, prioritizes the selected project, and gradually covers the rest. A revision guard prevents stale history from overwriting newer item events. The metadata cache is bounded to 512 entries and seven days. Closed-workbench status polling skips history bootstrap and Git. Managed workspace root changes are tracked as well. Verified activity cwd takes precedence over initial cwd for repository discovery; the most specific nested repository/worktree wins. Current HEAD following requires command evidence in a running/waiting chat or explicit `workspace.mode=worktree` ownership. Finished chats with only a shared cwd/branch do not follow later checkouts; a recorded SHA remains historical evidence, and missing SHA stays unresolved. Stale worktree cache entries without explicit ownership are ignored and removed. Native recorded gitInfo is preserved unchanged.

Live verification observed this conversation following two actual read-only command executions: `harness-mix-source` / `developing`, then `harness-mix-attention` / `codex/attention-workbench`. Neither command changed a checkout, ref or commit. Evidence: `dynamic-live-source.json` and `dynamic-live-attention.json` in the local task evidence directory.

Ordinary non-Git directories such as `C:/Users/yuanh/Documents/Codex/2026-10-11/new-chat` are represented as `reason:not-git` with no raw fatal message. They remain unassociated and do not consume the 16-valid-repository budget. Other repository failures are scoped to the affected project. The request contract remains at most 32 paths, with managed additions bounded to 64 total paths. The renderer also normalizes the older running Host's non-Git errors.

## Commit topology correction (2026-10-22)

The former renderer allocated a row per branch and positioned representative cards within those rows. That model could show several parallel lanes even where refs shared a commit, and could not explain the repository's actual structure. The replacement derives rows and tracks from the commit DAG. Multiple labels pointing to one hash share one node, merge nodes retain every parent, and forks share the same ancestor. Each repository renders separately. A conversation's graph pin requires a verified commit hash in the loaded topology; unresolved and out-of-range locations are explicitly listed. A workspace pin identifies the most recent observed execution directory and its current HEAD/WIP; it does not establish who authored any commit.

The overview preserves branch/worktree/pin nodes and all structural nodes. Only a continuous chain of unannotated nodes with exactly one parent and one child is condensed. `via` hashes and `skippedCount` preserve the verified omitted path. Dashed condensed edges are labelled `+N`; missing parents have explicit boundary markers. The user can switch to individual commits, locate any local branch, select a commit, browse its conversations and return from a chat via the persistent sidebar entry.

History coverage was a second source of misleading graphs. The old 80-commit window excluded Harness Mix's only merge and covered only 11 of 74 local branch heads in the Lagrange repository. The Host now reads up to 1024 commits in topology order, preserving raw parents and the overflow probe. Direct read-only checks of the new service returned all 206 Harness Mix commits (one merge, all three branch heads) and all 900 Lagrange commits (320 merges, all 74 branch heads). Lagrange still has a partial flag because its worktree-status checks exceed the separate 32-worktree bound.

Deployment is split deliberately: the current renderer can be refreshed through the isolated Attention Workbench lifecycle without restarting native execution. Host source changes, including the 1024-commit window and valid-repository budgeting, take effect on the next normal external launch. The running older Host may still provide 80 commits; the new UI must show that snapshot's explicit boundaries and out-of-range branch heads. Do not inject static history into the live view or claim the deeper source is already active.

The renderer's isolated lifecycle is `window.__harnessmixAttentionWorkbenchV1` (`open`, `close`, `refresh`, `dispose`). Replacing this feature preserves the native bridge, renderer binding, Host and active work. Full cross-harness execution parity still requires the separate native-route sequence documented above.

## Final targeted verification

- Core suite: exit 0 (54 top-level test commands).
- Attention suite: real Git snapshot PASS; seven Vitest files / 52 tests PASS.
- Native UI TypeScript check and renderer/controller build: PASS.
- JavaScript syntax check: 297 files PASS; final changed snapshot modules also pass `node --check`.
- Hidden Electron topology smoke: real two-parent merge, shared-head labels, exact chat pins, unresolved locations, linear-chain compression, branch/commit navigation, whole-project chat pagination, event isolation, failed/successful chat navigation, return and disposal PASS.
- Desktop 1024x736: dialog client/scroll height 607/607. Desktop 800x600: 531/531. Visible position cards are contained and enabled. Narrow 360/320 views have no horizontal overflow.
- An isolated test of the real Harness Mix 206-commit snapshot renders `developing` and `codex/attention-workbench` at one shared node and preserves the unique merge's two parent edges. This isolated test does not change the current live Host's history window.
- Native UI full-suite baseline remains the previously reproduced `renderer-agent-picker.test.ts:159` failure; that unrelated picker was not changed. Targeted checks do not establish cross-harness execution parity.

Final artifacts and logs: `C:/Users/yuanh/Desktop/codex-kb-workbench/tasks/attention-implementation-20261022/` and ignored `output/attention-smoke/`. The live topology screenshot/metadata shows a correctly bounded view from the currently running 80-commit Host, with missing branch heads explicitly counted. The 1024-commit Host source is prepared for the next normal external restart.

## Readability and single-axis navigation (2026-10-22)

The latest user preference permits continuous scrolling in one direction and prioritizes large, readable descriptions. The desktop graph now fills the available window (up to 1600px wide), with 56px commit rows, 15px change titles, and a single vertical graph scroller. Commit pagination is removed. The dialog itself and graph do not scroll horizontally; controls and the conversation panel stay in place.

Visible commit hashes have been removed from graph rows, the selected-change heading and conversation position summaries. Labels use the original commit subject with conventional-commit prefixes removed and a length bound; they do not infer undocumented changes. Full subjects, branch labels and hashes appear in a hover/focus tooltip. The branch selector scrolls the relevant node into view. Scroll state retains a visible commit and pixel offset across refresh, selection, dialog reopen and returning from a conversation. Existing ancestry, evidence rules and native request boundaries are unchanged.

The change is renderer-only and can be activated through the isolated workbench lifecycle in the current window. It does not require a Desktop/Host restart. The previously documented Host history-depth activation boundary remains independent.

## Visible conversation positions (2026-10-22)

The user accepted the large, single-axis graph and requested more obvious conversation positions. Verified chat pins now show clickable titles and live status directly beneath their commit subject. Rows with chats are 92px high; other rows remain 56px. A shared prefix-position table drives row placement, parent edges, node coordinates, focus navigation and scroll restoration. Wide windows show up to two labels per position, smaller desktop windows one; +N exposes the remaining chats in the existing side panel. The selected chat has a blue outline. Graph chat actions and overflow actions have independent stable focus keys.

The conversation locator scrolls and focuses a verified commit and prioritizes that conversation in the side panel. Unverified locations open the separate pending list. When a repository has no verified pins, its initial side panel shows pending chats with a short reason. Missing SHA evidence is never inferred from a matching branch name.

TypeScript check, renderer build and final hidden Electron smoke passed. The fixture verifies direct graph-label navigation and return position, three chats at one commit, conversation/branch location, precise dynamic-row geometry, refresh/reopen scroll preservation, tooltip/Escape behavior, and the unresolved-only case. Desktop 800x600, 1024x736, 1400x900 and narrow 320/360 layouts stay within the viewport. The offline real 206-commit repository still retains its merge edges.

The final UI was installed and checked in the current window without restarting the app or Host. The local debug port had changed; it was discovered from the running app and the test helper now accepts ATTENTION_CDP_ENDPOINT. Live checks confirmed a single sidebar trigger, no horizontal or outer-dialog scrolling, and the new conversation locator. In the selected project's live snapshot, 11 conversations lacked verified commit positions and therefore appeared in the pending side panel; zero graph pins were fabricated. This live check does not establish native cross-harness execution parity or completeness of all native chat enumeration. Evidence: visible-pins-live.json/png, visible-pins-smoke-final.log and visible-pins-final-manifest.json in the local task evidence folder.
