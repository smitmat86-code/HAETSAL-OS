// src/services/action/integrations/browser.ts
// Browser Rendering via @cloudflare/puppeteer + BROWSER binding
// Law 1: BROWSER binding is on Worker — NOT in Container
// LESSON: Always close browser in finally block to prevent leaked sessions

import puppeteer from '@cloudflare/puppeteer'
import type { Env } from '../../../types/env'

export interface BrowseResult {
  content: string
  title: string
}

/**
 * Execute a browse action via Cloudflare Browser Rendering
 * Navigates to URL, extracts readable text content (max 3000 chars)
 * Law 1: BROWSER binding used from Worker context only
 */
export async function executeBrowse(
  url: string,
  env: Env,
): Promise<BrowseResult> {
  const browser = await puppeteer.launch(env.BROWSER)
  try {
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30_000 })
    const title = await page.title()
    // Extract readable content — prefer <main>, fall back to <body>
    // Strip scripts/styles via evaluate context — only innerText
    const content = await page.evaluate(() => {
      const el = document.querySelector('main') ?? document.body
      return el?.innerText?.slice(0, 3000) ?? ''
    })
    return { content, title }
  } finally {
    await browser.close()
  }
}
