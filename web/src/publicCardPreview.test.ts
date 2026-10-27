import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Listener = (event: Record<string, unknown>) => void;
function harness(image = "https://cards.scryfall.io/normal/front/a/card.jpg") {
  const listeners = new Map<string, Listener>();
  class Node {
    children: Node[] = [];parent: Node | null = null;attrs = new Map<string, string>();dataset: Record<string,string> = {};
    className = "";id = "";style: Record<string,string> = {};textContent = "";href = "";src = "";alt = "";target = "";rel = "";type = "";loading = "";
    events = new Map<string, Listener>();
    constructor(public tag: string) {}
    get firstChild(): Node | null { return this.children[0] ?? null; }
    appendChild(node: Node) { node.parent = this;this.children.push(node);return node; }
    insertBefore(node: Node, before: Node | null) { node.parent = this;const i = before ? this.children.indexOf(before) : -1;i < 0 ? this.children.push(node) : this.children.splice(i, 0, node); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); }
    setAttribute(k: string, v: string) { this.attrs.set(k, v); }
    removeAttribute(k: string) { this.attrs.delete(k); }
    getAttribute(k: string) { return this.attrs.get(k); }
    addEventListener(k: string, fn: Listener) { this.events.set(k, fn); }
    contains(node: Node): boolean { return this === node || this.children.some((c) => c.contains(node)); }
    closest(selector: string): Node | null { return selector === ".public-card-ref" && this.className.includes("public-card-ref") ? this : this.parent?.closest(selector) ?? null; }
    querySelector(tag: string): Node | null { for (const c of this.children) { if (c.tag === tag) return c;const nested = c.querySelector(tag);if (nested) return nested; }return null; }
    get classList() { return { toggle: (s: string, on: boolean) => { this.className = this.className.replace(s, "").trim() + (on ? ` ${s}` : ""); } }; }
    getBoundingClientRect() { return { left: 300, right: 350, top: 600, bottom: 640 }; }
    focus() { listeners.get("focusin")?.({ target: this }); }
  }
  const body = new Node("body");const link = new Node("a");link.className = "public-card-ref";link.dataset = { cardName: "Sol Ring", cardImage: image };link.textContent = "Sol Ring";link.href = "https://scryfall.com/card/test";body.appendChild(link);
  const document = { readyState: "complete", body, querySelectorAll: () => [link], createElement: (tag: string) => new Node(tag), addEventListener: (name: string, fn: Listener) => listeners.set(name, fn) };
  runInNewContext(readFileSync(new URL("../public/card-preview-v1.js", import.meta.url), "utf8"), { document, window: { innerWidth: 390, innerHeight: 740, addEventListener: vi.fn() }, URL });
  const fire = (name: string, values: Record<string,unknown> = {}) => { const event = { target: link, pointerType: "mouse", preventDefault: vi.fn(), ...values };listeners.get(name)?.(event);return event; };
  const panel = () => body.children.find((n) => n.id === "public-card-preview");
  return { link, body, fire, panel, Node };
}

describe("public card previews", () => {
  it("adds a small thumbnail and previews the full image on hover and keyboard focus", () => {
    const h = harness();expect(h.link.querySelector("img")?.className).toBe("public-card-thumb");expect(h.link.getAttribute("aria-haspopup")).toBe("dialog");
    h.fire("pointerover");expect(h.panel()?.getAttribute("role")).toBe("tooltip");expect(h.panel()?.querySelector("img")?.src).toContain("cards.scryfall.io/normal/");
    h.fire("pointerout", { relatedTarget: null });expect(h.panel()).toBeUndefined();
    h.fire("focusin");expect(h.panel()).toBeDefined();expect(Number.parseInt(h.panel()!.style.left!)).toBeGreaterThanOrEqual(12);
  });
  it("pins on tap/click, keeps the details link and closes with Escape without reopening", () => {
    const h = harness();const event = h.fire("click");expect(event.preventDefault).toHaveBeenCalledOnce();expect(h.panel()?.getAttribute("role")).toBe("dialog");expect(h.panel()?.querySelector("a")?.href).toBe(h.link.href);
    h.fire("pointerout");expect(h.panel()).toBeDefined();
    h.fire("keydown", { key: "Escape" });expect(h.panel()).toBeUndefined();expect(h.link.getAttribute("aria-expanded")).toBeUndefined();
  });
  it("allows modified navigation and missing or unsafe image links to work normally", () => {
    const modified = harness();expect(modified.fire("click", { ctrlKey: true }).preventDefault).not.toHaveBeenCalled();expect(modified.panel()).toBeUndefined();
    for (const image of ["", "javascript:alert(1)", "https://untrusted.example/card.jpg"]) { const h=harness(image);h.fire("pointerover");expect(h.panel()).toBeUndefined();expect(h.fire("click").preventDefault).not.toHaveBeenCalled();expect(h.link.querySelector("img")).toBeNull(); }
  });
  it("closes an open pinned panel when a different part of the page is clicked", () => {
    const h=harness();h.fire("click");expect(h.panel()).toBeDefined();h.fire("click",{target:new h.Node("div")});expect(h.panel()).toBeUndefined();
  });
});
