'use client'

import type { LearningOrigin } from '@/lib/learning-library'
import { apiFetch, apiUrl } from '@/lib/api'
import { scopedUrl } from '@/lib/workspace-scope'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { SUBAGENT_KB_TYPE } from '@/lib/knowledge-helpers'
import type { TopicSourceInput, TopicSourceKind } from '@/lib/learning-api'
import { listNotebookEntries } from '@/lib/notebook-api'

export type SourceCandidateKind = Exclude<TopicSourceKind, 'goal'>

/**
 * A row that only exists to be opened: a question-bank category. It holds no
 * text of its own — its children do — so it renders without a checkbox and
 * never enters the selection.
 */
export type SourceContainerKind = 'category'

export interface SourceCandidate extends LearningOrigin {
  key: string
  kind: SourceCandidateKind | SourceContainerKind
  sourceId: string
  label: string
  detail: string
  available: boolean
  /**
   * False for a container row — one that is opened rather than chosen. The
   * selection and the hydration both skip these.
   */
  selectable?: boolean
  /** Whether opening this row fetches a child list. */
  expandable?: boolean
  /**
   * Prompt context carried from the listing that produced this row, so
   * hydration does not re-fetch what the list already showed. Only the
   * outline generator reads it; tutoring reads the real text server-side.
   */
  excerpt?: string
  /**
   * For a `file` candidate, the knowledge base it lives in.
   *
   * Both halves are needed to read it: the KB resolves access, the path
   * resolves the document inside it. `parentKey` is what lets selecting a
   * whole library and one of its files be mutually exclusive.
   */
  kbName?: string
  path?: string
  parentKey?: string
}

export interface SourceLibrary {
  notebooks: SourceCandidate[]
  knowledgeBases: SourceCandidate[]
  /** Past conversations — what the learner has already worked through. */
  chats: SourceCandidate[]
  /** Questions from every workspace, each carrying its origin. */
  questionSets: SourceCandidate[]
  failures: string[]
}

/** What one expandable row's child list is doing right now. */
export interface SourceChildren {
  candidates: SourceCandidate[]
  loading: boolean
  error: string
}

/** @deprecated Kept as the old name for {@link SourceChildren}. */
export type KnowledgeBaseFiles = SourceChildren

const EMPTY_LIBRARY: SourceLibrary = {
  notebooks: [],
  knowledgeBases: [],
  chats: [],
  questionSets: [],
  failures: [],
}

//: Entries listed under one question-bank category.
const MAX_CATEGORY_ENTRIES = 50

type Translate = (first: string, second: string) => string

