/**
 * Read buckets: the hour marks after publish at which the ledger takes a read.
 * Kept free of zod so browser bundles that need only the marks stay small.
 */
export type Bucket = '24' | '48' | '168' | '672'

export const BUCKETS: readonly Bucket[] = ['24', '48', '168', '672'] as const

export const BUCKET_HOURS: Record<Bucket, number> = { '24': 24, '48': 48, '168': 168, '672': 672 }
