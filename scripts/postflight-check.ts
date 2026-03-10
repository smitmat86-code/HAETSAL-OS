#!/usr/bin/env node
/**
 * postflight-check.ts
 *
 * Automated mechanical checks run at session CHECK-OUT.
 * Catches convention violations that don't require design judgment.
 *
 * Run: npm run postflight
 *
 * Exit code 0 = all clear. Non-zero = violations found.
 *
 * To add project-specific checks:
 * 1. Write a function that returns Violation[]
 * 2. Add it to the allViolations array at the bottom
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, relative, extname, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Configuration ──────────────────────────────────────────────────

// File size limits from CONVENTIONS.md — customize per project
const LINE_LIMITS: Record<string, number> = {
    '.tsx': 200,
    '.ts': 150,
    // PROJECT: Add your backend language limits:
    // '.rs': 300,
    // '.go': 300,
    // '.py': 200,
};

// Test files get a higher limit — test setup is inherently verbose
const TEST_LINE_LIMIT = 400;

const PACKAGES_DIR = join(ROOT, 'packages');
const SRC_DIR = join(ROOT, 'src');
const PAGES_SRC_DIR = join(ROOT, 'pages', 'src');
const PAGES_FUNCTIONS_DIR = join(ROOT, 'pages', 'functions');
const MIGRATIONS_DIR = join(ROOT, 'migrations');

// Packages excluded from certain checks (e.g., legacy code, copied libraries)
const LEGACY_PACKAGES: string[] = [
    // PROJECT: Add package names to exclude from checks
    // 'legacy-module',
];

// Files accepted as over-limit — reviewed and approved
const FILE_SIZE_ACCEPTED = new Set<string>([
    // PROJECT: Add accepted over-limit files with justification:
    // 'packages/worker/src/services/auth-service.ts',  // Auth flows are multi-step
]);

interface Violation {
    check: string;
    file: string;
    line?: number;
    detail: string;
}

// ── File walker ────────────────────────────────────────────────────

function walkFiles(dir: string, extensions: string[]): string[] {
    const results: string[] = [];
    if (!existsSync(dir)) return results;

    function walk(d: string) {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
            const full = join(d, entry.name);
            if (entry.isDirectory()) {
                if (['node_modules', 'target', 'dist', '.git'].includes(entry.name)) continue;
                walk(full);
            } else if (entry.isFile()) {
                if (extensions.length === 0 || extensions.includes(extname(entry.name))) {
                    results.push(full);
                }
            }
        }
    }
    walk(dir);
    return results;
}

function isLegacyPackage(filePath: string): boolean {
    const rel = relative(ROOT, filePath).replace(/\\/g, '/');
    return LEGACY_PACKAGES.some(pkg => rel.startsWith(`packages/${pkg}/`));
}

function isTestFile(filePath: string): boolean {
    const name = filePath.replace(/\\/g, '/');
    return name.includes('.test.') || name.includes('.spec.')
        || name.includes('__test') || name.includes('/tests/');
}

// ── Universal Checks ───────────────────────────────────────────────

/**
 * Check 1: File size limits
 * Enforces CONVENTIONS.md line limits per file extension.
 */
function checkFileSizeLimits(): Violation[] {
    const violations: Violation[] = [];
    const extensions = Object.keys(LINE_LIMITS);
    const files = [
        ...walkFiles(PACKAGES_DIR, extensions),
        ...walkFiles(SRC_DIR, extensions),
        ...walkFiles(PAGES_SRC_DIR, extensions),
        ...walkFiles(PAGES_FUNCTIONS_DIR, extensions),
    ];

    for (const file of files) {
        if (isLegacyPackage(file)) continue;
        if (FILE_SIZE_ACCEPTED.has(relative(ROOT, file).replace(/\\/g, '/'))) continue;

        const ext = extname(file);
        const isTest = isTestFile(file);
        const limit = isTest ? TEST_LINE_LIMIT : (LINE_LIMITS[ext] || 150);

        const content = readFileSync(file, 'utf-8');
        const lines = content.split('\n').length;
        if (lines > limit) {
            violations.push({
                check: 'File Size',
                file: relative(ROOT, file),
                detail: `${lines} lines (limit: ${limit}${isTest ? ', test' : ''})`,
            });
        }
    }
    return violations;
}