export function useTopicSourceLibrary(tr: Translate) {
  const [library, setLibrary] = useState<SourceLibrary>(EMPTY_LIBRARY)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let disposed = false
    const kinds = ['notebooks', 'knowledge', 'chats', 'practice'] as const
    Promise.allSettled(
        kinds.map(kind =>
          sourceRequest<{ items: Record<string, unknown>[]; unavailable_workspaces: string[] }>(
            `/api/dashboard/source-library/${kind}`,
            ''
          )
        )
      ).then(results => {
      if (disposed) return
      const failures: string[] = []
      const rows = (index: number) => {
        const result = results[index]
        if (result.status === 'rejected') {
          failures.push(kinds[index])
          return []
        }
        if (result.value.unavailable_workspaces.length) failures.push(kinds[index])
        return result.value.items
      }
      const candidate = (
        row: Record<string, unknown>,
        kind: SourceCandidateKind,
        id: unknown,
        label: unknown,
        detail: unknown = ''
      ): SourceCandidate => ({
        key: JSON.stringify([row.content_workspace_id ?? '', kind, id]),
        kind,
        sourceId: String(id),
        label: String(label || tr('Untitled', 'Untitled')),
        detail: String(detail || ''),
        content_workspace_id: String(row.content_workspace_id ?? ''),
        content_workspace_name: String(row.content_workspace_name || ''),
        available: row.available !== false && !row.unreadable,
      })
      setLibrary({
        notebooks: rows(0).map(row => candidate(row, 'notebook', row.id, row.name)),
        knowledgeBases: rows(1)
          .filter(
            row => (row.metadata as Record<string, unknown> | undefined)?.type !== SUBAGENT_KB_TYPE
          )
          .map(row => ({
            ...candidate(row, 'knowledge_base', row.id || row.name, row.name),
            expandable: true,
          })),
        chats: rows(2).map(row => ({
          ...candidate(row, 'chat', row.session_id, row.title),
          excerpt: String(row.last_message || ''),
        })),
        questionSets: rows(3).map(row => ({
          ...candidate(row, 'question_bank', row.id, row.question),
          excerpt: String(row.question || ''),
        })),
        failures,
      })
      setLoading(false)
    })
    return () => {
      disposed = true
    }
  }, [tr])

  // Child lists are fetched per row, only when the learner opens one: a
  // workspace with a dozen libraries and categories would otherwise
  // pay for every listing to answer a question about one of them.
  const [childLists, setChildLists] = useState<Record<string, SourceChildren>>({})

  const loadChildren = useCallback(
    async (candidate: SourceCandidate) => {
      const parentKey = candidate.key
      setChildLists(previous =>
        previous[parentKey]?.candidates.length
          ? previous
          : {
              ...previous,
              [parentKey]: { candidates: [], loading: true, error: '' },
            }
      )
      try {
        const listed = await fetchChildren(candidate, tr)
        setChildLists(previous => ({
          ...previous,
          [parentKey]: { loading: false, error: '', candidates: listed },
        }))
      } catch (reason) {
        setChildLists(previous => ({
          ...previous,
          [parentKey]: {
            candidates: [],
            loading: false,
            error:
              reason instanceof Error
                ? reason.message
                : tr('Could not load the list', 'Could not load the list'),
          },
        }))
      }
    },
    [tr]
  )

  const candidates = useMemo(
    () =>
      [
        ...library.notebooks,
        ...library.knowledgeBases,
        ...library.chats,
        ...library.questionSets,
        ...Object.values(childLists).flatMap(entry => entry.candidates),
        // Containers are opened, never chosen — keeping them out here means
        // neither the selection nor hydration has to know about them.
      ].filter(candidate => candidate.selectable !== false),
    [library, childLists]
  )
  return { library, loading, candidates, childLists, loadChildren }
}

/** One expandable row's children, by kind. Throws so the caller can show why. */
async function fetchChildren(
  candidate: SourceCandidate,
  tr: Translate
): Promise<SourceCandidate[]> {
  const parentKey = candidate.key
  if (candidate.kind === 'knowledge_base') {
    const kbName = candidate.sourceId
    const { files: listed } = await sourceRequest<{
      files: import('@/features/knowledge/model/types').KnowledgeBaseFile[]
    }>(
      `/api/knowledge-bases/${encodeURIComponent(kbName)}/files?resource_library=true`,
      candidate.content_workspace_id
    )
    return (
      listed
        // Folders are organisational only — they hold no text to ground an
        // outline in, and their files are listed by full path anyway.
        .filter(entry => entry.type !== 'folder')
        .map(entry => ({
          key: JSON.stringify([candidate.content_workspace_id ?? '', 'file', kbName, entry.name]),
          kind: 'file' as const,
          sourceId: entry.name,
          label: entry.name,
          detail: tr(`File in ${kbName}`, `File in ${kbName}`),
          available: true,
          kbName,
          path: entry.name,
          parentKey,
          content_workspace_id: candidate.content_workspace_id,
          content_workspace_name: candidate.content_workspace_name,
        }))
    )
  }
  if (candidate.kind === 'category') {
    const { items } = await listNotebookEntries({
      category_id: Number(candidate.sourceId),
      limit: MAX_CATEGORY_ENTRIES,
    })
    return items.map(entry => ({
      key: `question_bank:${entry.id}`,
      kind: 'question_bank' as const,
      sourceId: String(entry.id),
      label: entry.question.slice(0, 80) || tr('Untitled question', 'Untitled question'),
      detail: entry.is_correct
        ? tr('Answered correctly', 'Answered correctly')
        : tr('Answered wrong', 'Answered wrong'),
      available: true,
      excerpt: entry.question,
      parentKey,
    }))
  }
  return []
}

