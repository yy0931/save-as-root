/**
 * @file Provides the following commands to VSCode:
 * - save-as-root.saveFile(user: string = "root"): Saves the current file with root privileges or as the specified user
 * - save-as-root.saveFileAsSpecifiedUser(): Prompts for a username and saves the current file as that user
 * - save-as-root.newFile(uri?: vscode.Uri): Creates a new file with root privileges at the optional URI path
 * 
 * Notes:
 * - This script is intentionally written in JavaScript instead of TypeScript, as it's a small single-file script.
 *   I will not accept PRs converting this project to TypeScript.
 * - Feel free to fork this project, but do **not** remove the LICENSE file, as was done in this fork: https://github.com/FriedrichVoelker/vscode-root-on-remote/issues/2
 */

const vscode = require("vscode")
const { execFile } = require("child_process")
const crypto = require("crypto")
const fs = require("fs")
const os = require("os")
const path = require("path")

/**
 * Saves a file with `sudo 'tmpFile=/tmp/...' 'filename=...' sh -c 'cat < "$tmpFile" > "$filename"'`.
 * @returns {Promise<void>}
 */
const sudoWriteFile = async (/** @type {string} */filename, /** @type {string | Uint8Array} */content, /** @type {string} */user) =>
    withTmpFile(async (tmpFile) => {
        await fs.promises.writeFile(tmpFile, content)
        await sudoExec([`tmpFile=${tmpFile}`, `filename=${filename}`], 'cat < "$tmpFile" > "$filename"', user)
    })

/**
 * Runs a shell command with sudo.
 * For example, `sudoExec(["a=1", "b=2"], 'echo "$a" "$b"')` executes `sudo 'a=1' 'b=2' sh -c 'echo "$a" "$b"'`, with appropriate sudo options to handle password input.
 * 
 * @returns {Promise<string>} stdout of the command.
 */
const sudoExec = async (/** @type {readonly string[]} */setEnvs, /** @type {string} */shellScript, /** @type {string} the `sudo --user=user` option  */user) => {
    const config = vscode.workspace.getConfiguration("save-as-root")
    return new Promise((resolve, reject) => {
        // 1. Authenticate with `sudo -S -p 'password:' sh`.
        // 2. Execute `<setEnvs> sh -c <shellScript>`.
        const p = execFile(/* "sudo" or "/usr/bin/sudo" */config.get("command", "sudo"), /* e.g., "-u user" */[...(user === "root" ? [] : ["-u", user]), "-S", "-p", "password:", /* e.g., "env1=1", "env2=2" */...setEnvs, "sh", "-c", shellScript])
        p.on("error", (err) => {
            reject(err)
        })
        const cancel = (/** @type {Error} */err) => {
            if (!p.killed) { p.kill() }
            reject(err)
        }

        // Handle stderr.
        let stderr = ""
        p.stderr?.on("data", (/** @type {Buffer} */chunk) => {
            const lines = chunk.toString().split("\n").map((line) => line.trim())
            if (lines.includes("password:")) {
                // Show a password prompt.
                vscode.window.showInputBox({ password: true, title: "Save as Root", placeHolder: `password for ${os.userInfo().username}`, prompt: stderr !== "" ? `\n${stderr}` : "", ignoreFocusOut: true }).then((password) => {
                    if (password === undefined) { return cancel(new vscode.CancellationError()) }
                    p.stdin?.write(`${password}\n`)
                }, cancel)
                stderr = ""
            } else {
                // Concatenate error messages.
                stderr += chunk.toString()
            }
        })

        // Accumulate stdout.
        let stdout = ""
        p.stdout?.on("data", (/** @type {Buffer} */chunk) => {
            stdout += chunk.toString()
        })

        // Handle the exit event.
        p.on("close", (code) => {
            if (code === 0) {
                return resolve(stdout)
            } else {
                reject(new Error(`exit code ${code}: ${stderr}`))
            }
        })
    })
}

/** @type {<T>(fn: (tmpFile: string) => Promise<T>) => Promise<T>} */
const withTmpFile = async (fn) => {
    const tmpFile = path.join(os.tmpdir(), `save-as-root-${crypto.randomBytes(16).toString("hex")}.bin`)
    try {
        return await fn(tmpFile)
    } finally {
        await fs.promises.unlink(tmpFile)
    }
}

