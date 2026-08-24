# @sparkelf/dsh-query-result-analysis

Bounded, checkpointed batch analysis for immutable query-result references in DeepSeek Harness (DSH).

The plugin registers one model-facing tool:

```text
analyze_query_result({ resultRef, instruction, resumeAnalysisRef?, maxBatchRetries? })
```

## Ownership

This plugin owns the model loop, batching, provider-aware retry, checkpointing, and hierarchical reduction. It does **not** own DataOps credentials, transport, SQL/API execution, or result storage.

It consumes whichever `read_query_result` tool is visible to the current Agent. In the DataOps embedded profile that tool is supplied by the DataOps MCP adapter, so the flow is:

```text
analyze_query_result
  -> DSH ToolRuntime nested dispatch
  -> read_query_result(resultRef, cursor)
  -> bounded immutable page
  -> current DSH provider/model
  -> checkpoint
  -> hierarchical reduction
```

The plugin never knows the DataOps URL, workspace token, database credentials, or source SQL/API details.

## Batching

Each `read_query_result` page is one analysis batch. DataOps currently caps each result page by bytes before rows, so the plugin does not load the complete result into one model request.

Rows receive stable evidence labels derived from the immutable result reference:

```text
<resultRef>#row-1
<resultRef>#row-2
...
```

Batch summaries are reduced in bounded groups until one final summary remains.

## Model selection and retry

The plugin uses the active DSH session's latest durable `request/header` model configuration. Model credentials remain owned by DSH Settings/Credentials and provider plugins.

Retries follow the selected provider's `ResolvedRetryPolicy`:

- `normal`: only configured retryable failure codes are eligible, with the provider's backoff / Retry-After rules.
- `always`: any provider failure is eligible.
- `maxBatchRetries` adds a caller-visible cap of `0`, `1`, `2`, or `3` retries per bounded model call. The default is `1`.

Cancellation is forwarded to both nested result reads and model calls.

## Durable checkpoints

A new analysis creates an opaque `qa1_<uuid>` analysis reference. Checkpoints live under the DSH-owned home directory:

```text
$DSH_HOME/query-result-analysis/<session-hash>/<analysisRef>.json
```

The file is atomically replaced after every completed batch and after final reduction. It contains the source result reference, instruction, completed batch summaries, next cursor, provider/model facts, and final summary when complete.

If an analysis fails after an analysis reference is created, the tool error includes:

```text
Resume with resumeAnalysisRef=qa1_...
```

Calling the tool again with the same `resultRef`, `instruction`, and `resumeAnalysisRef` resumes from the last **completed** result cursor. Already completed pages are not re-read. A completed checkpoint returns immediately without new result reads or model calls.

The checkpoint is deliberately outside the DSH session event vocabulary. The pinned DSH core does not yet expose a write-side `ignorable: true` API for out-of-tree session events, so using a plugin-specific session event would make persisted sessions depend on the plugin being mounted during later reads.

## Profile bundle

The package declares a DSH bundle in `package.json`. Installing it with `dsh plugin --profile <name> add ...` appends its `cordis.patch.yml`, which registers the Host plugin:

```yaml
- insert:
    - id: query-result-analysis
      name: '@sparkelf/dsh-query-result-analysis'
```

The package has no browser half; its final summary is rendered through the normal DSH tool-result UI.
