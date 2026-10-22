/**
 * The Yama wordmark (design/logo/yama-wordmark.svg): YAMA in caps, the two A's without crossbars
 * rising a little above the cap line as two peaks. Drawn in currentColor; size it by height.
 */
export function Wordmark({ className, title = "Yama" }: { className?: string; title?: string }) {
  return (
    <svg className={className} viewBox="0 -8 280 110" role="img" aria-label={title} focusable="false">
      <g fill="currentColor">
        <path d="M0 0H20L32 30L44 0H64L42 56V100H22V56Z" />
        <path d="M60 100L92 -6L124 100H104L92 60L80 100Z" />
        <path d="M134 100V0H152L170 44L188 0H206V100H186V40L170 79L154 40V100Z" />
        <path d="M216 100L248 -6L280 100H260L248 60L236 100Z" />
      </g>
    </svg>
  );
}
