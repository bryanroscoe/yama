import { cloneElement, useId, type ComponentProps, type ReactElement, type ReactNode } from "react";

/**
 * A labelled control: the words above an `<input>`, a `<select>` or a `<textarea>` (or a
 * component that passes aria attributes on to one), in one `<label>`, so pressing the words
 * focuses the control and a screen reader reads them as its name. With an `error` the control
 * is marked invalid and described by it; the error is announced when it appears. The name
 * stays the label's words alone: a hint or an error describes the control, it doesn't rename
 * it. No hint lines under fields (design/tokens.md, rule 5); `hint` is for the rare fact a
 * label can't carry.
 */
export function Field({ label, error, hint, className, children }: { label: ReactNode; error?: ReactNode; hint?: ReactNode; className?: string; children: ReactElement<ComponentProps<"input">> }) {
  const id = useId();
  // Nothing under the control: the label's own text is its name, with no ids to wire.
  if (!hint && !error)
    return (
      <label className={className}>
        {label}
        {children}
      </label>
    );
  const notes = [children.props["aria-describedby"], hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return (
    <label className={className}>
      <span id={`${id}-label`}>{label}</span>
      {cloneElement(children, { "aria-labelledby": `${id}-label`, "aria-describedby": notes, "aria-invalid": error ? true : children.props["aria-invalid"] })}
      {hint && (
        <span className="hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {error && (
        <span className="field-error" id={`${id}-error`} role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

/**
 * A checkbox (or with `type="radio"` a radio) with its words beside it, in one `<label>`: the
 * whole row is the target. Everything an `<input>` takes passes through to the box. A `hint`
 * sits under the words and describes the box without joining its name.
 */
export function CheckRow({ children, hint, className, type = "checkbox", ...input }: { children: ReactNode; hint?: ReactNode; className?: string; type?: "checkbox" | "radio" } & Omit<ComponentProps<"input">, "type" | "className" | "children">) {
  const id = useId();
  if (!hint)
    return (
      <label className={className}>
        <input type={type} {...input} />
        {children}
      </label>
    );
  return (
    <label className={className}>
      <input type={type} {...input} aria-labelledby={`${id}-label`} aria-describedby={[input["aria-describedby"], `${id}-hint`].filter(Boolean).join(" ")} />
      <span id={`${id}-label`}>{children}</span>
      <span className="hint" id={`${id}-hint`}>
        {hint}
      </span>
    </label>
  );
}
