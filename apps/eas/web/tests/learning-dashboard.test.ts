import assert from 'node:assert/strict'
import test from 'node:test'
import {
  learningSurfaceStats,
  recentLearningActivity,
  learningTodos,
  type LearningSources,
} from '../lib/learning-dashboard'
import type { MasteryTopic } from '../lib/learning-api'

const topic = (status: 'active' | 'archived', due: boolean) =>
  ({
    path_id: status,
    name: 'Home',
    metadata: { status, goal: 'Home' },
    updated_at: 80,
    map: { counts: { mastered: 1, total: 2 } },
    reviews: [{ due }],
  }) as MasteryTopic

const sources: LearningSources = {
  mastery: [topic('active', true), topic('archived', true)],
  reading: [
    {
      workspace_id: 'r',
      title: 'Memory',
      updated_at: 70,
      created_at: 1,
      description: '',
      tabs: [],
      active_material_id: null,
    },
  ],
}

test('recent learning mixes active learning sources by epoch seconds and keeps six', () => {
  const recent = recentLearningActivity(sources)
  assert.deepEqual(
    recent.map(item => item.updatedAt),
    [80, 70]
  )
  assert.equal(recent[0].title, 'Home')
  assert.equal(recent[0].progress, 0.5)
  assert.equal(recent[1].title, 'Memory')
})

test('todos contain due active topics only', () => {
  const todos = learningTodos(sources)
  assert.deepEqual(
    todos.reviews.map(item => item.path_id),
    ['active']
  )
  assert.equal(learningTodos({ ...sources, mastery: [topic('active', false)] }).reviews.length, 0)
})

test('surface stats count each kind and name the piece of it touched last', () => {
  const stats = learningSurfaceStats(sources)
  assert.deepEqual(
    Object.fromEntries(Object.entries(stats).map(([kind, stat]) => [kind, stat.count])),
    { mastery: 1, reading: 1 }
  )
  assert.equal(stats.mastery.latest?.title, 'Home')
  assert.equal(stats.mastery.latest?.href, '/learning/mastery/active?dt_workspace=')
  const empty = learningSurfaceStats({ mastery: [], reading: [] })
  assert.equal(empty.reading.count, 0)
  assert.equal(empty.reading.latest, undefined)
})
