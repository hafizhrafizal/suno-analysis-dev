import { useState, useEffect } from 'react'

const SEARCHING_MESSAGES = [
  'Scanning the archives…',
  'Hunting through thousands of messages…',
  'Finding the signal in the noise…',
  'Sifting through the data…',
  'Turning over every stone…',
  'Almost there…',
]

export default function SearchingAnimation() {
  const [msgIdx, setMsgIdx] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setMsgIdx((i) => (i + 1) % SEARCHING_MESSAGES.length), 1800)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="bg-white rounded-2xl shadow px-6 py-12 flex flex-col items-center gap-5">
      <div className="relative w-14 h-14">
        <div className="absolute inset-0 rounded-full border-[3px] border-gray-100" />
        <div
          className="absolute inset-0 rounded-full border-[3px] border-transparent border-t-indigo-500 border-r-indigo-300 animate-spin"
          style={{ animationDuration: '0.85s' }}
        />
      </div>
      <p
        key={msgIdx}
        className="text-sm font-medium text-gray-500 tracking-wide"
      >
        {SEARCHING_MESSAGES[msgIdx]}
      </p>
    </div>
  )
}
