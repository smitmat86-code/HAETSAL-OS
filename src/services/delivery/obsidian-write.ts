// src/services/delivery/obsidian-write.ts
// Google Drive write to /from-brain/ folder
// Anti-circular: all output files carry generated_by: the-brain frontmatter
// Non-fatal: caller wraps in .catch(() => {})

const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files'
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'

export async function writeToDriveBrainFolder(
  filename: string,
  content: string,
  accessToken: string,
): Promise<void> {
  const folderId = await findOrCreateFolder(accessToken, 'from-brain')
  const metadata = JSON.stringify({
    name: filename,
    parents: [folderId],
    mimeType: 'text/markdown',
  })
  const boundary = 'brain_upload_boundary'
  const body =
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: text/markdown\r\n\r\n${content}\r\n` +
    `--${boundary}--`

  await fetch(DRIVE_UPLOAD_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  })
}

async function findOrCreateFolder(accessToken: string, name: string): Promise<string> {
  const q = encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)
  const res = await fetch(`${DRIVE_FILES_API}?q=${q}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const data = await res.json() as { files: Array<{ id: string }> }
  if (data.files?.length) return data.files[0].id

  const createRes = await fetch(DRIVE_FILES_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
  })
  const folder = await createRes.json() as { id: string }
  return folder.id
}
