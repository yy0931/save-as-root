const vscode = require("vscode")
const { execFile } = require("child_process")
const os = require("os")
const fs = require("fs")

/** @returns {Promise<void>} */
const sudoWriteFile = async (/** @type {string} */filename, /** @type {string} */content) => {
    return new Promise((resolve, reject) => {
        // 1. Authenticate with `sudo -S -p 'password:' sh`
        // 2. Call `echo file contents:` to inform the parent process that the authentication was successful
        // 3. Write the file contents with `cat <&0 > "$filename"`
        const p = execFile("sudo", ["-S", "-p", "password:", `filename=${filename}`, "sh", "-c", 'echo "file contents:" >&2; cat <&0 > "$filename"'])
        p.on("error", (err) => {
            stopTimer()
            reject(err)
        })
        const cancel = (/** @type {Error} */err) => {
            if (!p.killed) { p.kill() }
            stopTimer()
            reject(err)
        }

        // Set a timeout because the script may wait forever for stdin on error
        /** @type {NodeJS.Timeout | null} */
        let timer = null
        const startTimer = () => {
            timer = setTimeout(() => {
                if (p.exitCode === null) {
                    cancel(new Error(`Timeout: ${stderr}`))
                }
            }, 5000)
        }
        const stopTimer = () => {
            if (timer !== null) { clearTimeout(timer) }
            timer = null
        }
        startTimer()

        // Handle stderr
        let stderr = ""
        p.stderr?.on("data", (/** @type {Buffer} */chunk) => {
            const lines = chunk.toString().split("\n").map((line) => line.trim())
            if (lines.includes("password:")) {
                // Password prompt
                stopTimer()
                vscode.window.showInputBox({ password: true, title: "Save as Root", placeHolder: `password for ${os.userInfo().username}`, prompt: stderr !== "" ? `\n${stderr}` : "", ignoreFocusOut: true }).then((password) => {
                    if (password === undefined) { return cancel(new vscode.CancellationError()) }
                    startTimer()
                    p.stdin?.write(`${password}\n`)
                }, cancel)
                stderr = ""
            } else if (lines.includes("file contents:")) {
                // Authentication succeeded
                p.stdin?.write(content)
                p.stdin?.end()
                stderr += lines.slice(lines.lastIndexOf("file contents:") + 1).join("\n")
            } else {
                // Error messages
                stderr += chunk.toString()
            }
        })

        // Exit
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

exports.activate = async (/** @type {vscode.ExtensionContext} */context) => {
    context.subscriptions.push(vscode.commands.registerCommand("save-as-root.saveFile.noconfirm", async () => {
        // Check the status of the editor
        const editor = vscode.window.activeTextEditor
        if (editor === undefined) {
            return
        }
        if (!["file", "untitled"].includes(editor.document.uri.scheme)) {
            await vscode.window.showErrorMessage(`scheme ${editor.document.uri.scheme} is not supported.`)
            return
        }

        try {
            if (editor.document.isUntitled) {
                // Show the save dialog
                const input = await vscode.window.showSaveDialog({})
                if (input === undefined) {
                    return
                }
                const filename = input.fsPath

                // Create a file and write the editor content to it
                await sudoWriteFile(filename, editor.document.getText())

                const column = editor.viewColumn

                // Clear the content of the editor so that the save dialog won't be displayed when executing `workbench.action.closeActiveEditor`.
                await editor.edit((editBuilder) => editBuilder.delete(new vscode.Range(0, 0, editor.document.lineCount, 0)))

                // Close the editor for the untitled file
                await vscode.commands.executeCommand("workbench.action.closeActiveEditor")

                // Open the newly created file
                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(filename), column)
            } else {
                // Write the editor content to the file
                await sudoWriteFile(editor.document.fileName, editor.document.getText())

                // Reload the file contents from the file system
                await vscode.commands.executeCommand("workbench.action.files.revert")
            }
        } catch (err) {
            // Handle errors
            if (err instanceof vscode.CancellationError) {
                return
            }
            console.error(err)
            await vscode.window.showErrorMessage(`[Save as Root] ${/** @type {Error} */(err).message}`)
        }

    }))

    // Override Ctrl+S if the current user does not have write permission to the active file.
    const checkFilePermissionAndToggleCtrlSKeybinding = async (/** @type {vscode.TextEditor | undefined} */e) => {
        if (e?.document.uri.scheme !== "file" || process.platform === "win32") {
            await vscode.commands.executeCommand("setContext", "save-as-root.noWriteAccess", false)
            return
        }
        try {
            await fs.promises.access(e.document.uri.fsPath, fs.constants.W_OK)
        } catch (err) {
            await vscode.commands.executeCommand("setContext", "save-as-root.noWriteAccess", err instanceof Error && /** @type {Error & { code: string }} */(err).code === "EACCES")
            return
        }
        await vscode.commands.executeCommand("setContext", "save-as-root.noWriteAccess", false)
    }
    await checkFilePermissionAndToggleCtrlSKeybinding(vscode.window.activeTextEditor)
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(async (e) => {
        await checkFilePermissionAndToggleCtrlSKeybinding(e)
    }))

    context.subscriptions.push(vscode.commands.registerCommand("save-as-root.saveFile", async () => {
        if (await vscode.window.showInformationMessage("Use sudo?", "Yes", "No") === "Yes") {
            await vscode.commands.executeCommand("save-as-root.saveFile.noconfirm")
        }
    }))

    // Update "save-as-root.requiresSudo" context key
    {
        const update = async (/** @type {vscode.TextEditor | undefined} */e) => {
            await vscode.commands.executeCommand("setContext", "save-as-root.requiresSudo",
                process.platform !== "win32" &&
                e?.document.uri.scheme === "file" &&
                !await hasWritePermission(e.document.uri.fsPath))
        }
        await update(vscode.window.activeTextEditor)
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(async (e) => { await update(e) }))
    }
}

exports.deactivate = () => { }

const hasWritePermission = async (/** @type {string} */fsPath) => {
    try { await fs.promises.access(fsPath, fs.constants.W_OK) } catch (/** @type {any} */err) { return !["EACCES", "EPERM"].includes(err.code) }
    return true
}
