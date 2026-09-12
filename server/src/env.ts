import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function loadDotEnv(): void {
  for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')]) {
    let text: string
    try {
      text = readFileSync(candidate, 'utf8')
    } catch {
      continue
    }
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      if (key && process.env[key] === undefined) process.env[key] = value
    }
    return
  }
}

loadDotEnv()

// The ADK's OpenAI adapter reads OPENAI_API_KEY; the hackathon secret is named OPENAI_KEY.
process.env.OPENAI_API_KEY ??= process.env.OPENAI_KEY

export const env = {
  simBaseUrl: process.env.SIM_BASE_URL ?? 'https://sim.animahacks.com',
  simApiKey: process.env.SIM_API,
  openaiKey: process.env.OPENAI_API_KEY,
}

export function requireEnv<K extends keyof typeof env>(key: K): NonNullable<(typeof env)[K]> {
  const value = env[key]
  if (!value) throw new Error(`Missing environment variable for ${key}. See .env.example.`)
  return value
}
