import { readdirSync } from 'node:fs'
import { run } from 'node:test'
import { tap } from 'node:test/reporters'
import process from 'node:process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url))
const testDirectory = path.resolve(scriptsDirectory, '../src/lib')
const testFiles = readdirSync(testDirectory)
  .filter((file) => file.endsWith('.test.js'))
  .sort()
  .map((file) => path.join(testDirectory, file))

if (testFiles.length === 0) {
  console.error(`No test files found in ${testDirectory}`)
  process.exitCode = 1
} else {
  run({ files: testFiles })
    .on('test:fail', () => {
      process.exitCode = 1
    })
    .compose(tap)
    .pipe(process.stdout)
}
