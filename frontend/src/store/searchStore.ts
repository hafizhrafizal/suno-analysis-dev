import { create } from 'zustand'
import type { Message } from '../types'

interface SearchState {
  results: Message[]
  bookmarkedIds: Set<number>
  setResults: (results: Message[]) => void
  setBookmarkedIds: (ids: number[]) => void
  toggleBookmarked: (id: number) => void
}

export const useSearchStore = create<SearchState>((set) => ({
  results: [],
  bookmarkedIds: new Set(),

  setResults: (results) => set({ results }),

  setBookmarkedIds: (ids) => set({ bookmarkedIds: new Set(ids) }),

  toggleBookmarked: (id) =>
    set((s) => {
      const next = new Set(s.bookmarkedIds)
      next.has(id) ? next.delete(id) : next.add(id)
      return { bookmarkedIds: next }
    }),
}))
