# @sparkelf/dsh-api-client

A Postman-style Better Sidebar API workbench for DeepSeek Harness.

## Current capabilities

- Persistent workspaces, nested collection contracts, environments, requests, and bounded response history.
- Method, URL, query parameter, header, authorization, body, environment, response, and history views.
- Basic, Bearer, API-key, and OAuth-token authorization resolved only inside the Host through the shared encrypted Workbench vault.
- Explicit browser Send action with 30-second timeout, HTTP(S)-only URLs, redirect handling, and a 2 MiB response-body limit.
- Cascading workspace, collection, environment, request, history, and secret deletion.
- Sanitized Send to conversation action plus non-secret api_list_requests, api_get_request, and api_prepare_request model tools.

Model tools cannot execute requests or retrieve secret environment/auth values. Multipart, binary, and AWS SigV4 execution report an explicit unsupported error until their complete implementations are available.
