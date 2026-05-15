interface AvatarProps {
  gravatarHash: string | null;
  displayName: string;
  size?: number;
  className?: string;
}

// Renders Gravatar at size `size` (px). If the user opted out (hash is null)
// or the gravatar 404s, the `?d=identicon` query is what fills in. We use
// `&s=` to request the right size and `&r=g` to keep it work-safe.
export function Avatar({ gravatarHash, displayName, size = 32, className = '' }: AvatarProps) {
  const px = size;
  const src = gravatarHash
    ? `https://www.gravatar.com/avatar/${gravatarHash}?d=identicon&s=${px * 2}&r=g`
    : `https://www.gravatar.com/avatar/00000000000000000000000000000000?d=identicon&s=${px * 2}&r=g&f=y`;
  return (
    <img
      src={src}
      alt={displayName}
      width={px}
      height={px}
      className={`rounded-full bg-sand shrink-0 ${className}`}
      style={{ width: px, height: px }}
      loading="lazy"
    />
  );
}
