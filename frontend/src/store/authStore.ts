import { create } from 'zustand'
import type { User } from '../types'

interface AuthState {
  user: User | null
  appMode: string        // 'single' | 'multi' | 'demo'
  showKeyModal: boolean
  showHfTokenModal: boolean
  setUser: (user: User | null) => void
  setAppMode: (mode: string) => void
  setShowKeyModal: (show: boolean) => void
  setShowHfTokenModal: (show: boolean) => void
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  appMode: 'single',
  showKeyModal: false,
  showHfTokenModal: false,
  setUser: (user) => set({ user }),
  setAppMode: (appMode) => set({ appMode }),
  setShowKeyModal: (showKeyModal) => set({ showKeyModal }),
  setShowHfTokenModal: (showHfTokenModal) => set({ showHfTokenModal }),
}))
