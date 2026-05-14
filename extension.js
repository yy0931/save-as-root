/**
 * @file Provides the following commands to VSCode:
 * - save-as-root-remote-ssh.saveFile(user: string = "root"): Saves the current file with root privileges or as the specified user
 * - save-as-root-remote-ssh.saveFileAsSpecifiedUser(): Prompts for a username and saves the current file as that user
 * - save-as-root-remote-ssh.newFile(uri?: vscode.Uri): Creates a new file with root privileges at the optional URI path
 * 
 * Notes:
 * - This script is intentionally written in JavaScript instead of TypeScript, as it's a small single-file script.
 *   I will not accept PRs converting this project to TypeScript.
 * - Feel free to fork this project, but do **not** remove the LICENSE file, as was done in this fork: https://github.com/FriedrichVoelker/vscode-root-on-remote/issues/2
 */

const vscode = require("vscode")
const { execFile } = require("child_process")
const os = require("os")
const path = require("path")

/** @returns {Promise<void>} */
const sudoWriteFile = async (/** @type {string} */filename, /** @type {string | Uint8Array} */content, /** @type {string} the `sudo --user=user` option  */user) => {
    const config = vscode.workspace.getConfiguration("save-as-root-remote-ssh")
    return new Promise((resolve, reject) => {
        // 1. Authenticate with `sudo -S -p 'password:' sh`.
        // 2. Call `echo file contents:` to inform the parent process that the authentication was successful.
        // 3. Write the file contents with `cat <&0 > "$filename"`.
        const p = execFile(/* "sudo" or "/usr/bin/sudo" */config.get("command", "sudo"), [...(user === "root" ? [] : ["-u", user]), "-S", "-p", "password:", `filename=${filename}`, "sh", "-c", 'echo "file contents:" >&2; cat <&0 > "$filename"'])
        p.on("error", (err) => {
            stopTimer()
            reject(err)
        })
        const cancel = (/** @type {Error} */err) => {
            if (!p.killed) { p.kill() }
            stopTimer()
            reject(err)
        }

        // Set a timeout as the script may wait forever for stdin on error.
        /** @type {NodeJS.Timeout | null} */
        let timer = null
        const startTimer = () => {
            timer = setTimeout(() => {
                if (p.exitCode === null) {
                    cancel(new Error(`Timeout: ${stderr}`))
                }
            }, 60 * 1000)  // #17
        }
        const stopTimer = () => {
            if (timer !== null) { clearTimeout(timer) }
            timer = null
        }
        startTimer()

        // Handle stderr.
        let stderr = ""
        p.stderr?.on("data", (/** @type {Buffer} */chunk) => {
            const lines = chunk.toString().split("\n").map((line) => line.trim())
            if (lines.includes("password:")) {
                // Show a password prompt.
                stopTimer()
                vscode.window.showInputBox({ password: true, title: "Save as Root", placeHolder: `password for ${os.userInfo().username}`, prompt: stderr !== "" ? `\n${stderr}` : "", ignoreFocusOut: true }).then((password) => {
                    if (password === undefined) { return cancel(new vscode.CancellationError()) }
                    startTimer()
                    p.stdin?.write(`${password}\n`)
                }, cancel)
                stderr = ""
            } else if (lines.includes("file contents:")) {
                // Write to the file when the authentication is succeeded.
                p.stdin?.write(content)
                p.stdin?.end()
                stderr += lines.slice(lines.lastIndexOf("file contents:") + 1).join("\n")
            } else {
                // Concatenate error messages.
                stderr += chunk.toString()
            }
        })

        // Handle the exit event.
        p.on("exit", (code) => {
            stopTimer()
            if (code === 0) {
                return resolve()
            } else {
                reject(new Error(`exit code ${code}: ${stderr}`))
            }
        })
    })
}

/**
 * @typedef {{
 *     onWillSaveDocument(document: vscode.TextDocument, reason: vscode.TextDocumentSaveReason): Promise<void>
 *     onDocumentSaved(document: vscode.TextDocument): Promise<void>
 * }} SaveEventsAPI
 */

