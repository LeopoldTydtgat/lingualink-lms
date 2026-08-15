// Downloads every object listed in a manifest out of Supabase Storage.
//
// This backs up the file BYTES only. The bucket configuration and the object
// metadata rows live in the storage schema, which db-backup.yml already dumps.
// A restore needs both halves: rows without bytes point at nothing, and bytes
// without rows are unreachable through the Storage API.
//
// The file list comes from a psql query on storage.objects rather than from the
// Storage list API, because that API returns folders as pseudo-entries and
// requires prefix recursion plus pagination. That is easy to get subtly wrong,
// and getting it wrong means silently missing files instead of failing.
//
// Each manifest entry also carries the object's expected byte size as recorded
// by storage.objects, and every download is verified against it before the file
// is written, so a truncated or zero-byte response fails instead of being
// archived as a good copy.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'MANIFEST_PATH',
  'OUT_DIR',
]

function fail(message) {
  console.error(message)
  process.exit(1)
}

// The source is our own database, but a backup script that writes outside
// OUT_DIR on malformed input is not acceptable. bucket is checked as well as
// name because both are joined into the destination path.
function isUnsafePathValue(value) {
  if (typeof value !== 'string' || value.trim() === '') return true
  if (path.isAbsolute(value) || value.startsWith('/') || value.startsWith('\\')) return true
  return value.split(/[/\\]/).includes('..')
}

async function main() {
  const missing = REQUIRED_ENV.filter((key) => {
    const value = process.env[key]
    return typeof value !== 'string' || value.trim() === ''
  })

  if (missing.length > 0) {
    fail(`Missing or empty required environment variable(s): ${missing.join(', ')}`)
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const manifestPath = process.env.MANIFEST_PATH
  const outDir = process.env.OUT_DIR

  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  } catch (err) {
    fail(`Could not read or parse the manifest at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!Array.isArray(manifest)) {
    fail(`Manifest at ${manifestPath} is not a JSON array.`)
  }

  // An empty storage backup that "succeeds" is how people discover they have
  // no backup. Treat it as a broken listing query, not as zero files.
  if (manifest.length === 0) {
    fail('Manifest is empty. This project always has stored files, so an empty manifest means the listing query or the database credentials are broken. Refusing to produce an empty backup.')
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  let downloaded = 0
  let failed = 0

  // Sequential on purpose: this is a small nightly job, and being friendly to
  // the Storage rate limits is worth more than finishing a few seconds sooner.
  for (const entry of manifest) {
    const bucket = entry && entry.bucket
    const name = entry && entry.name
    const label = `${bucket}/${name}`

    if (isUnsafePathValue(bucket) || isUnsafePathValue(name)) {
      console.error(`FAIL ${label}: rejected, the bucket or object path is empty, absolute, or contains a '..' segment`)
      failed++
      continue
    }

    const { data, error } = await supabase.storage.from(bucket).download(name)

    // Never throw on a single object. The log has to show every failure, not
    // just the first one, or each rerun only reveals the next broken file.
    if (error || !data) {
      console.error(`FAIL ${label}: ${error ? error.message : 'no data returned'}`)
      failed++
      continue
    }

    try {
      const buffer = Buffer.from(await data.arrayBuffer())

      // The size storage.objects recorded is the authority. Checking it before
      // the write is what stops a truncated or zero-byte body from being
      // archived as a good copy: a short file is a failure, not a smaller file.
      const expectedSize = entry && entry.size

      if (typeof expectedSize !== 'number' || !Number.isFinite(expectedSize) || expectedSize < 0) {
        console.error(`FAIL ${label}: manifest entry has no usable expected size`)
        failed++
        continue
      }

      if (buffer.length !== expectedSize) {
        console.error(`FAIL ${label}: size mismatch, expected ${expectedSize} bytes, got ${buffer.length}`)
        failed++
        continue
      }

      const destination = path.join(outDir, bucket, name)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(destination, buffer)
      downloaded++
    } catch (err) {
      console.error(`FAIL ${label}: ${err instanceof Error ? err.message : String(err)}`)
      failed++
    }
  }

  // Ship the index inside the archive so a restore does not depend on finding
  // the matching database dump first.
  await fs.mkdir(outDir, { recursive: true })
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  console.log(`Manifest entries: ${manifest.length} | downloaded: ${downloaded} | failed: ${failed}`)

  if (failed > 0 || downloaded !== manifest.length) {
    console.error(`Storage backup incomplete: ${downloaded} of ${manifest.length} objects downloaded, ${failed} failed.`)
    process.exit(1)
  }

  console.log('Storage backup complete.')
}

main().catch((err) => {
  console.error('Unhandled error in backup-storage:', err)
  process.exit(1)
})
