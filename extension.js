const vscode = require('vscode')
const { execSync } = require('child_process')
const fs = require("fs")
const path = require("path")

exports.activate = (/** @type {vscode.ExtensionContext} */context) => {
    context.subscriptions.push(vscode.commands.registerCommand('save-as-root.saveFile', async () => {
        const editor = vscode.window.activeTextEditor
        if (editor === undefined) {
            return
        }
        if (!["file", "untitled"].includes(editor.document.uri.scheme)) {
            await vscode.window.showErrorMessage(`scheme ${editor.document.uri.scheme} is not supported.`)
            return
        }

        /** @type {string} */
        let fileName
        if (editor.document.isUntitled) { // New file
            const input = await vscode.window.showInputBox({ title: "New File", placeHolder: "/etc/nginx/nginx.conf" })
            if (input === undefined) {
                return
            }
            fileName = input
            fs.mkdirSync(path.dirname(fileName), { recursive: true })
        } else { // Save
            fileName = editor.document.fileName
        }
        try {
            // Save the file
            execSync(`sudo tee <&0 "$fileName" > /dev/null`, { shell: "/bin/bash", input: editor.document.getText(), env: { fileName } })

            // Reopen the file
            const column = editor.viewColumn
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fileName), column)
        } catch (err) {
            console.error(err)
            const message = /** @type {Error} */(err).message
            if (message.includes("a terminal is required to read the password")) {
                await vscode.window.showErrorMessage("Could not run sudo command without password.")
            } else {
                await vscode.window.showErrorMessage(message)
            }
        }
    }))
}

exports.deactivate = () => {}
