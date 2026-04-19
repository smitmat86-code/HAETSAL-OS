#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, renameSync } from 'fs'
import { basename, dirname, join } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

function fail(message: string): never {
  console.error(`\nCHECKOUT FAILED: ${message}`)
  process.exit(1)
}

function run(command: string): void {
  console.log(`\n> ${command}`)
  const result = spawnSync(command, { cwd: ROOT, stdio: 'inherit', shell: true })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function capture(command: string): string {
  const result = spawnSync(command, { cwd: ROOT, encoding: 'utf8', shell: true })
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout.trim()
}

function option(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index > -1 ? basename(process.argv[index + 1] ?? '') : null
}

function activeSpecNames(): string[] {
  return readdirSync(join(ROOT, 'specs', 'active'), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name !== '.gitkeep')
    .map(entry => entry.name)
}

function ensureSessionLogTouched(): void {
  if (!capture('git status --porcelain -- SESSION_LOG.md')) {
    fail('SESSION_LOG.md is not updated. Append the session entry before running checkout.')
  }
}

function changedPaths(): string[] {
  return capture('git status --porcelain')
    .split('\n')
    .filter(Boolean)
    .map(line => line.slice(3).trim())
}

function warnOptionalDocs(changed: string[]): void {
  const touchedCode = changed.some(path => /^(src|tests|migrations|pages\/src|pages\/functions)\//.test(path))
  if (touchedCode && !changed.includes('LESSONS.md')) {
    console.warn('\n! Reminder: LESSONS.md was not updated. Confirm there was no new edge case worth recording.')
  }
  if (touchedCode && !changed.includes('CONVENTIONS.md')) {
    console.warn('\n! Reminder: CONVENTIONS.md was not updated. Confirm there was no new reusable pattern worth recording.')
  }
}

function resolveSpecName(): string | null {
  const explicit = option('--spec')
  if (explicit) return explicit
  const active = activeSpecNames()
  return active.length === 1 ? active[0]! : null
}

function handleSpecLifecycle(): void {
  const specName = resolveSpecName()
  if (!specName) return
  const active = join(ROOT, 'specs', 'active', specName)
  const completed = join(ROOT, 'specs', 'completed', specName)
  const current = existsSync(active) ? active : completed
  if (!existsSync(current)) fail(`Spec not found: ${specName}`)
  if (!readFileSync(current, 'utf8').includes('## As-Built Record')) {
    fail(`Spec is missing "## As-Built Record": ${specName}`)
  }
  if (existsSync(active)) {
    renameSync(active, completed)
    console.log(`\nMoved spec to completed: specs/completed/${specName}`)
  }
}

console.log('Checkout protocol starting...')
ensureSessionLogTouched()
warnOptionalDocs(changedPaths())
run('npm run postflight')
run('npm test')
run('npm run manifest')
handleSpecLifecycle()
run('npm run postflight')
console.log('\nCheckout protocol passed.')
