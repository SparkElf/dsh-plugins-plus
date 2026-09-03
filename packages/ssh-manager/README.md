# @sparkelf/dsh-ssh-manager

A Better Sidebar SSH inventory and guarded-operation workbench for DeepSeek Harness.

## Current capabilities

- Clustered host inventory with search, names, descriptions, tags, environments, jump-host references, and known-host fingerprints.
- Password, private-key, passphrase, and SSH-agent metadata flows backed by the shared encrypted Workbench vault.
- Host detail view and sanitized Send to conversation action.
- Host and cluster CRUD Host APIs.
- Non-secret ssh_list_hosts and ssh_get_host model tools.
- ssh_prepare_command creates an explicit-review command request but never executes it.
- Strict SSH connection testing with an explicit OpenSSH SHA256 known-host fingerprint; unknown or changed host keys are rejected and the observed fingerprint is reported.
- Password, private-key/passphrase, and SSH-agent connection configuration through ssh2 1.17.

The plugin never returns decrypted credentials to browser state or model tools. A user can run one bounded command directly from the host detail pane; model-initiated `ssh_execute_command` always uses the DSH approval service and executes only after an `allowed-once` decision. Long-lived interactive terminal streaming and jump-host forwarding remain disabled until their complete lifecycle implementations are available.
