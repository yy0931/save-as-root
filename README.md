# Save as Root in Remote - SSH
This extension saves files with root privileges on Linux or macOS environments connected with `Remote - SSH`,
is an easy solution to [FileSystemProvider: no way of handling permissions issues #48659](https://github.com/microsoft/vscode/issues/48659).

## Usage
Select `Save as Root` in the command palette (F1 or Ctrl+Shift+P or Cmd+Shift+P).

![Screenshot](https://raw.githubusercontent.com/yy0931/save-as-root/main/screenshot.gif)

---

To override ctrl+s add the following code to shortcuts.json. (F1 or Ctrl+Shift+P or Cmd+Shift+P > `Preferences: Open Keyboard Shortcuts (JSON)`)

```json
{
    "key": "ctrl+s", // or cmd+s on macOS
    "command": "save-as-root.saveFile",
    "when": "editorFocus && save-as-root.requiresSudo"
}
```

## Contributing
If you find a bug or have a suggestion, feel free to submit an issue/PR to my repository.
