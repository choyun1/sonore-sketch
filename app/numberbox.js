// A box beside a slider for typing its value. The box shows the slider's
// value in the box's own units (`toBox`, for example metres as centimetres)
// and a value typed in it moves the slider (`fromBox`), kept to the slider's
// range, then fires the slider's input and change events, as a drag would.
// `show()` puts the slider's value back in the box, for code that sets the
// slider itself.

export function numberBox(range, { toBox = (value) => value, fromBox = (value) => value, digits = 2 } = {}) {
  const box = document.createElement("input");
  box.type = "number";
  box.className = "slider-value";
  box.min = toBox(Number(range.min));
  box.max = toBox(Number(range.max));
  box.step = range.step === "any" || !range.step ? "any" : toBox(Number(range.step));
  box.title = range.closest("[title]")?.title ?? "";
  const show = () => (box.value = Number(toBox(Number(range.value)).toFixed(digits)));
  range.addEventListener("input", show);
  box.addEventListener("change", () => {
    const typed = Number(box.value);
    if (box.value === "" || !Number.isFinite(typed)) return show();
    range.value = Math.min(Number(range.max), Math.max(Number(range.min), fromBox(typed)));
    show();
    range.dispatchEvent(new Event("input", { bubbles: true }));
    range.dispatchEvent(new Event("change", { bubbles: true }));
  });
  show();
  return { box, show };
}
