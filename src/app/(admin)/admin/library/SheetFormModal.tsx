'use client'

import { useState, useMemo, useRef, useEffect } from 'react'
import { StudySheet, WordRow, Attachment } from './LibraryAdminClient'
import { Tag, kindPillStyle } from './TagManagerModal'
import { Check, Tag as TagIcon, FileText, Loader2 } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

type Props = {
  sheet: StudySheet | null   // null = create mode
  onClose: () => void
  onSaved: () => Promise<void>
}

type FormTab = 'metadata' | 'vocabulary' | 'files' | 'tags' | 'access'

type SheetType = 'teaching_material' | 'study_sheet'

// ── Helpers ───────────────────────────────────────────────────────────────────

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']

const ACCEPTED_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]

const ACCEPTED_EXTENSIONS = '.pdf,.doc,.docx,.ppt,.pptx'
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

function newWordRow(): WordRow {
  return { id: crypto.randomUUID(), word: '', pos: '', definition: '', example: '', audio_url: '' }
}

function rolesToPreset(roles: string[]): string {
  if (!roles || roles.length === 0) return 'all'
  if (roles.includes('admin') && roles.length === 1) return 'admin'
  if (roles.includes('teacher_exam') && !roles.includes('teacher')) return 'exam'
  return 'all'
}

function presetToRoles(preset: string): string[] {
  if (preset === 'exam') return ['teacher_exam']
  if (preset === 'admin') return ['admin']
  return ['teacher', 'teacher_exam']
}

function fileTypeLabel(mimeType: string): string {
  if (mimeType === 'application/pdf') return 'PDF'
  if (mimeType === 'application/msword') return 'DOC'
  if (mimeType.includes('wordprocessingml')) return 'DOCX'
  if (mimeType === 'application/vnd.ms-powerpoint') return 'PPT'
  if (mimeType.includes('presentationml')) return 'PPTX'
  return mimeType.split('/')[1]?.toUpperCase() ?? 'FILE'
}

