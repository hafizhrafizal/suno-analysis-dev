import { Link } from 'react-router-dom'
import { getUserStyle } from '../../utils/colors'

export default function UsernameTag({ username }: { username: string }) {
  return (
    <Link
      to={`/discord/search/users/${encodeURIComponent(username)}`}
      className="ubadge text-xs font-semibold hover:underline"
      style={getUserStyle(username)}
      onClick={e => e.stopPropagation()}
    >
      {username}
    </Link>
  )
}
