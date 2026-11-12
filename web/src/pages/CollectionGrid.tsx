import { plural, usd } from "@yama/core";
import type { CollectionItem } from "../api";
import { Button, CardImage, Tag } from "../components/ui";
import { markWords } from "./collectionEdit";
import { FINISH_LABEL } from "./collectionFilters";

/**
 * The collection as pictures: each row's own printing, whole and as printed (the image loads
 * from Scryfall; nothing is laid over it or done to it). How many copies, the finish, proxy and
 * the price of one copy sit under the picture. A tap opens the same sheet as the list's row.
 */
export function CollectionGrid<T extends CollectionItem>({ items, onOpen }: { items: T[]; onOpen: (item: T) => void }) {
  return (
    <ul className="coll-grid">
      {items.map((i) => (
        <li key={i.id}>
          <Button className="coll-tile" onClick={() => onOpen(i)} aria-label={`${i.name ?? "A printing Yama doesn't know"}, ${plural(i.qty, "copy", "copies")}`}>
            <CardImage src={i.image_normal ?? i.image_small} name={i.name ?? "?"} />
          </Button>
          <span className="coll-tile-meta">
            <span className="coll-tile-what">
              <span className="num">×{i.qty}</span>
              {i.finish !== "nonfoil" && <Tag>{FINISH_LABEL[i.finish] ?? i.finish}</Tag>}
              {i.proxy && <Tag>Proxy</Tag>}
              {markWords(i).map((w) => <Tag key={w}>{w[0]!.toUpperCase() + w.slice(1)}</Tag>)}
            </span>
            <span className="num coll-tile-price">{usd(i.unit_price_usd)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
