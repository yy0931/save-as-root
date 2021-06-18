const vscode = require('vscode')
const { execSync } = require('child_process')
const fs = require("fs")
const path = require("path")

const sudoWriteFileSync = (/** @type {string} */filename, /** @type {string} */content) => {
    execSync(`sudo tee <&0 "$filename" > /dev/null`, { shell: "/bin/bash", input: content, env: { filename } })
}

exports.activate = (/** @type {vscode.ExtensionContext} */context) => {
    context.subscriptions.push(vscode.commands.registerCommand('save-as-root.saveFile', async () => {
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
                fs.mkdirSync(path.dirname(filename), { recursive: true })  // FIXME: Use sudo if permission error occurs
                sudoWriteFileSync(filename, editor.document.getText())

                const column = editor.viewColumn

                // Delete all so that the save dialog doesn't appear
                await editor.edit((editBuilder) => editBuilder.delete(new vscode.Range(0, 0, editor.document.lineCount, 0)))

                // Close the editor for the untitled file
                await vscode.commands.executeCommand('workbench.action.closeActiveEditor')

                // open the newly created file
                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(filename), column)
            } else {
                // write the editor content to the file
                sudoWriteFileSync(editor.document.fileName, editor.document.getText())

                // Reload the file content from the file system
                await vscode.commands.executeCommand("workbench.action.files.revert")
            }
        } catch (err) {
            // Handle errors
            console.error(err)
            const message = /** @type {Error} */(err).message
            if (message.includes("a terminal is required to read the password")) {
                await vscode.window.showErrorMessage("Could not run sudo command without password.")
                return
            }
            await vscode.window.showErrorMessage(message)
        }
    }))
}

exports.deactivate = () => { }