/**
 * Calls the 'on save' API (the return value of activate()) of pucelle's "Run on Save", or any other extension with a compatible API. #35
 * We assume the extensions specified in the configuration "save-as-root-remote-ssh.extensionsToNotifyOnSave" implement {@link SaveEventsAPI}.
 */
const notifyToOtherExtensions = async (/** @type {"willSave" | "didSave"} */eventName, /** @type {vscode.TextDocument} */document) => {
    for (const extensionId of
        // Get the list of extensions to notify from the configuration.
        vscode.workspace.getConfiguration("save-as-root-remote-ssh").get("extensionsToNotifyOnSave", /** @type {string[]} */([]))
    ) {
        // Get the extension, skipping if the extension is not installed.
        const extension = vscode.extensions.getExtension(extensionId)
        if (extension === undefined) {
            continue
        }

        // Activate the extension if it is not active yet.
        if (!extension.isActive) {
            await extension.activate()
        }

        // Call an API function of the extension.
        const exports = /** @type {SaveEventsAPI} */(extension.exports)
        switch (eventName) {
            case "willSave":
                if (typeof exports.onWillSaveDocument === "function") {
                    await exports.onWillSaveDocument(document, vscode.TextDocumentSaveReason.Manual)
                }
                break
            case "didSave":
                if (typeof exports.onDocumentSaved === "function") {
                    await exports.onDocumentSaved(document)
                }
                break
        }
    }
}

exports.activate = (/** @type {vscode.ExtensionContext} */context) => {
    // Register the "Save as Root" command.
    context.subscriptions.push(vscode.commands.registerCommand("save-as-root-remote-ssh.saveFile", async (/** @type {string | undefined} */user = "root") => {
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
                // Trigger the will save event.
                await notifyToOtherExtensions("willSave", editor.document)

                // Write the editor content to the file.
                await sudoWriteFile(editor.document.fileName, await vscode.workspace.encode(editor.document.getText(), { encoding: editor.document.encoding }), user)

                // Refocus the `editor` in case the user has switched to a different editor during save, to ensure the next command reverts the correct editor.
                if (vscode.window.activeTextEditor !== editor) {
                    await vscode.window.showTextDocument(editor.document, editor.viewColumn)
                }

                // Reload the file contents from the file system.
                await vscode.commands.executeCommand("workbench.action.files.revert")

                // Trigger the did save event.
                await notifyToOtherExtensions("didSave", editor.document)
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

                // Create a new file and open it as a document.
                await sudoWriteFile(filename, "", user)
                const newDocument = await vscode.workspace.openTextDocument(filename, { encoding: editor.document.encoding })

                // Trigger the will save event.
                await notifyToOtherExtensions("willSave", newDocument)

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
                await vscode.window.showTextDocument(newDocument, column)

                // Reload the file contents from the file system.
                await vscode.commands.executeCommand("workbench.action.files.revert")

                // Trigger the did save event.
                await notifyToOtherExtensions("didSave", newDocument)
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
                await vscode.window.showErrorMessage(`[Save as Root] NixOS's security wrapper prevented the sudo command from running. Try setting the configuration "save-as-root-remote-ssh.command" to "/usr/bin/sudo". \nOriginal error:\n${/** @type {Error} */(err).message}`)
                return
            }
            await vscode.window.showErrorMessage(`[Save as Root] ${/** @type {Error} */(err).message}`)
        }
    }))

    // Register the "Save as Specified User…" command.
    {
        // Persist the username input in the input box for the "Save as Specified User…" command until the VSCode's window is closed.
        let value = ""

        context.subscriptions.push(vscode.commands.registerCommand("save-as-root-remote-ssh.saveFileAsSpecifiedUser", async () => {
            // Show an input box to select a user
            const user = value = await vscode.window.showInputBox({ value, placeHolder: "username", ignoreFocusOut: true }) || ""
            if (!user) {
                await vscode.window.showInformationMessage("Canceled.")
                return
            }

            // Redirect to the main command
            vscode.commands.executeCommand("save-as-root-remote-ssh.saveFile", user)
        }))
    }

    // Register the "New File as Root..." command.
    context.subscriptions.push(vscode.commands.registerCommand("save-as-root-remote-ssh.newFile", async (/** @type {vscode.Uri | undefined} */uri) => {
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

exports.deactivate = () => { }
