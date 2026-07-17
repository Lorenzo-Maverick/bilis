/**
 * @file generate-proto.js
 * @description Generate single WAProto/index.js from all .proto files.
 *   Adapted for bilis CJS single-file WAProto structure.
 * @author Denzy ZeroDay
 */

const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const PROTO_DIR = path.resolve(__dirname, '..', 'WAProto')
const OUTPUT_FILE = path.join(PROTO_DIR, 'index.js')

// Recursively collect all .proto files
function getProtoFiles(dir) {
    const files = fs.readdirSync(dir, { withFileTypes: true })
    return files
        .flatMap((file) => {
            const filePath = path.join(dir, file.name)
            return file.isDirectory() ? getProtoFiles(filePath) : filePath
        })
        .filter((file) => file.endsWith('.proto'))
}

const protoFiles = getProtoFiles(PROTO_DIR)

if (protoFiles.length === 0) {
    // Fallback: single WAProto.proto at root
    const singleProto = path.join(PROTO_DIR, 'WAProto.proto')
    if (!fs.existsSync(singleProto)) {
        console.error('No .proto files found.')
        process.exit(1)
    }
    protoFiles.push(singleProto)
}

console.log(`Found ${protoFiles.length} proto file(s). Cleaning...`)

// Pass 1: Clean all proto files
protoFiles.forEach((file) => {
    try {
        let content = fs.readFileSync(file, 'utf8')

        // Ensure proto3 syntax
        if (/syntax\s*=/.test(content)) {
            content = content.replace(/syntax\s*=\s*"[^"]+"/i, 'syntax = "proto3";')
        } else {
            content = `syntax = "proto3";\n${content}`
        }

        // Clean duplicated semicolons
        content = content.replace(/;;+/g, ';')

        // Replace "required" with "optional"
        content = content.replace(/\brequired\s+/g, 'optional ')

        fs.writeFileSync(file, content, 'utf8')
    } catch (err) {
        console.error(`Error cleaning ${file}: ${err.message}`)
    }
})

console.log('Cleaning complete. Generating single index.js...')

// Pass 2: Generate single combined index.js
const pbjsCommand = [
    `npx pbjs`,
    `-t static-module`,
    `-w commonjs`,
    `--keep-case`,
    `-o "${OUTPUT_FILE}"`,
    ...protoFiles.map(f => `"${f}"`)
].join(' ')

try {
    execSync(pbjsCommand, { stdio: 'inherit' })
    console.log(`Generated: WAProto/index.js`)
} catch (err) {
    console.error('PBJS FAILED:', err.message)
    process.exit(1)
}

// Pass 3: Fix proto references - ganti waproto -> proto biar kompatibel bilis
let content = fs.readFileSync(OUTPUT_FILE, 'utf8')
content = content.replaceAll('waproto', 'proto')
fs.writeFileSync(OUTPUT_FILE, content, 'utf8')

console.log('DONE.')
