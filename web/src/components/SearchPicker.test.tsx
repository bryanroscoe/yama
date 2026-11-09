import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { filterOptions, SearchPicker } from "./SearchPicker";

const options = Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, label: `Box ${i}`, detail: i % 2 ? "binder" : "deck box" }));

describe("search picker", () => {
  it("keeps the choices holding every word typed, in either the label or the detail", () => {
    expect(filterOptions(options, "")).toHaveLength(10);
    expect(filterOptions(options, "box 3").map((o) => o.id)).toEqual(["b3"]);
    expect(filterOptions(options, "BINDER").length).toBe(5);
    expect(filterOptions(options, "nothing")).toEqual([]);
  });

  it("shows the search past eight choices and marks the current one", () => {
    const html = renderToStaticMarkup(<SearchPicker label="Boxes" options={options} current="b2" onPick={() => {}} />);
    expect(html).toContain('type="search"');
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    const few = renderToStaticMarkup(<SearchPicker label="Boxes" options={options.slice(0, 3)} onPick={() => {}} />);
    expect(few).not.toContain('type="search"');
  });
});
