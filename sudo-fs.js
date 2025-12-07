/** @file This file is called as `sudo node sudo-fs.js <args>` and accesses the file system with privileges. */

const fs = require("fs")
const path = require("path")

if (process.argv.length < 3) {
    process.exit(1)
}

/** @typedef {{ fn: string, args: any[] }} SudoFsParams */
/** @typedef {{ ok: true, value: unknown } | { ok: false, message?: string, code?: string, fsError?: string }} SudoFsResult */

const { fn, args } = /** @type {SudoFsParams} */(JSON.parse(fs.readFileSync(process.argv[2], { encoding: "utf-8" })))

const writeResult = (/** @type {SudoFsResult} */data) => {
    console.log("result:" + Buffer.from(JSON.stringify(data)).toString("hex"))
}

const getFileType = (/** @type {fs.Stats | fs.Dirent} */stat) => {
    let fileType = 0  // vscode.FileType.Unknown
    if (stat.isFile()) {
        fileType |= 1  // vscode.FileType.File
    } else if (stat.isDirectory()) {
        fileType |= 2  // vscode.FileType.Directory
    }
    if (stat.isSymbolicLink()) {
        fileType |= 64  // vscode.FileType.SymbolicLink
    }
    return fileType
}

try {
    switch (fn) {
        case "stat":
            const stat = fs.lstatSync(args[0])
            const { ctimeMs, mtimeMs, size } = stat
            writeResult({ ok: true, value: { type: getFileType(stat), ctime: ctimeMs, mtime: mtimeMs, size } })
            break
        case "readDirectory":
            writeResult({ ok: true, value: fs.readdirSync(args[0], { withFileTypes: true }).map((v) => [v.name, getFileType(v)]) })
            break
        case "createDirectory":
            fs.mkdirSync(args[0])
            break
        case "readFile":
            writeResult({ ok: true, value: fs.readFileSync(args[0], { encoding: "hex" }) })
            break
        case "writeFile":
            if (!args[2].create && !fs.existsSync(args[0])) {
                writeResult({ ok: false, fsError: "FileNotFound" })
                break
            } else if (args[2].create && !fs.existsSync(path.dirname(args[0]))) {
                writeResult({ ok: false, fsError: "FileNotFound" })
                break
            } else if (args[2].create && !args[2].overwrite && fs.existsSync(args[0])) {
                writeResult({ ok: false, fsError: "FileExists" })
                break
            }
            fs.writeFileSync(args[0], Buffer.from(args[1], "hex"))
            writeResult({ ok: true, value: null })
            break
        case "delete":
            fs.rmSync(args[0], args[1])
            writeResult({ ok: true, value: null })
            break
        case "rename":
            if (!args[2].overwrite && fs.existsSync(args[1])) {
                writeResult({ ok: false, fsError: "FileExists" })
                break
            }
            fs.renameSync(args[0], args[1])
            writeResult({ ok: true, value: null })
            break
        case "copy":
            if (!args[2].overwrite && fs.existsSync(args[1])) {
                writeResult({ ok: false, fsError: "FileExists" })
                break
            }
            if (fs.statSync(args[0]).isDirectory()) {
                fs.cpSync(args[0], args[1], { recursive: true })
            } else {
                fs.copyFileSync(args[0], args[1])
            }
            writeResult({ ok: true, value: null })
            break
    }
} catch (err) {
    writeResult({
        ok: false,
        message: err instanceof Error ? err.message : "" + err,
        code: err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined,
    })
}
