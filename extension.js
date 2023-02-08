const vscode = require("vscode")
const { execFile } = require("child_process")
const os = require("os")

/** @returns {Promise<void>} */
const sudoWriteFile = async (/** @type {string} */filename, /** @type {string} */content) => {
    const config = vscode.workspace.getConfiguration("save-as-root")
    return new Promise((resolve, reject) => {
        // 1. Authenticate with `sudo -S -p 'password:' sh`
        // 2. Call `echo file contents:` to inform the parent process that the authentication was successful
        // 3. Write the file contents with `cat <&0 > "$filename"`
        const p = execFile(/* "sudo" or "/usr/bin/sudo" */config.get("command", "sudo"), ["-S", "-p", "password:", `filename=${filename}`, "sh", "-c", 'echo "file contents:" >&2; cat <&0 > "$filename"'])
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
            }, 60 * 1000)  // #17
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

exports.activate = (/** @type {vscode.ExtensionContext} */context) => {
    context.subscriptions.push(vscode.commands.registerCommand("save-as-root.saveFile", async () => {
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
            if (!editor.document.isUntitled) {
                // Write the editor content to the file
                await sudoWriteFile(editor.document.fileName, editor.document.getText())

                // Reload the file contents from the file system
                await vscode.commands.executeCommand("workbench.action.files.revert")
            } else if (editor.document.uri.fsPath.startsWith("/")) {  // Untitled files with associated path (e.g. `code nonexistent.txt`)
                // Write the editor content to the file
                await sudoWriteFile(editor.document.fileName, editor.document.getText())

                // Save the viewColumn property before closing the editor
                const column = editor.viewColumn

                // Close the editor for the untitled file
                await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor")

                // Open the newly created file
                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(editor.document.uri.fsPath), column)
            } else { // Untitled files with a name such as "Untitled-1"
                // Show the save dialog
                const input = await vscode.window.showSaveDialog({})
                if (input === undefined) {
                    return
                }
                const filename = input.fsPath

                // Create a file and write the editor content to it
                await sudoWriteFile(filename, editor.document.getText())

                // Save the viewColumn property before closing the editor
                const column = editor.viewColumn

                // Close the editor for the untitled file
                await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor")

                // Open the newly created file
                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(filename), column)
            }
        } catch (err) {
            // Handle errors
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
}

exports.deactivate = () => { }
