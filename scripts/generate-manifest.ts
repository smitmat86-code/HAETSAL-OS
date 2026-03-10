#!/usr/bin/env node
/**
 * generate-manifest.ts
 *
 * Auto-generates the Module Registry tables in MANIFEST.md by scanning
 * the filesystem. AI agents are FORBIDDEN from editing these tables manually.
 *
 * Run: npm run manifest
 *
 * What it does:
 * 1. Scans each package's src/ directory for source files
 * 2. Counts lines per file, flags violations of CONVENTIONS.md limits
 * 3. Extracts exported function/component names via regex
 * 4. Generates markdown tables for each package
 * 5. Preserves hand-edited sections (Known Issues, Active Contracts, Quick Reference)
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative, extname, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MANIFEST_PATH = join(ROOT, 'MANIFEST.md');

// ── Configuration ──────────────────────────────────────────────────

// File size limits from CONVENTIONS.md — customize per project
const LINE_LIMITS: Record<string, number> = {
    '.tsx': 200,  // React component
    '.ts': 150,   // Hook/service/utility
    // PROJECT: Add your backend language limits here:
    // '.rs': 300,   // Rust module
    // '.go': 300,   // Go file
    // '.py': 200,   // Python module
};

// Packages to scan — customize for your monorepo structure
// Each entry scans packages/{name}/src/ for source files
const PACKAGES: string[] = [
    // PROJECT: Replace with your package names
    // 'shared',
    // 'worker',
    // 'ui',
];

// File extensions to scan
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];
// PROJECT: Add your backend language:
// const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.rs'];

// ── File scanning ──────────────────────────────────────────────────

interface FileInfo {
    path: string;
    lines: number;
    exports: string[];
    overLimit: boolean;
}

function scanDirectory(dir: string): FileInfo[] {
    const results: FileInfo[] = [];
    if (!existsSync(dir)) return results;

    function walk(d: string) {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
            const full = join(d, entry.name);
            if (entry.isDirectory() && !['node_modules', 'target', 'dist', '.git'].includes(entry.name)) {
                walk(full);
            } else if (entry.isFile()) {
                const ext = extname(entry.name);
                if (SOURCE_EXTENSIONS.includes(ext)) {
                    const content = readFileSync(full, 'utf-8');
                    const lines = content.split('\n').length;
                    const limit = LINE_LIMITS[ext] || 150;

                    // TypeScript/JavaScript export detection
                    const exports: string[] = [];
                    const exportRegex = /export\s+(?:default\s+)?(?:function|const|class|interface|type)\s+(\w+)/g;
                    let match;
                    while ((match = exportRegex.exec(content)) !== null) {
                        exports.push(match[1]);
                    }

                    // PROJECT: Add your backend language export detection here:
                    // Rust: /pub\s+(?:fn|struct|enum|trait)\s+(\w+)/g
                    // Go: /func\s+(\w+)/g
                    // Python: /^(?:def|class)\s+(\w+)/gm

                    results.push({
                        path: relative(ROOT, full),
                        lines,
                        exports,
                        overLimit: lines > limit,
                    });
                }
            }
        }
    }
    walk(dir);
    return results;
}

function generateTable(packageName: string, files: FileInfo[]): string {
    if (files.length === 0) return `*No source files yet.*\n`;

    const rows = files.map(f => {
        const status = f.overLimit ? '⚠️ OVER LIMIT' : '✅';
        const exportsStr = f.exports.slice(0, 3).join(', ') + (f.exports.length > 3 ? '...' : '');
        return `| ${f.path} | ${f.lines} | ${exportsStr || '—'} | ${status} |`;
    });

    return [
        '| File | Lines | Key Exports | Status |',
        '|------|-------|------------|--------|',
        ...rows,
        '',
    ].join('\n');
}

// ── Main ───────────────────────────────────────────────────────────

const sections: string[] = [];

for (const pkg of PACKAGES) {
    const files = scanDirectory(join(ROOT, 'packages', pkg, 'src'));
    sections.push(`### ${pkg}/\n\n${generateTable(pkg, files)}`);
}

// Also scan src/ directory (flat Worker layout used by Phase 1.1+)
const srcFiles = scanDirectory(join(ROOT, 'src'));
if (srcFiles.length > 0) {
    sections.push(`### src/\n\n${generateTable('src', srcFiles)}`);
}

// Read existing MANIFEST.md, preserve hand-edited sections
const existing = readFileSync(MANIFEST_PATH, 'utf-8');

const AUTO_START = '<!-- AUTO-GENERATED MODULE REGISTRY - DO NOT EDIT -->';
const AUTO_END = '<!-- END AUTO-GENERATED -->';

const moduleRegistry = [
    AUTO_START,
    '',
    `*Auto-generated: ${new Date().toISOString().split('T')[0]}*`,
    '',
    ...sections,
    AUTO_END,
].join('\n');

let updated: string;
if (existing.includes(AUTO_START)) {
    const before = existing.substring(0, existing.indexOf(AUTO_START));
    const after = existing.substring(existing.indexOf(AUTO_END) + AUTO_END.length);
    updated = before + moduleRegistry + after;
} else {
    const insertPoint = existing.indexOf('## Module Registry');
    if (insertPoint !== -1) {
        const nextSection = existing.indexOf('\n## ', insertPoint + 1);
        const before = existing.substring(0, insertPoint + '## Module Registry\n'.length);
        const after = nextSection !== -1 ? existing.substring(nextSection) : '';
        updated = before + '\n' + moduleRegistry + '\n' + after;
    } else {
        updated = existing + '\n\n' + moduleRegistry;
    }
}

writeFileSync(MANIFEST_PATH, updated);

// Report
const allFiles = [
    ...PACKAGES.flatMap(pkg => scanDirectory(join(ROOT, 'packages', pkg, 'src'))),
    ...scanDirectory(join(ROOT, 'src')),
];
const violations = allFiles.filter(f => f.overLimit);
console.log(`✅ MANIFEST.md updated (${allFiles.length} files across ${PACKAGES.length} packages)`);
if (violations.length > 0) {
    console.log(`⚠️  ${violations.length} file(s) over line limit:`);
    violations.forEach(f => console.log(`   ${f.path}: ${f.lines} lines`));
}
