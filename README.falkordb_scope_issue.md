# FalkorDB single-`group_id` scope bug (graphiti #1161)

> **Status: FIXED (Option A implemented).** `src/graphiti/backend.ts` now pads
> read/clear group ids to >= 2 via a private `queryGroupIds()` -> `padGroupIds()`
> pair (distinct empty sentinel `<groupId>__pg_empty`). `readGroupIds()` stays
> unpadded for logical/display use; only on-the-wire search/clear calls are
> padded. `dumpAllEpisodes`/`allGroupIds` remain clean (they use
> `groupId`/`projectGroupId` directly). Kept in sync with the standalone
> `pi-graphiti` extension.
>
> Separately, `searchNodes`/`searchFacts` now guard with `hasSearchableTerms()`:
> queries that tokenize to empty on RediSearch (stopword-only like `the`/`is`/`a`,
> or punctuation-only) are skipped client-side. graphiti-core otherwise builds an
> invalid `(@group_id:"...") ()` clause and FalkorDB throws
> `Syntax error at offset 34`.

Upstream issue: <https://github.com/getzep/graphiti/issues/1161>
(duplicated/triaged as #1325, fix proposed in open PR #1326)

## TL;DR

When the graphiti backend runs on **FalkorDB**, a search that is scoped to a
**single `group_id`** silently returns **zero results**, even though the data
exists. This is exactly the path our project-scoped memory takes
(`scope: "project"` and `scope: "global"`), so project-scoped reads come back
empty while the underlying graph is full.

## Root cause (upstream)

In FalkorDB each `group_id` is stored as a **separate graph/database**, not as a
property filter inside one graph (the Neo4j model). graphiti bridges the two
models with the `handle_multiple_group_ids` decorator in
`graphiti_core/decorators.py`. That decorator only clones the driver onto the
correct per-`group_id` graph when there is **more than one** group id:

```python
if (
    hasattr(self, 'clients')
    and hasattr(self.clients, 'driver')
    and self.clients.driver.provider == GraphProvider.FALKORDB
    and group_ids
    and len(group_ids) > 1          # <-- bug: should be >= 1
):
    # clone driver per group_id, run, merge
    ...
# else: "Normal execution" -> runs against the driver's default graph (default_db)
return await func(self, *args, **kwargs)
```

For a single `group_id`, the condition is `False`, so the query falls through to
"normal execution" against the driver's **default graph** (`default_db`), which
is empty. No error is raised; the search just returns nothing.

The decorator iterates each gid, does `driver.clone(database=gid)`, runs the
function with `group_ids=[gid]`, and merges the per-graph results. It does **not**
dedupe the incoming list. That detail matters for the workaround below.

Status: still present in the version our local stack pins
(`zepai/knowledge-graph-mcp:standalone` -> graphiti-core 0.28.x). The fix
(PR #1326, flip `> 1` to `>= 1`) was still open at last check. Related FalkorDB
multi-graph bugs to watch: #1305 and #1331 (concurrent `add_episode` mutating the
shared `self.driver` and contaminating the wrong graph).

## Where it bites us

`src/graphiti/backend.ts` -> `GraphitiBackend.readGroupIds(scope)`:

```ts
readGroupIds(scope: GraphScope = "both"): string[] {
  if (!this.options.projectScoping) return [this.options.groupId];        // 1 id -> BUG
  const project = this.options.projectGroupId;
  if (scope === "global") return [this.options.groupId];                  // 1 id -> BUG
  if (scope === "project") return [project ?? this.options.groupId];      // 1 id -> BUG
  // "both": project + global, deduped, project first
  const ids = [project ?? this.options.groupId, this.options.groupId];
  return [...new Set(ids)];                                               // 2 ids -> OK
}                                                                          //  (1 id if deduped -> BUG)
```

`readGroupIds` feeds `search_nodes` (`searchNodes`) and `search_memory_facts`
(`searchFacts`) as the `group_ids` array. Concretely:

| Caller | Scope | `group_ids` length | Result on FalkorDB |
|---|---|---|---|
| graphiti tool `search`, explicit `scope: "project"` | `project` | 1 | **empty (bug)** |
| graphiti tool `search`, explicit `scope: "global"` | `global` | 1 | **empty (bug)** |
| graphiti tool `search` default, project active | `both` | 2 | OK |
| graphiti tool `search` default, **no project active** | `both` | 1 (deduped) | **empty (bug)** |
| graphiti tool `search` default, **project scoping off** | (n/a) | 1 | **empty (bug)** |
| auto-context handler (`graphiti-context.ts`), project active | `both` | 2 | OK |

So the failure is broader than just project scope: any time the read collapses
to one distinct id (explicit project/global scope, no active project, or scoping
disabled) the search is dead on FalkorDB. The reason it looks like a
"project-scoped memory" bug specifically is that with project scoping on, the
default `"both"` path returns 2 ids and *appears* to work, masking the breakage
until a caller narrows to a single scope.

Writes are not affected: `add_memory`/`get_episodes` pass a singular `group_id`,
and graphiti's write path clones `self.driver` onto that graph (see #1305/#1331),
which is why the data is correctly stored in the per-project graph yet unreadable
by single-id search.

## Potential fixes

### Option A - client-side pad (recommended, fully in our control, no infra change)

Never emit a 1-element `group_ids` array for reads. Pad to length >= 2 with a
reserved, never-written sentinel group id. The decorator then takes the
multi-group path: it clones onto the real graph (returns hits) and onto the empty
sentinel graph (returns nothing), and merges -> exactly the real results. Because
the decorator does **not** dedupe, padding with the *same* id would double every
hit (our parsers do not dedupe by uuid), so use a distinct empty sentinel, not a
duplicate.

```ts
// src/graphiti/backend.ts
/** Reserved, never-written group id used only to force graphiti's FalkorDB
 *  multi-group code path (works around graphiti #1161). */
private padGroupIds(ids: string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length >= 2) return unique;
  const sentinel = `${this.options.groupId}__pihermes_empty`;
  return unique[0] === sentinel ? [unique[0], `${sentinel}_2`] : [...unique, sentinel];
}

readGroupIds(scope: GraphScope = "both"): string[] {
  if (!this.options.projectScoping) return this.padGroupIds([this.options.groupId]);
  const project = this.options.projectGroupId;
  if (scope === "global") return this.padGroupIds([this.options.groupId]);
  if (scope === "project") return this.padGroupIds([project ?? this.options.groupId]);
  const ids = [project ?? this.options.groupId, this.options.groupId];
  return this.padGroupIds(ids);
}
```

Notes:
- Apply only when `graphBackend === "graphiti"` on FalkorDB. It is harmless on
  Neo4j (extra group id just matches nothing) but unnecessary there.
- `clear_graph` also routes through `readGroupIds`; the sentinel graph is empty,
  so clearing it is a no-op. Verify `dumpAllEpisodes`/`allGroupIds` are not
  polluted - they use `groupId`/`projectGroupId` directly, not the padded set, so
  they stay clean. Keep it that way.
- Cost: FalkorDB lazily creates the empty sentinel graph on first clone. One tiny
  empty graph per global group; acceptable.
- Risk: relies on the decorator's documented "merge per group" behavior, which is
  stable in current releases. Remove once Option C lands.

### Option B - server-side patch (upstream-aligned, needs a custom image)

We already build the MCP image from upstream (`graphiti-mcp-local-stack` skill,
`Dockerfile.standalone`). Patch the decorator during the image build:

```dockerfile
# After deps are installed, before the server starts
RUN sed -i 's/and len(group_ids) > 1/and len(group_ids) >= 1/' \
    /app/graphiti_core/decorators.py
```

(Confirm the path inside the image; under uv it is typically the installed
`graphiti_core` in the venv site-packages, e.g.
`.venv/lib/python3.13/site-packages/graphiti_core/decorators.py`.) This is the
real fix and removes the need for client padding, but pins us to a maintained
fork image until upstream merges.

### Option C - version bump (best long-term, currently blocked)

Track PR #1326 (`> 1` -> `>= 1`). When it merges and a release ships, bump the
pinned graphiti-core / MCP image and drop Options A and B. Until then this is not
actionable on its own.

## Recommendation

Ship **Option A** now (small, reversible, test-covered with the mock client - the
`readGroupIds` unit tests just need to assert the padded output). Optionally add
**Option B** to the custom image build for defense in depth, and remove both once
**Option C** is available upstream.

## Verification

1. `./node_modules/.bin/tsc --noEmit` exits 0.
2. Unit test: `readGroupIds("project")` / `("global")` / `("both")` and
   scoping-off all return arrays of length >= 2 with the real id(s) first.
3. Live (FalkorDB up): add an episode with `scope: "project"`, wait for
   extraction, then `search` with `scope: "project"` and confirm non-empty hits.
   Cross-check with `redis-cli GRAPH.LIST` and
   `GRAPH.QUERY <projectGroup> "MATCH (n) RETURN count(n)"`.
4. Confirm `default_db` stays empty and the sentinel graph holds 0 nodes.
