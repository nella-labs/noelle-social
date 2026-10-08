interface NoelleBrandProps {
  variant?: "lockup" | "symbol";
  className?: string;
  decorative?: boolean;
}

/** Vector identity, colored by the surrounding theme. */
export function NoelleBrand({ variant = "lockup", className = "", decorative = false }: NoelleBrandProps) {
  return (
    <span
      className={`noelle-identity noelle-identity-${variant} ${className}`.trim()}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : "Noelle"}
      aria-hidden={decorative || undefined}
    />
  );
}
