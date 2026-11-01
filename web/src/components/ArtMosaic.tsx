/**
 * Up to four seats' commander art as a 2×2 mosaic: one image fills the box, two sit side by side,
 * three put the last one across the bottom. With none it's a plain raised block. Used for a game
 * with no single winner to show (Play's game list, the Table's recent games). The caller credits
 * the artists in the same view.
 */
export function ArtMosaic({ arts, className = "" }: { arts: (string | null | undefined)[]; className?: string }) {
  // Seats on the same commander show it once: four copies of one picture read as a tiling bug.
  const shown = [...new Set(arts.filter((a): a is string => !!a))].slice(0, 4);
  return (
    <span className={`art-mosaic${className ? ` ${className}` : ""}`} data-n={shown.length} aria-hidden="true">
      {shown.map((a, i) => (
        <img key={`${i}-${a}`} src={a} alt="" loading="lazy" />
      ))}
    </span>
  );
}