function DifficultyButton({ value, selected, onClick }: { value: number; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '6px 14px',
        borderRadius: '8px',
        border: selected ? '2px solid #FF8303' : '2px solid #e5e7eb',
        backgroundColor: selected ? '#FF8303' : 'white',
        cursor: 'pointer',
      }}
    >
      <span style={{ display: 'inline-flex', gap: '2px', alignItems: 'flex-end', height: '14px' }}>
        {[1, 2, 3].map(n => (
          <span key={n} style={{
            display: 'inline-block',
            width: '5px',
            height: n === 1 ? '5px' : n === 2 ? '9px' : '13px',
            borderRadius: '2px',
            backgroundColor: n <= value
              ? (selected ? 'white' : '#FF8303')
              : (selected ? 'rgba(255,255,255,0.35)' : '#e5e7eb'),
          }} />
        ))}
      </span>
      <span style={{ fontSize: '13px', color: selected ? 'white' : '#6b7280', fontWeight: 500 }}>
        {value === 1 ? 'Easy' : value === 2 ? 'Medium' : 'Hard'}
      </span>
    </button>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SheetFormModal({ sheet, onClose, onSaved }: Props) {
  const isEdit = sheet !== null

  // Stable ID for this sheet — used as storage path for file uploads
  const sheetId = useMemo(() => isEdit ? sheet!.id : crypto.randomUUID(), [])

  // ── Active tab ────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<FormTab>('metadata')

  // ── Sheet type (Teaching Material vs Study Sheet → audience column) ────────
  // CREATE defaults to Teaching Material (the fail-safe, staff-only side).
  // EDIT derives from the saved audience: only an explicit 'student' resolves to
  // Study Sheet; 'staff', null, undefined, or anything else → Teaching Material.
  const existingAudience = (sheet as (StudySheet & { audience?: string | null }) | null)?.audience
  const [type, setType] = useState<SheetType>(
    existingAudience === 'student' ? 'study_sheet' : 'teaching_material'
  )
  const selectType = (next: SheetType) => {
    setType(next)
    // Teaching Material hides vocabulary/access — if one of those is the active tab
    // when switching, fall back to Metadata so no orphaned tab shows.
    if (next === 'teaching_material' && (activeTab === 'vocabulary' || activeTab === 'access')) {
      setActiveTab('metadata')
    }
  }

  // ── Metadata fields ───────────────────────────────────────────────────────
  const [title, setTitle] = useState(sheet?.title ?? '')
  const [category, setCategory] = useState<'vocabulary' | 'grammar'>(
    (sheet?.category as 'vocabulary' | 'grammar') ?? 'vocabulary'
  )
  const [level, setLevel] = useState(sheet?.level ?? '')
  const [difficulty, setDifficulty] = useState<1 | 2 | 3 | null>(
    sheet?.difficulty ? (sheet.difficulty as 1 | 2 | 3) : null
  )
  const [introText, setIntroText] = useState(sheet?.intro_text ?? '')

  // ── Vocabulary rows ───────────────────────────────────────────────────────
  const [words, setWords] = useState<WordRow[]>(() => {
    const existing = sheet?.content?.words
    return existing && existing.length > 0 ? existing : [newWordRow()]
  })

  // ── Tags ──────────────────────────────────────────────────────────────────
  // tags and sheet_tags are service_role writes only, and the browser client is
  // never used for them here — the vocabulary, this sheet's set, and the eventual
  // replace all go through /api/admin routes.
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set())
  const [tagsLoading, setTagsLoading] = useState(true)
  // Set when the vocabulary or this sheet's set fails to load. The save PUT is a
  // full replace, so a set we never read must never be written back.
  const [tagsLoadError, setTagsLoadError] = useState(false)

  // Mount-only: the modal remounts per open, so this runs once and won't clobber
  // an in-progress selection.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const vocabRes = await fetch('/api/admin/tags')
        if (cancelled) return
        if (!vocabRes.ok) { setTagsLoadError(true); return }

        const vocab = await vocabRes.json().catch(() => null)
        if (cancelled) return
        if (!Array.isArray(vocab)) { setTagsLoadError(true); return }
        setAllTags(vocab)

        // Create mode has no saved set yet — the row does not exist.
        if (isEdit) {
          const currentRes = await fetch(`/api/admin/library/${sheetId}/tags`)
          if (cancelled) return
          if (!currentRes.ok) { setTagsLoadError(true); return }

          const current = await currentRes.json().catch(() => null)
          if (cancelled) return
          if (!current || !Array.isArray(current.tag_ids)) { setTagsLoadError(true); return }
          setSelectedTagIds(new Set(current.tag_ids))
        }
      } catch {
        // A rejected fetch must still land in a known state. Without this,
        // tagsLoading would stay true and tagsLoadError false forever — the one
        // combination that leaves saveTags unguarded and wipes the sheet's tags.
        if (!cancelled) setTagsLoadError(true)
      } finally {
        if (!cancelled) setTagsLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const toggleTag = (tagId: string) => {
    setSelectedTagIds(prev => {
      const next = new Set(prev)
      if (next.has(tagId)) next.delete(tagId)
      else next.add(tagId)
      return next
    })
  }

  // Writes the sheet's tag set. Returns an error message, or null on success.
  const saveTags = async (id: string): Promise<string | null> => {
    // Fail-safe: the PUT replaces the whole set, so a selection built on a failed
    // load would erase the sheet's real tags. Skip entirely — the server keeps
    // what it has, and the Tags tab already says why. (handleSave additionally
    // refuses to run while the load is still in flight, which is the other way
    // selectedTagIds could be unrepresentative of the saved set.)
    if (tagsLoadError) return null

    try {
      const res = await fetch(`/api/admin/library/${id}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_ids: Array.from(selectedTagIds) }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        return body.error || "The sheet was saved, but its tags weren't. Try saving again."
      }
    } catch {
      return "The sheet was saved, but its tags weren't — the server couldn't be reached. Try saving again."
    }

    return null
  }

  // ── Attachments ───────────────────────────────────────────────────────────
  const [attachments, setAttachments] = useState<Attachment[]>(() => {
    const existing = sheet?.attachments
    return Array.isArray(existing) ? existing : []
  })
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Keyed per attachment name: several rows can be removed at once, and a shared
  // boolean would spin and disable all of them.
  const [removingFiles, setRemovingFiles] = useState<Set<string>>(new Set())

  // Create mode only: files chosen but not yet uploaded. The study_sheets row
  // doesn't exist until Save and the upload route rejects uploads for missing
  // rows, so we stage Files here and upload them after the row is created.
  const [pendingFiles, setPendingFiles] = useState<File[]>([])

  // ── Access control ────────────────────────────────────────────────────────
  const [rolesPreset, setRolesPreset] = useState<string>(
    rolesToPreset(sheet?.allowed_roles ?? [])
  )

  // ── Save state ────────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Create mode only: the row was created but a follow-up step (files, tags)
  // failed. The row exists, so re-saving would POST the same id again and collide
  // — the modal instead holds the reason on screen and offers only Close.
  const [createdIncomplete, setCreatedIncomplete] = useState(false)

  // ── Word helpers ──────────────────────────────────────────────────────────
  const updateWord = (id: string, field: keyof WordRow, value: string) => {
    setWords(prev => prev.map(w => w.id === id ? { ...w, [field]: value } : w))
  }

  const addWord = () => setWords(prev => [...prev, newWordRow()])

  const removeWord = (id: string) => {
    setWords(prev => prev.filter(w => w.id !== id))
  }

  const moveWord = (index: number, direction: 'up' | 'down') => {
    setWords(prev => {
      const next = [...prev]
      const target = direction === 'up' ? index - 1 : index + 1
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  // ── File upload helpers ───────────────────────────────────────────────────
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return

    setUploadError(null)

    try {
      for (const file of files) {
        if (!ACCEPTED_TYPES.includes(file.type)) {
          setUploadError(`"${file.name}" is not a supported file type. Please upload PDF, DOC, DOCX, PPT, or PPTX files.`)
          continue
        }
        if (file.size > MAX_FILE_SIZE) {
          setUploadError(`"${file.name}" exceeds the 10 MB limit.`)
          continue
        }

        // Create mode: the study_sheets row doesn't exist yet and the upload route
        // rejects uploads for missing rows. Defer — stage the File and upload on Save.
        if (!isEdit) {
          setPendingFiles(prev => [...prev, file])
          continue
        }

        // Edit mode: the row exists, so upload immediately (unchanged behaviour).
        setUploading(true)
        const formData = new FormData()
        formData.append('file', file)
        formData.append('sheet_id', sheetId)

        const res = await fetch('/api/admin/library/upload', {
          method: 'POST',
          body: formData,
        })

        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          setUploadError(body.error ?? `Failed to upload "${file.name}". Please try again.`)
          break
        }

        const data: Attachment = await res.json()
        setAttachments(prev => [...prev, data])
      }
    } catch {
      // Without this the button sits at "Uploading…", disabled, with no reason.
      setUploadError('Could not reach the server, so the upload did not finish. Check your connection and try again.')
    } finally {
      setUploading(false)
      // Reset file input so the same file can be re-selected if needed
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleFileRemove = async (attachment: Attachment) => {
    setUploadError(null)
    setRemovingFiles(prev => {
      const next = new Set(prev)
      next.add(attachment.name)
      return next
    })

    try {
      const res = await fetch('/api/admin/library/upload', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_id: sheetId, filename: attachment.name }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setUploadError(body.error || `"${attachment.name}" could not be removed and is still attached to this sheet.`)
        return
      }

      // Only drop the row once the file is really gone. Removing it first and
      // saving would strip the reference from the sheet while the file stayed in
      // the bucket — orphaned, and unreachable from the UI ever again.
      setAttachments(prev => prev.filter(a => a.name !== attachment.name))
    } catch {
      setUploadError(`Could not reach the server, so "${attachment.name}" was not removed. Check your connection and try again.`)
    } finally {
      setRemovingFiles(prev => {
        const next = new Set(prev)
        next.delete(attachment.name)
        return next
      })
    }
  }

  // Create mode: drop a staged file. Nothing is on the server yet, so no fetch.
  const removePendingFile = (index: number) => {
    setPendingFiles(prev => prev.filter((_, i) => i !== index))
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    // The row already exists and its id is fixed — a second POST would collide.
    if (createdIncomplete) return
    // Tags: the PUT replaces the whole set, so saving before the sheet's saved tags
    // arrive would send the still-empty initial selection and clear every tag on
    // the sheet.
    if (tagsLoading) return
    if (!title.trim()) { setError('Title is required.'); setActiveTab('metadata'); return }

    setSaving(true)
    setError(null)

    // Create mode: flipped once the POST lands. A throw after that point must not
    // be reported as "nothing was saved" — the row is real from then on.
    let rowCreated = false

    try {
      const content = {
        words: category === 'vocabulary' ? words.filter(w => w.word.trim()) : [],
        // Exercises/MCQs now live in the activities table; content keeps an empty
        // array purely for the backward-compatible shape the routes expect.
        exercises: [],
      }

      const payload: Record<string, unknown> = {
        title: title.trim(),
        category,
        level,
        difficulty: difficulty ?? 1,
        intro_text: introText.trim() || null,
        content,
        allowed_roles: presetToRoles(rolesPreset),
        // Audience wall: Study Sheet → 'student'; anything else (Teaching Material)
        // → 'staff'. Fail-safe: only an explicit 'study_sheet' type reaches students.
        audience: type === 'study_sheet' ? 'student' : 'staff',
        is_active: true,
        // Edit mode persists the already-uploaded attachments; create mode uploads
        // after the row exists (see below), so it sends none here.
        attachments: isEdit ? attachments : [],
      }

      // Edit mode: single PATCH; files were uploaded inline on selection.
      if (isEdit) {
        const res = await fetch(`/api/admin/library/${sheet!.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })

        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          setError(body.error || 'Something went wrong. Please try again.')
          return
        }

        // Tags are a separate table, so a separate write. The sheet is already
        // saved: on failure hold the modal open with the reason rather than
        // closing over it — saving again simply re-runs both writes.
        const tagsError = await saveTags(sheet!.id)
        if (tagsError) {
          setActiveTab('tags')
          setError(tagsError)
          return
        }

        await onSaved()
        return
      }

      // Create mode: save first, then upload (the upload route rejects files for
      // rows that don't exist yet). Order: (a) create the row, (b) upload staged
      // files, (c) PATCH the resulting attachments onto the row, (d) write tags,
      // (e) finish.
      payload.id = sheetId

      // (a) Create the row with no attachments. On failure nothing else ran, so the
      // staged files and form state stay intact for a retry.
      const createRes = await fetch('/api/admin/library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!createRes.ok) {
        const body = await createRes.json().catch(() => ({}))
        setError(body.error || 'Something went wrong. Please try again.')
        return
      }

      rowCreated = true

      // (b) The row exists now — upload each staged file. Keep going on a failure so
      // one bad file doesn't drop the rest; remember that something failed.
      const uploaded: Attachment[] = []
      let anyFailed = false
      for (const file of pendingFiles) {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('sheet_id', sheetId)

        const upRes = await fetch('/api/admin/library/upload', {
          method: 'POST',
          body: formData,
        })

        if (!upRes.ok) {
          anyFailed = true
          continue
        }

        const data: Attachment = await upRes.json()
        uploaded.push(data)
      }

      // (c) Attach whatever uploaded successfully onto the new row. The files are
      // already sitting in the storage bucket, so a failure here is not silent
      // housekeeping: it strands them there with nothing pointing at them.
      let attachFailed = false
      if (uploaded.length > 0) {
        const attachRes = await fetch(`/api/admin/library/${sheetId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ attachments: uploaded }),
        })

        if (!attachRes.ok) attachFailed = true
      }

      // (d) The row exists, so its tags can be written.
      let tagsError: string | null = null
      if (selectedTagIds.size > 0) {
        tagsError = await saveTags(sheetId)
      }

      // (e) The row exists either way. If a file, the attachment record, or the
      // tags failed, the modal must STAY OPEN to say so: setError followed by
      // onSaved() would unmount this component in the same render, and the message
      // would never paint — the admin would see a clean close and believe
      // everything saved. Close (below) is what refreshes the list from here.
      if (anyFailed || attachFailed || tagsError) {
        const parts: string[] = []
        if (anyFailed) parts.push("some files didn't upload")
        if (attachFailed) parts.push('the files that did upload were not saved onto the sheet')
        if (tagsError) parts.push("its tags didn't save")

        const detail =
          parts.length === 1 ? parts[0] :
          parts.length === 2 ? `${parts[0]} and ${parts[1]}` :
          `${parts[0]}, ${parts[1]} and ${parts[2]}`

        setCreatedIncomplete(true)
        setError(`Sheet created, but ${detail}. Close, then open the sheet to add them again.`)
        return
      }

      await onSaved()
    } catch {
      if (rowCreated) {
        // The row is on the server. Offering Save again would POST the same id and
        // collide, so the modal switches to the same hold-and-explain state the
        // partial-failure path uses.
        setCreatedIncomplete(true)
        setError("Sheet created, but the server couldn't be reached to finish saving its files and tags. Close, then open the sheet to add them again.")
      } else {
        setError('Could not reach the server, so nothing was saved. Check your connection and try again.')
      }
    } finally {
      setSaving(false)
    }
  }

  // ── Tag picker ────────────────────────────────────────────────────────────
  const topicTags = allTags.filter(t => t.kind === 'topic')
  const skillTags = allTags.filter(t => t.kind === 'skill')

  const renderTagGroup = (label: string, group: Tag[]) => (
    <div>
      <p className="text-xs font-medium text-gray-400 uppercase mb-2">{label}</p>
      {group.length === 0 ? (
        <div className="py-6 text-center">
          <TagIcon className="w-5 h-5 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-400">No {label.toLowerCase()} yet.</p>
          <p className="text-xs text-gray-400 mt-1">Create them with Manage Tags on the library page.</p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {group.map(tag => {
            const selected = selectedTagIds.has(tag.id)
            const pill = kindPillStyle(tag.kind)
            return (
              <button
                key={tag.id}
                type="button"
                onClick={() => toggleTag(tag.id)}
                className="text-xs font-medium px-3 py-1.5 rounded-full border-2 transition-colors"
                style={{
                  borderColor: selected ? '#FF8303' : '#e5e7eb',
                  backgroundColor: selected ? '#FF8303' : pill.backgroundColor,
                  color: selected ? 'white' : pill.color,
                }}
              >
                {tag.name}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )

  // ── Tab bar ───────────────────────────────────────────────────────────────
  const allTabs: { key: FormTab; label: string; count?: number | null }[] = [
    { key: 'metadata', label: 'Metadata' },
    { key: 'vocabulary', label: 'Vocabulary', count: words.length },
    { key: 'files', label: 'Files', count: isEdit ? attachments.length : pendingFiles.length },
    { key: 'tags', label: 'Tags', count: tagsLoading ? null : selectedTagIds.size },
    { key: 'access', label: 'Access' },
  ]
  // Teaching Material is a staff-only resource: Title + Files only (plus Tags,
  // which classify library material of either kind).
  // Study Sheet keeps the full editor (metadata, vocabulary, files, access).
  const tabs = type === 'study_sheet'
    ? allTabs
    : allTabs.filter(t => t.key === 'metadata' || t.key === 'files' || t.key === 'tags')

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">

        {/* Modal header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <h2 className="text-lg font-bold text-gray-900">
            {isEdit ? 'Edit Study Sheet' : 'New Study Sheet'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 px-6 pt-4 border-b border-gray-200 flex-shrink-0">
          {tabs.map(tab => {
            const active = activeTab === tab.key
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className="px-4 py-2 text-sm font-medium rounded-t-lg transition-colors"
                style={active
                  ? { backgroundColor: '#FF8303', color: 'white' }
                  : { color: '#4b5563' }}
              >
                {tab.label}
                {typeof tab.count === 'number' && tab.count > 0 && (
                  <span
                    className="inline-flex ml-1.5 px-1.5 rounded-full text-xs"
                    style={active
                      ? { backgroundColor: 'rgba(255,255,255,0.25)', color: 'white' }
                      : { backgroundColor: '#f3f4f6', color: '#6b7280' }}
                  >
                    {tab.count}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* Tab content — scrollable */}
        <div className="overflow-y-auto flex-1 px-6 py-5 thin-scroll">

          {/* ── METADATA TAB ── */}
          {activeTab === 'metadata' && (
            <div className="space-y-5">

              {/* Type — Teaching Material vs Study Sheet (drives the audience column) */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Type *</label>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    {
                      value: 'teaching_material' as SheetType,
                      label: 'Teaching Material',
                      description: 'Staff-only resource for teachers. Title and files only.',
                    },
                    {
                      value: 'study_sheet' as SheetType,
                      label: 'Study Sheet',
                      description: 'Student-facing sheet with vocabulary, exercises, and access tiers.',
                    },
                  ].map(opt => (
                    <label
                      key={opt.value}
                      className="relative flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors"
                      style={{
                        borderColor: type === opt.value ? '#FF8303' : '#e5e7eb',
                        backgroundColor: type === opt.value ? '#FF830308' : 'white',
                      }}
                    >
                      <input
                        type="radio"
                        name="sheet-type"
                        value={opt.value}
                        checked={type === opt.value}
                        onChange={() => selectType(opt.value)}
                        className="sr-only"
                      />
                      {type === opt.value && (
                        <span
                          className="absolute top-2 right-2 inline-flex items-center justify-center rounded-full"
                          style={{ width: '18px', height: '18px', backgroundColor: '#FF8303' }}
                        >
                          <Check className="w-3 h-3 text-white" />
                        </span>
                      )}
                      <div>
                        <p className="text-sm font-semibold text-gray-900">{opt.label}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{opt.description}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Title *</label>
                <input
                  type="text"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="e.g. Business Email Vocabulary"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900"
                />
              </div>

              {type === 'study_sheet' && (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Category *</label>
                      <select
                        value={category}
                        onChange={e => setCategory(e.target.value as 'vocabulary' | 'grammar')}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700"
                      >
                        <option value="vocabulary">Vocabulary</option>
                        <option value="grammar">Grammar</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Level</label>
                      <select
                        value={level}
                        onChange={e => setLevel(e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700"
                      >
                        <option value="">Not specified</option>
                        {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Difficulty (optional)</label>
                    <div className="flex gap-2">
                      {([1, 2, 3] as const).map(n => (
                        <DifficultyButton
                          key={n}
                          value={n}
                          selected={difficulty === n}
                          onClick={() => setDifficulty(prev => prev === n ? null : n)}
                        />
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Introduction / Learning Objectives
                    </label>
                    <textarea
                      value={introText}
                      onChange={e => setIntroText(e.target.value)}
                      placeholder="Briefly describe what students will learn from this sheet…"
                      rows={3}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 resize-none"
                    />
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── VOCABULARY TAB ── */}
          {activeTab === 'vocabulary' && type === 'study_sheet' && (
            <div className="space-y-4">
              {category !== 'vocabulary' && (
                <p className="text-sm text-gray-400 italic">
                  Vocabulary lists are for Vocabulary sheets only. Switch the category on the Metadata tab if needed.
                </p>
              )}
              {category === 'vocabulary' && (
                <>
                  {/* Column headers */}
                  <div className="grid text-xs font-medium text-gray-400 uppercase gap-2"
                    style={{ gridTemplateColumns: '1.5rem 1.5fr 6rem 2fr 2fr 1.5rem 1.5rem 1.5rem' }}>
                    <span>#</span>
                    <span>Word</span>
                    <span>Part of speech</span>
                    <span>Definition</span>
                    <span>Example sentence</span>
                    <span />
                    <span />
                    <span />
                  </div>

                  {words.map((w, i) => (
                    <div key={w.id} className="grid gap-2 items-start"
                      style={{ gridTemplateColumns: '1.5rem 1.5fr 6rem 2fr 2fr 1.5rem 1.5rem 1.5rem' }}>
                      <span className="text-xs text-gray-400 pt-2 text-center">{i + 1}</span>
                      <input
                        type="text"
                        value={w.word}
                        onChange={e => updateWord(w.id, 'word', e.target.value)}
                        placeholder="Word"
                        className="border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900"
                      />
                      <input
                        type="text"
                        value={w.pos}
                        onChange={e => updateWord(w.id, 'pos', e.target.value)}
                        placeholder="noun, verb…"
                        className="border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900"
                      />
                      <input
                        type="text"
                        value={w.definition}
                        onChange={e => updateWord(w.id, 'definition', e.target.value)}
                        placeholder="Definition"
                        className="border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900"
                      />
                      <input
                        type="text"
                        value={w.example}
                        onChange={e => updateWord(w.id, 'example', e.target.value)}
                        placeholder="Example sentence"
                        className="border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900"
                      />
                      <button
                        type="button"
                        onClick={() => moveWord(i, 'up')}
                        disabled={i === 0}
                        className="text-gray-400 hover:text-gray-600 disabled:opacity-20 text-sm pt-1.5"
                        title="Move up"
                      >↑</button>
                      <button
                        type="button"
                        onClick={() => moveWord(i, 'down')}
                        disabled={i === words.length - 1}
                        className="text-gray-400 hover:text-gray-600 disabled:opacity-20 text-sm pt-1.5"
                        title="Move down"
                      >↓</button>
                      <button
                        type="button"
                        onClick={() => removeWord(w.id)}
                        disabled={words.length === 1}
                        className="disabled:opacity-20 text-sm pt-1.5"
                        style={{ color: '#FD5602' }}
                        onMouseEnter={e => { e.currentTarget.style.color = '#e04e02' }}
                        onMouseLeave={e => { e.currentTarget.style.color = '#FD5602' }}
                        title="Remove row"
                      >✕</button>
                    </div>
                  ))}

                  <button
                    type="button"
                    onClick={addWord}
                    className="flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg border-2 border-dashed border-gray-300 text-gray-500 w-full justify-center"
                    onMouseEnter={e => { e.currentTarget.style.borderColor = '#FFD9A8'; e.currentTarget.style.color = '#FF8303' }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = '#d1d5db'; e.currentTarget.style.color = '#6b7280' }}
                  >
                    + Add word
                  </button>
                </>
              )}
            </div>
          )}

          {/* ── FILES TAB ── */}
          {activeTab === 'files' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-500">
                Attach PDF, Word, or PowerPoint files to this study sheet. Max 10 MB per file.
              </p>

              {/* Upload button */}
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_EXTENSIONS}
                  multiple
                  onChange={handleFileSelect}
                  style={{ display: 'none' }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg border-2 border-dashed border-gray-300 text-gray-500 w-full justify-center disabled:opacity-50"
                  onMouseEnter={e => { if (!uploading) { e.currentTarget.style.borderColor = '#FFD9A8'; e.currentTarget.style.color = '#FF8303' } }}
                  onMouseLeave={e => { if (!uploading) { e.currentTarget.style.borderColor = '#d1d5db'; e.currentTarget.style.color = '#6b7280' } }}
                >
                  {uploading ? (
                    <>
                      <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                      Uploading…
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                      </svg>
                      Upload files
                    </>
                  )}
                </button>
                {uploadError && (
                  <p className="text-xs mt-2" style={{ color: '#FD5602' }}>{uploadError}</p>
                )}
              </div>

              {/* Attachment list */}
              {isEdit ? (
                /* Edit mode: attachments live on the server — View link + storage-backed remove. */
                attachments.length === 0 ? (
                  <div className="py-6 text-center">
                    <FileText className="w-5 h-5 text-gray-300 mx-auto mb-2" />
                    <p className="text-sm text-gray-400">No files attached yet.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {attachments.map((att, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-3 px-4 py-3 rounded-lg border border-gray-200 bg-gray-50"
                      >
                        {/* File type badge */}
                        <span
                          className="text-xs font-bold px-2 py-0.5 rounded flex-shrink-0"
                          style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}
                        >
                          {fileTypeLabel(att.type)}
                        </span>

                        {/* Name + view link */}
                        <span className="flex-1 min-w-0 text-sm text-gray-700 truncate">{att.name}</span>
                        <a
                          href={`/api/library-file/${sheetId}/${idx}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs flex-shrink-0"
                          style={{ color: '#FF8303' }}
                        >
                          View
                        </a>

                        {/* Remove */}
                        <button
                          type="button"
                          onClick={() => handleFileRemove(att)}
                          disabled={removingFiles.has(att.name)}
                          className="text-sm flex-shrink-0 disabled:opacity-60"
                          style={{ color: '#FD5602' }}
                          onMouseEnter={e => { e.currentTarget.style.color = '#e04e02' }}
                          onMouseLeave={e => { e.currentTarget.style.color = '#FD5602' }}
                          title="Remove file"
                        >
                          {removingFiles.has(att.name)
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : '✕'}
                        </button>
                      </div>
                    ))}
                  </div>
                )
              ) : (
                /* Create mode: files are staged locally and uploaded on Save. No View
                   link (nothing is on the server yet); remove just drops the staged File. */
                pendingFiles.length === 0 ? (
                  <div className="py-6 text-center">
                    <FileText className="w-5 h-5 text-gray-300 mx-auto mb-2" />
                    <p className="text-sm text-gray-400">No files attached yet.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {pendingFiles.map((file, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-3 px-4 py-3 rounded-lg border border-gray-200 bg-gray-50"
                      >
                        {/* File type badge */}
                        <span
                          className="text-xs font-bold px-2 py-0.5 rounded flex-shrink-0"
                          style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}
                        >
                          {fileTypeLabel(file.type)}
                        </span>

                        {/* Name (no view link — not uploaded yet) */}
                        <span className="flex-1 min-w-0 text-sm text-gray-700 truncate">{file.name}</span>

                        {/* Remove from the staged list only */}
                        <button
                          type="button"
                          onClick={() => removePendingFile(idx)}
                          className="text-sm flex-shrink-0"
                          style={{ color: '#FD5602' }}
                          onMouseEnter={e => { e.currentTarget.style.color = '#e04e02' }}
                          onMouseLeave={e => { e.currentTarget.style.color = '#FD5602' }}
                          title="Remove file"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>
          )}

          {/* ── TAGS TAB ── */}
          {activeTab === 'tags' && (
            <div className="space-y-5">
              <p className="text-sm text-gray-500">
                Tags classify this material for browsing and filtering. They do not affect who can see it —
                that is the Type and Access settings.
              </p>

              {tagsLoading ? (
                <p className="py-6 text-center text-sm text-gray-400">Loading tags…</p>
              ) : tagsLoadError ? (
                <p className="text-sm" style={{ color: '#FD5602' }}>
                  Couldn&apos;t load tags. This sheet&apos;s existing tags are left untouched when you save —
                  close and reopen to change them.
                </p>
              ) : allTags.length === 0 ? (
                <div className="py-6 text-center">
                  <TagIcon className="w-5 h-5 text-gray-300 mx-auto mb-2" />
                  <p className="text-sm text-gray-400">No tags exist yet.</p>
                  <p className="text-xs text-gray-400 mt-1">Create them with Manage Tags on the library page.</p>
                </div>
              ) : (
                <div className="space-y-5">
                  {renderTagGroup('Topics', topicTags)}
                  {renderTagGroup('Skills', skillTags)}
                </div>
              )}
            </div>
          )}

          {/* ── ACCESS TAB ── */}
          {activeTab === 'access' && type === 'study_sheet' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-500">
                Controls which teacher roles can see and assign this sheet on the Teacher Portal.
              </p>

              <div className="space-y-3">
                {[
                  {
                    value: 'all',
                    label: 'All Teachers',
                    description: 'Any teacher with an active account can see and assign this sheet.',
                  },
                  {
                    value: 'exam',
                    label: 'Teacher+Exam Only',
                    description: 'Only teachers with the Teacher+Exam role can access this sheet. Useful for exam prep content.',
                  },
                  {
                    value: 'admin',
                    label: 'Admin Only',
                    description: 'Not visible to any teacher. Admin can still assign it directly to students.',
                  },
                ].map(opt => (
                  <label
                    key={opt.value}
                    className="relative flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors"
                    style={{
                      borderColor: rolesPreset === opt.value ? '#FF8303' : '#e5e7eb',
                      backgroundColor: rolesPreset === opt.value ? '#FF830308' : 'white',
                    }}
                  >
                    <input
                      type="radio"
                      name="access"
                      value={opt.value}
                      checked={rolesPreset === opt.value}
                      onChange={() => setRolesPreset(opt.value)}
                      className="sr-only"
                    />
                    {rolesPreset === opt.value && (
                      <span
                        className="absolute top-2 right-2 inline-flex items-center justify-center rounded-full"
                        style={{ width: '18px', height: '18px', backgroundColor: '#FF8303' }}
                      >
                        <Check className="w-3 h-3 text-white" />
                      </span>
                    )}
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{opt.label}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{opt.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Modal footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 flex-shrink-0">
          {error && <p className="text-sm pr-4" style={{ color: '#FD5602' }}>{error}</p>}
          {!error && <span />}
          <div className="flex items-center gap-3 flex-shrink-0">
            <button
              type="button"
              // Once the row exists, dismissing must refresh the list — the sheet
              // is real and has to appear, error or not.
              onClick={createdIncomplete ? () => { void onSaved() } : onClose}
              className="px-4 py-2 text-sm rounded-md"
              style={{ border: '1px solid #E0DFDC', color: '#4b5563' }}
              onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#f9fafb' }}
              onMouseLeave={e => { e.currentTarget.style.backgroundColor = '' }}
            >
              {createdIncomplete ? 'Close' : 'Cancel'}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || tagsLoading || createdIncomplete}
              className="px-5 py-2 text-sm rounded-md text-white font-medium"
              style={
                saving || tagsLoading || createdIncomplete
                  ? { backgroundColor: '#E5E7EB', color: '#9CA3AF' }
                  : { backgroundColor: '#FF8303' }
              }
              onMouseEnter={e => { if (!(saving || tagsLoading || createdIncomplete)) e.currentTarget.style.backgroundColor = '#e67300' }}
              onMouseLeave={e => { if (!(saving || tagsLoading || createdIncomplete)) e.currentTarget.style.backgroundColor = '#FF8303' }}
            >
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Sheet'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