exports.activate = (/** @type {vscode.ExtensionContext} */context, /** @type {unknown} */options) => {
    // Register the "Save as Root" command.
    context.subscriptions.push(vscode.commands.registerCommand("save-as-root.saveFile", async (/** @type {string | undefined} */user = "root") => {
        // Check the status of the editor.
        const editor = vscode.window.activeTextEditor
        if (editor === undefined) {
            return
        }
        if (!["file", "untitled"].includes(editor.document.uri.scheme)) {
            // Fall back to a normal save when saving a document that isn't a local file, such as 'User Settings (JSON)', for convenience. #34
            vscode.commands.executeCommand("workbench.action.files.save")
            return
        }

        try {
            if (!editor.document.isUntitled) {  // Local files
                // Write the editor content to the file.
                await sudoWriteFile(editor.document.fileName, await vscode.workspace.encode(editor.document.getText(), { encoding: editor.document.encoding }), user)

                // Refocus the `editor` in case the user has switched to a different editor during save, to ensure the next command reverts the correct editor.
                if (vscode.window.activeTextEditor !== editor) {
                    await vscode.window.showTextDocument(editor.document, editor.viewColumn)
                }

                // Reload the file contents from the file system.
                await vscode.commands.executeCommand("workbench.action.files.revert")
            } else { // Untitled files
                // Get the filepath of the new file.
                /** @type {string} */
                let filename
                if (editor.document.fileName.startsWith("/")) {  // Untitled files opened with the "code" command (e.g. `code nonexistent.txt`)
                    filename = editor.document.fileName
                } else {  // Untitled files with a numbered name such as "Untitled-1"
                    // Show the save dialog.
                    const input = await vscode.window.showSaveDialog({})
                    if (input === undefined) {
                        return
                    }
                    filename = input.fsPath
                }

                // Write the editor content to the file.
                await sudoWriteFile(filename, await vscode.workspace.encode(editor.document.getText(), { encoding: editor.document.encoding }), user)

                // Save the viewColumn property before closing the editor.
                const column = editor.viewColumn

                // Refocus the `editor` in case the user has switched to a different editor during save, to ensure the next command reverts and closes the correct editor.
                if (vscode.window.activeTextEditor !== editor) {
                    await vscode.window.showTextDocument(editor.document, editor.viewColumn)
                }

                // Close the editor for the untitled file.
                await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor")

                // Open the new document in an editor.
                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(filename, { encoding: editor.document.encoding }), column)
            }
        } catch (err) {
            // Handle errors.
            if (err instanceof vscode.CancellationError) {
                return
            }
            console.error(err)
            if (err instanceof Error && "code" in err && err.code === "ENOENT" && "path" in err && err.path === "sudo") {  // #15
                await vscode.window.showErrorMessage(`[Save as Root] The extension could not find the sudo command. Install the sudo package using the system's package manager (e.g. apt-get install sudo).`)
                return
            } else if (err instanceof Error && err.message.includes("NixOS's wrapper.c failed.")) {  // #19
                await vscode.window.showErrorMessage(`[Save as Root] NixOS's security wrapper prevented the sudo command from running. Try setting the configuration "save-as-root.command" to "/usr/bin/sudo". \nOriginal error:\n${/** @type {Error} */(err).message}`)
                return
            }
            await vscode.window.showErrorMessage(`[Save as Root] ${/** @type {Error} */(err).message}`)
        }
    }))

    // Register the "Save as Specified User…" command.
    {
        // Persist the username input in the input box for the "Save as Specified User…" command until the VSCode's window is closed.
        let value = ""

        context.subscriptions.push(vscode.commands.registerCommand("save-as-root.saveFileAsSpecifiedUser", async () => {
            // Show an input box to select a user
            const user = value = await vscode.window.showInputBox({ value, placeHolder: "username", ignoreFocusOut: true }) || ""
            if (!user) {
                await vscode.window.showInformationMessage("Canceled.")
                return
            }

            // Redirect to the main command
            vscode.commands.executeCommand("save-as-root.saveFile", user)
        }))
    }

    // Initialize non-essential features ("New File as Root" and "Open as Root") if enabled in the configuration.
    const optionalFeatures = vscode.workspace.getConfiguration("save-as-root").get("optionalFeatures", ["new-file-as-root", "open-as-root"])

    // Register the "New File as Root..." command.
    if (optionalFeatures.includes("new-file-as-root")) {
        vscode.commands.executeCommand("setContext", "sqlite3-editor.activeFeatures.newFileAsRoot", true)

        context.subscriptions.push(vscode.commands.registerCommand("save-as-root.newFile", async (/** @type {vscode.Uri | undefined} */uri) => {
            try {
                /** @type {{ encoding: string } | undefined} */
                let encodingOptions

                // `uri` is set when the command is invoked from the explorer's context menu.
                // Otherwise, we fall back to the workspace folder or the user's home directory.
                // `uri` is set when the command is invoked from the explorer's context menu.
                // Otherwise, we fall back to the workspace folder or the user's home directory.
                if (uri === undefined && vscode.window.activeTextEditor !== undefined) {
                    uri = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)?.uri
                    encodingOptions = { encoding: vscode.window.activeTextEditor.document.encoding }
                }
                if (uri === undefined && vscode.workspace.workspaceFolders !== undefined && vscode.workspace.workspaceFolders.length > 0) {
                    uri = vscode.workspace.workspaceFolders[0].uri
                }
                if (uri === undefined) {
                    uri = vscode.Uri.parse(os.homedir())
                }

                if (uri.scheme !== "file") {
                    await vscode.window.showErrorMessage(`Unsupported uri scheme: ${uri.scheme}`)
                    return
                }
                const value = uri.fsPath + path.sep
                const filepath = await vscode.window.showInputBox({ value, valueSelection: [value.length, value.length] })
                if (!filepath || filepath.endsWith(path.sep)) {
                    return
                }
                uri = vscode.Uri.parse(filepath)
                const emptyString = encodingOptions === undefined ?  // TypeScript complains if undefined is passed as the second parameter to encode
                    await vscode.workspace.encode("") :
                    await vscode.workspace.encode("", encodingOptions)
                await sudoWriteFile(filepath, emptyString, "root")
                await vscode.commands.executeCommand("vscode.open", uri)
            } catch (err) {
                await vscode.window.showErrorMessage(`[Save as Root] ${/** @type {Error} */(err).message}`)
            }
        }))
    }

    // Initialize the "Open as Root" feature.
    if (optionalFeatures.includes("open-as-root")) {
        vscode.commands.executeCommand("setContext", "sqlite3-editor.activeFeatures.openAsRoot", true)

        /** @typedef {{ fn: string, args: any[] }} SudoFsParams */
        /** @typedef {{ ok: true, value: unknown } | { ok: false, message?: string, code?: string, fsError?: string }} SudoFsResult */

        /** Calls sudo-fs.js with sudo. */
        const sudoFs = async (/** @type {SudoFsParams["fn"]} */fn, /** @type {SudoFsParams["args"]} */...args) =>
            withTmpFile(async (tmpFile) => {
                /** @type {SudoFsResult} */
                let result
                try {
                    await fs.promises.writeFile(tmpFile, JSON.stringify({ fn, args }), { encoding: "utf-8" })
                    const stdout = await sudoExec([`nodePath=${process.execPath}`, `script=${context.asAbsolutePath("sudo-fs.js")}`, `tmpFile=${tmpFile}`], '"$nodePath" "$script" "$tmpFile"', "root")
                    const header = "result:"
                    if (!stdout.startsWith(header)) {
                        throw new Error(`The stdout of sudo-fs.js didn't start with "result:". The first 50 characters of stdout were: ${stdout.slice(0, 50)}`)
                    }

                    result = /** @type {SudoFsResult} */(JSON.parse(Buffer.from(stdout.slice(header.length), "hex").toString("utf-8")))
                } catch (err) {
                    throw err
                }
                if (!result.ok) {
                    switch (result.fsError) {
                        case "FileNotFound": throw vscode.FileSystemError.FileNotFound()
                        case "FileExists": throw vscode.FileSystemError.FileExists()
                        case "FileNotADirectory": throw vscode.FileSystemError.FileNotADirectory()
                        case "FileIsADirectory": throw vscode.FileSystemError.FileIsADirectory()
                        case "NoPermissions": throw vscode.FileSystemError.NoPermissions()
                        case "Unavailable": throw vscode.FileSystemError.Unavailable()
                    }
                    switch (result.code) {
                        case "ENOENT": throw vscode.FileSystemError.FileNotFound();
                        case "EEXIST": throw vscode.FileSystemError.FileExists();
                        case "ENOTDIR": throw vscode.FileSystemError.FileNotADirectory();
                        case "EISDIR": throw vscode.FileSystemError.FileIsADirectory();
                        case "EPERM": case "EACCES": case "EROFS": throw vscode.FileSystemError.NoPermissions();
                    }
                    if (result.code) {
                        throw new Error(result.code + ": " + result.message)
                    } else {
                        throw new Error(result.message)
                    }
                }
                return result.value
            })

        // Track open documents.
        // This is used to check whether opening a document failed, including permission errors.
        const openedFileSchemeTextDocuments = /** @type {Set<string>} */(new Set())
        context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((v) => {
            if (v.uri.scheme === "file") {
                openedFileSchemeTextDocuments.add(v.uri.fsPath)
            }
        }))
        context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((v) => {
            if (v.uri.scheme === "file") {
                openedFileSchemeTextDocuments.delete(v.uri.fsPath)
            }
        }))

        const checkTab = (/** @type {vscode.Tab} */tab) => {
            // 1. When a tab containing a text file is opened.
            if (!(tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === "file")) {
                return
            }

            // 2.1. If a matching text document does not exist.
            const filepath = tab.input.uri.fsPath
            if (openedFileSchemeTextDocuments.has(filepath)) {
                return
            }
            (async () => {
                // 2.2. And is also not created within 250 ms.
                await new Promise((resolve) => setTimeout(resolve, 250))
                if (openedFileSchemeTextDocuments.has(filepath)) {
                    return
                }

                // 3. Then check that the file is actually not readable.
                try {
                    await fs.promises.access(filepath, fs.constants.R_OK)
                    return
                } catch (err) {
                    if (!(err instanceof Error && "code" in err && (err.code === "EACCES" || err.code === "EPERM"))) {
                        return
                    }
                }

                // 4. Then open the document with the "open-as-root" file system provider,
                //    replacing the editor tab.
                if (await vscode.window.showErrorMessage("[Save as Root] Do you want to open the file as root?", "Open", "Cancel") === "Open") {
                    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: "open-as-root", path: filepath })), tab.group.viewColumn, true)
                    await vscode.window.tabGroups.close(tab)
                }
            })()
        }

        for (const tabGroup of vscode.window.tabGroups.all) {
            for (const tab of tabGroup.tabs) {
                checkTab(tab)
            }
        }

        context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs((e) => {
            for (const tab of e.opened) {
                checkTab(tab)
            }
        }))

        vscode.languages.registerCodeLensProvider({ scheme: "open-as-root" }, {
            provideCodeLenses(document, _token) {
                return [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), { title: "[Save as Root] Opening this file as root.", command: "noop" })]
            }
        })

        // Register the "open-as-root" file system provider
        const onDidChangeFile = /** @type {vscode.EventEmitter<vscode.FileChangeEvent[]>} */(new vscode.EventEmitter())
        context.subscriptions.push(vscode.workspace.registerFileSystemProvider("open-as-root", {
            onDidChangeFile: onDidChangeFile.event,  // unsupported
            watch(uri, options) {
                return { dispose() { } }  // unsupported
            },
            async stat(uri) {
                return /** @type {vscode.FileStat} */(await sudoFs("stat", uri.path))
            },
            async readDirectory(uri) {
                return /** @type {[string, vscode.FileType][]} */(await sudoFs("readDirectory", uri.path))
            },
            async createDirectory(uri) {
                await sudoFs("createDirectory", uri.path)
            },
            async readFile(uri) {
                return Buffer.from(/** @type {string} */(await sudoFs("readFile", uri.path)), "hex")
            },
            async writeFile(uri, content, options) {
                await sudoFs("writeFile", uri.path, Buffer.from(content).toString("hex"), { create: options.create, overwrite: options.overwrite })
            },
            async delete(uri, options) {
                await sudoFs("delete", uri.path, options.recursive)
            },
            async rename(oldUri, newUri, options) {
                await sudoFs("rename", oldUri.path, newUri.path, { overwrite: options.overwrite })
            },
            async copy(source, destination, options) {
                await sudoFs("copy", source.path, destination.path, { overwrite: options.overwrite })
            },
        }, {
            isCaseSensitive: true,  // Always case sensitive because this extension doesn't support Windows.
            isReadonly: false,
        }))
    }
}

exports.deactivate = () => { }
