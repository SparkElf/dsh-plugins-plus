# Workbench Plugin Suite

## Product boundary

Each workbench is an independent dsh-better-sidebar plugin with its own host API, client bundle, persistence schema, and model tools. Shared behavior belongs in small host-only libraries, not in Better Sidebar or the DSH core.

The suite uses one authoritative credential service. Browser clients may create, replace, test, and delete credentials, but cannot read secret values back. Model tools receive resource identifiers and non-secret metadata only. Managed DataOps authorization continues to use the DataOps JWT and is not duplicated by these plugins.

## Shared platform

- Resource metadata: stable id, display name, description, tags, folders or clusters, timestamps, and connection status.
- Encrypted vault: namespaced AES-256-GCM records, owner-only files, migration, rotation, delete, and host-only resolve.
- Better Sidebar UX: resource tree, search, pinned items, detail mode, double-click working tabs, recent history, and free-window support.
- Conversation handoff: add a sanitized resource or operation reference to the current composer; never include passwords, private keys, tokens, cookies, or decrypted environment variables.
- Audit events: connection tests, executions, destructive actions, exports, and AI-triggered operations.

## SSH Manager

Package: @sparkelf/dsh-ssh-manager

- Tree hierarchy: cluster, group, host, saved terminal, tunnel, and transfer.
- Host metadata: name, description, tags, environment, owner, hostname, port, user, jump host, known-host fingerprint, and health state.
- Credentials: password, private key, key passphrase, agent forwarding policy, and bastion credentials live only in the shared vault.
- Interaction: single-click host details; double-click terminal; multi-tab terminals; resize, reconnect, encoding, keepalive, snippets, SFTP browser, and local/remote port forwarding.
- AI handoff: send a host or cluster reference to the conversation, request a command plan, show the exact host set and command, require explicit confirmation for mutating or elevated commands, stream stdout/stderr, and record an audit event.
- Security: strict known-host checking by default, explicit fingerprint trust, no shell command concatenation, bounded output, cancellation, timeouts, and secret redaction.

## API Client

Package: @sparkelf/dsh-api-client

- Tree hierarchy: workspace, collection, folder, request, example, and environment.
- Request tabs: method, URL, path/query parameters, headers, cookies, authorization, body, pre-request script, tests, and documentation.
- Body editors: JSON, text, XML, form URL encoded, multipart, binary reference, GraphQL, and raw.
- Authorization: none, Basic, Bearer, API key, OAuth 2.0/OIDC, AWS SigV4, and inherited collection auth. Secret parts resolve through the shared vault.
- Response: status/timing/size, formatted and raw body, headers, cookies, redirects, TLS details, search, save example, and paginated history.
- Import/export: Postman collection/environment and OpenAPI 3.x. Exported files omit secrets unless the user makes a separate explicit secret export.
- AI handoff: send a sanitized request definition, response excerpt, schema, or failed test to the conversation; AI edits an unsaved working copy until the user saves it.

## Additional independent plugins

- Redis Explorer: key browser, TTL/type details, paginated scans, stream/group views, and AI-assisted commands.
- Message Queue Console: Kafka/Pulsar/RabbitMQ clusters, topics/queues, consumer groups, offset inspection, sampled messages, and safe publish workflows.
- Kubernetes Explorer: contexts, namespaces, workloads, events, logs, exec tabs, diffs, and explicit mutation confirmation.
- Object Storage Browser: S3-compatible buckets, object metadata, previews, multipart transfers, signed URL actions, and lifecycle inspection.
- Log Explorer: saved sources, structured filters, live tail, time ranges, field statistics, and send-selected-events to AI.
- Git and CI Console: repositories, branches, pull requests, workflow runs, logs, artifacts, and AI-assisted failure analysis.

## Delivery sequence

1. Extract the SQL encrypted credential implementation into the shared host-only vault contract and add migration tests.
2. Finish SQL product adapters, object metadata, pagination, sorting, filtering, and visual E2E coverage.
3. Deliver SSH Manager read-only host inventory and terminal tabs, then add SFTP/tunnels and guarded AI execution.
4. Deliver API Client request/response tabs and history, then collection import/export and OAuth flows.
5. Add other workbenches only when a concrete workflow requires them; do not create empty sidebar tabs.