/**
 * Check 2: Banned patterns
 * Catches eval(), new Function(), : any, and other dangerous patterns.
 */
function checkBannedPatterns(): Violation[] {
    const violations: Violation[] = [];

    const tsFiles = [
        ...walkFiles(PACKAGES_DIR, ['.ts', '.tsx']),
        ...walkFiles(SRC_DIR, ['.ts', '.tsx']),
        ...walkFiles(PAGES_SRC_DIR, ['.ts', '.tsx']),
        ...walkFiles(PAGES_FUNCTIONS_DIR, ['.ts', '.tsx']),
    ];
    const tsBanned = [
        { pattern: /\beval\s*\(/, name: 'eval()' },
        { pattern: /new\s+Function\s*\(/, name: 'new Function()' },
        { pattern: /:\s*any\b/, name: ': any' },
    ];

    for (const file of tsFiles) {
        if (isLegacyPackage(file)) continue;
        if (file.endsWith('.d.ts')) continue;
        const isTest = isTestFile(file);

        const content = readFileSync(file, 'utf-8');
        const lines = content.split('\n');
        const rel = relative(ROOT, file);

        for (const { pattern, name } of tsBanned) {
            if (name === ': any' && isTest) continue;
            for (let i = 0; i < lines.length; i++) {
                const trimmed = lines[i].trim();
                if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
                if (pattern.test(lines[i])) {
                    violations.push({
                        check: 'Banned Pattern',
                        file: rel,
                        line: i + 1,
                        detail: `Found '${name}'`,
                    });
                }
            }
        }
    }

    // PROJECT: Add backend language banned patterns here:
    // Example for Rust: check for .unwrap() in production code
    // const rsFiles = walkFiles(PACKAGES_DIR, ['.rs']);
    // for (const file of rsFiles) {
    //     if (isLegacyPackage(file) || isTestFile(file)) continue;
    //     // ... check for .unwrap() outside #[cfg(test)]
    // }

    return violations;
}

/**
 * Check 3: SQL safety
 * Catches string interpolation inside .prepare() calls.
 */
function checkSqlSafety(): Violation[] {
    const violations: Violation[] = [];
    const tsFiles = [
        ...walkFiles(PACKAGES_DIR, ['.ts']),
        ...walkFiles(SRC_DIR, ['.ts']),
        ...walkFiles(PAGES_SRC_DIR, ['.ts']),
        ...walkFiles(PAGES_FUNCTIONS_DIR, ['.ts']),
    ];

    for (const file of tsFiles) {
        if (isLegacyPackage(file)) continue;

        const content = readFileSync(file, 'utf-8');
        const rel = relative(ROOT, file);

        // Match: .prepare(`...${...}...`) — template literal with interpolation in SQL
        // Suppress with: // postflight-safe: <reason> on the preceding line
        const lines = content.split('\n');
        const prepareBlockRegex = /\.prepare\s*\(\s*`([^`]*\$\{[^`]*)`/g;
        let match;
        while ((match = prepareBlockRegex.exec(content)) !== null) {
            const upToMatch = content.substring(0, match.index);
            const lineNum = upToMatch.split('\n').length;
            const prevLine = lineNum >= 2 ? lines[lineNum - 2].trim() : '';
            if (prevLine.startsWith('// postflight-safe:')) continue;
            violations.push({
                check: 'SQL Safety',
                file: rel,
                line: lineNum,
                detail: 'String interpolation ${} in .prepare() — use parameterized queries',
            });
        }
    }
    return violations;
}

/**
 * Check 4: Duplicate tables in migrations
 * Catches the same CREATE TABLE appearing in multiple migration files.
 */
function checkDuplicateTables(): Violation[] {
    const violations: Violation[] = [];
    if (!existsSync(MIGRATIONS_DIR)) return violations;

    const migrationFiles = walkFiles(MIGRATIONS_DIR, ['.sql']);
    const tables = new Map<string, string[]>();

    for (const file of migrationFiles) {
        const content = readFileSync(file, 'utf-8');
        const rel = relative(ROOT, file);
        const regex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;
        let match;
        while ((match = regex.exec(content)) !== null) {
            const name = match[1].toLowerCase();
            if (!tables.has(name)) tables.set(name, []);
            tables.get(name)!.push(rel);
        }
    }

    for (const [table, files] of tables) {
        if (files.length > 1) {
            violations.push({
                check: 'Schema Consistency',
                file: files.join(', '),
                detail: `Table '${table}' created in multiple migrations`,
            });
        }
    }
    return violations;
}

/**
 * Check 5: Spec As-Built Record
 * Active specs must have an As-Built Record section before completion.
 */
function checkSpecAsBuilt(): Violation[] {
    const violations: Violation[] = [];
    const specsDir = join(ROOT, 'specs', 'active');
    if (!existsSync(specsDir)) return violations;

    for (const entry of readdirSync(specsDir)) {
        if (!entry.endsWith('.md') || entry.startsWith('.')) continue;
        const content = readFileSync(join(specsDir, entry), 'utf8');
        if (!content.includes('## As-Built Record')) {
            violations.push({
                check: 'Spec As-Built',
                file: `specs/active/${entry}`,
                detail: 'Missing "## As-Built Record" section — fill before moving to completed/',
            });
        }
    }
    return violations;
}

// ── Project-Specific Checks (Customize These) ──────────────────────

// PROJECT: Add your framework-specific checks here. Examples:

// function checkFrameworkGenerics(): Violation[] {
//     // e.g., ensure Hono<AppBindings> not Hono<{ Bindings: ... }>
//     return [];
// }

// function checkPermissionCrossRef(): Violation[] {
//     // Cross-reference requirePermission() calls against seeded permissions
//     return [];
// }

// function checkTenantClassification(): Violation[] {
//     // Ensure every migration table is classified as tenant-scoped or exempt
//     return [];
// }

// function checkDirectFetchInUI(): Violation[] {
//     // Ensure UI code uses API layer, not raw external fetch()
//     return [];
// }

// ── Main ───────────────────────────────────────────────────────────

console.log('🔍 Postflight Check\n');

const allViolations: Violation[] = [
    ...checkFileSizeLimits(),
    ...checkBannedPatterns(),
    ...checkSqlSafety(),
    ...checkDuplicateTables(),
    ...checkSpecAsBuilt(),
    // PROJECT: Add your custom checks here:
    // ...checkFrameworkGenerics(),
    // ...checkPermissionCrossRef(),
    // ...checkTenantClassification(),
    // ...checkDirectFetchInUI(),
];

if (allViolations.length === 0) {
    console.log('✅ All checks passed — no violations found.\n');
    process.exit(0);
} else {
    // Group by check
    const grouped = new Map<string, Violation[]>();
    for (const v of allViolations) {
        if (!grouped.has(v.check)) grouped.set(v.check, []);
        grouped.get(v.check)!.push(v);
    }

    for (const [check, violations] of grouped) {
        console.log(`\n❌ ${check} (${violations.length} violation${violations.length > 1 ? 's' : ''}):`);
        for (const v of violations) {
            const loc = v.line ? `${v.file}:${v.line}` : v.file;
            console.log(`   ${loc} — ${v.detail}`);
        }
    }

    console.log(`\n❌ ${allViolations.length} violation(s) found. Fix before marking work complete.\n`);
    process.exit(1);
}
