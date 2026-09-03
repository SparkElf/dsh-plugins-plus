# @sparkelf/dsh-ssh-manager

A Better Sidebar SSH inventory and guarded-operation workbench for DeepSeek Harness.

## Current capabilities

- Clustered host inventory with search, names, descriptions, tags, environments, jump-host references, and known-host fingerprints.
- Password, private-key, passphrase, and SSH-agent metadata flows backed by the shared encrypted Workbench vault.
- Host detail view and sanitized Send to conversation action.
- Host and cluster CRUD Host APIs.
- Non-secret ssh_list_hosts and ssh_get_host model tools.
- ssh_prepare_command creates an explicit-review command request but never executes it.
- ssh2 1.17 transport dependency is pinned for the upcoming verified terminal and SFTP execution boundary.

The plugin never returns decrypted credentials to browser state or model tools. Actual remote command execution remains disabled until the explicit approval and known-host verification path is implemented.
