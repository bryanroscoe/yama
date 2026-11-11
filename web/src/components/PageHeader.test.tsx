import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./Button";
import { PageHeader } from "./PageHeader";

const html = renderToStaticMarkup;

describe("PageHeader", () => {
  it("is the page's one h1 in its title row", () => {
    expect(html(<PageHeader title="What's new" />)).toBe('<div class="page-head"><h1>What&#x27;s new</h1></div>');
  });

  it("keeps a line under the title with it, and the actions at the end of the row", () => {
    const out = html(<PageHeader title="Blight Curse" sub={<p>Simulated on Phase, 400 games.</p>} actions={<Button variant="primary">Try a change</Button>} />);
    expect(out).toBe('<div class="page-head"><div><h1>Blight Curse</h1><p>Simulated on Phase, 400 games.</p></div><button type="button" class="primary">Try a change</button></div>');
    expect(out.match(/<h1>/g)).toHaveLength(1);
  });

  it("takes a title that is more than words, and a caller's class", () => {
    expect(html(<PageHeader className="run-head" title={<>Run <em>3</em></>} />)).toBe('<div class="page-head run-head"><h1>Run <em>3</em></h1></div>');
  });
});
