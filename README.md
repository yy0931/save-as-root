# Save As Root in Remote - SSH
This extension saves files with root privileges on *nux environments connected with `Remote - SSH`,
is an easy solution to [FileSystemProvider: no way of handling permissions issues #48659](https://github.com/microsoft/vscode/issues/48659).

## Limitations
- \*nix remote environments only.
- Your environment must be configured for running the sudo command without a password.

## Usage
1. Select `Save As Root` in the command palette.
2. Select `Don't Save` in the VSCode's native `Do you want to save the changes ...` dialog.

## Contributing
When you find and fix a bug/bugs, please send PRs to my repository.
