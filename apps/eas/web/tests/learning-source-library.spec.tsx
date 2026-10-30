import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { hydrateTopicSource, useTopicSourceLibrary } from '@/hooks/useTopicSourceLibrary'
import { apiFetch } from '@/lib/api'

vi.mock('@/lib/api', () => ({ apiUrl: (path: string) => path, apiFetch: vi.fn() }))
const translate = (key: string) => key

it('uses global indexes and pins file expansion and notebook hydration to their source', async () => {
  window.history.replaceState({}, '', '/learning/mastery?dt_workspace=destination')
  const origin = { content_workspace_id: 'original', content_workspace_name: 'Original' }
  vi.mocked(apiFetch).mockImplementation(async url => {
    const path = new URL(String(url), 'http://localhost').pathname
    const data = path.endsWith('/files')
      ? { files: [{ name: 'lesson.pdf', type: 'file' }] }
      : path.includes('/notebooks/')
        ? {
            id: 'nb1',
            name: 'Physics Notes',
            records: [{ title: 'Kinematics', summary: 'Motion', output: 'v = u + at' }],
          }
        : {
            items: path.endsWith('/knowledge')
              ? [{ id: 'workspace:original:kb:notes', name: 'notes', ...origin }]
              : path.endsWith('/notebooks')
                ? [{ id: 'nb1', name: 'Physics Notes', ...origin }]
                : [],
            unavailable_workspaces: [],
          }
    return new Response(JSON.stringify(data), { status: 200 })
  })
  const { result } = renderHook(() => useTopicSourceLibrary(translate))
  await waitFor(() => expect(result.current.loading).toBe(false))
  const kb = result.current.library.knowledgeBases[0]
  await act(() => result.current.loadChildren(kb))
  expect(result.current.childLists[kb.key].error).toBe('')
  expect(result.current.childLists[kb.key].candidates[0]).toMatchObject({
    sourceId: 'lesson.pdf',
    content_workspace_id: 'original',
  })
  const notebook = await hydrateTopicSource(result.current.library.notebooks[0])
  expect(notebook.available).toBe(true)
  expect(notebook.metadata?.content_workspace_id).toBe('original')
  const urls = vi
    .mocked(apiFetch)
    .mock.calls.map(call => new URL(String(call[0]), 'http://localhost'))
  expect(
    urls
      .filter(url => url.pathname.includes('source-library'))
      .every(url => url.searchParams.get('dt_workspace') === '')
  ).toBe(true)
  expect(
    urls
      .filter(url => /\/(files|notebooks\/nb1)$/.test(url.pathname))
      .every(url => url.searchParams.get('dt_workspace') === 'original')
  ).toBe(true)
  expect(window.location.search).toBe('?dt_workspace=destination')
})