/**
 * Add or remove one source from the selection.
 *
 * The rule that needs stating: selecting a whole knowledge base drops the
 * individual documents picked out of it. Sending both means the same material
 * arrives twice — once as retrieval over the library, once as extracted file
 * text — and is counted twice when the outline's coverage is measured.
 *
 * Pure, and exported, so the wizard and its test cannot disagree about it.
 */
export function toggleSourceSelection(
  selected: Set<string>,
  key: string,
  candidates: readonly SourceCandidate[]
): Set<string> {
  const next = new Set(selected)
  if (next.has(key)) {
    next.delete(key)
    return next
  }
  next.add(key)
  for (const candidate of candidates) {
    if (candidate.parentKey === key) next.delete(candidate.key)
  }
  return next
}

/** Resolve a selected source to bounded prompt context; failures stay visible. */
export async function hydrateTopicSource(candidate: SourceCandidate): Promise<TopicSourceInput> {
  const source = await hydrateSource(candidate)
  return candidate.content_workspace_id === undefined
    ? source
    : {
        ...source,
        metadata: { ...source.metadata, content_workspace_id: candidate.content_workspace_id },
      }
}

async function hydrateSource(candidate: SourceCandidate): Promise<TopicSourceInput> {
  try {
    if (candidate.kind === 'notebook') {
      const notebook = await sourceRequest<import('@/lib/notebook-api').NotebookDetail>(
        `/api/notebooks/${encodeURIComponent(candidate.sourceId)}`,
        candidate.content_workspace_id
      )
      return {
        kind: 'notebook',
        source_id: candidate.sourceId,
        label: candidate.label,
        excerpt: notebook.records
          .slice(0, 16)
          .map(
            record =>
              `${record.title}\n${record.summary || record.user_query || ''}\n${record.output || ''}`
          )
          .join('\n\n')
          .slice(0, 8_000),
        available: true,
        metadata: { record_count: notebook.records.length },
      }
    }
    if (candidate.kind === 'file') {
      // No excerpt: the browser cannot read a PDF out of the knowledge base,
      // so the server extracts the text while grounding the outline (see
      // `_ground_file_source`). What travels from here is the address.
      return {
        kind: 'file',
        source_id: candidate.path || candidate.sourceId,
        label: candidate.label,
        excerpt: '',
        available: candidate.available,
        metadata: {
          kb_name: candidate.kbName || '',
          path: candidate.path || candidate.sourceId,
        },
      }
    }
    if (
      candidate.kind === 'chat' || candidate.kind === 'question_bank'
    ) {
      // The listing already showed enough to ground an outline, and the full
      // text is read server-side during tutoring — so hydration here is an
      // address plus what the learner just looked at, not another fetch.
      return {
        kind: candidate.kind,
        source_id: candidate.sourceId,
        label: candidate.label,
        excerpt: (candidate.excerpt || candidate.detail).slice(0, 4_000),
        available: candidate.available,
      }
    }
    return {
      kind: 'knowledge_base',
      source_id: candidate.sourceId,
      label: candidate.label,
      excerpt: candidate.detail,
      available: candidate.available,
    }
  } catch {
    return {
      // Containers never reach hydration (they are filtered out of
      // `candidates`), so the cast is narrowing a type, not a guess.
      kind: candidate.kind as TopicSourceKind,
      source_id: candidate.sourceId,
      label: candidate.label,
      excerpt: '',
      available: false,
      metadata: { unavailable_during_generation: true },
    }
  }
}

export async function sourceRequest<T>(path: string, workspaceId = ''): Promise<T> {
  const response = await apiFetch(apiUrl(scopedUrl(path, workspaceId)), { cache: 'no-store' })
  if (!response.ok) throw new Error(`Could not load source (${response.status})`)
  return response.json() as Promise<T>
}
