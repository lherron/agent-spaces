import type { MemoryScanCategory } from './paths.js'

export type ScanCategory = MemoryScanCategory

export type ScanResult =
  | { ok: true }
  | {
      ok: false
      pattern: string
      category: ScanCategory
    }

export interface ScanOptions {
  categoriesToSkip?: ScanCategory[] | undefined
}

const ENTRY_DELIMITER = '\n§\n'

const THREAT_PATTERNS: Array<{
  pattern: RegExp
  id: string
  category: Exclude<ScanCategory, 'invisible_unicode' | 'delimiter'>
}> = [
  {
    pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i,
    id: 'ignore_instructions',
    category: 'prompt_injection',
  },
  {
    pattern: /you\s+are\s+now\s+/i,
    id: 'role_hijack',
    category: 'prompt_injection',
  },
  {
    pattern: /do\s+not\s+tell\s+the\s+user/i,
    id: 'deception_hide',
    category: 'prompt_injection',
  },
  {
    pattern: /system\s+prompt\s+override/i,
    id: 'sys_prompt_override',
    category: 'prompt_injection',
  },
  {
    pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i,
    id: 'disregard_rules',
    category: 'prompt_injection',
  },
  {
    pattern:
      /act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have)\s+(restrictions|limits|rules)/i,
    id: 'bypass_restrictions',
    category: 'prompt_injection',
  },
  {
    pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    id: 'exfil_curl',
    category: 'exfil',
  },
  {
    pattern: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    id: 'exfil_wget',
    category: 'exfil',
  },
  {
    pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i,
    id: 'read_secrets',
    category: 'exfil',
  },
  {
    pattern: /authorized_keys/i,
    id: 'ssh_backdoor',
    category: 'exfil',
  },
  {
    pattern: /\$HOME\/\.ssh|~\/\.ssh/i,
    id: 'ssh_access',
    category: 'exfil',
  },
  {
    pattern: /\$HOME\/\.hermes\/\.env|~\/\.hermes\/\.env/i,
    id: 'hermes_env',
    category: 'exfil',
  },
]

const INVISIBLE_CHARS = [
  '\u200B',
  '\u200C',
  '\u200D',
  '\u2060',
  '\uFEFF',
  '\u202A',
  '\u202B',
  '\u202C',
  '\u202D',
  '\u202E',
]

export function scan(content: string, options: ScanOptions = {}): ScanResult {
  const categoriesToSkip = new Set(options.categoriesToSkip ?? [])

  for (const char of INVISIBLE_CHARS) {
    if (!categoriesToSkip.has('invisible_unicode') && content.includes(char)) {
      return {
        ok: false,
        pattern: `U+${char.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')}`,
        category: 'invisible_unicode',
      }
    }
  }

  for (const threat of THREAT_PATTERNS) {
    if (categoriesToSkip.has(threat.category)) continue
    if (threat.pattern.test(content)) {
      return {
        ok: false,
        pattern: threat.id,
        category: threat.category,
      }
    }
  }

  if (content.includes(ENTRY_DELIMITER)) {
    return {
      ok: false,
      pattern: ENTRY_DELIMITER,
      category: 'delimiter',
    }
  }

  return { ok: true }
}
