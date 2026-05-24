export type RedactedValue =
  | {
      redacted: true
      reason: 'secret' | 'token' | 'path' | 'policy'
      digest?: string | undefined
    }
  | string
  | number
  | boolean
  | null
  | RedactedValue[]
  | { [key: string]: RedactedValue }
