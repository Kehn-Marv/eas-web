import Image from "next/image";

/** Color mark for light themes; monochrome mark for dark themes. */
export function BrandMark({
  size = 24,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`relative inline-flex shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      <Image
        src="/logo.png"
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        className="brand-mark-light h-full w-full object-contain"
        draggable={false}
      />
      <Image
        src="/logo_black.png"
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        className="brand-mark-dark hidden h-full w-full object-contain"
        draggable={false}
      />
    </span>
  );
}
