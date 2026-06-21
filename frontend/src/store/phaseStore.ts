import { create } from 'zustand'

export interface PhaseDef {
  key: string
  label: string
  sub: string
  from: string
  to: string
  barColor: string
  chipCls: string
}

export const CHIP_PRESETS: { label: string; chipCls: string; barColor: string }[] = [
  { label: 'Blue',    chipCls: 'bg-blue-100 text-blue-700 border-blue-400',       barColor: '#3b82f6' },
  { label: 'Amber',   chipCls: 'bg-amber-100 text-amber-700 border-amber-400',     barColor: '#f59e0b' },
  { label: 'Violet',  chipCls: 'bg-violet-100 text-violet-700 border-violet-400',  barColor: '#8b5cf6' },
  { label: 'Sky',     chipCls: 'bg-sky-100 text-sky-700 border-sky-400',           barColor: '#0ea5e9' },
  { label: 'Orange',  chipCls: 'bg-orange-100 text-orange-700 border-orange-400',  barColor: '#f97316' },
  { label: 'Rose',    chipCls: 'bg-rose-100 text-rose-700 border-rose-400',        barColor: '#f43f5e' },
  { label: 'Emerald', chipCls: 'bg-emerald-100 text-emerald-700 border-emerald-400', barColor: '#10b981' },
  { label: 'Indigo',  chipCls: 'bg-indigo-100 text-indigo-700 border-indigo-400',  barColor: '#6366f1' },
  { label: 'Teal',    chipCls: 'bg-teal-100 text-teal-700 border-teal-400',        barColor: '#14b8a6' },
  { label: 'Pink',    chipCls: 'bg-pink-100 text-pink-700 border-pink-400',        barColor: '#ec4899' },
]

export const DEFAULT_PHASE_DEFS: PhaseDef[] = [
  { key: '1',  label: 'Phase 1',  sub: 'Capability Surfacing',    from: '2023-04-01', to: '2023-07-18', barColor: '#3b82f6', chipCls: 'bg-blue-100 text-blue-700 border-blue-400'     },
  { key: '2',  label: 'Phase 2',  sub: 'Enclosure & Scrutiny',    from: '2023-07-19', to: '2023-09-05', barColor: '#f59e0b', chipCls: 'bg-amber-100 text-amber-700 border-amber-400'   },
  { key: '3a', label: 'Phase 3A', sub: 'Early Commercialization', from: '2023-09-06', to: '2023-12-18', barColor: '#8b5cf6', chipCls: 'bg-violet-100 text-violet-700 border-violet-400' },
  { key: '3b', label: 'Phase 3B', sub: 'Early Wide Adoption',     from: '2023-12-18', to: '2024-03-17', barColor: '#0ea5e9', chipCls: 'bg-sky-100 text-sky-700 border-sky-400'         },
  { key: '3c', label: 'Phase 3C', sub: 'Pre-Litigation',          from: '2024-03-17', to: '2024-05-16', barColor: '#f97316', chipCls: 'bg-orange-100 text-orange-700 border-orange-400' },
  { key: '3d', label: 'Phase 3D', sub: 'Warning & Lawsuit',       from: '2024-05-17', to: '',           barColor: '#f43f5e', chipCls: 'bg-rose-100 text-rose-700 border-rose-400'       },
]

const LS_KEY = 'phase_defs_v1'

function loadDefs(): PhaseDef[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) return JSON.parse(raw) as PhaseDef[]
  } catch {}
  return DEFAULT_PHASE_DEFS
}

interface PhaseStore {
  defs: PhaseDef[]
  setDefs: (defs: PhaseDef[]) => void
  resetToDefaults: () => void
}

export const usePhaseStore = create<PhaseStore>((set) => ({
  defs: loadDefs(),
  setDefs: (defs) => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(defs)) } catch {}
    set({ defs })
  },
  resetToDefaults: () => {
    try { localStorage.removeItem(LS_KEY) } catch {}
    set({ defs: DEFAULT_PHASE_DEFS })
  },
}))
