// src/services/google/drive.ts
// Google Drive file operations for Obsidian sync
// Anti-circular: generated_by: the-brain → skip

import type { GoogleDriveFile } from '../../types/google'

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files'

export async function listNewBrainFiles(
  folderId: string, accessToken: string, sinceMs: number,
): Promise<GoogleDriveFile[]> {
  const since = new Date(sinceMs).toISOString()
  const query = `'${folderId}' in parents and modifiedTime > '${since}' and trashed = false`
  const res = await fetch(
    `${DRIVE_API}?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,modifiedTime)`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) return []
  const data = await res.json() as { files: GoogleDriveFile[] }
  return data.files ?? []
}

export async function downloadDriveFile(
  fileId: string, accessToken: string,
): Promise<string | null> {
  const res = await fetch(`${DRIVE_API}/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return null
  return await res.text()
}

export interface ObsidianFrontmatter {
  brainFlag: boolean
  generatedByBrain: boolean
  metadata: Record<string, unknown>
}

/**
 * Parse Obsidian YAML frontmatter from markdown content
 * Anti-circular: generated_by: the-brain → skip
 */
export function parseObsidianFrontmatter(content: string): ObsidianFrontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return { brainFlag: false, generatedByBrain: false, metadata: {} }

  const yaml = match[1]
  const metadata: Record<string, unknown> = {}
  let brainFlag = false
  let generatedByBrain = false

  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    metadata[key] = value

    if (key === 'brain' && value === 'true') brainFlag = true
    if (key === 'generated_by' && value === 'the-brain') generatedByBrain = true
  }

  return { brainFlag, generatedByBrain, metadata }
}

/**
 * Extract [[wikilinks]] from Obsidian markdown content
 */
export function extractWikilinks(content: string): string[] {
  const matches = content.match(/\[\[([^\]]+)\]\]/g)
  if (!matches) return []
  return matches.map(m => m.slice(2, -2))
}
